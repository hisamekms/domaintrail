// The move of what older versions kept in the workspace, `.domaintrail/`, to the workspace's state and cache
// directories (./state-dirs.ts), on the first run of a version that keeps them there. The session's database moves
// with its WAL files as one, and only while no server of an older version runs on it (its `server.json` names a live
// process: refused, said). The files are copied into a new directory beside the state directory, checked, and that
// directory renamed into place; `.domaintrail/` is deleted only then. A run stopped half way leaves either the
// workspace's files where they were (a copy left behind is removed by the next run) or both copies, which the next run
// recognizes (`workspace.json` says where they were moved from and what they were) and finishes. A state directory
// that already holds a session is never overwritten: `.domaintrail/` is kept and that is said.
//
// A `.domaintrail/` may also have come with a cloned repository, crafted: it is imported only as far as it can be
// trusted. Nothing moves when git tracks or does not ignore anything in it (dt's own was always ignored by its own
// `.gitignore`), or when git cannot tell; only regular files of the user's, in directories nobody else can write, move
// (the database with its WAL files all or none); the moved database must be one dt made (the app's `clean` checks its
// schema) and loses every credential (sign-ins, facilitator links, pairing and sign-in codes, invites, the
// facilitator's binding: made again by the links the server prints), else it is not moved; and `generated.json`,
// which says which files `dt generate ts` deletes, is never moved. The directory must be named exactly `.domaintrail`
// on disk (a case variant on a case-insensitive file system is not dt's).
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { gitExposedEntries } from './git-files.js';
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
    type WorkspaceRecord,
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
    { from: 'seed.json', to: 'seed.json', into: 'state' },
    { from: 'layout.json', to: 'layout.json', into: 'cache' },
];
/** The blobs: `session/blobs/<two hex digits>/<sha256>`, to `blobs/…` in the state directory. */
const BLOBS = 'session/blobs';
/**
 * What older versions wrote that is not kept: their ignore files, a stopped server's address, a credential, and the
 * record of `dt generate ts` (it says which files a run deletes: not taken from a directory that may be foreign; the
 * next run records its own, and generated files of earlier runs outside its output directories stay).
 */
const DROPPED = new Set(['.gitignore', 'session/.gitignore', 'session/server.json', 'session/agent.json', 'generated.json']);
/** The session's database and its WAL files: moved all or none. */
const DATABASE = new Set(['session/session.db', 'session/session.db-wal', 'session/session.db-shm']);
/**
 * Cleans the moved copy of the session's database (its WAL files beside it) of its credentials, after checking that it
 * is one dt made; false: it must not be moved. Given by the app (the collaboration owns the schema).
 */
export type CleanDatabase = (file: string) => boolean;
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

/** Whether every file of `moved` still in `legacy` is what `record` says was moved from there (none recorded: no). */
async function movedAsRecorded(legacy: string, moved: readonly Moved[], record: WorkspaceRecord | undefined): Promise<boolean> {
    if (record?.movedFrom !== legacy || !record.moved) return false;
    for (const m of moved) {
        const from = path.join(legacy, m.from);
        if (!(await exists(from))) continue;
        if (record.moved[m.from] !== (await sha256(from))) return false;
    }
    return true;
}

/** Whether `p` (not followed) is the user's and nobody else can write it; always on Windows, where the modes do not apply. */
async function yours(p: string, kind: 'file' | 'directory'): Promise<boolean> {
    const s = await lstat(p).catch(() => undefined);
    if (!s || (kind === 'file' ? !s.isFile() : !s.isDirectory())) return false;
    if (process.platform === 'win32' || !process.getuid) return true;
    return s.uid === process.getuid() && (kind === 'file' || (s.mode & 0o022) === 0);
}

/**
 * The files of `moved` that can be trusted: regular files of the user's, in directories (from `.domaintrail` down) of
 * the user's that nobody else can write. The database and its WAL files go together: one refused refuses them all.
 */
async function trusted(legacy: string, moved: readonly Moved[]): Promise<{ readonly ok: Moved[]; readonly refused: string[] }> {
    const dirOk = new Map<string, boolean>();
    const dirTrusted = async (rel: string): Promise<boolean> => {
        if (!dirOk.has(rel)) dirOk.set(rel, (rel === '.' || (await dirTrusted(path.posix.dirname(rel)))) && (await yours(path.join(legacy, rel), 'directory')));
        return dirOk.get(rel)!;
    };
    const fine = new Set<string>();
    for (const m of moved) if ((await dirTrusted(path.posix.dirname(m.from))) && (await yours(path.join(legacy, m.from), 'file'))) fine.add(m.from);
    const db = moved.filter((m) => DATABASE.has(m.from));
    if (db.some((m) => !fine.has(m.from))) for (const m of db) fine.delete(m.from);
    return { ok: moved.filter((m) => fine.has(m.from)), refused: moved.filter((m) => !fine.has(m.from)).map((m) => m.from) };
}

/** Whether the state directory holds anything but its record (a session, generated files, ...). */
async function holdsData(dir: string): Promise<boolean> {
    const entries = await readdir(dir).catch(() => []);
    return entries.some((e) => e !== WORKSPACE_FILE);
}

/** Copies `from` to `to` (a new file, 0600), checked to have the same bytes; their SHA-256. */
async function copyChecked(from: string, to: string): Promise<string> {
    await copyFile(from, to, constants.COPYFILE_EXCL);
    await restrict(to, PRIVATE_FILE);
    const hash = await sha256(from);
    if (hash !== (await sha256(to))) throw new Error(`The copy of ${from} differs from it`);
    return hash;
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

/** At most `n` of `items`, and how many more. */
const some = (items: readonly string[], n = 5): string =>
    items.length > n ? `${items.slice(0, n).join(', ')} and ${items.length - n} more` : items.join(', ');

/**
 * Moves the workspace's `.domaintrail/` (if it has one) to its state and cache directories `dirs`, saying so with
 * `log`. Refuses (`StateDirError`) while a server of an older version runs on it. A `.domaintrail` that is a symbolic
 * link or not a directory is not dt's: left alone. One that git tracks or does not ignore (or of which git cannot
 * tell) is left as it is, and said: the workspace starts a new session.
 */
export async function moveLegacyState(dirs: WorkspaceDirs, log: (line: string) => void, clean?: CleanDatabase): Promise<LegacyMove> {
    const legacy = path.join(dirs.workspace, LEGACY_DIR);
    // by its name on disk: on a case-insensitive file system `.DomainTrail` answers to `.domaintrail` too
    const named = (await readdir(dirs.workspace).catch(() => [])).filter((n) => n.normalize('NFC').toLowerCase() === LEGACY_DIR);
    if (!named.length) return 'none';
    const stat = await lstat(legacy).catch(() => undefined);
    if (!stat?.isDirectory()) return 'none';
    if (!named.includes(LEGACY_DIR)) {
        log(`Not moving ${named[0]}/: dt only ever wrote ${LEGACY_DIR}/, by that exact name. It stays as it is.`);
        return 'kept';
    }
    const where = shownPath(dirs.state);
    const server = await readFile(path.join(legacy, 'session', 'server.json'), 'utf8')
        .then((t): unknown => JSON.parse(t))
        .catch(() => undefined);
    const pid = typeof server === 'object' && server !== null && 'pid' in server && typeof server.pid === 'number' ? server.pid : undefined;
    if (pid !== undefined && pid !== process.pid && processAlive(pid))
        throw new StateDirError(
            `A session server of an older dt (pid ${pid}) runs on this workspace, with its files in ${LEGACY_DIR}/: stop it, then run dt again to move them to ${where} (or remove ${LEGACY_DIR}/session/server.json if no such server runs).`,
        );
    const keep = (why: string): LegacyMove => {
        log(why);
        return 'kept';
    };
    const fresh = `It stays as it is, and this workspace starts a new session in ${where}; delete ${LEGACY_DIR}/ once you no longer need it`;
    // dt's own `.domaintrail/` was always ignored by its own `.gitignore`: one a commit may hold may be anyone's
    let exposed: string[] | undefined;
    try {
        exposed = await gitExposedEntries(dirs.workspace, LEGACY_DIR);
    } catch (e) {
        return keep(`Not moving ${LEGACY_DIR}/: git cannot tell whether it ignores it (${e instanceof Error ? e.message : String(e)}). ${fresh}.`);
    }
    if (exposed?.length)
        return keep(
            `Not moving ${LEGACY_DIR}/: git tracks or does not ignore ${some(exposed)}, so it may have come with the repository rather than from dt. ${fresh} (\`git rm -r --cached ${LEGACY_DIR}\` if git tracks it).`,
        );
    const found = await inventory(legacy);
    const { ok, refused } = await trusted(legacy, found.moved);
    if (refused.length)
        log(
            `Not moving ${refused.length} file(s) of ${LEGACY_DIR}/ (not a plain file of yours, or in a directory others can write): ${some(refused)}. They stay there.`,
        );
    const inv: Inventory = { moved: ok, dropped: found.dropped, foreign: [...found.foreign, ...refused] };

    await mkdir(dirs.roots.state, { recursive: true, mode: PRIVATE_DIR });
    await removeUnfinished(dirs);
    const toState = inv.moved.filter((m) => m.into === 'state');
    if (toState.length && (await holdsData(dirs.state))) {
        // moved by a run that stopped before deleting `.domaintrail/` (or by another process just now): finished
        const record = await readWorkspaceRecord(dirs.state);
        if (record?.path === dirs.workspace && (await movedAsRecorded(legacy, toState, record))) {
            const gone = await removeLegacy(legacy, inv);
            if (!gone) log(`Kept ${LEGACY_DIR}/: it holds files that are not dt's (${[...inv.foreign].sort().join(', ')}).`);
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
            const moved: Record<string, string> = {};
            for (const m of toState) {
                const to = path.join(staging, m.to);
                for (let d = path.dirname(m.to); d !== '.'; d = path.dirname(d)) await mkdir(path.join(staging, d), { recursive: true, mode: PRIVATE_DIR });
                moved[m.from] = await copyChecked(path.join(legacy, m.from), to);
            }
            for (const d of await readdir(path.join(staging, 'blobs')).catch(() => [])) await restrict(path.join(staging, 'blobs', d), PRIVATE_DIR);
            if (await exists(path.join(staging, 'blobs'))) await restrict(path.join(staging, 'blobs'), PRIVATE_DIR);
            // the copy loses every credential before it is in place; one that cannot be cleaned is not moved
            if (toState.some((m) => DATABASE.has(m.from)) && !clean?.(path.join(staging, 'session.db'))) {
                for (const m of toState.filter((t) => DATABASE.has(t.from))) {
                    await rm(path.join(staging, m.to), { force: true });
                    delete moved[m.from];
                }
                await rm(path.join(staging, 'session.db-journal'), { force: true });
                inv.foreign.push(...toState.filter((t) => DATABASE.has(t.from)).map((t) => t.from));
                inv.moved.splice(0, inv.moved.length, ...inv.moved.filter((t) => !DATABASE.has(t.from)));
                log(
                    `Not moving ${LEGACY_DIR}/session/session.db: it is not a session database of dt's (its schema is not one dt made), or it could not be cleaned of its credentials. It stays there.`,
                );
            }
            for (const f of ['session.db', 'session.db-wal', 'session.db-shm'])
                if (await exists(path.join(staging, f))) await restrict(path.join(staging, f), PRIVATE_FILE);
            await writeWorkspaceRecord(staging, { version: 1, path: dirs.workspace, movedFrom: legacy, moved });
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
                if (await movedAsRecorded(legacy, toState, await readWorkspaceRecord(dirs.state))) {
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
    if (!gone) log(`Kept ${LEGACY_DIR}/: it holds files that are not dt's (${inv.foreign.map(toPosix).sort().join(', ')}).`);
    return 'moved';
}
