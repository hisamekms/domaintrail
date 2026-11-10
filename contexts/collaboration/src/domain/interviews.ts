// The interviews of the `/` commands (the plan's "`/` commands: ways of working with the AI", round 5, and "The current
// journey, and how journeys begin"): `/es:start` starts or revises a storming's ES journey, `/model:start` continues a
// modeling journey or starts a new one. The AI (the answerer role, read-only) asks one question at a time and ends with
// a brief — the journey's why (purpose, scope, constraints, participants as roles) and how far (the ES level and use;
// the pattern, goal and subject) — that the facilitator confirms (as is or with its why edited: for an interview a
// participant started, that is the approval) or rejects, or its starter drops; confirmed, dt writes it into the journey
// file (`journey.ts`), and only a new storming takes a run, to create its `storming` block.
// While an interview runs, its starter's messages go to it without triage (`interviewOf` in the use cases).
//
// Here: the commands' decisions, the stable English IDs of the commands, the interviewer's output (a question or a
// brief: AI output, untrusted, validated against its shape and limits before anything is kept, as the answerer's), and
// which messages make up an interview's transcript. Pure.
import { Collaboration, decide, err, ok, type Result } from '../generated/index.js';
import { isAi } from './ai.js';
import { GUIDE_PATTERNS, MODEL_PATTERNS, PATTERN_SUBJECT, type EsGoalLevel } from './guide-paths.js';
import { JOURNEY_ID, journeyIdFor, type JourneyUse } from './journey.js';

/** The commands' stable IDs (what one types after `/`), and the commands they are. */
export const INTERVIEW_COMMANDS = { 'es:start': 'Es', 'model:start': 'Model' } as const satisfies Record<string, Collaboration.InterviewCommand>;

export type InterviewCommandId = keyof typeof INTERVIEW_COMMANDS;

/** Whether a string is an interview's ID (`es:start`, `model:start`). */
export const isInterviewCommandId = (id: string): id is InterviewCommandId => Object.hasOwn(INTERVIEW_COMMANDS, id);

/** The IDs before the ES commands had a prefix (`/es`, `/model`), still read on the wire. */
const LEGACY_INTERVIEW_IDS: Readonly<Record<string, InterviewCommandId>> = { es: 'es:start', model: 'model:start' };

/** The command an ID names (`es:start`, `model:start`, or the former `es`, `model`); undefined for any other. */
export function interviewCommandOf(id: unknown): Collaboration.InterviewCommand | undefined {
    if (typeof id !== 'string') return undefined;
    const current = Object.hasOwn(LEGACY_INTERVIEW_IDS, id) ? LEGACY_INTERVIEW_IDS[id] : id;
    return Object.entries(INTERVIEW_COMMANDS).find(([k]) => k === current)?.[1];
}

/** The ID of a command (`es:start`, `model:start`). */
export const commandId = (command: Collaboration.InterviewCommand): InterviewCommandId => (command === 'Es' ? 'es:start' : 'model:start');

/** The UI languages on the wire (`ja`, `en`), and the model's. */
export const UI_LANGUAGES = { ja: 'Ja', en: 'En' } as const satisfies Record<string, Collaboration.UiLanguage>;

/** The limits of what the interviewer writes, and of a brief as the person edits it. */
export const INTERVIEW_LIMITS = {
    /** One question (with a short lead-in, at most a few lines). */
    question: 600,
    /** The brief's lines: at least three, at most six (four or five is the aim). */
    minLines: 3,
    maxLines: 6,
    /** A line's head (目的, 範囲 …) and its text. */
    head: 20,
    line: 240,
    /** The whole brief as text (also as the person edits it), the `BriefText` primitive's bound. */
    text: 1500,
    /** A new storming's or context's label. */
    label: 100,
    /**
     * A question's choices: at least two to show any, at most six, each one short line — `choice` characters as the page
     * shows it (an element reference by its name), `choiceWritten` as written (its references `@{…}` in full).
     */
    minChoices: 2,
    maxChoices: 6,
    choice: 40,
    choiceWritten: 200,
} as const;

/** Whether an interview is still running: asking, or its brief waiting to be confirmed. */
export const isRunning = (i: Collaboration.Interview): i is Collaboration.AskingInterview | Collaboration.BriefedInterview =>
    i.state === 'Asking' || i.state === 'Briefed';

/** The interview running in a session, if any (at most one). */
export function runningInterview(interviews: readonly Collaboration.Interview[]): Collaboration.AskingInterview | Collaboration.BriefedInterview | undefined {
    return interviews.find(isRunning);
}

/** The message an interview waits for the interviewer to answer: its job is due (none once it asked or briefed). */
export const awaitedMessage = (i: Collaboration.Interview): Collaboration.RequestId | undefined => (i.state === 'Asking' ? i.awaiting : undefined);

/** When an interview ended (confirmed, stopped or rejected), if it did. */
function endedAt(i: Collaboration.Interview): Date | undefined {
    if (i.state === 'Confirmed') return i.confirmedAt;
    if (i.state === 'Stopped') return i.stoppedAt;
    if (i.state === 'Rejected') return i.rejectedAt;
    return undefined;
}

/**
 * The messages of an interview, in order: its opening, its starter's messages while it ran, and the AI's messages
 * that answer one of those (the questions). Other people's messages meanwhile are not part of it.
 */
export function interviewMessages(interview: Collaboration.Interview, requests: readonly Collaboration.Request[]): Collaboration.Request[] {
    const end = endedAt(interview);
    const start = requests.findIndex((r) => r.id === interview.opening);
    if (start < 0) return [];
    const ids = new Set<string>();
    const out: Collaboration.Request[] = [];
    for (const r of requests.slice(start)) {
        if (end && r.sentAt > end) break;
        const ofStarter = r.author === interview.startedBy;
        const question = isAi(r.author) && r.replyTo?.kind === 'Message' && ids.has(r.replyTo.request);
        if (!ofStarter && !question) continue;
        ids.add(r.id);
        out.push(r);
    }
    return out;
}

/** A line of the brief as the text shows it: a head (目的) and its text. */
export interface BriefLine {
    readonly head: string;
    readonly text: string;
}

/** The brief's journey as the interviewer writes it (and the wire carries it). */
export interface JourneyBriefData {
    readonly purpose: string;
    readonly scope?: string;
    readonly constraints?: string;
    readonly participants: readonly string[];
    /** `/es:start`: what the result is for, how far. */
    readonly use?: JourneyUse;
    readonly level?: EsGoalLevel;
    /** `/model:start`: the journey's name (a new one), the pattern, its goal and subject. */
    readonly name?: string;
    readonly pattern?: Collaboration.GuidePattern;
    readonly goal?: string;
    readonly stormings?: readonly string[];
    readonly context?: string;
}

/** The brief as the interviewer writes it (`readInterviewerReply`). */
export interface BriefData {
    /** `/es:start`: the storming's ID; `/model:start`: the journey's ID when it continues one (a new one's is derived). */
    readonly name?: string;
    readonly label?: string;
    readonly isNew: boolean;
    /** `/es:start`, a new storming: its short description (`///`, one line). */
    readonly description?: string;
    readonly journey: JourneyBriefData;
}

/** What the brief is read for: the interview's command (what its journey holds) and language (the heads of its text). */
export interface BriefContext {
    readonly command: Collaboration.InterviewCommand;
    readonly language: Collaboration.UiLanguage;
}

/**
 * The interviewer's reply to an interview job: the next question (with its choices, none when it has no natural
 * candidates; `multiple` when several of them make one answer), or the brief.
 */
export type InterviewerReply =
    | {
          readonly kind: 'question';
          readonly question: string;
          readonly choices: readonly Collaboration.AnswerChoice[];
          readonly multiple: boolean;
      }
    | { readonly kind: 'brief'; readonly brief: Collaboration.InterviewBrief };

/** What went wrong reading the interviewer's output (or a brief edited on the page): where, and what. */
export interface InterviewProblem {
    readonly path: string;
    readonly message: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Control characters other than the line feed (the brief has lines). */
// oxlint-disable-next-line no-control-regex -- control characters are what it finds
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/u;

function extra(v: Record<string, unknown>, keys: readonly string[], path: string): InterviewProblem | undefined {
    const k = Object.keys(v).find((x) => !keys.includes(x));
    return k === undefined ? undefined : { path: `${path}.${k}`, message: 'Unknown field.' };
}

/** A non-blank string on one line within `max` characters, trimmed. */
function oneLine(v: unknown, path: string, max: number): Result<string, InterviewProblem> {
    if (typeof v !== 'string' || !v.trim()) return err({ path, message: 'Expected a non-empty string.' });
    const t = v.trim();
    if (t.length > max) return err({ path, message: `At most ${max} characters.` });
    if (/[\n\r]/u.test(t) || CONTROL.test(t)) return err({ path, message: 'One line, no control characters.' });
    return ok(t);
}

/**
 * A brief's text as the person edits it (or as written from the journey's why): one line or more, at most
 * `INTERVIEW_LIMITS.maxLines + 2` non-blank lines (a little room to add one), each at most `head + line` characters,
 * the whole within `INTERVIEW_LIMITS.text`. Blank lines and the lines' ends are trimmed.
 */
export function readBriefText(v: unknown, path: string): Result<Collaboration.BriefText, InterviewProblem> {
    if (typeof v !== 'string') return err({ path, message: 'Expected a string.' });
    const lines = v
        .split(/\r?\n/u)
        .map((l) => l.trim())
        .filter((l) => l !== '');
    if (lines.length === 0) return err({ path, message: 'Expected at least one line.' });
    if (lines.length > INTERVIEW_LIMITS.maxLines + 2) return err({ path, message: `At most ${INTERVIEW_LIMITS.maxLines + 2} lines.` });
    const long = lines.findIndex((l) => l.length > INTERVIEW_LIMITS.head + 2 + INTERVIEW_LIMITS.line);
    if (long >= 0) return err({ path: `${path}[${long}]`, message: `A line is at most ${INTERVIEW_LIMITS.head + 2 + INTERVIEW_LIMITS.line} characters.` });
    const text = lines.join('\n');
    if (CONTROL.test(text)) return err({ path, message: 'No control characters.' });
    if (text.length > INTERVIEW_LIMITS.text) return err({ path, message: `At most ${INTERVIEW_LIMITS.text} characters.` });
    const made = Collaboration.makeBriefText(text);
    return made.ok ? ok(made.value) : err({ path, message: 'Not a brief.' });
}

/** The brief's lines as its text: `head: text`, one per line. */
export const briefText = (lines: readonly BriefLine[]): string => lines.map((l) => `${l.head}: ${l.text}`).join('\n');

/** A brief's text split into its lines: the head before the first `:` or `：` (short), else no head. */
export function briefLines(text: string): readonly { readonly head?: string; readonly text: string }[] {
    return text
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => {
            const m = /^([^:：]{1,20})[:：]\s*(.*)$/u.exec(l.trim());
            return m ? { head: m[1].trim(), text: m[2] } : { text: l.trim() };
        });
}

/** An identifier in kebab case (`ConvenienceStoreIssuance` → `convenience-store-issuance`). */
const kebab = (id: string): string =>
    id
        .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
        .replace(/_+/gu, '-')
        .toLowerCase();

/** The heads of the why's lines in the brief's text, per language: what the card shows and the person edits. */
export const BRIEF_HEADS: Readonly<
    Record<Collaboration.UiLanguage, { readonly purpose: string; readonly scope: string; readonly constraints: string; readonly participants: string }>
> = {
    Ja: { purpose: '目的', scope: '範囲', constraints: '制約', participants: '参加者' },
    En: { purpose: 'Purpose', scope: 'Scope', constraints: 'Constraints', participants: 'Participants' },
};

/** The roles in a participants line (「窓口担当、システム担当」, "clerk, IT"). */
const rolesOf = (line: string): string[] =>
    line
        .split(/[、,，/／・]/u)
        .map((r) => r.trim())
        .filter((r) => r !== '');

/** The journey's why as the brief's text: purpose, scope, constraints, participants, each on its line under its head. */
export function journeyBriefText(j: Pick<JourneyBriefData, 'purpose' | 'scope' | 'constraints' | 'participants'>, language: Collaboration.UiLanguage): string {
    const h = BRIEF_HEADS[language];
    return briefText([
        { head: h.purpose, text: j.purpose },
        ...(j.scope !== undefined ? [{ head: h.scope, text: j.scope }] : []),
        ...(j.constraints !== undefined ? [{ head: h.constraints, text: j.constraints }] : []),
        ...(j.participants.length > 0 ? [{ head: h.participants, text: j.participants.join(language === 'Ja' ? '、' : ', ') }] : []),
    ]);
}

const field = (v: string, path: string): Result<Collaboration.BriefField, InterviewProblem> => {
    const made = Collaboration.makeBriefField(v);
    return made.ok ? ok(made.value) : err({ path, message: `At most ${INTERVIEW_LIMITS.line} characters.` });
};

const roles = (vs: readonly string[], path: string): Result<Collaboration.RoleName[], InterviewProblem> => {
    const out: Collaboration.RoleName[] = [];
    for (const [i, v] of vs.entries()) {
        const made = Collaboration.makeRoleName(v);
        if (!made.ok) return err({ path: `${path}[${i}]`, message: 'A role: one short line (at most 60 characters).' });
        if (!out.includes(made.value)) out.push(made.value);
    }
    return out.length > 12 ? err({ path, message: 'At most 12 roles.' }) : ok(out);
};

/**
 * A brief with its text edited by the person: the why's lines read back by their heads (either language's), the rest
 * of the journey kept. A line without a known head is refused, so that nothing typed is silently lost.
 */
export function withEditedText(brief: Collaboration.InterviewBrief, text: Collaboration.BriefText): Result<Collaboration.InterviewBrief, InterviewProblem> {
    const j = brief.journey;
    if (!j) return ok({ ...brief, text });
    const heads = (k: keyof (typeof BRIEF_HEADS)['Ja']): string[] => [BRIEF_HEADS.Ja[k], BRIEF_HEADS.En[k]].map((h) => h.toLowerCase());
    let purpose: string | undefined;
    let scope: string | undefined;
    let constraints: string | undefined;
    let participants: string[] = [];
    for (const [i, l] of briefLines(text).entries()) {
        const head = l.head?.toLowerCase();
        const t = l.text.trim();
        if (head !== undefined && heads('purpose').includes(head)) purpose = t;
        else if (head !== undefined && heads('scope').includes(head)) scope = t || undefined;
        else if (head !== undefined && heads('constraints').includes(head)) constraints = t || undefined;
        else if (head !== undefined && heads('participants').includes(head)) participants = rolesOf(t);
        else
            return err({
                path: `text[${i}]`,
                message: `Start each line with ${Object.values(BRIEF_HEADS.Ja).join(' / ')} (or ${Object.values(BRIEF_HEADS.En).join(' / ')}).`,
            });
    }
    if (!purpose) return err({ path: 'text', message: `The ${BRIEF_HEADS.Ja.purpose} / ${BRIEF_HEADS.En.purpose} line is required.` });
    const p = field(purpose, 'text');
    if (!p.ok) return p;
    const s = scope === undefined ? undefined : field(scope, 'text');
    if (s && !s.ok) return s;
    const c = constraints === undefined ? undefined : field(constraints, 'text');
    if (c && !c.ok) return c;
    const r = roles(participants, 'text');
    if (!r.ok) return r;
    const { scope: _s, constraints: _c, ...rest } = j;
    const journey: Collaboration.JourneyBrief = {
        ...rest,
        purpose: p.value,
        ...(s?.ok && { scope: s.value }),
        ...(c?.ok && { constraints: c.value }),
        participants: r.value,
    };
    return ok({ ...brief, journey, text });
}

const BRIEF_JOURNEY_KEYS = ['purpose', 'scope', 'constraints', 'participants', 'use', 'level', 'name', 'pattern', 'goal', 'stormings', 'context'];

/** The brief's journey as the interviewer writes it, validated for the command. */
function readJourneyBrief(raw: unknown, path: string, ctx: BriefContext, isNew: boolean): Result<Collaboration.JourneyBrief, InterviewProblem> {
    if (!isObject(raw)) return err({ path, message: 'Expected an object.' });
    const unknown = extra(raw, BRIEF_JOURNEY_KEYS, path);
    if (unknown) return err(unknown);
    const text = (k: string, required: boolean): Result<string | undefined, InterviewProblem> =>
        raw[k] === undefined && !required ? ok(undefined) : oneLine(raw[k], `${path}.${k}`, INTERVIEW_LIMITS.line);
    const purpose = text('purpose', true);
    if (!purpose.ok) return purpose;
    const p = field(purpose.value ?? '', `${path}.purpose`);
    if (!p.ok) return p;
    const optional = (k: string): Result<Collaboration.BriefField | undefined, InterviewProblem> => {
        const read = text(k, false);
        if (!read.ok) return read;
        return read.value === undefined ? ok(undefined) : field(read.value, `${path}.${k}`);
    };
    const scope = optional('scope');
    if (!scope.ok) return scope;
    const constraints = optional('constraints');
    if (!constraints.ok) return constraints;
    if (raw.participants !== undefined && (!Array.isArray(raw.participants) || raw.participants.some((x) => typeof x !== 'string')))
        return err({ path: `${path}.participants`, message: 'Expected an array of roles.' });
    const r = roles(
        ((raw.participants as string[] | undefined) ?? []).map((x) => x.trim()).filter((x) => x !== ''),
        `${path}.participants`,
    );
    if (!r.ok) return r;
    const base = {
        purpose: p.value,
        ...(scope.value !== undefined && { scope: scope.value }),
        ...(constraints.value !== undefined && { constraints: constraints.value }),
        participants: r.value,
        stormings: [],
        continues: false,
    };
    if (ctx.command === 'Es') {
        if (raw.use !== 'align' && raw.use !== 'modeling') return err({ path: `${path}.use`, message: 'Expected align or modeling.' });
        if (raw.level !== 'BigPicture' && raw.level !== 'DesignLevel') return err({ path: `${path}.level`, message: 'Expected BigPicture or DesignLevel.' });
        for (const k of ['name', 'pattern', 'goal', 'stormings', 'context'])
            if (raw[k] !== undefined) return err({ path: `${path}.${k}`, message: 'Not for /es:start.' });
        return ok({ ...base, use: raw.use === 'modeling' ? 'Modeling' : 'Align', level: raw.level });
    }
    if (raw.use !== undefined || raw.level !== undefined)
        return err({ path: `${path}.${raw.use !== undefined ? 'use' : 'level'}`, message: 'Not for /model:start.' });
    const pattern = GUIDE_PATTERNS.find((x) => x === raw.pattern);
    if (!pattern) return err({ path: `${path}.pattern`, message: `Expected one of ${GUIDE_PATTERNS.join(', ')}.` });
    const goals = MODEL_PATTERNS[pattern].goals;
    if (raw.goal !== undefined && (typeof raw.goal !== 'string' || !goals.includes(raw.goal)))
        return err({ path: `${path}.goal`, message: `${pattern}'s goals: ${goals.join(', ')}.` });
    const goal = typeof raw.goal === 'string' ? Collaboration.makeGuideStepKey(raw.goal) : undefined;
    let name: Collaboration.JourneyName | undefined;
    if (raw.name !== undefined || isNew) {
        const n = oneLine(raw.name, `${path}.name`, 100);
        if (!n.ok) return n;
        const made = Collaboration.makeJourneyName(n.value);
        if (!made.ok) return err({ path: `${path}.name`, message: 'A name: one short line.' });
        name = made.value;
    }
    const subject = PATTERN_SUBJECT[pattern];
    let stormings: Collaboration.StormingName[] = [];
    let context: Collaboration.ContextName | undefined;
    if (subject === 'stormings') {
        if (!Array.isArray(raw.stormings) || raw.stormings.length === 0 || raw.stormings.length > 10)
            return err({ path: `${path}.stormings`, message: 'FromStorming: one to ten storming IDs.' });
        for (const [i, x] of raw.stormings.entries()) {
            const made = typeof x === 'string' ? Collaboration.makeStormingName(subjectId(x)) : undefined;
            if (!made?.ok) return err({ path: `${path}.stormings[${i}]`, message: 'A storming ID.' });
            if (!stormings.includes(made.value)) stormings.push(made.value);
        }
    } else if (raw.stormings !== undefined) return err({ path: `${path}.stormings`, message: `Not for ${pattern}.` });
    if (subject === 'context') {
        const made = typeof raw.context === 'string' ? Collaboration.makeContextName(subjectId(raw.context)) : undefined;
        if (!made?.ok) return err({ path: `${path}.context`, message: 'OneContext: the name of its context.' });
        context = made.value;
    } else if (raw.context !== undefined) return err({ path: `${path}.context`, message: `Not for ${pattern}.` });
    return ok({
        ...base,
        pattern,
        ...(goal?.ok && { goal: goal.value }),
        stormings,
        ...(context !== undefined && { context }),
        ...(name !== undefined && { journeyName: name }),
        continues: !isNew,
    });
}

/**
 * The interviewer's brief (`{ name?, label?, isNew, description?, journey }`), validated for the interview's command:
 * `/es:start` names the storming (an identifier; a new one with its label and, optionally, its short description);
 * `/model:start` names the journey it continues (its ID), or, new, gets an ID derived from the journey's name. The text
 * is the journey's why under the language's heads.
 */
export function readBrief(raw: unknown, path: string, ctx: BriefContext): Result<Collaboration.InterviewBrief, InterviewProblem> {
    if (!isObject(raw)) return err({ path, message: 'Expected an object.' });
    const unknown = extra(raw, ['name', 'label', 'isNew', 'description', 'journey', 'replaces'], path);
    if (unknown) return err(unknown);
    if (typeof raw.isNew !== 'boolean') return err({ path: `${path}.isNew`, message: 'Expected a boolean.' });
    const journey = readJourneyBrief(raw.journey, `${path}.journey`, ctx, raw.isNew);
    if (!journey.ok) return journey;
    let label: Collaboration.BriefLabel | undefined;
    if (raw.label !== undefined) {
        const l = oneLine(raw.label, `${path}.label`, INTERVIEW_LIMITS.label);
        if (!l.ok) return l;
        const made = Collaboration.makeBriefLabel(l.value);
        if (!made.ok) return err({ path: `${path}.label`, message: 'Not a label.' });
        label = made.value;
    }
    let description: Collaboration.ShortDescription | undefined;
    if (raw.description !== undefined) {
        const d = oneLine(raw.description, `${path}.description`, 200);
        if (!d.ok) return d;
        const made = Collaboration.makeShortDescription(d.value);
        if (!made.ok) return err({ path: `${path}.description`, message: 'One short line.' });
        description = made.value;
    }
    let nameText: string;
    if (ctx.command === 'Es') {
        if (typeof raw.name !== 'string' || !/^[_a-zA-Z][A-Za-z0-9_]*$/u.test(raw.name.trim()) || raw.name.trim().length > 100)
            return err({ path: `${path}.name`, message: "Expected the storming's ID (letters, digits and _, not starting with a digit)." });
        nameText = raw.name.trim();
    } else if (raw.isNew) {
        // a name with no ASCII word: the ID from its subject (`Billing` → billing, `ConvenienceStoreIssuance` →
        // convenience-store-issuance), else its pattern's
        const subject = journey.value.context ?? journey.value.stormings[0] ?? journey.value.pattern ?? 'journey';
        nameText = journeyIdFor(journey.value.journeyName ?? '', [], kebab(subject));
    } else {
        if (typeof raw.name !== 'string' || !JOURNEY_ID.test(raw.name.trim()))
            return err({ path: `${path}.name`, message: 'Expected the ID of the journey it continues.' });
        nameText = raw.name.trim();
    }
    const name = Collaboration.makeBriefName(nameText);
    if (!name.ok) return err({ path: `${path}.name`, message: 'Not a name.' });
    const text = readBriefText(journeyBriefText({ ...journey.value, participants: journey.value.participants.map(String) }, ctx.language), `${path}.journey`);
    if (!text.ok) return text;
    return ok({
        name: name.value,
        ...(label !== undefined && { label }),
        isNew: raw.isNew,
        // a revised brief replaces the journey's why (the card says so)
        replaces: !raw.isNew,
        text: text.value,
        journey: journey.value,
        ...(description !== undefined && ctx.command === 'Es' && raw.isNew && { description }),
    });
}

/** An element reference as the chat writes it (`@{es:Returns}`, `@{Billing}`): its identifier in the braces. */
const REFERENCE = /@\{([^\n{}@]{1,200})\}/gu;

/** A reference's identifier as the page shows it when it does not resolve: of an `es:` one, its last segment. */
const referenceName = (id: string): string => (id.trim().startsWith('es:') ? (id.trim().slice(3).split('/').at(-1) ?? id) : id).trim();

/**
 * A choice's text in pieces: text, and element references kept whole, each with the length it counts as (a
 * reference by its name: the page shows it by its label, or its name).
 */
function choicePieces(text: string): { readonly text: string; readonly shown: number; readonly reference: boolean }[] {
    const out: { text: string; shown: number; reference: boolean }[] = [];
    let last = 0;
    for (const m of text.matchAll(REFERENCE)) {
        if (m.index > last) out.push({ text: text.slice(last, m.index), shown: m.index - last, reference: false });
        out.push({ text: m[0], shown: referenceName(m[1] ?? '').length, reference: true });
        last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last), shown: text.length - last, reference: false });
    return out;
}

/** A choice's length as the page shows it: its element references by their names. */
function choiceShownLength(text: string): number {
    return choicePieces(text).reduce((n, p) => n + p.shown, 0);
}

/**
 * A choice cut to `INTERVIEW_LIMITS.choice` characters as shown, `…` at the end: text is cut, a reference never (one
 * that does not fit is left out, unless it is the first: the page shows it by its label, shorter than its name).
 */
function cutChoice(text: string): string {
    if (choiceShownLength(text) <= INTERVIEW_LIMITS.choice) return text;
    const pieces = choicePieces(text);
    let out = '';
    let room = INTERVIEW_LIMITS.choice - 1;
    for (const [i, p] of pieces.entries()) {
        if (p.shown <= room || (p.reference && i === 0)) {
            out += p.text;
            room = Math.max(0, room - p.shown);
            continue;
        }
        if (!p.reference) out += p.text.slice(0, room);
        return `${out.trimEnd()}…`;
    }
    // all of it: a first reference that is longer as its name
    return out;
}

/**
 * A brief's subject as an ID: the interviewer's choices name stormings and contexts as references (`@{es:Returns}`,
 * `@{Billing}`), and the brief may repeat one as written: its identifier, of an `es:` one the storming's.
 */
function subjectId(raw: string): string {
    const m = /^@\{\s*(?:es:)?\s*([^{}@\s]+)\s*\}$/u.exec(raw.trim());
    return (m?.[1] ?? raw).trim();
}

/** Every control character (a choice is one line): what `readChoices` turns into spaces. */
// oxlint-disable-next-line no-control-regex -- control characters are what it finds
const CONTROLS = /[\u0000-\u001f\u007f]+/gu;

/**
 * A question's choices as the interviewer writes them, cleaned rather than refused (they only help the person answer):
 * what is not a string or is blank is dropped, each one is put on one line, trimmed and cut to
 * `INTERVIEW_LIMITS.choice` characters as shown (`cutChoice`: an element reference counts as its name, and is never
 * cut), one longer than `INTERVIEW_LIMITS.choiceWritten` as written is dropped, the second of two alike (case aside) is dropped, and at most
 * `INTERVIEW_LIMITS.maxChoices` are kept. Fewer than `INTERVIEW_LIMITS.minChoices` left: none (one is no choice).
 * They are the model's output, shown as text and sent back as the person's answer: never read as instructions.
 */
export function readChoices(raw: unknown): readonly Collaboration.AnswerChoice[] {
    if (!Array.isArray(raw)) return [];
    const out: Collaboration.AnswerChoice[] = [];
    const seen = new Set<string>();
    for (const c of raw) {
        if (out.length >= INTERVIEW_LIMITS.maxChoices) break;
        if (typeof c !== 'string') continue;
        const line = c.replace(CONTROLS, ' ').replace(/\s+/gu, ' ').trim();
        if (!line) continue;
        const cut = cutChoice(line);
        if (cut.length > INTERVIEW_LIMITS.choiceWritten) continue;
        const key = cut.toLowerCase();
        if (seen.has(key)) continue;
        const made = Collaboration.makeAnswerChoice(cut);
        if (!made.ok) continue;
        seen.add(key);
        out.push(made.value);
    }
    return out.length >= INTERVIEW_LIMITS.minChoices ? out : [];
}

/**
 * The interviewer's JSON (`{ kind: 'question', question, choices?, multiple? }` or `{ kind: 'brief', brief }`),
 * validated (a brief for the interview's command and language).
 */
export function readInterviewerReply(raw: unknown, ctx: BriefContext): Result<InterviewerReply, InterviewProblem> {
    if (!isObject(raw)) return err({ path: 'reply', message: 'Expected an object.' });
    switch (raw.kind) {
        case 'question': {
            const unknown = extra(raw, ['kind', 'question', 'choices', 'multiple'], 'reply');
            if (unknown) return err(unknown);
            if (raw.choices !== undefined && !Array.isArray(raw.choices)) return err({ path: 'reply.choices', message: 'Expected an array of strings.' });
            if (raw.multiple !== undefined && typeof raw.multiple !== 'boolean') return err({ path: 'reply.multiple', message: 'Expected a boolean.' });
            if (typeof raw.question !== 'string' || !raw.question.trim()) return err({ path: 'reply.question', message: 'Expected a non-empty string.' });
            const q = raw.question.trim();
            if (q.length > INTERVIEW_LIMITS.question) return err({ path: 'reply.question', message: `At most ${INTERVIEW_LIMITS.question} characters.` });
            if (CONTROL.test(q)) return err({ path: 'reply.question', message: 'No control characters.' });
            const choices = readChoices(raw.choices);
            // several at once only means something with choices to pick
            return ok({ kind: 'question', question: q, choices, multiple: choices.length > 0 && raw.multiple === true });
        }
        case 'brief': {
            const unknown = extra(raw, ['kind', 'brief'], 'reply');
            if (unknown) return err(unknown);
            const brief = readBrief(raw.brief, 'reply.brief', ctx);
            return brief.ok ? ok({ kind: 'brief', brief: brief.value }) : brief;
        }
        default:
            return err({ path: 'reply.kind', message: 'Expected question or brief.' });
    }
}

/** A brief as the interviewer sends it again (the agent validates, the server reads it again): its journey's fields. */
export function briefData(brief: Collaboration.InterviewBrief): BriefData {
    const j = brief.journey;
    const journey: JourneyBriefData = j
        ? {
              purpose: j.purpose,
              ...(j.scope !== undefined && { scope: j.scope }),
              ...(j.constraints !== undefined && { constraints: j.constraints }),
              participants: j.participants,
              ...(j.use !== undefined && { use: j.use === 'Modeling' ? 'modeling' : 'align' }),
              ...(j.level !== undefined && { level: j.level }),
              ...(j.journeyName !== undefined && { name: j.journeyName }),
              ...(j.pattern !== undefined && { pattern: j.pattern }),
              ...(j.goal !== undefined && { goal: j.goal }),
              ...(j.stormings.length > 0 && { stormings: j.stormings }),
              ...(j.context !== undefined && { context: j.context }),
          }
        : { purpose: briefLines(brief.text)[0]?.text ?? brief.text, participants: [] };
    return {
        // a new modeling journey's ID is derived again from its name
        ...(!(j?.journeyName !== undefined && brief.isNew) && { name: brief.name }),
        ...(brief.label !== undefined && { label: brief.label }),
        isNew: brief.isNew,
        ...(brief.description !== undefined && { description: brief.description }),
        journey,
    };
}

/** The JSON schema of the interviewer's reply (one object with a `kind` and its field). */
export function interviewerJsonSchema(): Record<string, unknown> {
    const line = { type: 'string', minLength: 1, maxLength: INTERVIEW_LIMITS.line };
    return {
        type: 'object',
        properties: {
            kind: { type: 'string', enum: ['question', 'brief'] },
            question: { type: 'string', minLength: 1, maxLength: INTERVIEW_LIMITS.question },
            choices: {
                type: 'array',
                maxItems: INTERVIEW_LIMITS.maxChoices,
                items: { type: 'string', minLength: 1, maxLength: INTERVIEW_LIMITS.choiceWritten },
            },
            multiple: { type: 'boolean' },
            brief: {
                type: 'object',
                properties: {
                    name: { type: 'string', pattern: '^[_a-zA-Z0-9][A-Za-z0-9_-]*$', maxLength: 100 },
                    label: { type: 'string', minLength: 1, maxLength: INTERVIEW_LIMITS.label },
                    isNew: { type: 'boolean' },
                    description: { type: 'string', minLength: 1, maxLength: 200 },
                    journey: {
                        type: 'object',
                        properties: {
                            purpose: line,
                            scope: line,
                            constraints: line,
                            participants: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 60 } },
                            use: { type: 'string', enum: ['align', 'modeling'] },
                            level: { type: 'string', enum: ['BigPicture', 'DesignLevel'] },
                            name: { type: 'string', minLength: 1, maxLength: 100 },
                            pattern: { type: 'string', enum: [...GUIDE_PATTERNS] },
                            goal: { type: 'string', enum: [...new Set(Object.values(MODEL_PATTERNS).flatMap((p) => p.goals))] },
                            stormings: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', pattern: '^[_a-zA-Z][A-Za-z0-9_]*$' } },
                            context: { type: 'string', pattern: '^[_a-zA-Z][A-Za-z0-9_]*$' },
                        },
                        required: ['purpose', 'participants'],
                        additionalProperties: false,
                    },
                },
                required: ['isNew', 'journey'],
                additionalProperties: false,
            },
        },
        required: ['kind'],
        additionalProperties: false,
    };
}

export const interviewCommands: Collaboration.InterviewCommands = {
    start: decide<Collaboration.StartInterviewDecision>(Collaboration.InterviewShape, (params) => {
        const { id, command, startedBy, opening, focus, language, startedAt } = params;
        // the session without its evidence: the aggregate stores the base type
        const session: Collaboration.SessionId = params.session;
        return ok({
            Asking: {
                set: { id, session, command, startedBy, opening, focus, language, startedAt, awaiting: opening, asked: undefined },
                events: {
                    InterviewStarted: {
                        type: 'InterviewStarted',
                        interviewId: id,
                        session,
                        command,
                        startedBy,
                        opening,
                        ...(focus && { focus }),
                        language,
                        startedAt,
                    },
                },
            },
        });
    }),

    hear: decide<Collaboration.HearInterviewDecision>(Collaboration.InterviewShape, {
        Asking: (interview, { message, heardAt }) =>
            ok({
                Asking: {
                    set: { awaiting: message, asked: undefined },
                    events: { InterviewAnswered: { type: 'InterviewAnswered', interviewId: interview.id, message, heardAt } },
                },
            }),
        // a word on the brief: it is dropped, and the interviewer takes it from there
        Briefed: (interview, { message, heardAt }) =>
            ok({
                Asking: {
                    set: { awaiting: message, asked: undefined },
                    events: { InterviewAnswered: { type: 'InterviewAnswered', interviewId: interview.id, message, heardAt } },
                },
            }),
    }),

    ask: decide<Collaboration.AskInterviewDecision>(Collaboration.InterviewShape, {
        Asking: (interview, params) => {
            if (Collaboration.checkAskInterviewRequires(interview, params) === 'stillAwaited') return err({ type: 'Collaboration.InterviewMovedOn' });
            const { question, askedAt } = params;
            return ok({
                Asking: {
                    set: { awaiting: undefined, asked: question },
                    events: {
                        InterviewQuestionAsked: {
                            type: 'InterviewQuestionAsked',
                            interviewId: interview.id,
                            question: question.question,
                            choices: question.choices,
                            multiple: question.multiple,
                            askedAt,
                        },
                    },
                },
            });
        },
    }),

    summarize: decide<Collaboration.SummarizeInterviewDecision>(Collaboration.InterviewShape, {
        Asking: (interview, params) => {
            if (Collaboration.checkSummarizeInterviewRequires(interview, params) === 'stillAwaited') return err({ type: 'Collaboration.InterviewMovedOn' });
            const { answered, summary, briefedAt } = params;
            return ok({
                Briefed: {
                    set: { brief: summary, answered, briefedAt },
                    events: { InterviewBriefed: { type: 'InterviewBriefed', interviewId: interview.id, brief: summary, answered, briefedAt } },
                },
            });
        },
    }),

    confirm: decide<Collaboration.ConfirmInterviewDecision>(Collaboration.InterviewShape, {
        Briefed: (interview, params) => {
            if (Collaboration.checkConfirmInterviewRequires(interview, params) === 'facilitatorConfirms') return err({ type: 'Collaboration.FacilitatorOnly' });
            const { confirmedBy, confirmedBrief, edited, run, confirmedAt } = params;
            return ok({
                Confirmed: {
                    set: { brief: confirmedBrief, edited, confirmedBy, run, confirmedAt },
                    events: {
                        InterviewConfirmed: {
                            type: 'InterviewConfirmed',
                            interviewId: interview.id,
                            brief: confirmedBrief,
                            edited,
                            confirmedBy,
                            run,
                            confirmedAt,
                        },
                    },
                },
            });
        },
    }),

    reject: decide<Collaboration.RejectInterviewDecision>(Collaboration.InterviewShape, {
        Briefed: (interview, params) => {
            if (Collaboration.checkRejectInterviewRequires(interview, params) === 'facilitatorRejects') return err({ type: 'Collaboration.FacilitatorOnly' });
            const { rejectedBy, note, rejectedAt } = params;
            return ok({
                Rejected: {
                    set: { rejectedBy, note, rejectedAt },
                    events: { InterviewRejected: { type: 'InterviewRejected', interviewId: interview.id, rejectedBy, ...(note && { note }), rejectedAt } },
                },
            });
        },
    }),

    stop: decide<Collaboration.StopInterviewDecision>(Collaboration.InterviewShape, {
        Asking: (interview, params) => stopped(interview, params),
        Briefed: (interview, params) => stopped(interview, params),
    }),
};

function stopped(
    interview: Collaboration.AskingInterview | Collaboration.BriefedInterview,
    params: Collaboration.StopInterviewParams,
): Result<
    {
        readonly Stopped: {
            readonly set: { readonly stoppedBy: Collaboration.ParticipantId; readonly stoppedAt: Date };
            readonly events: { readonly InterviewStopped: Collaboration.InterviewStopped };
        };
    },
    Collaboration.NotTheInterviewer
> {
    if (Collaboration.checkStopInterviewRequires(interview, params) === 'starterOrFacilitatorStops') return err({ type: 'Collaboration.NotTheInterviewer' });
    const { stoppedBy, stoppedAt } = params;
    return ok({
        Stopped: {
            set: { stoppedBy, stoppedAt },
            events: { InterviewStopped: { type: 'InterviewStopped', interviewId: interview.id, stoppedBy, stoppedAt } },
        },
    });
}
