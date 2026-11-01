// The agent's reply to a run (ADR 0026, appendix "Structured replies"): what the AI says it did, asks or declines, as
// structured data. Its limits are set here and nowhere else: the JSON schema the agent is given, the prompt's
// description of the reply, the validation of the subscriber and of the server, and the page all take them from
// `REPLY_LIMITS`. The reply is untrusted input: it is validated against the shape and the limits before it is kept, and
// shown as plain text. Facts (success, the files changed, `dt fmt`/`dt check`) are never taken from it.
//
// The subscriber may import this module (values, not only types): it is pure, and imports only the generated model.
import { Collaboration, err, ok, type Result } from '../generated/index.js';

/** The limits of a reply, and of the facilitator's answer to it: change one here and every side follows. */
export const REPLY_LIMITS = {
    /** Characters of the summary (1–2 sentences; for a decline, the reason). */
    summary: 300,
    /** Characters of a request's note (required when it is partly done or skipped). */
    requestNote: 200,
    /** Questions of a clarification (at least one). */
    questions: 3,
    /** Characters of a question. */
    questionText: 500,
    /** Options of a question (none: answered in words only). */
    options: 5,
    /** Characters of an option's label. */
    optionLabel: 80,
    /** Characters of an option's detail. */
    optionDetail: 300,
    /** Assumptions the agent made. */
    assumptions: 5,
    /** Characters of an assumption. */
    assumptionText: 300,
    /** Alternatives of an assumption. */
    alternatives: 3,
    /** Characters of an alternative's label. */
    alternativeLabel: 80,
    /** Characters of a question's or an option's key. */
    key: 40,
    /** Characters of the facilitator's own words in an answer. */
    answerText: 500,
} as const;

export const REPLY_OUTCOMES = ['done', 'clarification', 'declined'] as const;
/** How a run ended in the agent's words: carried out, asks first, or will not do it. */
export type ReplyOutcome = (typeof REPLY_OUTCOMES)[number];

export const REQUEST_STATUSES = ['done', 'partial', 'skipped', 'question'] as const;
/** What the agent says it did about one request. */
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

const PROGRESS = { done: 'Done', partial: 'Partial', skipped: 'Skipped', question: 'Question' } as const satisfies Record<
    RequestStatus,
    Collaboration.RequestProgress
>;

/** The pattern of a key (`ReplyKey` of the model). */
const KEY = /^[A-Za-z0-9_-]+$/;

/** A reply as validated, with its requests named by `R`: their number in the prompt, or their ID. */
export interface ReplyData<R> {
    readonly outcome: ReplyOutcome;
    readonly summary: string;
    readonly requests: readonly { readonly request: R; readonly status: RequestStatus; readonly note?: string }[];
    readonly questions: readonly {
        readonly id: string;
        readonly text: string;
        readonly requests: readonly R[];
        readonly options: readonly { readonly id: string; readonly label: string; readonly detail?: string }[];
        readonly multiple: boolean;
    }[];
    readonly assumptions: readonly {
        readonly text: string;
        readonly requests: readonly R[];
        readonly alternatives: readonly { readonly id: string; readonly label: string }[];
    }[];
}

/** Why a reply (or an answer) was refused: where in it, and what is wrong. */
export interface ReplyProblem {
    readonly path: string;
    readonly message: string;
}

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A failure while reading: thrown inside, returned as a `ReplyProblem`. */
class Refused extends Error {
    constructor(
        readonly path: string,
        message: string,
    ) {
        super(message);
    }
}

/** Whether `s` has a control character; tabs and line breaks are allowed when `lines`. */
function hasControl(s: string, lines: boolean): boolean {
    for (let i = 0; i < s.length; i++) {
        const n = s.charCodeAt(i);
        if (lines && (n === 0x09 || n === 0x0a || n === 0x0d)) continue;
        if (n < 0x20 || (n >= 0x7f && n <= 0x9f)) return true;
    }
    return false;
}

/** Text: a string, not blank, at most `max` characters, no control characters (line breaks only when `lines`). Trimmed. */
function text(v: unknown, path: string, max: number, lines = true): string {
    if (typeof v !== 'string' || !v.trim()) throw new Refused(path, 'Expected a non-empty string.');
    const t = v.trim();
    if (t.length > max) throw new Refused(path, `At most ${max} characters.`);
    if (hasControl(t, lines)) throw new Refused(path, 'No control characters.');
    return t;
}

function key(v: unknown, path: string): string {
    if (typeof v !== 'string' || !KEY.test(v) || v.length > REPLY_LIMITS.key)
        throw new Refused(path, `Expected a key of 1 to ${REPLY_LIMITS.key} letters, digits, '_' or '-'.`);
    return v;
}

function list(v: unknown, path: string, max: number): unknown[] {
    if (!Array.isArray(v)) throw new Refused(path, 'Expected an array.');
    if (v.length > max) throw new Refused(path, `At most ${max} items.`);
    return v;
}

/** An object with only `keys` (the schema's `additionalProperties: false`). */
function object(v: unknown, path: string, keys: readonly string[]): Raw {
    if (!isObject(v)) throw new Refused(path, 'Expected an object.');
    const extra = Object.keys(v).find((k) => !keys.includes(k));
    if (extra !== undefined) throw new Refused(`${path}.${extra}`, 'Unknown field.');
    return v;
}

function unique<T>(values: readonly T[], path: string, what: string): void {
    if (new Set(values).size !== values.length) throw new Refused(path, `Each ${what} at most once.`);
}

/** How a reader of requests names one: `undefined` when the value is not one of the run's requests. */
export type RequestReader<R> = (v: unknown) => R | undefined;

/** The requests a question or an assumption is about: optional, each once, each one of the run's. */
function requestList<R>(v: unknown, path: string, request: RequestReader<R>, max: number): R[] {
    if (v === undefined) return [];
    const rs = list(v, path, max).map((x, i) => {
        const r = request(x);
        if (r === undefined) throw new Refused(`${path}[${i}]`, 'Not a request of this run.');
        return r;
    });
    unique(rs, path, 'request');
    return rs;
}

/**
 * A reply validated against the shape and the limits: `outcome`, `summary`, `requests` (each of the run's requests
 * at most once, a note for partial and skipped), `questions` (1 to `questions` for a clarification, none otherwise),
 * `assumptions`. Unknown fields are refused. `request` reads a request reference (a number in the prompt, or an ID);
 * `maxRequests` is how many the run has.
 */
export function readReply<R>(raw: unknown, request: RequestReader<R>, maxRequests: number): Result<ReplyData<R>, ReplyProblem> {
    try {
        return ok(readOrThrow(raw, request, maxRequests));
    } catch (e) {
        if (e instanceof Refused) return err({ path: e.path, message: e.message });
        throw e;
    }
}

function readOrThrow<R>(raw: unknown, request: RequestReader<R>, maxRequests: number): ReplyData<R> {
    const L = REPLY_LIMITS;
    const v = object(raw, 'reply', ['outcome', 'summary', 'requests', 'questions', 'assumptions']);
    const outcome = REPLY_OUTCOMES.find((o) => o === v.outcome);
    if (!outcome) throw new Refused('reply.outcome', `Expected one of ${REPLY_OUTCOMES.join(', ')}.`);
    const summary = text(v.summary, 'reply.summary', L.summary);
    const requests = list(v.requests, 'reply.requests', maxRequests).map((x, i) => {
        const p = `reply.requests[${i}]`;
        const o = object(x, p, ['request', 'status', 'note']);
        const r = request(o.request);
        if (r === undefined) throw new Refused(`${p}.request`, 'Not a request of this run.');
        const status = REQUEST_STATUSES.find((s) => s === o.status);
        if (!status) throw new Refused(`${p}.status`, `Expected one of ${REQUEST_STATUSES.join(', ')}.`);
        const note = o.note === undefined ? undefined : text(o.note, `${p}.note`, L.requestNote);
        if ((status === 'partial' || status === 'skipped') && note === undefined) throw new Refused(`${p}.note`, `A note is required when ${status}.`);
        return { request: r, status, ...(note !== undefined && { note }) };
    });
    unique(
        requests.map((r) => r.request),
        'reply.requests',
        'request',
    );
    const questions = (v.questions === undefined ? [] : list(v.questions, 'reply.questions', L.questions)).map((x, i) => {
        const p = `reply.questions[${i}]`;
        const o = object(x, p, ['id', 'text', 'requests', 'options', 'multiple']);
        const options = list(o.options, `${p}.options`, L.options).map((y, j) => {
            const q = `${p}.options[${j}]`;
            const opt = object(y, q, ['id', 'label', 'detail']);
            const detail = opt.detail === undefined ? undefined : text(opt.detail, `${q}.detail`, L.optionDetail);
            return { id: key(opt.id, `${q}.id`), label: text(opt.label, `${q}.label`, L.optionLabel, false), ...(detail !== undefined && { detail }) };
        });
        unique(
            options.map((o) => o.id),
            `${p}.options`,
            'option id',
        );
        if (typeof o.multiple !== 'boolean') throw new Refused(`${p}.multiple`, 'Expected true or false.');
        return {
            id: key(o.id, `${p}.id`),
            text: text(o.text, `${p}.text`, L.questionText),
            requests: requestList(o.requests, `${p}.requests`, request, maxRequests),
            options,
            multiple: o.multiple,
        };
    });
    unique(
        questions.map((q) => q.id),
        'reply.questions',
        'question id',
    );
    if (outcome === 'clarification' && questions.length === 0) throw new Refused('reply.questions', 'A clarification asks at least one question.');
    if (outcome !== 'clarification' && questions.length > 0) throw new Refused('reply.questions', `Only a clarification asks questions, not ${outcome}.`);
    const assumptions = (v.assumptions === undefined ? [] : list(v.assumptions, 'reply.assumptions', L.assumptions)).map((x, i) => {
        const p = `reply.assumptions[${i}]`;
        const o = object(x, p, ['text', 'requests', 'alternatives']);
        const alternatives = (o.alternatives === undefined ? [] : list(o.alternatives, `${p}.alternatives`, L.alternatives)).map((y, j) => {
            const q = `${p}.alternatives[${j}]`;
            const alt = object(y, q, ['id', 'label']);
            return { id: key(alt.id, `${q}.id`), label: text(alt.label, `${q}.label`, L.alternativeLabel, false) };
        });
        unique(
            alternatives.map((a) => a.id),
            `${p}.alternatives`,
            'alternative id',
        );
        return { text: text(o.text, `${p}.text`, L.assumptionText), requests: requestList(o.requests, `${p}.requests`, request, maxRequests), alternatives };
    });
    return { outcome, summary, requests, questions, assumptions };
}

/** A reader of request numbers as the prompt numbers them: 1 to `count`. */
export const requestNumber =
    (count: number): RequestReader<number> =>
    (v) =>
        typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= count ? v : undefined;

/** The reply with its requests named otherwise (numbers in the prompt → IDs). */
export function mapRequests<R, S>(reply: ReplyData<R>, f: (r: R) => S): ReplyData<S> {
    return {
        ...reply,
        requests: reply.requests.map((r) => ({ ...r, request: f(r.request) })),
        questions: reply.questions.map((q) => ({ ...q, requests: q.requests.map(f) })),
        assumptions: reply.assumptions.map((a) => ({ ...a, requests: a.requests.map(f) })),
    };
}

/** The questions of a reply as plain text, one per line (what a run that needs clarification shows without structure). */
export const plainQuestion = (reply: Pick<ReplyData<unknown>, 'questions'>): string => reply.questions.map((q) => q.text).join('\n');

/**
 * The JSON schema of the reply the agent returns (`claude --json-schema`), from the limits; `requests` is how many the
 * run has (they are numbered from 1 in the prompt).
 */
export function replyJsonSchema(requests: number): Record<string, unknown> {
    const L = REPLY_LIMITS;
    const str = (maxLength: number): Record<string, unknown> => ({ type: 'string', minLength: 1, maxLength });
    const keyed = { type: 'string', pattern: KEY.source, maxLength: L.key };
    const number = { type: 'integer', minimum: 1, maximum: requests };
    const refs = { type: 'array', items: number, maxItems: requests, uniqueItems: true };
    const obj = (properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> => ({
        type: 'object',
        properties,
        required,
        additionalProperties: false,
    });
    return obj(
        {
            outcome: { type: 'string', enum: REPLY_OUTCOMES },
            summary: str(L.summary),
            requests: {
                type: 'array',
                maxItems: requests,
                items: obj({ request: number, status: { type: 'string', enum: REQUEST_STATUSES }, note: str(L.requestNote) }, ['request', 'status']),
            },
            questions: {
                type: 'array',
                maxItems: L.questions,
                items: obj(
                    {
                        id: keyed,
                        text: str(L.questionText),
                        requests: refs,
                        options: {
                            type: 'array',
                            maxItems: L.options,
                            items: obj({ id: keyed, label: str(L.optionLabel), detail: str(L.optionDetail) }, ['id', 'label']),
                        },
                        multiple: { type: 'boolean' },
                    },
                    ['id', 'text', 'options', 'multiple'],
                ),
            },
            assumptions: {
                type: 'array',
                maxItems: L.assumptions,
                items: obj(
                    {
                        text: str(L.assumptionText),
                        requests: refs,
                        alternatives: {
                            type: 'array',
                            maxItems: L.alternatives,
                            items: obj({ id: keyed, label: str(L.alternativeLabel) }, ['id', 'label']),
                        },
                    },
                    ['text'],
                ),
            },
        },
        ['outcome', 'summary', 'requests'],
    );
}

/** A value made by a generated factory from what `readReply` already checked. */
function made<T>(r: Result<T, unknown>): T {
    if (!r.ok) throw new Error('A validated reply did not make a value of the model');
    return r.value;
}

/** A validated reply (requests by ID) as the model's `AgentReply`; its outcome is the run's state. */
export function toAgentReply(reply: ReplyData<Collaboration.RequestId>): Collaboration.AgentReply {
    const t = (s: string): Collaboration.Text => made(Collaboration.makeText(s));
    const k = (s: string): Collaboration.ReplyKey => made(Collaboration.makeReplyKey(s));
    return {
        summary: t(reply.summary),
        requests: reply.requests.map((r) => ({ request: r.request, status: PROGRESS[r.status], ...(r.note !== undefined && { note: t(r.note) }) })),
        questions: reply.questions.map((q) => ({
            id: k(q.id),
            text: t(q.text),
            requests: q.requests,
            options: q.options.map((o) => ({ id: k(o.id), label: t(o.label), ...(o.detail !== undefined && { detail: t(o.detail) }) })),
            multiple: q.multiple,
        })),
        assumptions: reply.assumptions.map((a) => ({
            text: t(a.text),
            requests: a.requests,
            alternatives: a.alternatives.map((x) => ({ id: k(x.id), label: t(x.label) })),
        })),
    };
}

/** The invariants of a reply and of every value in it that it breaks (empty: it holds them all). */
export function checkAgentReplyDeep(reply: Collaboration.AgentReply): string[] {
    return [
        ...Collaboration.checkAgentReply(reply),
        ...reply.requests.flatMap((r) => Collaboration.checkRequestReply(r)),
        ...reply.questions.flatMap((q) => Collaboration.checkReplyQuestion(q)),
        ...reply.assumptions.flatMap((a) => Collaboration.checkReplyAssumption(a)),
    ];
}

// ---- The facilitator's answer ----

/** An answer as the page sends it: for each question answered, the options chosen (by ID) and/or own words. */
export interface AnswerData {
    readonly answers: readonly { readonly question: string; readonly options: readonly string[]; readonly text?: string }[];
}

/** An answer's shape: `{ answers: [{ question, options, text? }] }`, one to `questions` answers, each question once. */
export function readAnswer(raw: unknown): Result<AnswerData, ReplyProblem> {
    try {
        const v = object(raw, 'answer', ['answers']);
        const answers = list(v.answers, 'answer.answers', REPLY_LIMITS.questions).map((x, i) => {
            const p = `answer.answers[${i}]`;
            const o = object(x, p, ['question', 'options', 'text']);
            const options = list(o.options, `${p}.options`, REPLY_LIMITS.options).map((y, j) => key(y, `${p}.options[${j}]`));
            unique(options, `${p}.options`, 'option');
            const t = o.text === undefined ? undefined : text(o.text, `${p}.text`, REPLY_LIMITS.answerText);
            if (options.length === 0 && t === undefined) throw new Refused(p, 'Choose an option or write an answer.');
            return { question: key(o.question, `${p}.question`), options, ...(t !== undefined && { text: t }) };
        });
        if (answers.length === 0) throw new Refused('answer.answers', 'Answer at least one question.');
        unique(
            answers.map((a) => a.question),
            'answer.answers',
            'question',
        );
        return ok({ answers });
    } catch (e) {
        if (e instanceof Refused) return err({ path: e.path, message: e.message });
        throw e;
    }
}

/**
 * The answer to the questions of `reply` (a run that needs clarification), frozen with their text and the options
 * chosen: every question and option ID must be the reply's, a single-choice question takes at most one option.
 */
export function resolveAnswer(
    answer: AnswerData,
    answerTo: Collaboration.AgentRunId,
    reply: Collaboration.AgentReply,
): Result<Collaboration.Answer, ReplyProblem> {
    const answered: Collaboration.AnsweredQuestion[] = [];
    for (const [i, a] of answer.answers.entries()) {
        const p = `answer.answers[${i}]`;
        const q = reply.questions.find((x) => x.id === a.question);
        if (!q) return err({ path: `${p}.question`, message: 'Not a question of that run.' });
        if (!q.multiple && a.options.length > 1) return err({ path: `${p}.options`, message: 'This question takes one option.' });
        const chosen: Collaboration.ReplyOption[] = [];
        for (const [j, id] of a.options.entries()) {
            const o = q.options.find((x) => x.id === id);
            if (!o) return err({ path: `${p}.options[${j}]`, message: 'Not an option of that question.' });
            chosen.push(o);
        }
        answered.push({
            question: q.id,
            text: q.text,
            chosen,
            ...(a.text !== undefined && { freeText: made(Collaboration.makeText(a.text)) }),
        });
    }
    const [first, ...rest] = answered;
    if (!first) return err({ path: 'answer.answers', message: 'Answer at least one question.' });
    return ok({ answerTo, answers: [first, ...rest] });
}

// ---- The facilitator's pick of an alternative ----

/** A pick as the page sends it: the completed run, its assumption (by its index in the reply) and the alternative (by its key). */
export interface PickData {
    readonly pickOf: Collaboration.AgentRunId;
    readonly assumption: Collaboration.Tally;
    readonly alternative: Collaboration.ReplyKey;
}

/**
 * The pick of an alternative of `run`'s assumptions, frozen with the assumption's text and the alternative: the run is
 * completed with a reply that has assumptions, the assumption and the alternative are its reply's, and the requests
 * queued again are that run's requests (each once, in any order). The run is the session's: the caller loads it so.
 */
export function resolvePick(
    pick: PickData,
    run: Collaboration.AgentRun,
    requests: readonly Collaboration.RequestId[],
): Result<Collaboration.AlternativePick, Collaboration.RunNotPickable | Collaboration.AlternativeNotFound | Collaboration.PickMismatch> {
    if (run.state !== 'Completed' || !run.reply || run.reply.assumptions.length === 0) return err({ type: 'RunNotPickable', run: run.id });
    const assumption = run.reply.assumptions[pick.assumption];
    const alternative = assumption?.alternatives.find((a) => a.id === pick.alternative);
    if (!assumption || !alternative) return err({ type: 'AlternativeNotFound', run: run.id });
    const own = new Set(run.input.requests.map((r) => r.request));
    const again = new Set(requests);
    if (again.size !== own.size || [...again].some((r) => !own.has(r))) return err({ type: 'PickMismatch', run: run.id });
    return ok({ pickOf: run.id, assumption: pick.assumption, text: assumption.text, alternative });
}
