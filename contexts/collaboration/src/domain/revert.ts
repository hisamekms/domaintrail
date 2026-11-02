// The revert of a run's changes (ADR 0026, amendment "revert a run instead of restoring before it"), decided without I/O:
// which runs can be reverted, whether a run was reverted (its assumptions are then closed as reverted), the reverse of a
// run's changes applied onto the workspace as it is now — mechanically, as `git revert` does, or not at all — and what
// an agent asked to revert a run is told of its changes.
//
// The mechanical revert, per source the run changed (its base and result revisions differ there):
//   - the workspace still has the run's result → the base is written back (a file the run added is removed, one it
//     removed comes back);
//   - the workspace already has the base → nothing to do there;
//   - otherwise, a later change touched the file: the reverse of the run's change is merged into it line by line (a
//     three-way merge of the current text and the base, from the result as their ancestor). A change of the run that a
//     later change overlaps or touches, a file the run added and someone changed since, a file the run changed and
//     someone removed since, or a file too large to merge, is a conflict: the revert is not mechanical, and is left to
//     the AI. The sources the run did not change are never touched.
import type { FileStatus } from './compare.js';
import { matchLines } from './compare.js';
import { fileDiff, type ComparedChange } from './previous-runs.js';
import { comparePaths } from './snapshot.js';

/** A run as the revert's rules read it (the aggregate, or its JSON on a page). */
export interface RevertRun {
    readonly id: string;
    readonly state: string;
    /** Absent while it is queued, and when it was cancelled before it started. */
    readonly baseRevision?: string;
    /** Absent until it ended with a result. */
    readonly resultRevision?: string;
    readonly input: { readonly requests: readonly { readonly reverts?: string }[] };
}

/**
 * The revisions a run's changes go from and to: those of a run that ended with a result other than its base (it
 * changed files: completed, asked, declined, failed by the rule, or a mechanical revert). `undefined` for any other run.
 */
export function revertableChanges(run: RevertRun): { readonly base: string; readonly result: string } | undefined {
    if (run.state === 'Queued' || run.state === 'Running' || run.state === 'Cancelled') return undefined;
    const { baseRevision: base, resultRevision: result } = run;
    return base !== undefined && result !== undefined && base !== result ? { base, result } : undefined;
}

/** Whether a run is a revert: it bundles a request that reverts a run. */
export const isRevert = (run: RevertRun): boolean => run.input.requests.some((r) => r.reverts !== undefined);

/** The states of a revert that reverted its run: recorded mechanically, or completed by the AI. */
const DONE: ReadonlySet<string> = new Set(['Reverted', 'Completed']);
/** The states of a revert that may still revert its run: waiting, running, or asking the facilitator. */
const PENDING: ReadonlySet<string> = new Set(['Queued', 'Running', 'NeedsClarification']);

/**
 * What became of the changes of `run` among the session's runs: `reverted` by a run that reverted them (a mechanical revert,
 * or an AI's revert that completed) — unless that revert was itself reverted —, `pending` while a revert of it waits, runs or
 * asks, `none` otherwise (never asked, or the revert failed, was declined or cancelled: it may be asked again).
 */
export type RevertStatus<R extends RevertRun> =
    | { readonly kind: 'none' }
    | { readonly kind: 'pending'; readonly by: R }
    | { readonly kind: 'reverted'; readonly by: R };

export function revertStatus<R extends RevertRun>(run: RevertRun, runs: readonly R[], seen: ReadonlySet<string> = new Set()): RevertStatus<R> {
    // a revert of a revert of … is followed once per run
    const visited = new Set([...seen, run.id]);
    const reverts = runs.filter((r) => !visited.has(r.id) && r.input.requests.some((q) => q.reverts === run.id));
    const done = reverts.find((u) => DONE.has(u.state) && revertStatus(u, runs, visited).kind !== 'reverted');
    if (done) return { kind: 'reverted', by: done };
    const pending = reverts.find((u) => PENDING.has(u.state));
    return pending ? { kind: 'pending', by: pending } : { kind: 'none' };
}

/** The sources of a snapshot by path, as text. */
export type SourceTexts = ReadonlyMap<string, string>;

/** What the mechanical revert of a run's changes gives on the workspace as it is now. */
export type RevertMerge =
    /** The sources to write (a path to its new text) and to remove; every other source stays as it is. */
    | { readonly kind: 'merged'; readonly write: ReadonlyMap<string, string>; readonly remove: readonly string[] }
    /** The run's changes cannot all be reverted mechanically: the paths where they conflict with later changes. */
    | { readonly kind: 'conflict'; readonly paths: readonly string[] }
    /** The workspace already has none of the run's changes. */
    | { readonly kind: 'nothing' };

/** A text as its lines, each with its line end (the last one may have none): a merge keeps every byte. */
export function linesWithEnds(text: string): string[] {
    return text === '' ? [] : (text.match(/[^\n]*\n|[^\n]+$/g) ?? []);
}

const sameLines = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((l, i) => l === b[i]);

/**
 * The three-way merge of two texts that both come from `ancestor` (diff3): where only one side changed a region, its
 * change is taken; where both made the same change, it is taken once; where both changed the same region differently
 * — overlapping or touching changes — it is a conflict (`undefined`). Also `undefined` when a side is too large to
 * diff (`matchLines`).
 */
export function merge3(ancestor: string, ours: string, theirs: string): string | undefined {
    const o = linesWithEnds(ancestor);
    const a = linesWithEnds(ours);
    const b = linesWithEnds(theirs);
    const toA = matchLines(o, a);
    const toB = matchLines(o, b);
    if (!toA || !toB) return undefined;
    const out: string[] = [];
    let io = 0;
    let ia = 0;
    let ib = 0;
    for (;;) {
        // the next line of the ancestor that both sides kept: the end of a region where they may differ
        let stable = io;
        while (stable < o.length && (toA[stable] < 0 || toB[stable] < 0)) stable++;
        const endA = stable < o.length ? toA[stable] : a.length;
        const endB = stable < o.length ? toB[stable] : b.length;
        const was = o.slice(io, stable);
        const left = a.slice(ia, endA);
        const right = b.slice(ib, endB);
        if (sameLines(left, was)) out.push(...right);
        else if (sameLines(right, was) || sameLines(left, right)) out.push(...left);
        else return undefined;
        if (stable >= o.length) break;
        out.push(o[stable]);
        io = stable + 1;
        ia = endA + 1;
        ib = endB + 1;
    }
    return out.join('');
}

/**
 * The reverse of a run's changes (from its `base` to its `result`) applied onto the workspace's sources now
 * (`current`), as the module's comment describes: what to write and remove, or the paths in conflict, or nothing.
 */
export function reverseChanges(base: SourceTexts, result: SourceTexts, current: SourceTexts): RevertMerge {
    const write = new Map<string, string>();
    const remove: string[] = [];
    const conflicts: string[] = [];
    const paths = [...new Set([...base.keys(), ...result.keys()])].sort(comparePaths);
    for (const path of paths) {
        const before = base.get(path);
        const after = result.get(path);
        if (before === after) continue;
        const now = current.get(path);
        // already as before the run
        if (now === before) continue;
        if (now === after) {
            if (before === undefined) remove.push(path);
            else write.set(path, before);
            continue;
        }
        // changed since: merged only when the run changed it (neither added nor removed it) and it is still there
        const merged = before !== undefined && after !== undefined && now !== undefined ? merge3(after, now, before) : undefined;
        if (merged === undefined) conflicts.push(path);
        else if (merged !== now) write.set(path, merged);
    }
    if (conflicts.length > 0) return { kind: 'conflict', paths: conflicts };
    return write.size === 0 && remove.length === 0 ? { kind: 'nothing' } : { kind: 'merged', write, remove };
}

/** The most characters of diff an agent asked to revert a run is given of its changes (every file's diff together). */
export const MAX_REVERT_DIFF = 64 * 1024;

/** A source a run changed, as an agent asked to revert it is told: its unified diff while they fit, else its line counts. */
export interface RevertFile {
    readonly path: string;
    readonly status: Exclude<FileStatus, 'unchanged'>;
    /** Its unified diff from before to after the run (`---`/`+++` headers); absent past the budget or when none was made. */
    readonly diff?: string;
    readonly added?: number;
    readonly removed?: number;
}

/** What a run to revert changed, file by file. */
export interface RevertChanges {
    readonly files: readonly RevertFile[];
    /** Some files have no diff: past the budget (`MAX_REVERT_DIFF`), too large, or their content is gone. */
    readonly diffsOmitted: boolean;
}

/** The changes of a run to revert, each file's diff while the budget lasts (in path order), else its line counts. */
export function revertChanges(files: readonly ComparedChange[], budget = MAX_REVERT_DIFF): RevertChanges {
    let left = budget;
    let diffsOmitted = false;
    const out = files.map((f): RevertFile => {
        const diff = fileDiff(f);
        if (diff !== undefined && diff.length <= left) {
            left -= diff.length;
            return { path: f.path, status: f.status, diff };
        }
        diffsOmitted = true;
        return { path: f.path, status: f.status, ...(f.diff?.kind === 'diff' && { added: f.diff.added, removed: f.diff.removed }) };
    });
    return { files: out, diffsOmitted };
}
