// The interviews of the `/` commands (the plan's "`/` commands: ways of working with the AI", round 5): `/es:start`
// starts an event storming, `/model:start` the modeling of a context. The AI (the answerer role, read-only) asks one question at a time
// and ends with a brief — four or five lines with conventional heads — that the facilitator confirms (as is or edited:
// for an interview a participant started, that is the approval) or rejects, or its starter drops; confirmed, a run writes
// it as the `///` description right above the `storming` or the `context`.
// While an interview runs, its starter's messages go to it without triage (`interviewOf` in the use cases).
//
// Here: the commands' decisions, the stable English IDs of the commands, the interviewer's output (a question or a
// brief: AI output, untrusted, validated against its shape and limits before anything is kept, as the answerer's), and
// which messages make up an interview's transcript. Pure.
import { Collaboration, decide, err, ok, type Result } from '../generated/index.js';
import { isAi } from './ai.js';

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
    /** A question's choices: at least two to show any, at most six, each one short line. */
    minChoices: 2,
    maxChoices: 6,
    choice: 40,
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

/** A line of the brief as the interviewer writes it: a head (目的) and its text. */
export interface BriefLine {
    readonly head: string;
    readonly text: string;
}

/** The brief as the interviewer writes it (`readInterviewerReply`). */
export interface BriefData {
    readonly name: string;
    readonly label?: string;
    readonly isNew: boolean;
    readonly replaces: boolean;
    readonly lines: readonly BriefLine[];
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
 * A brief's text as the person edits it (or as written from the interviewer's lines): one line or more, at most
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

/** The interviewer's brief (`{ name, label?, isNew, replaces, lines }`), validated. */
export function readBrief(raw: unknown, path: string): Result<Collaboration.InterviewBrief, InterviewProblem> {
    if (!isObject(raw)) return err({ path, message: 'Expected an object.' });
    const unknown = extra(raw, ['name', 'label', 'isNew', 'replaces', 'lines'], path);
    if (unknown) return err(unknown);
    const name = typeof raw.name === 'string' ? Collaboration.makeBriefName(raw.name.trim()) : undefined;
    if (!name?.ok) return err({ path: `${path}.name`, message: 'Expected an identifier (letters, digits and _, not starting with a digit).' });
    let label: Collaboration.BriefLabel | undefined;
    if (raw.label !== undefined) {
        const l = oneLine(raw.label, `${path}.label`, INTERVIEW_LIMITS.label);
        if (!l.ok) return l;
        const made = Collaboration.makeBriefLabel(l.value);
        if (!made.ok) return err({ path: `${path}.label`, message: 'Not a label.' });
        label = made.value;
    }
    if (typeof raw.isNew !== 'boolean') return err({ path: `${path}.isNew`, message: 'Expected a boolean.' });
    if (typeof raw.replaces !== 'boolean') return err({ path: `${path}.replaces`, message: 'Expected a boolean.' });
    if (!Array.isArray(raw.lines) || raw.lines.length < INTERVIEW_LIMITS.minLines || raw.lines.length > INTERVIEW_LIMITS.maxLines)
        return err({ path: `${path}.lines`, message: `Expected ${INTERVIEW_LIMITS.minLines} to ${INTERVIEW_LIMITS.maxLines} lines.` });
    const lines: BriefLine[] = [];
    for (const [i, l] of raw.lines.entries()) {
        const at = `${path}.lines[${i}]`;
        if (!isObject(l)) return err({ path: at, message: 'Expected an object.' });
        const unknownLine = extra(l, ['head', 'text'], at);
        if (unknownLine) return err(unknownLine);
        const head = oneLine(l.head, `${at}.head`, INTERVIEW_LIMITS.head);
        if (!head.ok) return head;
        if (/[:：]/u.test(head.value)) return err({ path: `${at}.head`, message: 'A head has no colon.' });
        const text = oneLine(l.text, `${at}.text`, INTERVIEW_LIMITS.line);
        if (!text.ok) return text;
        lines.push({ head: head.value, text: text.value });
    }
    const text = readBriefText(briefText(lines), `${path}.lines`);
    if (!text.ok) return text;
    return ok({
        name: name.value,
        ...(label !== undefined && { label }),
        // a new one keeps no description to replace
        isNew: raw.isNew,
        replaces: !raw.isNew && raw.replaces,
        text: text.value,
    });
}

/** Every control character (a choice is one line): what `readChoices` turns into spaces. */
// oxlint-disable-next-line no-control-regex -- control characters are what it finds
const CONTROLS = /[\u0000-\u001f\u007f]+/gu;

/**
 * A question's choices as the interviewer writes them, cleaned rather than refused (they only help the person answer):
 * what is not a string or is blank is dropped, each one is put on one line, trimmed and cut to
 * `INTERVIEW_LIMITS.choice` characters (`…` at the end), the second of two alike (case aside) is dropped, and at most
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
        const cut = line.length > INTERVIEW_LIMITS.choice ? `${line.slice(0, INTERVIEW_LIMITS.choice - 1).trimEnd()}…` : line;
        const key = cut.toLowerCase();
        if (seen.has(key)) continue;
        const made = Collaboration.makeAnswerChoice(cut);
        if (!made.ok) continue;
        seen.add(key);
        out.push(made.value);
    }
    return out.length >= INTERVIEW_LIMITS.minChoices ? out : [];
}

/** The interviewer's JSON (`{ kind: 'question', question, choices?, multiple? }` or `{ kind: 'brief', brief }`), validated. */
export function readInterviewerReply(raw: unknown): Result<InterviewerReply, InterviewProblem> {
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
            const brief = readBrief(raw.brief, 'reply.brief');
            return brief.ok ? ok({ kind: 'brief', brief: brief.value }) : brief;
        }
        default:
            return err({ path: 'reply.kind', message: 'Expected question or brief.' });
    }
}

/** A brief as the interviewer sends it again (the agent validates, the server reads it again): its lines from its text. */
export function briefData(brief: Collaboration.InterviewBrief): BriefData {
    return {
        name: brief.name,
        ...(brief.label !== undefined && { label: brief.label }),
        isNew: brief.isNew,
        replaces: brief.replaces,
        lines: briefLines(brief.text).map((l) => ({ head: l.head ?? '-', text: l.text })),
    };
}

/** The JSON schema of the interviewer's reply (one object with a `kind` and its field). */
export function interviewerJsonSchema(): Record<string, unknown> {
    return {
        type: 'object',
        properties: {
            kind: { type: 'string', enum: ['question', 'brief'] },
            question: { type: 'string', minLength: 1, maxLength: INTERVIEW_LIMITS.question },
            choices: {
                type: 'array',
                maxItems: INTERVIEW_LIMITS.maxChoices,
                items: { type: 'string', minLength: 1, maxLength: INTERVIEW_LIMITS.choice },
            },
            multiple: { type: 'boolean' },
            brief: {
                type: 'object',
                properties: {
                    name: { type: 'string', pattern: '^[_a-zA-Z][A-Za-z0-9_]*$', maxLength: 100 },
                    label: { type: 'string', minLength: 1, maxLength: INTERVIEW_LIMITS.label },
                    isNew: { type: 'boolean' },
                    replaces: { type: 'boolean' },
                    lines: {
                        type: 'array',
                        minItems: INTERVIEW_LIMITS.minLines,
                        maxItems: INTERVIEW_LIMITS.maxLines,
                        items: {
                            type: 'object',
                            properties: {
                                head: { type: 'string', minLength: 1, maxLength: INTERVIEW_LIMITS.head },
                                text: { type: 'string', minLength: 1, maxLength: INTERVIEW_LIMITS.line },
                            },
                            required: ['head', 'text'],
                            additionalProperties: false,
                        },
                    },
                },
                required: ['name', 'isNew', 'replaces', 'lines'],
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
            if (Collaboration.checkAskInterviewRequires(interview, params) === 'stillAwaited') return err({ type: 'InterviewMovedOn' });
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
            if (Collaboration.checkSummarizeInterviewRequires(interview, params) === 'stillAwaited') return err({ type: 'InterviewMovedOn' });
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
            if (Collaboration.checkConfirmInterviewRequires(interview, params) === 'facilitatorConfirms') return err({ type: 'FacilitatorOnly' });
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
            if (Collaboration.checkRejectInterviewRequires(interview, params) === 'facilitatorRejects') return err({ type: 'FacilitatorOnly' });
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
    if (Collaboration.checkStopInterviewRequires(interview, params) === 'starterOrFacilitatorStops') return err({ type: 'NotTheInterviewer' });
    const { stoppedBy, stoppedAt } = params;
    return ok({
        Stopped: {
            set: { stoppedBy, stoppedAt },
            events: { InterviewStopped: { type: 'InterviewStopped', interviewId: interview.id, stoppedBy, stoppedAt } },
        },
    });
}
