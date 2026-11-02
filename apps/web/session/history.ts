// The session's runs grouped into "change units", without React: one card of the chat, and one row of AI の作業. A
// unit is one run, or a run followed by the runs that continue it (the answer to its question, the replies to it, an
// alternative picked, the same messages applied again), and so on. Everything is derived from the session's state on the page.
//
// People read a unit as one chunk of change, so it is named, not numbered: its title is the one the AI gave its first
// run that has one (the runs that continue it never rename it), else the head of the first message it applied.
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { MAX_REQUEST_MENTIONS, plainBody } from '@domaintrail/collaboration';

type RunJson = SessionStateBody['runs'][number];
type RevisionJson = SessionStateBody['revisions'][number];
type FrozenRequest = RunJson['input']['requests'][number];

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
    /** The sources the unit's runs changed, sorted (each once); `undefined` when no run's revisions are known. */
    readonly paths: readonly string[] | undefined;
    /**
     * The revisions the unit went from and to — the base of its first run that recorded them, the result of its last —
     * for comparing what the whole chunk changed; `undefined` when no run recorded them.
     */
    readonly span: { readonly base: string; readonly result: string } | undefined;
    /** The title the AI gave the unit's first run that has one (the runs that continue it do not rename it). */
    readonly title: string | undefined;
    /** What the AI says about the unit: its latest run's reply summary, else its question. */
    readonly summary: string | undefined;
    /** Who sent the requests of the unit's first run (whose chunk it is), in order of first appearance. */
    readonly requesters: readonly string[];
}

/** The reply of a run that has ended with one (completed, asked, declined). */
const replyOf = (run: RunJson): Extract<RunJson, { state: 'Completed' }>['reply'] =>
    run.state === 'Completed' || run.state === 'NeedsClarification' || run.state === 'Declined' ? run.reply : undefined;

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
 * (`answer.answerTo`) or picked an alternative of (`pick.pickOf`), or else the unit of a run its messages reply to (`replyTo` a run; the latest such unit when they reply
 * to runs of several), or else the latest unit whose latest run asked or completed with the same messages (queued
 * again with a note, an alternative picked, applied again); otherwise it starts a unit. A unit is one card of the chat.
 */
export function changeUnits(state: Pick<SessionStateBody, 'runs' | 'revisions'>): ChangeUnit[] {
    const revisions = new Map(state.revisions.map((r) => [r.id, r]));
    const runs = [...state.runs].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    const groups: UnitRun[][] = [];
    runs.forEach((run, i) => {
        const continued = run.input.answer?.answerTo ?? run.input.pick?.pickOf;
        // a reply to a message joins no unit by it
        const replied = new Set(run.input.requests.flatMap((r) => (r.replyTo?.kind === 'Run' ? [r.replyTo.run] : [])));
        const into =
            (continued !== undefined ? groups.find((g) => g.some((u) => u.run.id === continued)) : undefined) ??
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
        const recorded = runsOf.flatMap(({ run }) => revisionsOf(run) ?? []);
        const span = recorded.length > 0 ? { base: recorded[0].base, result: recorded[recorded.length - 1].result } : undefined;
        const reply = replyOf(last);
        const summary = reply?.summary ?? (last.state === 'NeedsClarification' ? last.question : undefined);
        const requesters: string[] = [];
        for (const r of runsOf[0].run.input.requests) if (!requesters.includes(r.author)) requesters.push(r.author);
        return {
            key: runsOf[0].run.id,
            runs: runsOf,
            at: runAt(last),
            start: runsOf[0].run.queuedAt,
            outcome: outcomeOf(last, files),
            files,
            paths: paths && [...paths].sort(),
            span,
            title: runsOf.map(({ run }) => replyOf(run)?.title).find((t) => t !== undefined),
            summary,
            requesters,
        };
    });
    return units.sort((a, b) => b.at.localeCompare(a.at) || b.runs[0].number - a.runs[0].number);
}

/** The finished units AI の作業 shows: those that changed files, or all of them. */
export function shownUnits(units: readonly ChangeUnit[], all: boolean): ChangeUnit[] {
    return all ? [...units] : units.filter((u) => (u.files ?? 0) > 0);
}

/** AI の作業 in its groups, each in the order it is shown; a group may be empty (the page then leaves it out). */
export interface WorkGroups {
    /** The units whose latest run asked a question, newest first. */
    readonly awaiting: readonly ChangeUnit[];
    /** The units whose latest run is running. */
    readonly running: readonly ChangeUnit[];
    /** The units whose latest run waits for its turn, in the order they will run (by when that run was queued). */
    readonly queued: readonly ChangeUnit[];
    /** The units that ended (changed or not, declined, failed, cancelled), newest first. */
    readonly finished: readonly ChangeUnit[];
}

/** The units (newest first, as `changeUnits` gives them) in the groups of AI の作業. */
export function workGroups(units: readonly ChangeUnit[]): WorkGroups {
    const latest = (u: ChangeUnit): UnitRun => u.runs[u.runs.length - 1];
    return {
        awaiting: units.filter((u) => u.outcome === 'clarification'),
        running: units.filter((u) => u.outcome === 'running'),
        queued: units.filter((u) => u.outcome === 'queued').sort((a, b) => latest(a).number - latest(b).number),
        finished: units.filter((u) => u.outcome !== 'clarification' && u.outcome !== 'running' && u.outcome !== 'queued'),
    };
}

/** How many units are not finished yet, the badge of AI の作業: running and queued (not those awaiting an answer). */
export const unfinishedCount = (units: readonly ChangeUnit[]): number => units.filter((u) => u.outcome === 'running' || u.outcome === 'queued').length;

/**
 * A request's text on one line, its tokens (elements and people, `body.ts`) as the names they were written with,
 * without sign nor number. A frozen request does not keep whom it mentioned, so every person token is read as one.
 */
export const requestHead = (r: Pick<FrozenRequest, 'body' | 'targets'>): string =>
    plainBody(r.body, { targets: r.targets.length, people: MAX_REQUEST_MENTIONS }, true).replace(/\s+/g, ' ').trim();

/**
 * What a unit is called: its title, else the head of the first message its first run applied (on one line; the page
 * cuts it to the room). `kind` tells which, for the look and the tooltip.
 */
export function unitName(unit: Pick<ChangeUnit, 'title' | 'runs'>): { readonly kind: 'title' | 'request'; readonly text: string } {
    if (unit.title !== undefined) return { kind: 'title', text: unit.title };
    const first = unit.runs[0]?.run.input.requests[0];
    return { kind: 'request', text: first ? requestHead(first) : '' };
}

/** Who asked for a unit, as its heading says it: one or two names, or the first and how many others. */
export type Requesters =
    | { readonly kind: 'none' }
    | { readonly kind: 'names'; readonly names: readonly string[] }
    | { readonly kind: 'more'; readonly first: string; readonly others: number };

/** The requesters of a unit for its heading (names already resolved): up to two by name, else the first and a count. */
export function requestersOf(names: readonly string[]): Requesters {
    if (names.length === 0) return { kind: 'none' };
    if (names.length <= 2) return { kind: 'names', names };
    return { kind: 'more', first: names[0], others: names.length - 1 };
}

/** The first `max` of a list for one line, and how many are left out (「ほか n」). */
export function cutList<T>(items: readonly T[], max: number): { readonly shown: readonly T[]; readonly more: number } {
    return items.length <= max ? { shown: items, more: 0 } : { shown: items.slice(0, max), more: items.length - max };
}
