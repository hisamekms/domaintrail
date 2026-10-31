// The inputs of the session APIs, checked at the boundary before any use case sees them: IDs, targets, text lengths.
// A failure names the field and why, and is answered 400 (`InvalidInput`).
import { Collaboration, err, ok, type Result } from '@domaintrail/collaboration/generated/index';

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
            if (typeof v.occurrence !== 'string' || !/^[1-9]\d{0,5}(\.[1-9]\d{0,5}){0,31}$/.test(v.occurrence))
                return invalid(f('occurrence'), "Expected a step path like '3' or '2.1'.");
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
        sourceRevision: Collaboration.makeRevisionId(revision.value),
        ...(label !== undefined && { label }),
        ...(range && { range }),
    };
    return Collaboration.checkTargetSnapshot(snapshot).length ? invalid(`${field}.range`, 'A workspace target has no range.') : ok(snapshot);
}

/** The requests a run bundles: 1 to `MAX_RUN_REQUESTS` request IDs, in order. */
export function requestIds(v: unknown, field = 'requests'): Result<Collaboration.RequestId[], InvalidInput> {
    if (!Array.isArray(v) || v.length === 0 || v.length > MAX_RUN_REQUESTS) return invalid(field, `Expected 1 to ${MAX_RUN_REQUESTS} request IDs.`);
    const ids: Collaboration.RequestId[] = [];
    for (const [i, raw] of v.entries()) {
        const id = uuid(raw, `${field}[${i}]`);
        if (!id.ok) return id;
        ids.push(Collaboration.makeRequestId(id.value));
    }
    return ok(ids);
}
