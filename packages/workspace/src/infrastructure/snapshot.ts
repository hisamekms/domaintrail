// The sources of a workspace as snapshots (ADR 0026): read them all (`.dt` and `.dtes`, as `SourceScope` decides),
// and write one back. It implements the `WorkspaceSnapshot` port of `@domaintrail/collaboration` structurally (ADR
// 0025: writes to the sources are a port on the consumer's side, implemented here), with plain strings for paths.
// Paths are relative to the root and `/`-separated. Symbolic links are never followed: they are reported by `read` and
// make `write` refuse.
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { DEFAULT_SOURCES } from '@domaintrail/modeling/core/config';
import { SourceScope } from './files.js';

export interface SnapshotScan {
    readonly files: readonly { readonly path: string; readonly bytes: Uint8Array; readonly hash: string }[];
    /** Symbolic links where a source or a directory of sources could be: not followed, not read. */
    readonly symlinks: readonly string[];
}

export type SnapshotWriteRefusal =
    | { readonly type: 'SymlinkInWorkspace'; readonly path: string }
    | { readonly type: 'PathOutsideRoot'; readonly path: string }
    | { readonly type: 'ExternalChangesSinceSnapshot'; readonly paths: readonly string[] };

export interface WorkspaceSnapshotFiles {
    read(): Promise<SnapshotScan>;
    write(
        files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
        expected: readonly { readonly path: string; readonly hash: string }[],
    ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: SnapshotWriteRefusal }>;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const posix = (rel: string): string => rel.split(path.sep).join('/');
const isSource = (rel: string): boolean => rel.endsWith('.dt') || rel.endsWith('.dtes');

async function lstatOrAbsent(p: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
    return lstat(p).catch((e: unknown) => {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return undefined;
        throw e;
    });
}

/** The snapshots of the sources below `root`, as `loadWorkspace` finds them (`sources`, `.gitignore`). */
export function createWorkspaceSnapshot(root: string, sources: readonly string[] = DEFAULT_SOURCES, respectGitignore = true): WorkspaceSnapshotFiles {
    const scope = new SourceScope(root, sources, respectGitignore);

    async function read(): Promise<SnapshotScan> {
        const files: { path: string; bytes: Uint8Array; hash: string }[] = [];
        const symlinks: string[] = [];
        const walk = async (dir: string): Promise<void> => {
            for (const entry of await readdir(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isSymbolicLink()) {
                    // a link to a directory may hold sources, a link named like a source would be one: neither is followed
                    if (scope.includesDirectory(full) || scope.sourcePath(full) !== undefined) symlinks.push(posix(path.relative(scope.root, full)));
                } else if (entry.isDirectory()) {
                    if (scope.includesDirectory(full)) await walk(full);
                } else if (entry.isFile()) {
                    const rel = scope.sourcePath(full);
                    if (rel === undefined) continue;
                    const bytes = new Uint8Array(await readFile(full));
                    files.push({ path: posix(rel), bytes, hash: sha256(bytes) });
                }
            }
        };
        await walk(scope.root);
        files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        return { files, symlinks: symlinks.sort() };
    }

    /** The absolute path of a relative source path, when it stays inside the root and is a source there. */
    function inside(rel: string): string | undefined {
        if (rel === '' || rel.includes('\\') || path.posix.isAbsolute(rel) || path.posix.normalize(rel) !== rel || rel.split('/').includes('..'))
            return undefined;
        const full = path.resolve(scope.root, ...rel.split('/'));
        const back = path.relative(scope.root, full);
        if (back === '' || back.startsWith('..') || path.isAbsolute(back) || !isSource(rel)) return undefined;
        return scope.sourcePath(full) === undefined ? undefined : full;
    }

    /** The first component of `rel` (a directory on the way, or the file) that is a symbolic link. */
    async function linkOnTheWay(rel: string): Promise<string | undefined> {
        const parts = rel.split('/');
        for (let i = 1; i <= parts.length; i++) {
            const stat = await lstatOrAbsent(path.join(scope.root, ...parts.slice(0, i)));
            if (!stat) return undefined;
            if (stat.isSymbolicLink()) return parts.slice(0, i).join('/');
        }
        return undefined;
    }

    let temps = 0;

    return {
        read,

        async write(files, expected) {
            for (const f of files) if (inside(f.path) === undefined) return { ok: false, error: { type: 'PathOutsideRoot', path: f.path } };
            for (const f of files) {
                const link = await linkOnTheWay(f.path);
                if (link !== undefined) return { ok: false, error: { type: 'SymlinkInWorkspace', path: link } };
            }
            const now = await read();
            const [link] = now.symlinks;
            if (link !== undefined) return { ok: false, error: { type: 'SymlinkInWorkspace', path: link } };
            const was = new Map(expected.map((f) => [f.path, f.hash]));
            const is = new Map(now.files.map((f) => [f.path, f.hash]));
            const changed = [...new Set([...was.keys(), ...is.keys()])].filter((p) => was.get(p) !== is.get(p)).sort();
            if (changed.length) return { ok: false, error: { type: 'ExternalChangesSinceSnapshot', paths: changed } };

            const keep = new Set(files.map((f) => f.path));
            for (const f of files) {
                if (is.get(f.path) === sha256(f.bytes)) continue;
                const full = inside(f.path);
                if (full === undefined) return { ok: false, error: { type: 'PathOutsideRoot', path: f.path } };
                // the directories on the way, one at a time, none of them a link (checked above, and again when made)
                const parts = f.path.split('/').slice(0, -1);
                for (let i = 1; i <= parts.length; i++) {
                    const dir = path.join(scope.root, ...parts.slice(0, i));
                    const stat = await lstatOrAbsent(dir);
                    if (!stat) await mkdir(dir);
                    else if (stat.isSymbolicLink() || !stat.isDirectory())
                        return { ok: false, error: { type: 'SymlinkInWorkspace', path: parts.slice(0, i).join('/') } };
                }
                // a rename replaces whatever is at the target (a link included) instead of writing through it
                const temp = path.join(path.dirname(full), `.${path.basename(full)}.${process.pid}.${++temps}.restore.tmp`);
                await writeFile(temp, f.bytes, { flag: 'wx' });
                await rename(temp, full);
            }
            for (const f of now.files) if (!keep.has(f.path)) await unlink(path.join(scope.root, ...f.path.split('/')));
            return { ok: true };
        },
    };
}
