// The messages a page may send over the WebSocket in a session (`ClientMessage`), parsed and validated before anything
// else sees them: a message that is not exactly one of them is dropped.
import type { ClientMessage, Cursor, ViewLocation } from '@domaintrail/collaboration/protocol';

/** Longest string of a location or a target: keys, IDs and names, never free text. */
const MAX_KEY = 512;
/** Furthest a cursor may be from the origin of the canvas. */
const MAX_COORDINATE = 1e7;

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const isKey = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_KEY;
const hasOnly = (o: Raw, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));

function location(v: unknown): ViewLocation | undefined {
    if (!isObject(v)) return undefined;
    if (v.kind === 'dt' && hasOnly(v, ['kind', 'viewKey', 'layoutKey']) && isKey(v.viewKey) && isKey(v.layoutKey)) {
        return { kind: 'dt', viewKey: v.viewKey, layoutKey: v.layoutKey };
    }
    if (
        v.kind === 'dtes' &&
        hasOnly(v, ['kind', 'stormingId', 'level', 'timelineId', 'layoutKey']) &&
        isKey(v.stormingId) &&
        isKey(v.level) &&
        isKey(v.layoutKey) &&
        (v.timelineId === undefined || isKey(v.timelineId))
    ) {
        return {
            kind: 'dtes',
            stormingId: v.stormingId,
            level: v.level,
            layoutKey: v.layoutKey,
            ...(typeof v.timelineId === 'string' && { timelineId: v.timelineId }),
        };
    }
    return undefined;
}

function cursor(v: unknown): Cursor | undefined {
    if (!isObject(v) || !hasOnly(v, ['x', 'y'])) return undefined;
    const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORDINATE;
    return ok(v.x) && ok(v.y) ? { x: v.x, y: v.y } : undefined;
}

/** A target as the page names it (`ModelTarget`'s shape); checked for shape only, since presence is never stored. */
function target(v: unknown): NonNullable<Extract<ClientMessage, { type: 'presence.update' }>['selectedTarget']> | undefined {
    if (!isObject(v)) return undefined;
    switch (v.kind) {
        case 'Workspace':
            if (!hasOnly(v, ['kind', 'scope'])) return undefined;
            if (v.scope === undefined) return { kind: 'Workspace' };
            return v.scope === 'Dt' || v.scope === 'Dtes' ? { kind: 'Workspace', scope: v.scope } : undefined;
        case 'DtElement':
            return hasOnly(v, ['kind', 'element']) && isKey(v.element) ? { kind: 'DtElement', element: v.element } : undefined;
        case 'DtesElement':
            return hasOnly(v, ['kind', 'storming', 'local']) && isKey(v.storming) && isKey(v.local)
                ? { kind: 'DtesElement', storming: v.storming, local: v.local }
                : undefined;
        case 'DtesOccurrence':
            return hasOnly(v, ['kind', 'storming', 'timeline', 'eventName', 'occurrence']) &&
                isKey(v.storming) &&
                isKey(v.timeline) &&
                isKey(v.eventName) &&
                typeof v.occurrence === 'string' &&
                /^\d+(\.\d+)*$/.test(v.occurrence) &&
                v.occurrence.length <= MAX_KEY
                ? { kind: 'DtesOccurrence', storming: v.storming, timeline: v.timeline, eventName: v.eventName, occurrence: v.occurrence }
                : undefined;
        default:
            return undefined;
    }
}

/** The page's message in `text`, or `undefined` when it is not JSON or not exactly a `ClientMessage`. */
export function parseClientMessage(text: string): ClientMessage | undefined {
    let v: unknown;
    try {
        v = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (!isObject(v)) return undefined;
    if (v.type === 'presence.leave') return hasOnly(v, ['type']) ? { type: 'presence.leave' } : undefined;
    if (v.type !== 'presence.update' || !hasOnly(v, ['type', 'location', 'cursor', 'selectedTarget'])) return undefined;
    const where = location(v.location);
    if (!where) return undefined;
    const at = v.cursor === undefined || v.cursor === null ? undefined : cursor(v.cursor);
    if (v.cursor !== undefined && v.cursor !== null && !at) return undefined;
    const selected = v.selectedTarget === undefined || v.selectedTarget === null ? undefined : target(v.selectedTarget);
    if (v.selectedTarget !== undefined && v.selectedTarget !== null && !selected) return undefined;
    return { type: 'presence.update', location: where, ...(at && { cursor: at }), ...(selected && { selectedTarget: selected }) };
}
