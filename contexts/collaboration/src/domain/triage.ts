// Who talks to the AI, and the triage of what they say (ADR 0030, decisions 3 and 4; the plan's "Who talks to the AI"
// and "Triage"). Pure, over plain shapes where the page decides the same (its AI mark before sending):
//
// - addressing: in a Collab session a message is addressed to the AI when it mentions the AI or replies to the AI (one
//   of its answers, or a run); in a Solo session every message is. The facilitator can address any other message
//   (「AI に送る」), recorded as addressed by the facilitator;
// - stage 1 of the cascade, mechanical and narrow: an empty body, emoji only, or a short fixed acknowledgement is
//   "neither"; anything else is unknown. It never reads keywords to tell 相談 from 依頼;
// - the verdicts of stages 2 (Clef: probabilities of three questions) and 3 (a light model: a kind and a confidence),
//   kept as each stage's answer only when confident;
// - where a decided triage goes: an answer, a proposal (a participant's change request), the queue (the facilitator's,
//   a Solo session's, or a message the facilitator addressed), or nowhere;
// - the commands of the `Triage` aggregate.
import { Collaboration, decide, decideNamed, err, ok, parseDecimal } from '../generated/index.js';
import { isAi } from './ai.js';
import { parseBody } from './body.js';

type Verdict = Collaboration.TriageVerdict;

// ---- Addressing ----

/** What addressing reads of a message as it is sent: the session's mode, the people it mentions, what it replies to. */
export interface AddressingFacts {
    readonly mode: Collaboration.SessionMode;
    /** The participants the body mentions (the AI's ID among them when it mentions `@AI`). */
    readonly mentions: readonly string[];
    /** What it replies to: a run, or a message with its author. */
    readonly replyTo?: { readonly kind: 'Run' } | { readonly kind: 'Message'; readonly author: string };
}

/**
 * Why a message is addressed to the AI when it is sent, or `undefined` when it is talk between people: every message of a
 * Solo session; in a Collab session, a mention of the AI, then a reply to a run or to one of the AI's messages.
 */
export function addressing(facts: AddressingFacts): Collaboration.AddressedBy | undefined {
    if (facts.mode === 'Solo') return 'Solo';
    if (facts.mentions.some(isAi)) return 'Mention';
    const to = facts.replyTo;
    if (to?.kind === 'Run' || (to?.kind === 'Message' && isAi(to.author))) return 'Reply';
    return undefined;
}

// ---- Stage 1: mechanical ----

/**
 * The short acknowledgements stage 1 knows, in their normalised form (`normalizeAcknowledgement`): thanks and "got it",
 * nothing that asks. A closed list on purpose: whatever is not on it goes on to the next stage.
 */
export const ACKNOWLEDGEMENTS: ReadonlySet<string> = new Set([
    'ありがとう',
    'ありがとうございます',
    'ありがとうございました',
    'ありがと',
    'どうも',
    'どうもありがとう',
    'サンキュー',
    'さんきゅー',
    'あざす',
    'あざっす',
    '了解',
    '了解です',
    '了解しました',
    '承知',
    '承知です',
    '承知しました',
    'わかりました',
    '分かりました',
    'りょ',
    'おk',
    'おけ',
    'ok',
    'okay',
    'thanks',
    'thank you',
    'thx',
    'got it',
]);

/** The most characters (after normalising) an acknowledgement may have: a longer message is never one. */
export const MAX_ACKNOWLEDGEMENT = 20;

/** Emoji and the characters that only join or qualify them. */
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|\u20e3/gu;

/** Punctuation and long-vowel marks a short reply may end with. */
const TRAILING = /[\s.,!?。、．，！？…‥〜～ー~]+$/u;

/** A text as stage 1 compares it: full width folded (NFKC), lower case, spaces collapsed, trailing punctuation dropped. */
export function normalizeAcknowledgement(text: string): string {
    return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim().replace(TRAILING, '').trim();
}

/** Why stage 1 judged a message "neither". */
export type MechanicalRule = 'empty' | 'emojiOnly' | 'acknowledgement';

/** The rules of stage 1, as its step's reason. */
export const MECHANICAL_REASONS: Readonly<Record<MechanicalRule, string>> = {
    empty: '本文が空（言及だけ）',
    emojiOnly: '絵文字だけ',
    acknowledgement: '決まった相づち',
};

/**
 * Stage 1 of the cascade: `NotForAi` with the rule when the body (its people's mentions left out: `@AI[p1]` is the
 * addressing, not the message) is empty, emoji only, or a short fixed acknowledgement (`ACKNOWLEDGEMENTS`, emoji around
 * it allowed); `Unknown` otherwise. It never answers 相談 or 依頼.
 */
export function mechanicalVerdict(body: string): { readonly verdict: 'NotForAi'; readonly rule: MechanicalRule } | { readonly verdict: 'Unknown' } {
    const words = parseBody(body, { targets: 99, people: 99 })
        .map((s) => (s.kind === 'text' ? s.text : s.kind === 'element' ? `#${s.name}` : ' '))
        .join('');
    if (!words.trim()) return { verdict: 'NotForAi', rule: 'empty' };
    const bare = words.replace(EMOJI, '');
    if (!bare.trim()) return { verdict: 'NotForAi', rule: 'emojiOnly' };
    const text = normalizeAcknowledgement(bare);
    if (text.length <= MAX_ACKNOWLEDGEMENT && ACKNOWLEDGEMENTS.has(text)) return { verdict: 'NotForAi', rule: 'acknowledgement' };
    return { verdict: 'Unknown' };
}

// ---- Stages 2 and 3: confident answers only ----

/** The thresholds of plan Q5 (strict at first; M7's sample sets them). */
export const TRIAGE_THRESHOLDS = {
    /** A Clef question's probability that decides. */
    clef: 0.9,
    /** The light model's confidence below which its "neither" is not taken (it is unknown, then 相談). */
    modelNeither: 0.8,
} as const;

/** Clef's probabilities for the three questions of stage 2 (each 0–1). */
export interface ClefProbabilities {
    readonly consultation: number;
    readonly changeRequest: number;
    readonly neither: number;
}

/** Stage 2's verdict: the one question at or above the threshold decides; none or several is unknown. */
export function clefVerdict(p: ClefProbabilities, threshold: number = TRIAGE_THRESHOLDS.clef): { readonly verdict: Verdict; readonly confidence?: number } {
    const answers: [Verdict, number][] = [
        ['Consultation', p.consultation],
        ['ChangeRequest', p.changeRequest],
        ['NotForAi', p.neither],
    ];
    const sure = answers.filter(([, x]) => Number.isFinite(x) && x >= threshold);
    const [only] = sure;
    return sure.length === 1 && only ? { verdict: only[0], confidence: only[1] } : { verdict: 'Unknown' };
}

/** What the light model answers (its JSON schema): a kind and how sure it is (0–1). */
export interface ModelAnswer {
    readonly kind: Verdict;
    readonly confidence: number;
}

/** Stage 3's verdict: as the model answered, but a "neither" below the threshold is unknown (the cascade then makes it 相談). */
export function modelVerdict(answer: ModelAnswer, neitherThreshold: number = TRIAGE_THRESHOLDS.modelNeither): Verdict {
    if (answer.kind === 'NotForAi' && !(answer.confidence >= neitherThreshold)) return 'Unknown';
    return answer.kind;
}

// ---- The cascade's order and decision ----

/** The stages of the cascade, in order: each runs only after those before it. */
export const CASCADE: readonly Collaboration.TriageStage[] = ['Mechanical', 'Clef', 'Model'];

/** Whether `stage` may be recorded after `steps`: a cascade stage after every cascade stage recorded so far. */
export function inCascadeOrder(steps: readonly { readonly stage: Collaboration.TriageStage }[], stage: Collaboration.TriageStage): boolean {
    const at = CASCADE.indexOf(stage);
    return at >= 0 && steps.every((s) => CASCADE.indexOf(s.stage) < at);
}

/**
 * What a cascade stage's answer decides: its kind when it knows; after the last stage (the light model), still unknown is
 * 相談 (the side that writes nothing); otherwise nothing yet (the next stage runs).
 */
export function decisionOf(step: { readonly stage: Collaboration.TriageStage; readonly verdict: Verdict }): Verdict | undefined {
    if (step.verdict !== 'Unknown') return step.verdict;
    return step.stage === 'Model' ? 'Consultation' : undefined;
}

// ---- Where a decided triage goes ----

/** What follows a triage: an answer by the read-only answerer, a proposal, a run queued, or nothing. */
export type TriageRoute = 'answer' | 'propose' | 'queue' | 'none';

/**
 * Where a triage goes once decided: 相談 → an answer; 依頼 → the queue when the session is Solo, the message is the
 * facilitator's, or the facilitator addressed it (「AI に送る」: the sending is the approval, plan Q3), else a proposal
 * for the facilitator; neither → nothing.
 */
export function triageRoute(
    triage: { readonly kind: Verdict; readonly addressedBy: Collaboration.AddressedBy },
    facts: { readonly mode: Collaboration.SessionMode; readonly authorIsFacilitator: boolean },
): TriageRoute {
    switch (triage.kind) {
        case 'Consultation':
            return 'answer';
        case 'ChangeRequest':
            return facts.mode === 'Solo' || facts.authorIsFacilitator || triage.addressedBy === 'Facilitator' ? 'queue' : 'propose';
        case 'NotForAi':
        case 'Unknown':
            return 'none';
    }
}

// ---- The commands ----

export const triageCommands: Collaboration.TriageCommands = {
    open: decide<Collaboration.OpenTriageDecision>(Collaboration.TriageShape, (params) => {
        const { id, session, addressedBy, addressedByParticipant, openedAt } = params;
        // the message without its evidence: the aggregate stores the base type
        const request: Collaboration.RequestId = params.request;
        return ok({
            Pending: {
                set: { id, session, request, addressedBy, addressedByParticipant, steps: [], openedAt },
                events: { TriageOpened: { type: 'TriageOpened', triageId: id, session, request, addressedBy, addressedByParticipant, openedAt } },
            },
        });
    }),

    // a cascade stage's answer: decided when it knows (or after the last stage), still pending otherwise
    record: decideNamed<Collaboration.RecordTriageDecision>()(Collaboration.TriageShape, { Pending: 'Pending', Decided: 'Decided' }, (triage, params) => {
        const check = Collaboration.checkRecordTriageRequiresWith({ inOrder: (t, p) => inCascadeOrder(t.steps, p.step.stage) });
        switch (check(triage, params)) {
            case 'cascadeStage':
            case 'mechanicalDecidesNeither':
                return err({ type: 'InvalidTriageStep' });
            case 'inOrder':
                return err({ type: 'TriageStepOutOfOrder' });
        }
        const { step, recordedAt } = params;
        const steps = [...triage.steps, step];
        const recorded: Collaboration.TriageStepRecorded = { type: 'TriageStepRecorded', triageId: triage.id, step };
        const kind = decisionOf(step);
        if (kind === undefined) return ok({ Pending: { set: { steps }, events: { TriageStepRecorded: recorded } } });
        return ok({
            Decided: {
                set: { steps, kind, decidedBy: step.stage, decidedAt: recordedAt, outcome: undefined },
                events: {
                    TriageStepRecorded: recorded,
                    TriageDecided: { type: 'TriageDecided', triageId: triage.id, kind, decidedBy: step.stage, decidedAt: recordedAt },
                },
            },
        });
    }),

    override: decide<Collaboration.OverrideTriageDecision>(Collaboration.TriageShape, {
        Decided: (triage, params) => {
            if (Collaboration.checkOverrideTriageRequires(triage, params) === 'overridable') return err({ type: 'TriageNotOverridable' });
            const { step, overriddenAt } = params;
            return ok({
                Decided: {
                    set: { steps: [...triage.steps, step], kind: step.verdict, decidedBy: step.stage, decidedAt: overriddenAt },
                    events: { TriageOverridden: { type: 'TriageOverridden', triageId: triage.id, step, kind: step.verdict } },
                },
            });
        },
    }),

    // plan Q6: a message judged "neither" sent again by the facilitator skips the cascade and goes on as 相談, as the
    // facilitator's (a change request it turns out to be is then queued without a proposal)
    readdress: decide<Collaboration.ReaddressTriageDecision>(Collaboration.TriageShape, {
        Decided: (triage, params) => {
            switch (Collaboration.checkReaddressTriageRequires(triage, params)) {
                case 'facilitatorReaddresses':
                    return err({ type: 'FacilitatorOnly' });
                case 'decidedNotForAi':
                    return err({ type: 'RequestAlreadyAddressed', request: triage.request });
            }
            const { by, readdressedAt } = params;
            const step: Collaboration.TriageStep = { stage: 'Facilitator', verdict: 'Consultation', durationMs: zeroMs, at: readdressedAt };
            return ok({
                Decided: {
                    set: {
                        addressedBy: 'Facilitator',
                        addressedByParticipant: by,
                        steps: [...triage.steps, step],
                        kind: 'Consultation',
                        decidedBy: 'Facilitator',
                        decidedAt: readdressedAt,
                    },
                    events: { TriageReaddressed: { type: 'TriageReaddressed', triageId: triage.id, by, readdressedAt } },
                },
            });
        },
    }),

    conclude: decide<Collaboration.ConcludeTriageDecision>(Collaboration.TriageShape, {
        Decided: (triage, params) => {
            switch (Collaboration.checkConcludeTriageRequires(triage, params)) {
                case 'noOutcomeYet':
                    return err({ type: 'TriageAlreadyConcluded' });
                case 'outcomeFits':
                    return err({ type: 'TriageNotConcludable' });
            }
            const { to, concludedAt } = params;
            return ok({ Decided: { set: { outcome: to }, events: { TriageConcluded: { type: 'TriageConcluded', triageId: triage.id, to, concludedAt } } } });
        },
    }),
};

const zero = Collaboration.makeMilliseconds(0);
if (!zero.ok) throw new Error('0 ms is not a duration');
const zeroMs: Collaboration.Milliseconds = zero.value;

/** A duration in whole milliseconds (negative and fractional values rounded into range: a clock is never trusted to be monotonic). */
export function milliseconds(n: number): Collaboration.Milliseconds {
    const made = Collaboration.makeMilliseconds(Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
    if (!made.ok) throw new Error(`Not a duration: ${n}`);
    return made.value;
}

/** A confidence (0–1) as the model's `Confidence`, to 4 decimals; `undefined` for a number out of range or not finite. */
export function confidence(n: number): Collaboration.Confidence | undefined {
    if (!Number.isFinite(n) || n < 0 || n > 1) return undefined;
    const text = parseDecimal(n.toFixed(4).replace(/\.?0+$/u, ''));
    if (text === undefined) return undefined;
    const made = Collaboration.makeConfidence(text);
    return made.ok ? made.value : undefined;
}

// ---- What the answerer role is asked to do ----

/** The cascade stage a pending triage waits for: the first not recorded yet (`undefined` once the last ran). */
export function nextStage(steps: readonly { readonly stage: Collaboration.TriageStage }[]): Collaboration.TriageStage | undefined {
    return CASCADE.find((stage) => inCascadeOrder(steps, stage));
}

/**
 * The job of the answerer role a triage waits for: `triage` (stage 3, once stages 1 and 2 are recorded — the server
 * records Clef's step, a skipped one when Clef is not configured), `answer` (a 相談 not answered yet), `propose` (a
 * participant's 依頼 without a proposal yet); `undefined` when it waits for none (the server's stage, the queue, done).
 */
export function answerJobOf(
    triage: Collaboration.Triage,
    facts: { readonly mode: Collaboration.SessionMode; readonly authorIsFacilitator: boolean },
): 'triage' | 'answer' | 'propose' | undefined {
    if (triage.state === 'Pending') return nextStage(triage.steps) === 'Model' ? 'triage' : undefined;
    if (triage.outcome !== undefined) return undefined;
    const route = triageRoute(triage, facts);
    return route === 'answer' ? 'answer' : route === 'propose' ? 'propose' : undefined;
}
