// The move of what older versions kept in the workspace, `.domaintrail/`, to the workspace's state and cache
// directories (./state-dirs.ts), on the first run of a version that keeps them there. The session's database moves
// with its WAL files as one, and only while no server of an older version runs on it (its `server.json` names a live
// process: refused, said). The files are copied into a new directory beside the state directory, checked, and that
// directory renamed into place; `.domaintrail/` is deleted only then. A run stopped half way leaves either the
// workspace's files where they were (a copy left behind is removed by the next run) or both copies, which the next run
// recognizes (`workspace.json` says where they were moved from) and finishes. A state directory that already holds a
// session is never overwritten: `.domaintrail/` is kept and that is said.
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import {
    PRIVATE_DIR,
    PRIVATE_FILE,
    StateDirError,
    WORKSPACE_FILE,
    type WorkspaceDirs,
    exists,
    plainDirectory,
    processAlive,
    readWorkspaceRecord,
    replaceFile,
    restrict,
    shownPath,
    workspaceDirectory,
    writeWorkspaceRecord,
} from './state-dirs.js';

/** Where older versions kept the workspace's state, below its root. */
export const LEGACY_DIR = '.domaintrail';

/** A file of `.domaintrail/` (`/`-separated, relative to it) and where it goes: the state or the cache directory. */
interface Moved {
    readonly from: string;
    readonly to: string;
    readonly into: 'state' | 'cache';
}

/** The files older versions wrote, by where they go; anything else in `.domaintrail/` is not dt's, and stays. */
const FILES: readonly Moved[] = [
    { from: 'session/session.db', to: 'session.db', into: 'state' },
    { from: 'session/session.db-wal', to: 'session.db-wal', into: 'state' },
    { from: 'session/session.db-shm', to: 'session.db-shm', into: 'state' },
    { from: 'generated.json', to: 'generated.json', into: 'state' },
    { from: 'seed.json', to: 'seed.json', into: 'state' },
    { from: 'layout.json', to: 'layout.json', into: 'cache' },
];
/** The blobs: `session/blobs/<two hex digits>/<sha256>`, to `blobs/…` in the state directory. */
const BLOBS = 'session/blobs';
/** What older versions wrote that is not kept: their ignore files, a stopped server's address, a credential. */
const DROPPED = new Set(['.gitignore', 'session/.gitignore', 'session/server.json', 'session/agent.json']);
const DIRECTORIES = new Set(['session', BLOBS]);

/** What `.domaintrail/` holds: the files to move, what is dropped, and the entries that are not dt's. */
interface Inventory {
    readonly moved: Moved[];
    readonly dropped: string[];
    readonly foreign: string[];
}

const toPosix = (p: string): string => p.split(path.sep).join('/');

const sha256 = async (file: string): Promise<string> =>
    createHash('sha256')
        .update(await readFile(file))
        .digest('hex');

/** The files below `legacy` and what becomes of them; links are never followed (one is not dt's). */
async function inventory(legacy: string): Promise<Inventory> {
    const moved: Moved[] = [];
    const dropped: string[] = [];
    const foreign: string[] = [];
    const known = new Map(FILES.map((f) => [f.from, f]));
    const walk = async (rel: string): Promise<void> => {
        for (const entry of await readdir(path.join(legacy, rel), { withFileTypes: true })) {
            const p = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory() && DIRECTORIES.has(p)) await walk(p);
            else if (entry.isDirectory() && rel === BLOBS && /^[0-9a-f]{2}$/.test(entry.name)) {
                for (const blob of await readdir(path.join(legacy, p), { withFileTypes: true })) {
                    const b = `${p}/${blob.name}`;
                    if (blob.isFile() && /^[0-9a-f]{64}$/.test(blob.name)) moved.push({ from: b, to: b.slice('session/'.length), into: 'state' });
                    else foreign.push(b);
                }
            } else if (entry.isFile() && known.has(p)) moved.push(known.get(p)!);
            else if (entry.isFile() && DROPPED.has(p)) dropped.push(p);
            else foreign.push(p);
        }
    };
    await walk('');
    return { moved, dropped, foreign };
}

/** Whether every file of `moved` still in `legacy` is the same as its copy in `dirs` (a copy missing: not the same). */
async function sameCopies(legacy: string, moved: readonly Moved[], dirs: WorkspaceDirs): Promise<boolean> {
    for (const m of moved) {
        const from = path.join(legacy, m.from);
        if (!(await exists(from))) continue;
        const to = path.join(dirs[m.into], m.to);
        if (!(await exists(to)) || (await sha256(from)) !== (await sha256(to))) return false;
    }
    return true;
}

/** Whether the state directory holds anything but its record (a session, generated files, ...). */
async function holdsData(dir: string): Promise<boolean> {
    const entries = await readdir(dir).catch(() => []);
    return entries.some((e) => e !== WORKSPACE_FILE);
}

/** Copies `from` to `to` (a new file, 0600), checked to have the same bytes. */
async function copyChecked(from: string, to: string): Promise<void> {
    await copyFile(from, to, constants.COPYFILE_EXCL);
    await restrict(to, PRIVATE_FILE);
    if ((await sha256(from)) !== (await sha256(to))) throw new Error(`The copy of ${from} differs from it`);
}

/** Removes the copies a run stopped half way left beside the state directory (their process is gone). */
async function removeUnfinished(dirs: WorkspaceDirs): Promise<void> {
    const prefix = `.${dirs.name}.moving-`;
    for (const entry of await readdir(dirs.roots.state, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
        const pid = Number(entry.name.slice(prefix.length).split('-')[0]);
        if (Number.isInteger(pid) && pid !== process.pid && processAlive(pid)) continue;
        await rm(path.join(dirs.roots.state, entry.name), { recursive: true, force: true });
    }
}

/** Deletes what dt wrote in `legacy`, then `legacy` itself if nothing else is left. Whether it is gone. */
async function removeLegacy(legacy: string, inv: Inventory): Promise<boolean> {
    for (const m of inv.moved) await rm(path.join(legacy, m.from), { force: true });
    // only what the walk found below plain directories: never through a link
    for (const d of inv.dropped) await rm(path.join(legacy, d), { force: true });
    // the blobs' directories, then the session's, then `.domaintrail` itself: each only when empty
    const blobs = path.join(legacy, BLOBS);
    for (const sub of await readdir(blobs).catch(() => [])) await rmdir(path.join(blobs, sub)).catch(() => undefined);
    for (const d of [BLOBS, 'session', '']) await rmdir(path.join(legacy, d)).catch(() => undefined);
    return !(await exists(legacy));
}

/** What became of `.domaintrail/`. */
export type LegacyMove = 'none' | 'moved' | 'finished' | 'kept';

/**
 * Moves the workspace's `.domaintrail/` (if it has one) to its state and cache directories `dirs`, saying so with
 * `log`. Refuses (`StateDirError`) while a server of an older version runs on it. A `.domaintrail` that is a symbolic
 * link or not a directory is not dt's: left alone.
 */
export async function moveLegacyState(dirs: WorkspaceDirs, log: (line: string) => void): Promise<LegacyMove> {
    const legacy = path.join(dirs.workspace, LEGACY_DIR);
    const stat = await lstat(legacy).catch(() => undefined);
    if (!stat?.isDirectory()) return 'none';
    const where = shownPath(dirs.state);
    const server = await readFile(path.join(legacy, 'session', 'server.json'), 'utf8')
        .then((t): unknown => JSON.parse(t))
        .catch(() => undefined);
    const pid = typeof server === 'object' && server !== null && 'pid' in server && typeof server.pid === 'number' ? server.pid : undefined;
    if (pid !== undefined && pid !== process.pid && processAlive(pid))
        throw new StateDirError(
            `A session server of an older dt (pid ${pid}) runs on this workspace, with its files in ${LEGACY_DIR}/: stop it, then run dt again to move them to ${where} (or remove ${LEGACY_DIR}/session/server.json if no such server runs).`,
        );
    const inv = await inventory(legacy);
    const keep = (why: string): LegacyMove => {
        log(why);
        return 'kept';
    };

    await mkdir(dirs.roots.state, { recursive: true, mode: PRIVATE_DIR });
    await removeUnfinished(dirs);
    const toState = inv.moved.filter((m) => m.into === 'state');
    if (toState.length && (await holdsData(dirs.state))) {
        // moved by a run that stopped before deleting `.domaintrail/` (or by another process just now): finished
        const record = await readWorkspaceRecord(dirs.state);
        if (record?.path === dirs.workspace && record.movedFrom === legacy && (await sameCopies(legacy, toState, dirs))) {
            const gone = await removeLegacy(legacy, inv);
            if (!gone) log(`Kept ${LEGACY_DIR}/: it holds files that are not dt's (${inv.foreign.join(', ')}).`);
            return 'finished';
        }
        return keep(`Kept ${LEGACY_DIR}/ as it is: ${where} already holds this workspace's files (remove one of them to choose).`);
    }

    // the state: copied into a directory of this run's beside the state directory, checked, renamed into place
    if (toState.length) {
        const staging = path.join(dirs.roots.state, `.${dirs.name}.moving-${process.pid}-${randomBytes(4).toString('hex')}`);
        await mkdir(staging, { mode: PRIVATE_DIR });
        try {
            await restrict(staging, PRIVATE_DIR);
            for (const m of toState) {
                const to = path.join(staging, m.to);
                for (let d = path.dirname(m.to); d !== '.'; d = path.dirname(d)) await mkdir(path.join(staging, d), { recursive: true, mode: PRIVATE_DIR });
                await copyChecked(path.join(legacy, m.from), to);
            }
            for (const d of await readdir(path.join(staging, 'blobs')).catch(() => [])) await restrict(path.join(staging, 'blobs', d), PRIVATE_DIR);
            if (await exists(path.join(staging, 'blobs'))) await restrict(path.join(staging, 'blobs'), PRIVATE_DIR);
            await writeWorkspaceRecord(staging, { version: 1, path: dirs.workspace, movedFrom: legacy });
            // an empty state directory (its record only) gives way; one with files was handled above
            if (await exists(dirs.state)) {
                await plainDirectory(dirs.state);
                await unlink(path.join(dirs.state, WORKSPACE_FILE)).catch(() => undefined);
                await rmdir(dirs.state);
            }
            await rename(staging, dirs.state);
        } catch (e) {
            await rm(staging, { recursive: true, force: true });
            if (e instanceof Error && 'code' in e && (e.code === 'ENOTEMPTY' || e.code === 'EEXIST')) {
                // another process moved them first
                if (await sameCopies(legacy, toState, dirs)) {
                    await removeLegacy(legacy, inv);
                    return 'finished';
                }
                return keep(`Kept ${LEGACY_DIR}/ as it is: ${where} already holds this workspace's files (remove one of them to choose).`);
            }
            throw e;
        }
    }

    // the layouts: regenerable, copied when the cache has none
    const layout = inv.moved.find((m) => m.into === 'cache');
    if (layout) {
        await workspaceDirectory(dirs.roots.cache, dirs.cache, dirs.workspace);
        const to = path.join(dirs.cache, layout.to);
        if (!(await exists(to))) await replaceFile(to, await readFile(path.join(legacy, layout.from)));
    }

    const gone = await removeLegacy(legacy, inv);
    if (toState.length || layout) log(`Moved ${LEGACY_DIR}/ to ${where}${path.sep}`);
    else if (gone) log(`Removed ${LEGACY_DIR}/ (nothing in it to keep).`);
    if (!gone) log(`Kept ${LEGACY_DIR}/: it holds files that are not dt's (${inv.foreign.map(toPosix).join(', ')}).`);
    return 'moved';
}
