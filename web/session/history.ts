// The session's runs grouped into "change units", without React: one card of the chat, and one row of its 履歴. A
// unit is one run, or a run followed by the runs that continue it (the answer to its question, the replies to it, an
// alternative picked, the same messages applied again), and so on. Everything is derived from the session's state on the page.
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
    /** When its first run was queued (where its card stays in the chat). */
    readonly start: string;
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

/**
 * Whether `next` continues a unit whose latest run is `last`: it queues the same messages again once that run asked a
 * question (the answer as a note) or completed (another alternative picked, or applied again). A run after a cancel, a
 * failure or a decline starts a card of its own.
 */
function continues(last: RunJson, next: RunJson): boolean {
    if (last.state !== 'NeedsClarification' && last.state !== 'Completed') return false;
    const before = new Set(last.input.requests.map((r) => r.request));
    return next.input.requests.length === before.size && next.input.requests.every((r) => before.has(r.request));
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
 * (`answer.answerTo`), or else the unit of a run its messages reply to (`replyTo`; the latest such unit when they reply
 * to runs of several), or else the latest unit whose latest run asked or completed with the same messages (queued
 * again with a note, an alternative picked, applied again); otherwise it starts a unit. A unit is one card of the chat.
 */
export function changeUnits(state: Pick<SessionStateBody, 'runs' | 'revisions'>): ChangeUnit[] {
    const revisions = new Map(state.revisions.map((r) => [r.id, r]));
    const runs = [...state.runs].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    const groups: UnitRun[][] = [];
    runs.forEach((run, i) => {
        const answerTo = run.input.answer?.answerTo;
        const replied = new Set(run.input.requests.flatMap((r) => (r.replyTo === undefined ? [] : [r.replyTo])));
        const into =
            (answerTo !== undefined ? groups.find((g) => g.some((u) => u.run.id === answerTo)) : undefined) ??
            (replied.size > 0 ? groups.findLast((g) => g.some((u) => replied.has(u.run.id))) : undefined) ??
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
            start: runsOf[0].run.queuedAt,
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
