// Rows written before a request could have several targets (ADR 0026, appendix "Requests with several targets"): a
// request, the frozen copy of a request in a run's input, and the `RequestSent` event held one `target`. They are
// read as the list of targets they stand for: none when the target was the whole workspace, else that one target.
// Nothing is rewritten in the database; new rows are written with `targets`. Likewise a request and its `RequestSent`
// written before people could be mentioned are read as mentioning no one (`mentions: []`), and a reply written
// before a message could reply to a message names its run by its ID alone (`replyTo: "<id>"`): it is read as
// `{ kind: 'Run', run }` in a request, the frozen copy of a request in a run's input, and the `RequestSent` event.
// Since ADR 0030, a session and its `SessionStarted` written before sessions had a mode are read as Collab, and a run's
// report written when `formatted` / `checked` were booleans is read with `Ran` (true) or `Failed` (false: did not run).

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

/** An object whose `replyTo` is a run's ID (written before a message could reply to a message) as replying to that run. */
function withReplyTarget(v: unknown): unknown {
    return isObject(v) && typeof v.replyTo === 'string' ? { ...v, replyTo: { kind: 'Run', run: v.replyTo } } : v;
}

/** A request as stored. */
export const upgradeRequest = (v: unknown): unknown => withReplyTarget(withMentions(withTargets(v)));

/** A tool's former boolean in a report as its outcome. */
const outcome = (v: unknown): unknown => (v === true ? 'Ran' : v === false ? 'Failed' : v);

/** A run's report with its former booleans as outcomes; any other value as it is. */
function withOutcomes(v: Raw): Raw {
    const report = v.report;
    if (!isObject(report) || (typeof report.formatted !== 'boolean' && typeof report.checked !== 'boolean')) return v;
    return { ...v, report: { ...report, formatted: outcome(report.formatted), checked: outcome(report.checked) } };
}

/** A run: the frozen requests of its input, and its report's outcomes. */
export function upgradeRun(v: unknown): unknown {
    if (!isObject(v)) return v;
    const run = withOutcomes(v);
    if (!isObject(run.input) || !Array.isArray(run.input.requests)) return run;
    return { ...run, input: { ...run.input, requests: run.input.requests.map((r) => withReplyTarget(withTargets(r))) } };
}

/** An object without `mode` (a session, or its `SessionStarted`, written before modes) as a Collab one. */
const withMode = (v: unknown): unknown => (isObject(v) && !('mode' in v) ? { ...v, mode: 'Collab' } : v);

/** A session as stored. */
export const upgradeSession = withMode;

/** An event of the outbox: a `RequestSent`, a `SessionStarted`. */
export function upgradeEvent(v: unknown): unknown {
    if (isObject(v) && v.type === 'SessionStarted') return withMode(v);
    return isObject(v) && v.type === 'RequestSent' ? withReplyTarget(withMentions(withTargets(v))) : v;
}
