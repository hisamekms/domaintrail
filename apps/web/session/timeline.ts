// The revision timeline of a session (ADR 0026, S7) as the page shows it, without React: each revision with its number
// in the session, where it came from (the session's start, a run's base or result, a person's snapshot, a restore),
// the two revisions chosen for a comparison, what a refused or failed restore asks of the facilitator, and the lines of
// a unified diff.
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { SessionApiError } from './api';

type RevisionJson = SessionStateBody['revisions'][number];

/** Where a revision came from, with the numbers of the runs and revisions it refers to (1-based, in the session's order). */
export type OriginDetail =
    | { readonly kind: 'SessionStart' }
    | { readonly kind: 'RunBase' | 'RunResult'; readonly run: number | undefined }
    | { readonly kind: 'Manual'; readonly by: string }
    | { readonly kind: 'PreRestore'; readonly restoring: number | undefined }
    | { readonly kind: 'Restored'; readonly from: number | undefined; readonly preRestore: number | undefined };

export interface TimelineEntry {
    readonly revision: RevisionJson;
    /** Its number in the session: 1 for the first revision taken. */
    readonly number: number;
    readonly origin: OriginDetail;
    /** The session's last revision. */
    readonly latest: boolean;
    /** Its sources are those of the last revision: restoring it would change nothing. */
    readonly sameAsLatest: boolean;
}

/** The revisions in the order they were taken (the state's order; by time when it is not). */
const taken = (revisions: readonly RevisionJson[]): RevisionJson[] =>
    revisions
        .map((r, i) => ({ r, i }))
        .sort((a, b) => a.r.takenAt.localeCompare(b.r.takenAt) || a.i - b.i)
        .map(({ r }) => r);

/** The timeline of a session, newest first. */
export function timeline(state: Pick<SessionStateBody, 'revisions' | 'runs'>): TimelineEntry[] {
    const ordered = taken(state.revisions);
    const numbers = new Map(ordered.map((r, i) => [r.id, i + 1]));
    const runs = new Map([...state.runs].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)).map((r, i) => [r.id, i + 1]));
    const last = ordered.at(-1);
    const originOf = (o: RevisionJson['origin']): OriginDetail => {
        switch (o.kind) {
            case 'SessionStart':
                return { kind: 'SessionStart' };
            case 'RunBase':
            case 'RunResult':
                return { kind: o.kind, run: runs.get(o.run) };
            case 'Manual':
                return { kind: 'Manual', by: o.takenBy };
            case 'PreRestore':
                return { kind: 'PreRestore', restoring: numbers.get(o.restoring) };
            case 'Restored':
                return { kind: 'Restored', from: numbers.get(o.restoredFrom), preRestore: numbers.get(o.preRestore) };
        }
    };
    return ordered
        .map((revision, i) => ({
            revision,
            number: i + 1,
            origin: originOf(revision.origin),
            latest: revision === last,
            sameAsLatest: revision.contentHash === last?.contentHash,
        }))
        .reverse();
}

/** The revisions chosen for a comparison after (un)checking `id`: at most two, the earlier choice dropped for a third. */
export function chooseForComparison(chosen: readonly string[], id: string, on: boolean): string[] {
    const others = chosen.filter((c) => c !== id);
    return on ? [...others, id].slice(-2) : others;
}

/** The two chosen revisions that still exist, the earlier taken first; undefined unless there are two. */
export function comparisonPair(chosen: readonly string[], revisions: readonly RevisionJson[]): [string, string] | undefined {
    const ordered = taken(revisions)
        .map((r) => r.id)
        .filter((id) => chosen.includes(id));
    const [before, after] = ordered;
    return ordered.length === 2 && before !== undefined && after !== undefined ? [before, after] : undefined;
}

/** What a restore that did not go through asks of the facilitator. */
export type RestoreProblem =
    /** The workspace changed since the last revision: record it first (the two-step), or leave it. */
    | { readonly kind: 'external'; readonly paths: readonly string[] }
    /** A run is running or claimed: cancel it first, or wait for it. */
    | { readonly kind: 'run'; readonly run: string }
    /** The write failed midway: the workspace before is the revision `preRestore`. */
    | { readonly kind: 'manual'; readonly preRestore: string; readonly cause: string; readonly message: string }
    | { readonly kind: 'other'; readonly message: string };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function restoreProblem(e: unknown): RestoreProblem {
    if (!(e instanceof SessionApiError)) return { kind: 'other', message: e instanceof Error ? e.message : String(e) };
    const d = e.detail;
    if (e.type === 'ExternalChangesSinceSnapshot') return { kind: 'external', paths: strings(d.paths) };
    if (e.type === 'RunInProgress' && typeof d.run === 'string') return { kind: 'run', run: d.run };
    if (e.type === 'ManualRecoveryNeeded' && typeof d.preRestore === 'string')
        return { kind: 'manual', preRestore: d.preRestore, cause: typeof d.cause === 'string' ? d.cause : '', message: e.message };
    return { kind: 'other', message: e.message && e.message !== e.type ? `${e.type}: ${e.message}` : e.type };
}

export type DiffLineKind = 'hunk' | 'add' | 'remove' | 'context' | 'note';

/** The lines of a unified diff, each with its kind (`@@` header, `+`, `-`, context, `\` note). */
export function diffLines(unified: string): { kind: DiffLineKind; text: string }[] {
    if (unified === '') return [];
    return unified.split('\n').map((text) => {
        const kind: DiffLineKind = text.startsWith('@@')
            ? 'hunk'
            : text.startsWith('+')
              ? 'add'
              : text.startsWith('-')
                ? 'remove'
                : text.startsWith('\\')
                  ? 'note'
                  : 'context';
        return { kind, text };
    });
}
