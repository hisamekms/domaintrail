// Rows written before a request could have several targets (ADR 0026, appendix "Requests with several targets"): a
// request, the frozen copy of a request in a run's input, and the `RequestSent` event held one `target`. They are
// read as the list of targets they stand for: none when the target was the whole workspace, else that one target.
// Nothing is rewritten in the database; new rows are written with `targets`. Likewise a request and its `RequestSent`
// written before people could be mentioned are read as mentioning no one (`mentions: []`).

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The targets a former single target stands for: none for the whole workspace. */
function targetsOf(target: unknown): unknown[] {
    return isObject(target) && isObject(target.target) && target.target.kind === 'Workspace' ? [] : [target];
}

/** An object with a former `target` as `targets`, in the same place among its fields; any other value as it is. */
export function withTargets(v: unknown): unknown {
    if (!isObject(v) || !('target' in v) || 'targets' in v) return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => (k === 'target' ? ['targets', targetsOf(x)] : [k, x])));
}

/** An object without `mentions` (written before people could be mentioned) as mentioning no one. */
function withMentions(v: unknown): unknown {
    return isObject(v) && !('mentions' in v) ? { ...v, mentions: [] } : v;
}

/** A request as stored. */
export const upgradeRequest = (v: unknown): unknown => withMentions(withTargets(v));

/** A run: the frozen requests of its input. */
export function upgradeRun(v: unknown): unknown {
    if (!isObject(v) || !isObject(v.input) || !Array.isArray(v.input.requests)) return v;
    return { ...v, input: { ...v.input, requests: v.input.requests.map(withTargets) } };
}

/** An event of the outbox: a `RequestSent`. */
export function upgradeEvent(v: unknown): unknown {
    return isObject(v) && v.type === 'RequestSent' ? withMentions(withTargets(v)) : v;
}
