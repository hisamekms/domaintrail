// The runs a run continues (ADR 0026, amendment "replies to runs"), decided without I/O: the runs its messages reply
// to and the run its answer answers, in the order the input names them, and what each changed, bounded for the
// agent's prompt. The input names the runs only (frozen at queueing); what they changed is measured from their base and
// result revisions when the run starts, and given as a unified diff of the changed sources — or, when the diffs of all
// of them together exceed the budget (`session.agent.maxPreviousRunDiff`), as the list of the files each changed.
import type { Collaboration } from '../generated/index.js';
import type { FileStatus, LineDiff } from './compare.js';

/** The runs a run's input continues: those its messages reply to, then the run its answer answers; each once. */
export function previousRunIds(input: Collaboration.RunInput): Collaboration.AgentRunId[] {
    const ids: Collaboration.AgentRunId[] = [];
    for (const r of input.requests) if (r.replyTo !== undefined && !ids.includes(r.replyTo)) ids.push(r.replyTo);
    if (input.answer && !ids.includes(input.answer.answerTo)) ids.push(input.answer.answerTo);
    return ids;
}

/** A source a previous run changed. */
export interface PreviousRunFile {
    readonly path: string;
    readonly status: Exclude<FileStatus, 'unchanged'>;
}

/** What a previous run changed, as the agent is told. */
export type PreviousRunChanges =
    /** The run recorded no result (cancelled, or failed before its end): what it changed is unknown. */
    | { readonly kind: 'unrecorded' }
    /** The files it changed and their unified diff (with `---`/`+++` headers per file); no file: nothing changed. */
    | { readonly kind: 'diff'; readonly files: readonly PreviousRunFile[]; readonly diff: string }
    /** The files it changed only: the diff did not fit the budget (or could not be made). */
    | { readonly kind: 'files'; readonly files: readonly PreviousRunFile[]; readonly added: number; readonly removed: number; readonly diffOmitted: true };

/** A changed file of a comparison, with its line diff when one was made. */
export interface ComparedChange extends PreviousRunFile {
    readonly diff?: LineDiff;
}

/** The unified diff of one file, with its headers; `undefined` when no complete diff was made (too large, cut, missing). */
export function fileDiff(file: ComparedChange): string | undefined {
    const d = file.diff;
    if (!d || d.kind !== 'diff' || d.truncated) return undefined;
    const before = file.status === 'added' ? '/dev/null' : `a/${file.path}`;
    const after = file.status === 'removed' ? '/dev/null' : `b/${file.path}`;
    return `--- ${before}\n+++ ${after}\n${d.unified}${d.unified.endsWith('\n') ? '' : '\n'}`;
}

/**
 * What each previous run changed within `budget` characters of diff for all of them: in order, a run whose whole diff
 * fits what is left gets it, any other the list of its files with the lines added and removed (when known). A run
 * without a result (`undefined`) is `unrecorded`.
 */
export function boundChanges(runs: readonly (readonly ComparedChange[] | undefined)[], budget: number): PreviousRunChanges[] {
    let left = budget;
    return runs.map((files): PreviousRunChanges => {
        if (!files) return { kind: 'unrecorded' };
        const list = files.map(({ path, status }) => ({ path, status }));
        const diffs = files.map(fileDiff);
        const complete = diffs.every((d) => d !== undefined);
        const diff = diffs.join('');
        if (complete && diff.length <= left) {
            left -= diff.length;
            return { kind: 'diff', files: list, diff };
        }
        let added = 0;
        let removed = 0;
        for (const f of files) {
            if (f.diff?.kind !== 'diff') continue;
            added += f.diff.added;
            removed += f.diff.removed;
        }
        return { kind: 'files', files: list, added, removed, diffOmitted: true };
    });
}
