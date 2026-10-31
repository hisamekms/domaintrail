// The session's history of changes (the chat pillar's 履歴), without React: the runs grouped into "change units". A
// unit is one run, or a run that asked for clarification followed by the run queued to answer it (the same requests
// again, or the answer to it), and so on. Everything is derived from the session's state on the page.
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';

type RunJson = SessionStateBody['runs'][number];
type RevisionJson = SessionStateBody['revisions'][number];

/** How a unit ended, from its latest run; `changed`/`unchanged` for a completed one, by the files the unit changed. */
export type UnitOutcome = 'changed' | 'unchanged' | 'clarification' | 'declined' | 'failed' | 'cancelled' | 'running' | 'queued';

/** A run in a unit, with its number in the session (as the chat numbers it: by when it was queued, from 1). */
export interface UnitRun {
    readonly run: RunJson;
    readonly number: number;
}

/** A change unit of the history. */
export interface ChangeUnit {
    /** Stable across updates: the first run's ID. */
    readonly key: string;
    /** Its runs, oldest first. */
    readonly runs: readonly UnitRun[];
    /** When it last changed: the latest run's latest change of state. */
    readonly at: string;
    readonly outcome: UnitOutcome;
    /**
     * How many sources the unit's runs changed (measured from the revisions before and after each run, a file counted
     * once); `undefined` when no run's revisions are known.
     */
    readonly files: number | undefined;
    /** What the AI says about the unit: its latest run's reply summary, else its question. */
    readonly summary: string | undefined;
    /** Who sent the requests, in order of first appearance. */
    readonly requesters: readonly string[];
}

/** When a run last changed state. */
export function runAt(run: RunJson): string {
    switch (run.state) {
        case 'Queued':
            return run.queuedAt;
        case 'Running':
            return run.startedAt;
        case 'Cancelled':
            return run.cancelledAt;
        default:
            return run.finishedAt;
    }
}

/** The paths that differ between two revisions (added, changed or removed, by content hash). */
export function changedPaths(before: RevisionJson | undefined, after: RevisionJson | undefined): Set<string> | undefined {
    if (!before || !after) return undefined;
    const out = new Set<string>();
    if (before.id === after.id) return out;
    const old = new Map(before.files.map((f) => [f.path, f.hash]));
    for (const f of after.files) {
        if (old.get(f.path) !== f.hash) out.add(f.path);
        old.delete(f.path);
    }
    for (const path of old.keys()) out.add(path);
    return out;
}

/** The revisions a run went from and to, when it has both. */
function revisionsOf(run: RunJson): { base: string; result: string } | undefined {
    if (run.state === 'Completed' || run.state === 'NeedsClarification' || run.state === 'Declined')
        return { base: run.baseRevision, result: run.resultRevision };
    return undefined;
}

/** Whether `next` continues a unit whose latest run is `last`: it queues some of its requests again after its question. */
function continues(last: RunJson, next: RunJson): boolean {
    if (last.state !== 'NeedsClarification') return false;
    const asked = new Set(last.input.requests.map((r) => r.request));
    return next.input.requests.some((r) => asked.has(r.request));
}

function outcomeOf(run: RunJson, files: number | undefined): UnitOutcome {
    switch (run.state) {
        case 'Queued':
            return 'queued';
        case 'Running':
            return 'running';
        case 'NeedsClarification':
            return 'clarification';
        case 'Completed':
            return (files ?? 0) > 0 || (files === undefined && run.changed) ? 'changed' : 'unchanged';
        case 'Declined':
            return 'declined';
        case 'Failed':
            return 'failed';
        case 'Cancelled':
            return 'cancelled';
    }
}

/**
 * The change units of a session, newest first (by when each last changed). A run joins the unit of the run it answers
 * (`answer.answerTo`), or else the latest unit whose latest run asked for clarification and had any of its requests;
 * otherwise it starts a unit.
 */
export function changeUnits(state: Pick<SessionStateBody, 'runs' | 'revisions'>): ChangeUnit[] {
    const revisions = new Map(state.revisions.map((r) => [r.id, r]));
    const runs = [...state.runs].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    const groups: UnitRun[][] = [];
    runs.forEach((run, i) => {
        const answerTo = run.input.answer?.answerTo;
        const into =
            (answerTo !== undefined ? groups.find((g) => g.some((u) => u.run.id === answerTo)) : undefined) ??
            groups.findLast((g) => continues(g[g.length - 1].run, run));
        if (into) into.push({ run, number: i + 1 });
        else groups.push([{ run, number: i + 1 }]);
    });
    const units = groups.map((runsOf): ChangeUnit => {
        const last = runsOf[runsOf.length - 1].run;
        let paths: Set<string> | undefined;
        for (const { run } of runsOf) {
            const r = revisionsOf(run);
            const changed = r && changedPaths(revisions.get(r.base), revisions.get(r.result));
            if (changed) paths = new Set([...(paths ?? []), ...changed]);
        }
        const files = paths?.size;
        const reply = last.state === 'Completed' || last.state === 'NeedsClarification' || last.state === 'Declined' ? last.reply : undefined;
        const summary = reply?.summary ?? (last.state === 'NeedsClarification' ? last.question : undefined);
        const requesters: string[] = [];
        for (const { run } of runsOf) for (const r of run.input.requests) if (!requesters.includes(r.author)) requesters.push(r.author);
        return {
            key: runsOf[0].run.id,
            runs: runsOf,
            at: runAt(last),
            outcome: outcomeOf(last, files),
            files,
            summary,
            requesters,
        };
    });
    return units.sort((a, b) => b.at.localeCompare(a.at) || b.runs[0].number - a.runs[0].number);
}

/** The units the history shows: those that changed files, or all of them. */
export function shownUnits(units: readonly ChangeUnit[], all: boolean): ChangeUnit[] {
    return all ? [...units] : units.filter((u) => (u.files ?? 0) > 0);
}
