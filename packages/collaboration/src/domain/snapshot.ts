// The content of a snapshot, decided without I/O: the normalized path of each source, its language, the hash of its
// bytes, and the content hash of the whole snapshot (the declared invariant `hashOfFiles` of Revision and the
// requirement `hashMatchesFiles` of take and restore).
import { isStormingFile } from '@domaintrail/modeling/core/analyze';
import { Collaboration, err, type Result } from '../generated/index.js';
import { sha256Hex } from './sha256.js';

type ContentHash = Collaboration.ContentHash;
type WorkspacePath = Collaboration.WorkspacePath;

const encoder = new TextEncoder();

/** A file of a snapshot by path and content hash: what the content hash of a snapshot is computed from. */
export interface HashedPath {
    readonly path: WorkspacePath;
    readonly hash: ContentHash;
}

/** The language of a source, by its extension (`.dtes` is Event Storming, every other source `.dt`). */
export const languageOf = (path: string): Collaboration.SourceLanguage => (isStormingFile(path) ? 'Dtes' : 'Dt');

/**
 * A path relative to the workspace's root as a `WorkspacePath`: `/`-separated, without `.`/`..` segments, empty
 * segments, a leading `/` or backslashes. Anything else is outside the root (or not a path below it).
 */
export function workspacePath(raw: string): Result<WorkspacePath, Collaboration.PathOutsideRoot> {
    const made = Collaboration.makeWorkspacePath(raw);
    return made.ok ? made : err({ type: 'PathOutsideRoot', path: raw });
}

/** A hexadecimal SHA-256 as a `ContentHash`; throws on anything else (a programming error, never input). */
export function contentHash(hex: string): ContentHash {
    const made = Collaboration.makeContentHash(hex);
    if (!made.ok) throw new Error(`Not a SHA-256: ${JSON.stringify(hex)}`);
    return made.value;
}

/** The content hash of a file's bytes. */
export const hashBytes = (bytes: Uint8Array): ContentHash => contentHash(sha256Hex(bytes));

/** The snapshot file of a source: its path, language, hash and size. */
export const snapshotFile = (path: WorkspacePath, bytes: Uint8Array, hash: ContentHash = hashBytes(bytes)): Collaboration.SnapshotFile => ({
    path,
    language: languageOf(path),
    hash,
    bytes: bytes.length,
});

/** Compares paths by UTF-16 code units: the canonical order, independent of the locale. */
export const comparePaths = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The content hash of a snapshot: the SHA-256 of `path NUL hash LF` for every file, in path order. Only the paths and
 * the files' hashes count (not their order as given, their language or size), so equal sources give equal hashes.
 */
export function snapshotHash(files: readonly HashedPath[]): ContentHash {
    const lines = [...files]
        .sort((a, b) => comparePaths(a.path, b.path))
        .map((f) => `${f.path}\u0000${f.hash}\n`)
        .join('');
    return hashBytes(encoder.encode(lines));
}

/** Whether a revision's content hash is the one its files give (`hashOfFiles`). */
export const holdsHashOfFiles = (revision: { readonly contentHash: ContentHash; readonly files: readonly HashedPath[] }): boolean =>
    snapshotHash(revision.files) === revision.contentHash;

/**
 * The paths whose content differs between two snapshots: added, removed or changed, sorted. Empty when both have the
 * same sources.
 */
export function changedPaths(before: readonly HashedPath[], after: readonly HashedPath[]): WorkspacePath[] {
    const was = new Map(before.map((f) => [f.path, f.hash]));
    const is = new Map(after.map((f) => [f.path, f.hash]));
    const paths = new Set([...was.keys(), ...is.keys()]);
    return [...paths].filter((p) => was.get(p) !== is.get(p)).sort(comparePaths);
}

/** A list as a non-empty tuple, or `undefined` when it is empty. */
export function nonEmpty<T>(xs: readonly T[]): readonly [T, ...T[]] | undefined {
    const [first, ...rest] = xs;
    return first === undefined ? undefined : [first, ...rest];
}
