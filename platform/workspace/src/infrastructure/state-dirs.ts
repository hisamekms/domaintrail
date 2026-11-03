// Where dt keeps what it writes of a workspace: outside it, per user (ADR 0026, amendment "State outside the
// workspace"). The state — the session's database and blobs, the running server's address, the record of
// `dt generate ts` — in `$XDG_STATE_HOME/domaintrail/<workspace>/` (`~/.local/state/domaintrail/…`, macOS too); what
// can be made again — the layouts — in `$XDG_CACHE_HOME/domaintrail/<workspace>/` (`~/.cache/domaintrail/…`); on
// Windows `%LOCALAPPDATA%\domaintrail\state\<workspace>\` and `…\cache\<workspace>\`. `DOMAINTRAIL_STATE_DIR` replaces
// the state's root (CI, containers). `<workspace>` is the workspace's directory name and a short hash of its real path;
// `workspace.json` in each directory records that path, so that two workspaces of one hash, or a moved workspace, are
// told apart and said rather than mixed. Directories 0700, files 0600, whatever the umask; a workspace's directory (and
// what dt writes in it) is never a symbolic link. The roots themselves are the user's (their dotfiles may link them).
import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

/** Replaces the root of the state (the directories of the workspaces go below it). */
export const STATE_DIR_ENV = 'DOMAINTRAIL_STATE_DIR';
/** In each directory of a workspace: the workspace's real path. */
export const WORKSPACE_FILE = 'workspace.json';
/** The permissions of what dt writes there: the user's alone. */
export const PRIVATE_DIR = 0o700;
export const PRIVATE_FILE = 0o600;

/** What the locations depend on: injected by the tests (another platform, another environment). */
export interface StateEnvironment {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly platform: NodeJS.Platform;
    readonly home: string;
}

/** This process's environment, platform and home directory. */
export const currentEnvironment = (): StateEnvironment => ({ env: process.env, platform: process.platform, home: homedir() });

/** Where the directories of the workspaces are: their state, and their cache. */
export interface StateRoots {
    readonly state: string;
    readonly cache: string;
}

/** The directories of one workspace. */
export interface WorkspaceDirs {
    /** The workspace's real path (links followed). */
    readonly workspace: string;
    /** The name of its directories: `<basename>-<short hash of the real path>`. */
    readonly name: string;
    readonly state: string;
    readonly cache: string;
    readonly roots: StateRoots;
}

/** A state directory that cannot be used as it is: printed as one line. */
export class StateDirError extends Error {}

const pathOf = (platform: NodeJS.Platform): typeof path.posix => (platform === 'win32' ? path.win32 : path.posix);

/**
 * The roots of the state and the cache: XDG's (macOS too), else `~/.local/state` and `~/.cache`; on Windows below
 * `%LOCALAPPDATA%`. A relative `XDG_*` is ignored (as the XDG specification asks); a relative `DOMAINTRAIL_STATE_DIR`
 * is taken from the working directory.
 */
export function stateRoots(e: StateEnvironment = currentEnvironment()): StateRoots {
    const p = pathOf(e.platform);
    const absolute = (v: string | undefined): string | undefined => (v && p.isAbsolute(v) ? v : undefined);
    let state: string;
    let cache: string;
    if (e.platform === 'win32') {
        const local = absolute(e.env.LOCALAPPDATA) ?? p.join(e.home, 'AppData', 'Local');
        state = p.join(local, 'domaintrail', 'state');
        cache = p.join(local, 'domaintrail', 'cache');
    } else {
        state = p.join(absolute(e.env.XDG_STATE_HOME) ?? p.join(e.home, '.local', 'state'), 'domaintrail');
        cache = p.join(absolute(e.env.XDG_CACHE_HOME) ?? p.join(e.home, '.cache'), 'domaintrail');
    }
    const override = e.env[STATE_DIR_ENV];
    return { state: override ? p.resolve(override) : state, cache };
}

/**
 * The name of a workspace's directories: its directory name (letters, digits, `.`, `_` and `-` kept, the rest `_`, no
 * leading dot, 48 characters at most) and the first 8 hexadecimal digits of the SHA-256 of its real path.
 */
export function workspaceDirName(real: string, platform: NodeJS.Platform = process.platform): string {
    const base =
        pathOf(platform)
            .basename(real)
            .replace(/[^A-Za-z0-9._-]+/g, '_')
            .replace(/^\.+/, '')
            .slice(0, 48) || 'workspace';
    return `${base}-${createHash('sha256').update(real).digest('hex').slice(0, 8)}`;
}

/** The directories of the workspace at `root` (which must exist), nothing made. */
export function workspaceDirs(root: string, e: StateEnvironment = currentEnvironment()): WorkspaceDirs {
    const workspace = realpathSync.native(path.resolve(root));
    const roots = stateRoots(e);
    const name = workspaceDirName(workspace, e.platform);
    const p = pathOf(e.platform);
    return { workspace, name, state: p.join(roots.state, name), cache: p.join(roots.cache, name), roots };
}

/** Whether `p` is `dir` or below it. */
export const isWithin = (dir: string, p: string): boolean => {
    const rel = path.relative(dir, p);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

/** The real path of `p`, or of its nearest existing parent with the rest appended (`p` itself when none exists). */
export function realOrNearest(p: string): string {
    const rest: string[] = [];
    let at = path.resolve(p);
    for (;;) {
        try {
            return path.join(realpathSync.native(at), ...rest.reverse());
        } catch {
            const up = path.dirname(at);
            if (up === at) return path.resolve(p);
            rest.push(path.basename(at));
            at = up;
        }
    }
}

/**
 * Refuses directories of the workspace's inside it, or a workspace inside a root (the AI reads the workspace: the
 * session's state must stay out of what it reads, and nothing of dt's may show up in git).
 */
export function checkOutsideWorkspace(dirs: WorkspaceDirs): void {
    for (const [what, dir] of [
        ['state', dirs.roots.state],
        ['cache', dirs.roots.cache],
    ] as const) {
        const real = realOrNearest(dir);
        if (isWithin(dirs.workspace, real) || isWithin(real, dirs.workspace))
            throw new StateDirError(
                `dt's ${what} directory ${dir} and the workspace ${dirs.workspace} overlap: the session's files must stay outside the workspace. ${
                    what === 'state' ? `Set ${STATE_DIR_ENV}` : 'Set XDG_CACHE_HOME'
                } to a directory outside it.`,
            );
    }
}

/** Whether `p` is absent; throws `StateDirError` when it is there but a symbolic link or not of the kind expected. */
export async function checkPlain(p: string, kind: 'directory' | 'file'): Promise<'absent' | 'present'> {
    const stat = await lstat(p).catch((e: unknown) => {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return undefined;
        throw e;
    });
    if (!stat) return 'absent';
    if (stat.isSymbolicLink()) throw new StateDirError(`${p} is a symbolic link: dt never writes through one.`);
    if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) throw new StateDirError(`${p} is not a ${kind}.`);
    return 'present';
}

/** Sets the mode of `p` through a handle opened without following a link; nothing on Windows. */
export async function restrict(p: string, mode: number): Promise<void> {
    if (process.platform === 'win32') return;
    const handle = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        await handle.chmod(mode);
    } finally {
        await handle.close();
    }
}

/** Makes the directory `dir` (0700) if absent (its parent must exist), refusing a symbolic link; an existing one is made 0700. */
export async function plainDirectory(dir: string): Promise<void> {
    if ((await checkPlain(dir, 'directory')) === 'absent') {
        await mkdir(dir, { mode: PRIVATE_DIR }).catch((e: unknown) => {
            // made at the same time by someone else: checked again below
            if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
        });
        await checkPlain(dir, 'directory');
    }
    await restrict(dir, PRIVATE_DIR);
}

/** Writes `text` to `file` (0600) through a new temporary file renamed into place: a link there is replaced, never followed. */
export async function replaceFile(file: string, text: string | Uint8Array): Promise<void> {
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(temp, text, { flag: 'wx', mode: PRIVATE_FILE });
    await restrict(temp, PRIVATE_FILE);
    await rename(temp, file);
}

/**
 * `workspace.json`: the workspace a directory belongs to, and where its state was moved from (`.domaintrail/`) with
 * the SHA-256 of each file moved as it was there (`/`-separated paths below it).
 */
export interface WorkspaceRecord {
    readonly version: 1;
    readonly path: string;
    readonly movedFrom?: string;
    readonly moved?: Readonly<Record<string, string>>;
}

/** The record of `dir`, if it has a readable one. */
export async function readWorkspaceRecord(dir: string): Promise<WorkspaceRecord | undefined> {
    try {
        const file = path.join(dir, WORKSPACE_FILE);
        if ((await checkPlain(file, 'file')) === 'absent') return undefined;
        const v: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (typeof v !== 'object' || v === null || !('path' in v) || typeof v.path !== 'string') return undefined;
        const moved =
            'moved' in v && typeof v.moved === 'object' && v.moved !== null && !Array.isArray(v.moved)
                ? Object.fromEntries(Object.entries(v.moved).filter((e): e is [string, string] => typeof e[1] === 'string'))
                : undefined;
        return {
            version: 1,
            path: v.path,
            ...('movedFrom' in v && typeof v.movedFrom === 'string' && { movedFrom: v.movedFrom }),
            ...(moved && { moved }),
        };
    } catch {
        return undefined;
    }
}

export const writeWorkspaceRecord = (dir: string, record: WorkspaceRecord): Promise<void> =>
    replaceFile(path.join(dir, WORKSPACE_FILE), `${JSON.stringify(record, null, 2)}\n`);

/** Whether a process with this ID exists (EPERM: it does, someone else's). */
export function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e instanceof Error && 'code' in e && e.code === 'EPERM';
    }
}

/** Whether `p` exists (a link counts, followed or not). */
export const exists = async (p: string): Promise<boolean> => (await lstat(p).catch(() => undefined)) !== undefined;

/**
 * Makes the directory `dir` of the workspace below `root` (the root and its parents made 0700 when absent) and records
 * the workspace in it; one recorded for another workspace is refused (`StateDirError`): the same name and hash for
 * another path, or the record of a workspace that is gone. `made`: whether the directory had no record before.
 */
export async function workspaceDirectory(root: string, dir: string, workspace: string): Promise<{ made: boolean }> {
    await mkdir(root, { recursive: true, mode: PRIVATE_DIR });
    await plainDirectory(dir);
    const record = await readWorkspaceRecord(dir);
    if (!record) {
        await writeWorkspaceRecord(dir, { version: 1, path: workspace });
        return { made: true };
    }
    if (record.path === workspace) return { made: false };
    throw new StateDirError(
        (await exists(record.path))
            ? `${dir} holds the files of another workspace, ${record.path} (the same name and short hash as ${workspace}): set ${STATE_DIR_ENV} to keep this one's elsewhere.`
            : `${dir} holds the files of ${record.path}, which no longer exists: \`dt session prune --yes\` removes them (or move them into place if ${workspace} is that workspace moved).`,
    );
}

/**
 * The directories of a gone workspace with the same directory name as `dirs`' (its state kept under another hash): a
 * moved workspace's previous state, said once when this workspace's state directory is made.
 */
export async function movedFrom(dirs: WorkspaceDirs): Promise<{ readonly dir: string; readonly workspace: string }[]> {
    const prefix = `${dirs.name.slice(0, dirs.name.lastIndexOf('-'))}-`;
    const found: { dir: string; workspace: string }[] = [];
    for (const entry of await readdir(dirs.roots.state, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || entry.name === dirs.name || !entry.name.startsWith(prefix) || !/^[0-9a-f]{8}$/.test(entry.name.slice(prefix.length)))
            continue;
        const dir = path.join(dirs.roots.state, entry.name);
        const record = await readWorkspaceRecord(dir);
        if (record && !(await exists(record.path))) found.push({ dir, workspace: record.path });
    }
    return found;
}

/** `p` with the home directory written `~`. */
export function shownPath(p: string, home: string = homedir()): string {
    const rel = path.relative(home, p);
    return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? `~${path.sep}${rel}` : p;
}
