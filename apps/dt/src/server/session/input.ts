// The inputs of the session APIs, checked at the boundary before any use case sees them: IDs, targets, text lengths.
// A failure names the field and why, and is answered 400 (`InvalidInput`).
import {
    type AnswerData,
    checkAgentReplyDeep,
    Collaboration,
    err,
    knownAgentRunId,
    knownRequestId,
    knownRevisionId,
    makeEmoji,
    MAX_EMOJI_BYTES,
    MAX_REQUEST_MENTIONS,
    MAX_REQUEST_TARGETS,
    ok,
    type PickData,
    readAnswer,
    readEmoji,
    readReply,
    REPLY_LIMITS,
    type ReplyOutcome,
    type Result,
    toAgentReply,
    VOTE,
} from '@domaintrail/collaboration';

/** Why an input was refused. */
export interface InvalidInput {
    readonly type: 'InvalidInput';
    readonly field: string;
    readonly message: string;
}

/** Longest request body, and the facilitator's note on a run. */
export const MAX_REQUEST_TEXT = 10_000;
export const MAX_NOTE = 4_000;
/** Longest name picked in `dev` mode. */
export const MAX_NAME = 60;
/** Longest label, element name or other key of a target. */
const MAX_KEY = 512;
/** Most requests one run bundles. */
export const MAX_RUN_REQUESTS = 100;

type Raw = Record<string, unknown>;

const invalid = (field: string, message: string): Result<never, InvalidInput> => err({ type: 'InvalidInput', field, message });
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Whether `s` has a control character other than a tab or a line break (those are allowed in free text only). */
function hasControl(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const n = s.charCodeAt(i);
        if ((n < 0x20 && n !== 0x09 && n !== 0x0a && n !== 0x0d) || n === 0x7f) return true;
    }
    return false;
}

/** An object body with only `keys`. */
export function body(v: unknown, keys: readonly string[]): Result<Raw, InvalidInput> {
    if (!isObject(v)) return invalid('body', 'Expected a JSON object.');
    const extra = Object.keys(v).find((k) => !keys.includes(k));
    return extra === undefined ? ok(v) : invalid(extra, 'Unknown field.');
}

/** A UUID as the IDs of the model are (lowercase). */
export function uuid(v: unknown, field: string): Result<string, InvalidInput> {
    return typeof v === 'string' && UUID.test(v) ? ok(v) : invalid(field, 'Expected a UUID.');
}

/** Text written by a person: `max` characters at most, not blank, no control characters but tabs and line breaks. */
export function text(v: unknown, field: string, max: number): Result<Collaboration.Text, InvalidInput> {
    if (typeof v !== 'string' || !v.trim()) return invalid(field, 'Expected a non-empty string.');
    if (v.length > max) return invalid(field, `At most ${max} characters.`);
    if (hasControl(v)) return invalid(field, 'No control characters.');
    const t = Collaboration.makeText(v);
    return t.ok ? t : invalid(field, `At most ${max} characters.`);
}

/** A display name picked in `dev` mode: trimmed, 1–60 characters, on one line. */
export function displayName(v: unknown, field = 'name'): Result<Collaboration.DisplayName, InvalidInput> {
    if (typeof v !== 'string') return invalid(field, 'Expected a name.');
    const name = v.trim();
    if (!name || name.length > MAX_NAME || /[\r\n]/.test(name) || hasControl(name)) return invalid(field, `A name of 1 to ${MAX_NAME} characters on one line.`);
    const n = Collaboration.makeDisplayName(name);
    return n.ok ? n : invalid(field, 'Not a name.');
}

function key(v: unknown, field: string): Result<string, InvalidInput> {
    if (typeof v !== 'string' || !v || v.length > MAX_KEY || hasControl(v) || /[\r\n]/.test(v))
        return invalid(field, `Expected a name of 1 to ${MAX_KEY} characters.`);
    return ok(v);
}

/** A value made by a generated factory from a checked key. */
function made<T>(v: unknown, field: string, make: (s: string) => Result<T, unknown>): Result<T, InvalidInput> {
    const k = key(v, field);
    if (!k.ok) return k;
    const m = make(k.value);
    return m.ok ? ok(m.value) : invalid(field, 'Not a valid name.');
}

function modelTarget(v: unknown, field: string): Result<Collaboration.ModelTarget, InvalidInput> {
    if (!isObject(v)) return invalid(field, 'Expected a target.');
    const f = (name: string): string => `${field}.${name}`;
    switch (v.kind) {
        case 'Workspace': {
            const b = body(v, ['kind', 'scope']);
            if (!b.ok) return invalid(f(b.error.field), b.error.message);
            if (v.scope === undefined) return ok({ kind: 'Workspace' });
            return v.scope === 'Dt' || v.scope === 'Dtes' ? ok({ kind: 'Workspace', scope: v.scope }) : invalid(f('scope'), "Expected 'Dt' or 'Dtes'.");
        }
        case 'DtElement': {
            const b = body(v, ['kind', 'element']);
            if (!b.ok) return invalid(f(b.error.field), b.error.message);
            const element = made(v.element, f('element'), Collaboration.makeElementName);
            return element.ok ? ok({ kind: 'DtElement', element: element.value }) : element;
        }
        case 'DtesElement': {
            const b = body(v, ['kind', 'storming', 'local']);
            if (!b.ok) return invalid(f(b.error.field), b.error.message);
            const storming = made(v.storming, f('storming'), Collaboration.makeStormingName);
            if (!storming.ok) return storming;
            const local = made(v.local, f('local'), Collaboration.makeStormingLocalName);
            return local.ok ? ok({ kind: 'DtesElement', storming: storming.value, local: local.value }) : local;
        }
        case 'DtesOccurrence': {
            const b = body(v, ['kind', 'storming', 'timeline', 'eventName', 'occurrence']);
            if (!b.ok) return invalid(f(b.error.field), b.error.message);
            const storming = made(v.storming, f('storming'), Collaboration.makeStormingName);
            if (!storming.ok) return storming;
            const timeline = made(v.timeline, f('timeline'), Collaboration.makeTimelineName);
            if (!timeline.ok) return timeline;
            const eventName = made(v.eventName, f('eventName'), Collaboration.makeStormingEventName);
            if (!eventName.ok) return eventName;
            // the step path of the Live View's occurrences: 0-based indexes, the step and, in a group, the event (decodeOccurrencePath)
            if (typeof v.occurrence !== 'string' || !/^(0|[1-9]\d{0,5})(\.(0|[1-9]\d{0,5}))?$/.test(v.occurrence))
                return invalid(f('occurrence'), "Expected a step path like '0', '3' or '2.1'.");
            const occurrence = Collaboration.makeOccurrencePath(v.occurrence);
            if (!occurrence.ok) return invalid(f('occurrence'), 'Not a step path.');
            return ok({ kind: 'DtesOccurrence', storming: storming.value, timeline: timeline.value, eventName: eventName.value, occurrence: occurrence.value });
        }
        default:
            return invalid(f('kind'), "Expected 'Workspace', 'DtElement', 'DtesElement' or 'DtesOccurrence'.");
    }
}

function position(v: unknown, field: string): Result<number, InvalidInput> {
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10_000_000 ? ok(v) : invalid(field, 'Expected a positive integer.');
}

function sourceRange(v: unknown, field: string): Result<Collaboration.SourceRange, InvalidInput> {
    const b = body(v, ['path', 'startLine', 'startColumn', 'endLine', 'endColumn']);
    if (!b.ok) return invalid(b.error.field === 'body' ? field : `${field}.${b.error.field}`, b.error.message);
    const r = b.value;
    const p = made(r.path, `${field}.path`, Collaboration.makeWorkspacePath);
    if (!p.ok) return p;
    const numbers: number[] = [];
    for (const name of ['startLine', 'startColumn', 'endLine', 'endColumn']) {
        const n = position(r[name], `${field}.${name}`);
        if (!n.ok) return n;
        numbers.push(n.value);
    }
    const [startLine, startColumn, endLine, endColumn] = numbers;
    const sl = Collaboration.makeLineNumber(startLine);
    const sc = Collaboration.makeColumnNumber(startColumn);
    const el = Collaboration.makeLineNumber(endLine);
    const ec = Collaboration.makeColumnNumber(endColumn);
    if (!sl.ok || !sc.ok || !el.ok || !ec.ok) return invalid(field, 'Expected positive line and column numbers.');
    const range: Collaboration.SourceRange = { path: p.value, startLine: sl.value, startColumn: sc.value, endLine: el.value, endColumn: ec.value };
    return Collaboration.checkSourceRange(range).length ? invalid(field, 'The range must start before it ends.') : ok(range);
}

/** A request's target as the page took it: the target, the revision it was seen in, its label and range then. */
export function targetSnapshot(v: unknown, field = 'target'): Result<Collaboration.TargetSnapshot, InvalidInput> {
    const b = body(v, ['target', 'sourceRevision', 'label', 'range']);
    if (!b.ok) return invalid(b.error.field === 'body' ? field : `${field}.${b.error.field}`, b.error.message);
    const raw = b.value;
    const target = modelTarget(raw.target, `${field}.target`);
    if (!target.ok) return target;
    const revision = uuid(raw.sourceRevision, `${field}.sourceRevision`);
    if (!revision.ok) return revision;
    let label: string | undefined;
    if (raw.label !== undefined) {
        const l = key(raw.label, `${field}.label`);
        if (!l.ok) return l;
        label = l.value;
    }
    let range: Collaboration.SourceRange | undefined;
    if (raw.range !== undefined) {
        const r = sourceRange(raw.range, `${field}.range`);
        if (!r.ok) return r;
        range = r.value;
    }
    const snapshot: Collaboration.TargetSnapshot = {
        target: target.value,
        sourceRevision: knownRevisionId(revision.value),
        ...(label !== undefined && { label }),
        ...(range && { range }),
    };
    return Collaboration.checkTargetSnapshot(snapshot).length ? invalid(`${field}.range`, 'A workspace target has no range.') : ok(snapshot);
}

/**
 * What a request is about: 0 to 20 targets, each once, none of them the whole workspace (no target is the whole
 * workspace). The body `{ targets }` is checked; the former `{ target }` (one target, the workspace's when it was
 * about the whole workspace) is still taken, as a list of one or none.
 */
export function requestTargets(raw: Raw): Result<Collaboration.TargetSnapshot[], InvalidInput> {
    if (raw.targets !== undefined && raw.target !== undefined) return invalid('target', "Give 'targets' only.");
    if (raw.target !== undefined) {
        const one = targetSnapshot(raw.target, 'target');
        if (!one.ok) return one;
        return ok(one.value.target.kind === 'Workspace' ? [] : [one.value]);
    }
    const v = raw.targets ?? [];
    if (!Array.isArray(v) || v.length > MAX_REQUEST_TARGETS) return invalid('targets', `Expected 0 to ${MAX_REQUEST_TARGETS} targets.`);
    const targets: Collaboration.TargetSnapshot[] = [];
    for (const [i, item] of v.entries()) {
        const t = targetSnapshot(item, `targets[${i}]`);
        if (!t.ok) return t;
        if (t.value.target.kind === 'Workspace') return invalid(`targets[${i}].target.kind`, 'No target is the whole workspace: leave the targets out.');
        if (targets.some((o) => Collaboration.equalModelTarget(o.target, t.value.target))) return invalid(`targets[${i}].target`, 'Each target once.');
        targets.push(t.value);
    }
    return ok(targets);
}

/** What a message replies to: `{ kind: 'Run', run }` or `{ kind: 'Message', request }` (whether it can be replied to: the use case checks). */
export function replyTarget(v: unknown, field = 'replyTo'): Result<Collaboration.ReplyTarget, InvalidInput> {
    if (!isObject(v) || (v.kind !== 'Run' && v.kind !== 'Message'))
        return invalid(field, 'Expected { "kind": "Run", "run" } or { "kind": "Message", "request" }.');
    const key = v.kind === 'Run' ? 'run' : 'request';
    const extra = Object.keys(v).find((k) => k !== 'kind' && k !== key);
    if (extra !== undefined) return invalid(`${field}.${extra}`, 'Unknown field.');
    const id = uuid(v[key], `${field}.${key}`);
    if (!id.ok) return id;
    return ok(v.kind === 'Run' ? { kind: 'Run', run: knownAgentRunId(id.value) } : { kind: 'Message', request: knownRequestId(id.value) });
}

/** The people a message mentions: 0 to `MAX_REQUEST_MENTIONS` participant IDs, each once (the session's: the use case checks). */
export function mentionIds(v: unknown, field = 'mentions'): Result<Collaboration.ParticipantId[], InvalidInput> {
    if (v === undefined) return ok([]);
    if (!Array.isArray(v) || v.length > MAX_REQUEST_MENTIONS) return invalid(field, `Expected 0 to ${MAX_REQUEST_MENTIONS} participant IDs.`);
    const ids: Collaboration.ParticipantId[] = [];
    for (const [i, raw] of v.entries()) {
        const id = typeof raw === 'string' && raw.length <= 200 && !hasControl(raw) ? Collaboration.makeParticipantId(raw) : undefined;
        if (!id?.ok) return invalid(`${field}[${i}]`, 'Expected a participant ID.');
        if (ids.includes(id.value)) return invalid(`${field}[${i}]`, 'Each person once.');
        ids.push(id.value);
    }
    return ok(ids);
}

/** The requests a run bundles: 1 to `MAX_RUN_REQUESTS` request IDs, in order. */
export function requestIds(v: unknown, field = 'requests'): Result<Collaboration.RequestId[], InvalidInput> {
    if (!Array.isArray(v) || v.length === 0 || v.length > MAX_RUN_REQUESTS) return invalid(field, `Expected 1 to ${MAX_RUN_REQUESTS} request IDs.`);
    const ids: Collaboration.RequestId[] = [];
    for (const [i, raw] of v.entries()) {
        const id = uuid(raw, `${field}[${i}]`);
        if (!id.ok) return id;
        ids.push(knownRequestId(id.value));
    }
    return ok(ids);
}

/**
 * The agent's reply as the subscriber sends it (`AgentReplyBody`), validated against the shape and `REPLY_LIMITS`, with
 * the outcome the route ends the run with; its requests are IDs (that they are the run's requests is the model's
 * `replyAboutInput`).
 */
export function agentReply(v: unknown, outcome: ReplyOutcome, field = 'reply'): Result<Collaboration.AgentReply, InvalidInput> {
    const read = readReply(v, (x) => (uuid(x, field).ok ? knownRequestId(String(x)) : undefined), MAX_RUN_REQUESTS);
    if (!read.ok) return invalid(read.error.path, read.error.message);
    if (read.value.outcome !== outcome) return invalid(`${field}.outcome`, `Expected '${outcome}'.`);
    const reply = toAgentReply(read.value);
    const violated = checkAgentReplyDeep(reply);
    return violated.length ? invalid(field, `Breaks ${violated.join(', ')}.`) : ok(reply);
}

/** The facilitator's answer to a run's questions (`AnswerBody`): its shape and limits; the run's questions are checked later. */
export function answer(v: unknown, field = 'answer'): Result<AnswerData, InvalidInput> {
    const read = readAnswer(v);
    return read.ok ? read : invalid(read.error.path.replace(/^answer/, field), read.error.message);
}

/** A reply's key (a question's, an option's, an alternative's): letters, digits, `_` and `-`, at most `REPLY_LIMITS.key`. */
function replyKey(v: unknown, field: string): Result<Collaboration.ReplyKey, InvalidInput> {
    if (typeof v !== 'string' || !v || v.length > REPLY_LIMITS.key) return invalid(field, `Expected a key of 1 to ${REPLY_LIMITS.key} characters.`);
    const k = Collaboration.makeReplyKey(v);
    return k.ok ? k : invalid(field, 'Letters, digits, _ and - only.');
}

/** An assumption's number: its index in the reply, 0 to `REPLY_LIMITS.assumptions` - 1. */
function assumptionNumber(n: unknown, field: string): Result<Collaboration.Tally, InvalidInput> {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= REPLY_LIMITS.assumptions)
        return invalid(field, `Expected an assumption's number, 0 to ${REPLY_LIMITS.assumptions - 1}.`);
    const assumption = Collaboration.makeTally(n);
    return assumption.ok ? assumption : invalid(field, 'Expected a number.');
}

/** The alternative picked of a completed run's assumption: `{ pickOf, assumption, alternative }` (its number and the alternative's key). */
export function pick(v: unknown, field = 'pick'): Result<PickData, InvalidInput> {
    if (!isObject(v)) return invalid(field, 'Expected { "pickOf": …, "assumption": …, "alternative": … }.');
    const keys = ['pickOf', 'assumption', 'alternative'];
    if (!body(v, keys).ok) return invalid(`${field}.${Object.keys(v).find((k) => !keys.includes(k))}`, 'Unknown field.');
    const of = uuid(v.pickOf, `${field}.pickOf`);
    if (!of.ok) return of;
    const assumption = assumptionNumber(v.assumption, `${field}.assumption`);
    if (!assumption.ok) return assumption;
    const alternative = replyKey(v.alternative, `${field}.alternative`);
    if (!alternative.ok) return alternative;
    return ok({ pickOf: knownAgentRunId(of.value), assumption: assumption.value, alternative: alternative.value });
}

/** The assumption approved, from a body's `run` and `assumption` (its number in the run's reply). */
export function assumptionRef(raw: Raw): Result<Collaboration.AssumptionRef, InvalidInput> {
    const run = uuid(raw.run, 'run');
    if (!run.ok) return run;
    const assumption = assumptionNumber(raw.assumption, 'assumption');
    if (!assumption.ok) return assumption;
    return ok({ run: knownAgentRunId(run.value), assumption: assumption.value });
}

/** What a mark is on: a message, an AI turn, a question's option, or an assumption's choice (none: kept as it is). */
export function markTarget(v: unknown, field = 'target'): Result<Collaboration.MarkTarget, InvalidInput> {
    if (!isObject(v)) return invalid(field, 'Expected a mark target.');
    const only = (keys: readonly string[]): Result<Raw, InvalidInput> =>
        body(v, keys).ok ? ok(v) : invalid(`${field}.${Object.keys(v).find((k) => !keys.includes(k))}`, 'Unknown field.');
    const id = <T>(name: string, make: (s: string) => T): Result<T, InvalidInput> => {
        const u = uuid(v[name], `${field}.${name}`);
        return u.ok ? ok(make(u.value)) : u;
    };
    switch (v.kind) {
        case 'Message': {
            const o = only(['kind', 'request']);
            if (!o.ok) return o;
            const request = id('request', knownRequestId);
            return request.ok ? ok({ kind: 'Message', request: request.value }) : request;
        }
        case 'Turn': {
            const o = only(['kind', 'run']);
            if (!o.ok) return o;
            const run = id('run', knownAgentRunId);
            return run.ok ? ok({ kind: 'Turn', run: run.value }) : run;
        }
        case 'QuestionOption': {
            const o = only(['kind', 'run', 'question', 'option']);
            if (!o.ok) return o;
            const run = id('run', knownAgentRunId);
            if (!run.ok) return run;
            const question = replyKey(v.question, `${field}.question`);
            if (!question.ok) return question;
            const option = replyKey(v.option, `${field}.option`);
            if (!option.ok) return option;
            return ok({ kind: 'QuestionOption', run: run.value, question: question.value, option: option.value });
        }
        case 'AssumptionChoice': {
            const o = only(['kind', 'run', 'assumption', 'alternative']);
            if (!o.ok) return o;
            const run = id('run', knownAgentRunId);
            if (!run.ok) return run;
            const assumption = assumptionNumber(v.assumption, `${field}.assumption`);
            if (!assumption.ok) return assumption;
            if (v.alternative === undefined) return ok({ kind: 'AssumptionChoice', run: run.value, assumption: assumption.value });
            const alternative = replyKey(v.alternative, `${field}.alternative`);
            if (!alternative.ok) return alternative;
            return ok({ kind: 'AssumptionChoice', run: run.value, assumption: assumption.value, alternative: alternative.value });
        }
        default:
            return invalid(`${field}.kind`, 'Expected Message, Turn, QuestionOption or AssumptionChoice.');
    }
}

/**
 * A mark's sign: `{ kind: 'Vote' }`, or `{ kind: 'Reaction', emoji }` with exactly one emoji (one grapheme, at most
 * `MAX_EMOJI_BYTES` bytes), turned into the form reactions are kept (NFC, fully qualified: ❤ is ❤️).
 */
export function markSign(v: unknown, field = 'sign'): Result<Collaboration.MarkSign, InvalidInput> {
    if (!isObject(v)) return invalid(field, 'Expected { "kind": "Vote" } or { "kind": "Reaction", "emoji": … }.');
    const keys = v.kind === 'Reaction' ? ['kind', 'emoji'] : ['kind'];
    if (!body(v, keys).ok) return invalid(`${field}.${Object.keys(v).find((k) => !keys.includes(k))}`, 'Unknown field.');
    if (v.kind === 'Vote') return ok(VOTE);
    if (v.kind !== 'Reaction') return invalid(`${field}.kind`, 'Expected Vote or Reaction.');
    const read = typeof v.emoji === 'string' ? readEmoji(v.emoji) : undefined;
    const emoji = read === undefined ? undefined : makeEmoji(read);
    if (!emoji?.ok) return invalid(`${field}.emoji`, `Expected exactly one emoji (at most ${MAX_EMOJI_BYTES} bytes).`);
    return ok({ kind: 'Reaction', emoji: emoji.value });
}
