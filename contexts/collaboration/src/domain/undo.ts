// The undo of a run's changes (ADR 0026, amendment "undo a run instead of restoring before it"), decided without I/O:
// which runs can be undone, whether a run was undone (its assumptions are then closed as undone), the reverse of a
// run's changes applied onto the workspace as it is now — mechanically, as `git revert` does, or not at all — and what
// an agent asked to undo a run is told of its changes.
//
// The mechanical undo, per source the run changed (its base and result revisions differ there):
//   - the workspace still has the run's result → the base is written back (a file the run added is removed, one it
//     removed comes back);
//   - the workspace already has the base → nothing to do there;
//   - otherwise, a later change touched the file: the reverse of the run's change is merged into it line by line (a
//     three-way merge of the current text and the base, from the result as their ancestor). A change of the run that a
//     later change overlaps or touches, a file the run added and someone changed since, a file the run changed and
//     someone removed since, or a file too large to merge, is a conflict: the undo is not mechanical, and is left to
//     the AI. The sources the run did not change are never touched.
import type { FileStatus } from './compare.js';
import { matchLines } from './compare.js';
import { fileDiff, type ComparedChange } from './previous-runs.js';
import { comparePaths } from './snapshot.js';

/** A run as the undo's rules read it (the aggregate, or its JSON on a page). */
export interface UndoRun {
    readonly id: string;
    readonly state: string;
    /** Absent while it is queued, and when it was cancelled before it started. */
    readonly baseRevision?: string;
    /** Absent until it ended with a result. */
    readonly resultRevision?: string;
    readonly input: { readonly requests: readonly { readonly undoes?: string }[] };
}

/**
 * The revisions a run's changes go from and to: those of a run that ended with a result other than its base (it
 * changed files: completed, asked, declined, failed by the rule, or a mechanical undo). `undefined` for any other run.
 */
export function undoableChanges(run: UndoRun): { readonly base: string; readonly result: string } | undefined {
    if (run.state === 'Queued' || run.state === 'Running' || run.state === 'Cancelled') return undefined;
    const { baseRevision: base, resultRevision: result } = run;
    return base !== undefined && result !== undefined && base !== result ? { base, result } : undefined;
}

/** Whether a run is an undo: it bundles a request that undoes a run. */
export const isUndo = (run: UndoRun): boolean => run.input.requests.some((r) => r.undoes !== undefined);

/** The states of an undo that undid its run: recorded mechanically, or completed by the AI. */
const DONE: ReadonlySet<string> = new Set(['Reverted', 'Completed']);
/** The states of an undo that may still undo its run: waiting, running, or asking the facilitator. */
const PENDING: ReadonlySet<string> = new Set(['Queued', 'Running', 'NeedsClarification']);

/**
 * What became of the changes of `run` among the session's runs: `undone` by a run that undid them (a mechanical undo,
 * or an AI's undo that completed) — unless that undo was itself undone —, `pending` while an undo of it waits, runs or
 * asks, `none` otherwise (never asked, or the undo failed, was declined or cancelled: it may be asked again).
 */
export type UndoStatus<R extends UndoRun> =
    | { readonly kind: 'none' }
    | { readonly kind: 'pending'; readonly by: R }
    | { readonly kind: 'undone'; readonly by: R };

export function undoStatus<R extends UndoRun>(run: UndoRun, runs: readonly R[], seen: ReadonlySet<string> = new Set()): UndoStatus<R> {
    // an undo of an undo of … is followed once per run
    const visited = new Set([...seen, run.id]);
    const undos = runs.filter((r) => !visited.has(r.id) && r.input.requests.some((q) => q.undoes === run.id));
    const done = undos.find((u) => DONE.has(u.state) && undoStatus(u, runs, visited).kind !== 'undone');
    if (done) return { kind: 'undone', by: done };
    const pending = undos.find((u) => PENDING.has(u.state));
    return pending ? { kind: 'pending', by: pending } : { kind: 'none' };
}

/** The sources of a snapshot by path, as text. */
export type SourceTexts = ReadonlyMap<string, string>;

/** What the mechanical undo of a run's changes gives on the workspace as it is now. */
export type UndoMerge =
    /** The sources to write (a path to its new text) and to remove; every other source stays as it is. */
    | { readonly kind: 'merged'; readonly write: ReadonlyMap<string, string>; readonly remove: readonly string[] }
    /** The run's changes cannot all be undone mechanically: the paths where they conflict with later changes. */
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
export function reverseChanges(base: SourceTexts, result: SourceTexts, current: SourceTexts): UndoMerge {
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

/** The most characters of diff an agent asked to undo a run is given of its changes (every file's diff together). */
export const MAX_UNDO_DIFF = 64 * 1024;

/** A source a run changed, as an agent asked to undo it is told: its unified diff while they fit, else its line counts. */
export interface UndoFile {
    readonly path: string;
    readonly status: Exclude<FileStatus, 'unchanged'>;
    /** Its unified diff from before to after the run (`---`/`+++` headers); absent past the budget or when none was made. */
    readonly diff?: string;
    readonly added?: number;
    readonly removed?: number;
}

/** What a run to undo changed, file by file. */
export interface UndoChanges {
    readonly files: readonly UndoFile[];
    /** Some files have no diff: past the budget (`MAX_UNDO_DIFF`), too large, or their content is gone. */
    readonly diffsOmitted: boolean;
}

/** The changes of a run to undo, each file's diff while the budget lasts (in path order), else its line counts. */
export function undoChanges(files: readonly ComparedChange[], budget = MAX_UNDO_DIFF): UndoChanges {
    let left = budget;
    let diffsOmitted = false;
    const out = files.map((f): UndoFile => {
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
