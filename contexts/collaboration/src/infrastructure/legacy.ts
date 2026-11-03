// Rows written before a request could have several targets (ADR 0026, appendix "Requests with several targets"): a
// request, the frozen copy of a request in a run's input, and the `RequestSent` event held one `target`. They are
// read as the list of targets they stand for: none when the target was the whole workspace, else that one target.
// Nothing is rewritten in the database; new rows are written with `targets`. Likewise a request and its `RequestSent`
// written before people could be mentioned are read as mentioning no one (`mentions: []`), and a reply written
// before a message could reply to a message names its run by its ID alone (`replyTo: "<id>"`): it is read as
// `{ kind: 'Run', run }` in a request, the frozen copy of a request in a run's input, and the `RequestSent` event.
// Since ADR 0030, a session and its `SessionStarted` written before sessions had a mode are read as Collab, and a run's
// report written when `formatted` / `checked` were booleans is read with `Ran` (true) or `Failed` (false: did not run).
// A change proposal written when it was three texts (`{ what, where, how }`) is read as a proposal with no targets
// and no options whose how is the three joined (a line each, cut at the type's limit); likewise its `ChangeProposed`
// event, an approval's edit (`edited` → `editedHow`) in the proposal and its `ProposalApproved`, and an approved
// proposal frozen in a run's input (`content` → `instruction`). A `/` command written when `/guide` was `/es:next`
// (`kind: 'EsNext'`) or `/hint` (`kind: 'Hint'`), and its `SlashCommandStarted`, are read as a `Guide`; its answer's
// steps written before they had places to go (`targets`), in the command and its `SlashCommandAnswered`, with none.

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

/** The most characters of a proposal's text (`ProposalText`): the joined former fields are cut there. */
const PROPOSAL_TEXT_MAX = 2000;

/** Whether a proposal's content is of the former shape (three texts). */
const isFormerContent = (v: unknown): v is Raw => isObject(v) && !('targets' in v) && typeof v.how === 'string';

/** The former three texts as one: a line each, the blank ones left out, cut at the type's limit. */
function joined(c: Raw): string {
    const text = [c.what, c.where, c.how]
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .map((x) => x.trim())
        .join('\n');
    return text.length > PROPOSAL_TEXT_MAX ? `${text.slice(0, PROPOSAL_TEXT_MAX - 1)}…` : text;
}

/** A proposal's content of the former shape as one with no targets and no options; any other value as it is. */
const upgradeContent = (v: unknown): unknown => (isFormerContent(v) ? { targets: [], how: joined(v), options: [] } : v);

/** An approval's former `edited` (a whole content) as the how it edited (`editedHow`); any other value as it is. */
function withEditedHow(v: unknown): unknown {
    if (!isObject(v) || !('edited' in v)) return v;
    const { edited, ...rest } = v;
    return isFormerContent(edited) ? { ...rest, editedHow: joined(edited) } : rest;
}

/** A change proposal as stored: its content, and its approval's edit. */
export function upgradeProposal(v: unknown): unknown {
    if (!isObject(v)) return v;
    return withEditedHow({ ...v, content: upgradeContent(v.content) });
}

/** An approved proposal frozen in a run's input, of the former shape (`content`), as its instruction. */
function withInstruction(v: unknown): unknown {
    if (!isObject(v) || !('content' in v) || 'instruction' in v) return v;
    const { content, ...rest } = v;
    return { ...rest, instruction: isFormerContent(content) ? { targets: [], how: joined(content) } : content };
}

/** A run: the frozen requests and approved proposals of its input, and its report's outcomes. */
export function upgradeRun(v: unknown): unknown {
    if (!isObject(v)) return v;
    const run = withOutcomes(v);
    if (!isObject(run.input) || !Array.isArray(run.input.requests)) return run;
    const proposals = run.input.proposals;
    return {
        ...run,
        input: {
            ...run.input,
            requests: run.input.requests.map((r) => withReplyTarget(withTargets(r))),
            ...(isObject(proposals) && Array.isArray(proposals.approved) && { proposals: { ...proposals, approved: proposals.approved.map(withInstruction) } }),
        },
    };
}

/** An object without `mode` (a session, or its `SessionStarted`, written before modes) as a Collab one. */
const withMode = (v: unknown): unknown => (isObject(v) && !('mode' in v) ? { ...v, mode: 'Collab' } : v);

/** A session as stored. */
export const upgradeSession = withMode;

/** An object of a former kind `EsNext` (`/es:next`) or `Hint` (`/hint`), both now `/guide`, as a `Guide`; any other value as it is. */
const withGuideKind = (v: unknown): unknown => (isObject(v) && (v.kind === 'EsNext' || v.kind === 'Hint') ? { ...v, kind: 'Guide' } : v);

/** A guide's answer written before its steps had places to go: each step with none. */
function withStepTargets(next: unknown): unknown {
    if (!isObject(next) || !Array.isArray(next.steps)) return next;
    return { ...next, steps: next.steps.map((st: unknown) => (isObject(st) && !('targets' in st) ? { ...st, targets: [] } : st)) };
}

/** A command, or its `SlashCommandAnswered`, with its answer's steps upgraded. */
const withNext = (v: unknown): unknown => (isObject(v) && 'next' in v ? { ...v, next: withStepTargets(v.next) } : v);

/** A `/` command as stored. */
export const upgradeSlashCommand = (v: unknown): unknown => withNext(withGuideKind(v));

/**
 * An event of the outbox: a `RequestSent`, a `SessionStarted`, a `ChangeProposed`, a `ProposalApproved`, a
 * `SlashCommandStarted`.
 */
export function upgradeEvent(v: unknown): unknown {
    if (isObject(v) && v.type === 'SlashCommandStarted') return withGuideKind(v);
    if (isObject(v) && v.type === 'SlashCommandAnswered') return withNext(v);
    if (isObject(v) && v.type === 'SessionStarted') return withMode(v);
    if (isObject(v) && v.type === 'ChangeProposed') return { ...v, content: upgradeContent(v.content) };
    if (isObject(v) && v.type === 'ProposalApproved') return withEditedHow(v);
    return isObject(v) && v.type === 'RequestSent' ? withReplyTarget(withMentions(withTargets(v))) : v;
}
