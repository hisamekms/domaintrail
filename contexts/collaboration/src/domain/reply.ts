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
    /** Characters of the title (one line naming what the requests are about; the prompt asks for about `titleAim`). */
    title: 30,
    /** Characters the prompt asks the title to be, about. */
    titleAim: 20,
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
    /**
     * Characters of the AI's answer: a run's (`answer`, when it judged a request a question and changed nothing) and the
     * read-only answerer's (a message of the AI).
     */
    answer: 2000,
    /** What the agent fixed in its review at the run's end (ADR 0034): items, and characters of each. */
    reviewFixed: 10,
    /** What it kept as it was in its review, with why: items (each `what` and `why` at most `reviewText` characters). */
    reviewKept: 10,
    reviewText: 300,
    /** Knowledge items its review found at odds with the stickies as the run left them. */
    reviewKnowledge: 5,
    /** Knowledge items its review proposes to retire (ADR 0031 §12), and the evidence of each. */
    reviewRetire: 5,
    reviewEvidence: 3,
} as const;

/** A knowledge item's ID (`kn_…`, the knowledge context's `KnowledgeItemId`) and a sticky reference (`<Storming>.<Local>`). */
const KNOWLEDGE_ID = /^kn_[0-9a-z]{8,32}$/;
const STICKY_REF = /^[_a-zA-Z][_a-zA-Z0-9]*\.[_a-zA-Z][_a-zA-Z0-9]*$/;

/** What the agent says of its review at the run's end (ADR 0034): what it fixed, what it kept and why, the knowledge at odds. */
export interface ReviewReplyData {
    readonly fixed: readonly string[];
    readonly kept: readonly { readonly what: string; readonly why: string }[];
    /** Knowledge items at odds with the stickies as the run left them: the item, the sticky, and why. */
    readonly knowledge: readonly { readonly item: string; readonly sticky: string; readonly why: string }[];
    /** Knowledge items it proposes to retire (ADR 0031 §12), with why and the evidence; people decide. */
    readonly retire: readonly ReviewRetireData[];
}

/** The reasons a retirement gives (the knowledge context's `RetirementReason`). */
export const RETIREMENT_REASONS = ['replaced', 'obsolete', 'wrong'] as const;

/** A proposal of the review to retire an item: a sticky the run changed, or a decision, as its evidence. */
export interface ReviewRetireData {
    readonly item: string;
    readonly reason: (typeof RETIREMENT_REASONS)[number];
    readonly replacedBy?: string;
    readonly explanation: string;
    readonly evidence: readonly (
        | { readonly kind: 'StickyChange'; readonly sticky: string; readonly change: string }
        | { readonly kind: 'Decision'; readonly item: string }
    )[];
}

export const REPLY_OUTCOMES = ['done', 'clarification', 'declined'] as const;
/** How a run ended in the agent's words: carried out, asks first, or will not do it. */
export type ReplyOutcome = (typeof REPLY_OUTCOMES)[number];

export const REQUEST_STATUSES = ['done', 'partial', 'skipped', 'question', 'answered'] as const;
/** What the agent says it did about one request. */
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

const PROGRESS = { done: 'Done', partial: 'Partial', skipped: 'Skipped', question: 'Question', answered: 'Answered' } as const satisfies Record<
    RequestStatus,
    Collaboration.RequestProgress
>;

/** The pattern of a key (`ReplyKey` of the model). */
const KEY = /^[A-Za-z0-9_-]+$/;

/** A reply as validated, with its requests named by `R`: their number in the prompt, or their ID. */
export interface ReplyData<R> {
    readonly outcome: ReplyOutcome;
    /** A short name of what the requests are about (one line); none in a reply that gives none. */
    readonly title?: string;
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
    /** The answer, when the agent judged a request a question and answered it without editing (its status `answered`). */
    readonly answer?: string;
    /** The review's report, from the turn that reviews the run (ADR 0034); never kept with the reply itself. */
    readonly review?: ReviewReplyData;
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
 * A reply validated against the shape and the limits: `outcome`, `title` (optional, one line), `summary`, `requests` (each of the run's requests
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
    const v = object(raw, 'reply', ['outcome', 'title', 'summary', 'requests', 'questions', 'assumptions', 'answer', 'review']);
    const outcome = REPLY_OUTCOMES.find((o) => o === v.outcome);
    if (!outcome) throw new Refused('reply.outcome', `Expected one of ${REPLY_OUTCOMES.join(', ')}.`);
    const title = v.title === undefined ? undefined : text(v.title, 'reply.title', L.title, false);
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
    const answer = v.answer === undefined ? undefined : text(v.answer, 'reply.answer', L.answer);
    if (answer !== undefined && outcome !== 'done') throw new Refused('reply.answer', `Only a done reply answers, not ${outcome}.`);
    if (answer === undefined && requests.some((r) => r.status === 'answered'))
        throw new Refused('reply.answer', 'An answer is required when a request is answered.');
    const review = v.review === undefined ? undefined : readReview(v.review);
    return {
        outcome,
        ...(title !== undefined && { title }),
        summary,
        requests,
        questions,
        assumptions,
        ...(answer !== undefined && { answer }),
        ...(review !== undefined && { review }),
    };
}

/** The review's report alone (`AgentFinishBody.review`), validated as in a reply. */
export function readReviewReply(raw: unknown): Result<ReviewReplyData, ReplyProblem> {
    try {
        return ok(readReview(raw));
    } catch (e) {
        if (e instanceof Refused) return err({ path: e.path, message: e.message });
        throw e;
    }
}

/** The review's report: `fixed`, `kept` (`what`, `why`) and `knowledge` (`item`, `sticky`, `why`), each optional, within the limits. */
function readReview(raw: unknown): ReviewReplyData {
    const L = REPLY_LIMITS;
    const v = object(raw, 'reply.review', ['fixed', 'kept', 'knowledge', 'retire']);
    const fixed = (v.fixed === undefined ? [] : list(v.fixed, 'reply.review.fixed', L.reviewFixed)).map((x, i) =>
        text(x, `reply.review.fixed[${i}]`, L.reviewText),
    );
    const kept = (v.kept === undefined ? [] : list(v.kept, 'reply.review.kept', L.reviewKept)).map((x, i) => {
        const p = `reply.review.kept[${i}]`;
        const o = object(x, p, ['what', 'why']);
        return { what: text(o.what, `${p}.what`, L.reviewText), why: text(o.why, `${p}.why`, L.reviewText) };
    });
    const knowledge = (v.knowledge === undefined ? [] : list(v.knowledge, 'reply.review.knowledge', L.reviewKnowledge)).map((x, i) => {
        const p = `reply.review.knowledge[${i}]`;
        const o = object(x, p, ['item', 'sticky', 'why']);
        if (typeof o.item !== 'string' || !KNOWLEDGE_ID.test(o.item)) throw new Refused(`${p}.item`, 'Expected a knowledge item ID (kn_…).');
        if (typeof o.sticky !== 'string' || !STICKY_REF.test(o.sticky)) throw new Refused(`${p}.sticky`, 'Expected a sticky as <Storming>.<Local>.');
        return { item: o.item, sticky: o.sticky, why: text(o.why, `${p}.why`, L.reviewText) };
    });
    const retire = (v.retire === undefined ? [] : list(v.retire, 'reply.review.retire', L.reviewRetire)).map((x, i) => {
        const p = `reply.review.retire[${i}]`;
        const o = object(x, p, ['item', 'reason', 'replacedBy', 'explanation', 'evidence']);
        const id = (w: unknown, at: string): string => {
            if (typeof w !== 'string' || !KNOWLEDGE_ID.test(w)) throw new Refused(at, 'Expected a knowledge item ID (kn_…).');
            return w;
        };
        const reason = RETIREMENT_REASONS.find((r) => r === o.reason);
        if (!reason) throw new Refused(`${p}.reason`, `Expected one of ${RETIREMENT_REASONS.join(', ')}.`);
        const replacedBy = o.replacedBy === undefined ? undefined : id(o.replacedBy, `${p}.replacedBy`);
        if (replacedBy !== undefined && reason !== 'replaced') throw new Refused(`${p}.replacedBy`, "Only with the reason 'replaced'.");
        const evidence = list(o.evidence, `${p}.evidence`, L.reviewEvidence).map((y, j) => {
            const q = `${p}.evidence[${j}]`;
            const e = object(y, q, ['kind', 'sticky', 'change', 'item']);
            if (e.kind === 'Decision') return { kind: 'Decision' as const, item: id(e.item, `${q}.item`) };
            if (e.kind !== 'StickyChange') throw new Refused(`${q}.kind`, 'Expected StickyChange or Decision.');
            if (typeof e.sticky !== 'string' || !STICKY_REF.test(e.sticky)) throw new Refused(`${q}.sticky`, 'Expected a sticky as <Storming>.<Local>.');
            return { kind: 'StickyChange' as const, sticky: e.sticky, change: text(e.change, `${q}.change`, L.reviewText) };
        });
        if (evidence.length === 0) throw new Refused(`${p}.evidence`, 'Expected evidence: a sticky changed or a decision.');
        return {
            item: id(o.item, `${p}.item`),
            reason,
            ...(replacedBy !== undefined && { replacedBy }),
            explanation: text(o.explanation, `${p}.explanation`, L.reviewText),
            evidence,
        };
    });
    return { fixed, kept, knowledge, retire };
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
 * run has (they are numbered from 1 in the prompt). The title is required of the agent, though a stored reply may have
 * none (replies from before it, and what is kept of an invalid reply).
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
            title: str(L.title),
            summary: str(L.summary),
            answer: str(L.answer),
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
            review: obj(
                {
                    fixed: { type: 'array', maxItems: L.reviewFixed, items: str(L.reviewText) },
                    kept: { type: 'array', maxItems: L.reviewKept, items: obj({ what: str(L.reviewText), why: str(L.reviewText) }, ['what', 'why']) },
                    knowledge: {
                        type: 'array',
                        maxItems: L.reviewKnowledge,
                        items: obj(
                            {
                                item: { type: 'string', pattern: KNOWLEDGE_ID.source },
                                sticky: { type: 'string', pattern: STICKY_REF.source },
                                why: str(L.reviewText),
                            },
                            ['item', 'sticky', 'why'],
                        ),
                    },
                    retire: {
                        type: 'array',
                        maxItems: L.reviewRetire,
                        items: obj(
                            {
                                item: { type: 'string', pattern: KNOWLEDGE_ID.source },
                                reason: { type: 'string', enum: RETIREMENT_REASONS },
                                replacedBy: { type: 'string', pattern: KNOWLEDGE_ID.source },
                                explanation: str(L.reviewText),
                                evidence: {
                                    type: 'array',
                                    minItems: 1,
                                    maxItems: L.reviewEvidence,
                                    items: {
                                        anyOf: [
                                            obj(
                                                {
                                                    kind: { const: 'StickyChange' },
                                                    sticky: { type: 'string', pattern: STICKY_REF.source },
                                                    change: str(L.reviewText),
                                                },
                                                ['kind', 'sticky', 'change'],
                                            ),
                                            obj({ kind: { const: 'Decision' }, item: { type: 'string', pattern: KNOWLEDGE_ID.source } }, ['kind', 'item']),
                                        ],
                                    },
                                },
                            },
                            ['item', 'reason', 'explanation', 'evidence'],
                        ),
                    },
                },
                [],
            ),
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
        ['outcome', 'title', 'summary', 'requests'],
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
        ...(reply.title !== undefined && { title: t(reply.title) }),
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
        ...(reply.answer !== undefined && { answer: t(reply.answer) }),
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
