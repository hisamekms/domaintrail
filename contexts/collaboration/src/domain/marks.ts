// Votes and reactions as one mechanism (ADR 0026, appendix "Votes and reactions"): a mark is who (a participant) marked
// what (a target) with which sign. What differs between votes and reactions is a rule per kind of target, decided here:
//
// - which signs fit a target: the vote (♡) on a question's option and on an assumption's choices (the assumption kept
//   as it is, or one of its alternatives); reactions — any one emoji, to which the app gives no meaning — on a message
//   and on an AI turn (`signFits`), at most `MAX_REACTION_EMOJI` different emoji per target (`reactionRoom`);
// - who may mark: anyone for a reaction, participants only for a vote (the facilitator's answer is the decision; the
//   model's `participantsVote`);
// - exclusivity: one vote per participant in a single-choice question and in an assumption group, moved by voting
//   another; any number in a multiple-choice question; each emoji on its own (`exclusiveGroup`);
// - closing, derived from the runs and never stored (`markTargetStatus`): a reaction never closes; a vote is open while
//   its run is the latest run to have handled its requests — no later run (one cancelled before it started does not
//   count) bundles any of them or answers it — and the run is still waiting for an answer (a question's option) or
//   completed (an assumption's choices). Answering, picking an alternative (a run of the same requests with a note)
//   and applying the same messages again all close it; cancelling that later run before it started opens it again.
//
// Pure, and over the plain shapes of the runs and requests, so that the server (the generated types) and the page
// (their JSON) decide the same way.
import { isNormalEmoji } from './emoji.js';
import { Collaboration, decide, err, ok } from '../generated/index.js';

/** A target as JSON carries it (the generated `MarkTarget` without its brands). */
export type MarkTargetData =
    | { readonly kind: 'Message'; readonly request: string }
    | { readonly kind: 'Turn'; readonly run: string }
    | { readonly kind: 'QuestionOption'; readonly run: string; readonly question: string; readonly option: string }
    | { readonly kind: 'AssumptionChoice'; readonly run: string; readonly assumption: number; readonly alternative?: string };

/** A sign as JSON carries it (the generated `MarkSign` without its brands): the vote, or a reaction's emoji. */
export type MarkSignData = { readonly kind: 'Vote' } | { readonly kind: 'Reaction'; readonly emoji: string };

/** The vote (♡). */
export const VOTE = { kind: 'Vote' } as const satisfies Collaboration.MarkSign;

/** Most different emoji on one message or turn: placing one more is refused (`ReactionLimitReached`). */
export const MAX_REACTION_EMOJI = 20;

/** The `Emoji` primitive's constructor: one emoji, in the form reactions are kept (`./emoji.ts`). */
export const makeEmoji: Collaboration.MakeEmoji = Collaboration.makeEmojiWith({ singleEmoji: isNormalEmoji });

/** One text per sign, equal exactly for equal signs: `Vote`, or the reaction's emoji (the store's column and unique index, the page's maps). */
export const signKey = (sign: MarkSignData): string => (sign.kind === 'Vote' ? 'Vote' : sign.emoji);

/** What the rules read of a run: an `AgentRun`, or its JSON on a page. */
export interface MarkRun {
    readonly id: string;
    readonly state: string;
    readonly input: {
        /** `replyTo`: the run or the message it replied to (only a run is continued). */
        readonly requests: readonly {
            readonly request: string;
            readonly replyTo?: { readonly kind: 'Run'; readonly run: string } | { readonly kind: 'Message' };
        }[];
        readonly answer?: { readonly answerTo: string };
        readonly pick?: { readonly pickOf: string };
    };
    /** Absent for a queued run, and for a run cancelled before it started. */
    readonly baseRevision?: string;
    readonly reply?: {
        readonly questions: readonly { readonly id: string; readonly multiple: boolean; readonly options: readonly { readonly id: string }[] }[];
        readonly assumptions: readonly { readonly alternatives: readonly { readonly id: string }[] }[];
    };
}

/** What a target is looked up in: the session's requests and its runs, in queue order. */
export interface MarkScope {
    readonly requests: readonly { readonly id: string }[];
    readonly runs: readonly MarkRun[];
}

/** One text per target, equal exactly for equal targets: the key of a mark's target (the store's unique index, the page's maps). */
export function markKey(target: MarkTargetData): string {
    switch (target.kind) {
        case 'Message':
            return `message:${target.request}`;
        case 'Turn':
            return `turn:${target.run}`;
        case 'QuestionOption':
            return `option:${target.run}:${target.question}:${target.option}`;
        case 'AssumptionChoice':
            return `assumption:${target.run}:${target.assumption}:${target.alternative ?? ''}`;
    }
}

export const isVoteTarget = (target: MarkTargetData): boolean => target.kind === 'QuestionOption' || target.kind === 'AssumptionChoice';

/** Whether a sign fits a target: the vote on an option or an assumption's choice, a reaction on a message or a turn (`fitsTarget`). */
export const signFits = (target: MarkTargetData, sign: MarkSignData): boolean => (sign.kind === 'Vote') === isVoteTarget(target);

/**
 * Whether a sign may be placed on a target, given the marks placed there (anyone's): a reaction with an emoji already
 * there always, another one while the target has fewer than `MAX_REACTION_EMOJI` different emoji. Votes are not limited.
 */
export function reactionRoom(placed: readonly { readonly sign: MarkSignData }[], sign: MarkSignData): boolean {
    if (sign.kind === 'Vote') return true;
    const emoji = new Set(placed.flatMap((m) => (m.sign.kind === 'Reaction' ? [m.sign.emoji] : [])));
    return emoji.has(sign.emoji) || emoji.size < MAX_REACTION_EMOJI;
}

/** Whether a run was cancelled before it started: as if it had never been queued. */
const undone = (run: MarkRun): boolean => run.state === 'Cancelled' && run.baseRevision === undefined;

/**
 * The first run after `run` (in queue order) that answers it, picks one of its alternatives, bundles one of its requests
 * or bundles a reply to it, leaving out runs cancelled before they started: the run that took over its requests (and
 * continues its card), which closes its votes. A pick bundles the run's requests again, so it took over by them too.
 */
export function laterRunOf(run: MarkRun, runs: readonly MarkRun[]): MarkRun | undefined {
    const at = runs.findIndex((r) => r.id === run.id);
    if (at < 0) return undefined;
    const mine = new Set(run.input.requests.map((r) => r.request));
    return runs
        .slice(at + 1)
        .find(
            (r) =>
                !undone(r) &&
                (r.input.answer?.answerTo === run.id ||
                    r.input.pick?.pickOf === run.id ||
                    r.input.requests.some((q) => mine.has(q.request) || (q.replyTo?.kind === 'Run' && q.replyTo.run === run.id))),
        );
}

/** `open`: it can be marked now; `closed`: a vote whose decision was made (frozen); `missing`: not in the session. */
export type MarkStatus = 'open' | 'closed' | 'missing';

/** Whether a target is in the session, and whether its marks can still change (see the module's comment for the rules). */
export function markTargetStatus(target: MarkTargetData, scope: MarkScope): MarkStatus {
    if (target.kind === 'Message') return scope.requests.some((r) => r.id === target.request) ? 'open' : 'missing';
    const run = scope.runs.find((r) => r.id === target.run);
    if (!run) return 'missing';
    switch (target.kind) {
        case 'Turn':
            return 'open';
        case 'QuestionOption': {
            const question = run.reply?.questions.find((q) => q.id === target.question);
            if (!question?.options.some((o) => o.id === target.option)) return 'missing';
            return run.state === 'NeedsClarification' && !laterRunOf(run, scope.runs) ? 'open' : 'closed';
        }
        case 'AssumptionChoice': {
            const assumption = run.reply?.assumptions[target.assumption];
            if (!assumption) return 'missing';
            if (target.alternative !== undefined && !assumption.alternatives.some((a) => a.id === target.alternative)) return 'missing';
            return run.state === 'Completed' && !laterRunOf(run, scope.runs) ? 'open' : 'closed';
        }
    }
}

/**
 * The group in which a participant has at most one vote: a single-choice question, or an assumption (kept, or one of
 * its alternatives). `undefined`: no group (an option of a multiple-choice question, a reaction).
 */
export function exclusiveGroup(target: MarkTargetData, runs: readonly MarkRun[]): string | undefined {
    if (target.kind === 'AssumptionChoice') return `assumption:${target.run}:${target.assumption}`;
    if (target.kind !== 'QuestionOption') return undefined;
    const question = runs.find((r) => r.id === target.run)?.reply?.questions.find((q) => q.id === target.question);
    return question && !question.multiple ? `question:${target.run}:${target.question}` : undefined;
}

/** A mark as the rules read it: whose, on what, with which sign. */
export interface MarkFacts {
    readonly participant: string;
    readonly target: MarkTargetData;
    readonly sign: MarkSignData;
}

/**
 * What setting one mark of a participant (`want`: placed or not) changes, given the marks they have placed in the
 * session: whether to place it (it is not there yet), and which of their marks to remove — the mark itself when it is
 * taken off, the other votes of its exclusive group when it is placed (the vote moves). Setting a mark to what it is
 * already changes nothing.
 */
export function markChange<M extends MarkFacts>(
    mine: readonly M[],
    target: MarkTargetData,
    sign: MarkSignData,
    want: boolean,
    groupOf: (target: MarkTargetData) => string | undefined,
): { readonly place: boolean; readonly remove: readonly M[] } {
    const key = markKey(target);
    const same = (m: M): boolean => signKey(m.sign) === signKey(sign);
    const existing = mine.filter((m) => same(m) && markKey(m.target) === key);
    if (!want) return { place: false, remove: existing };
    if (existing.length > 0) return { place: false, remove: [] };
    const group = groupOf(target);
    return { place: true, remove: group === undefined ? [] : mine.filter((m) => same(m) && groupOf(m.target) === group) };
}

/** The commands of a mark, checked against the generated contracts as the other aggregates' (`commands.ts`). */
export const markCommands: Collaboration.MarkCommands = {
    place: decide<Collaboration.PlaceMarkDecision>(Collaboration.MarkShape, (params) => {
        switch (Collaboration.checkPlaceMarkRequires(params)) {
            case 'fitsTarget':
                return err({ type: 'MarkNotForTarget' });
            case 'participantsVote':
                return err({ type: 'FacilitatorDoesNotVote' });
        }
        const { id, session, participant, target, sign, placedAt } = params;
        return ok({
            Placed: {
                set: { id, session, participant, target, sign, placedAt },
                events: { MarkPlaced: { type: 'MarkPlaced', markId: id, session, participant, target, sign, placedAt } },
            },
        });
    }),

    remove: decide<Collaboration.RemoveMarkDecision>(Collaboration.MarkShape, {
        Placed: (mark, { removedAt }) =>
            ok({
                Removed: {
                    set: { removedAt },
                    events: {
                        MarkRemoved: { type: 'MarkRemoved', markId: mark.id, participant: mark.participant, target: mark.target, sign: mark.sign, removedAt },
                    },
                },
            }),
    }),
};
