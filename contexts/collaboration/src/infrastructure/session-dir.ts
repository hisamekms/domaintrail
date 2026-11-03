// Where a session keeps its state: `.domaintrail/session/` below the workspace's root, with a `.gitignore` that
// ignores everything in it. Like the layout file (`.domaintrail/layout.json`), nothing is ever written through a
// symbolic link: a checked-out repository may contain `.domaintrail` or its children as links. Everything in it is the
// user's alone: directories 0700, files 0600, whatever the umask, and tightened when found looser (older versions
// made them 0755 and 0644).
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export const SESSION_DIR = path.join('.domaintrail', 'session');
export const DATABASE_FILE = 'session.db';
export const BLOBS_DIR = 'blobs';
const GITIGNORE = '*\n';
/** The permissions of the session's directories and files: the user's alone. */
export const PRIVATE_DIR = 0o700;
export const PRIVATE_FILE = 0o600;

/** A path where a session's file would be, refused because it is a symbolic link or not what it should be. */
export class UnsafeSessionPath extends Error {}

/** Whether `p` is absent; throws `UnsafeSessionPath` when it is there but a symbolic link or not of the kind expected. */
export async function checkPlain(p: string, kind: 'directory' | 'file'): Promise<'absent' | 'present'> {
    const stat = await lstat(p).catch((e: unknown) => {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return undefined;
        throw e;
    });
    if (!stat) return 'absent';
    if (stat.isSymbolicLink()) throw new UnsafeSessionPath(`${p} is a symbolic link: a session never writes through one.`);
    if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) throw new UnsafeSessionPath(`${p} is not a ${kind}.`);
    return 'present';
}

/**
 * Sets the permissions of the file or directory `p` to `mode`, whatever the umask, through a handle opened without
 * following a symbolic link (one fails with `ELOOP`). Nothing on Windows, where the modes do not apply.
 */
export async function restrict(p: string, mode: number): Promise<void> {
    if (process.platform === 'win32') return;
    const handle = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        await handle.chmod(mode);
    } finally {
        await handle.close();
    }
}

/**
 * Whether the file or directory `p` allows more than `mode`, read with `lstat` (no handle is opened on it: closing one
 * would drop the POSIX locks SQLite holds on a database file of this process). False on Windows, where the modes do not
 * apply.
 */
export async function looserThan(p: string, mode: number): Promise<boolean> {
    if (process.platform === 'win32') return false;
    return ((await lstat(p)).mode & 0o777 & ~mode) !== 0;
}

/** Makes the directory `dir` (0700) if it is absent (its parent must exist), refusing a symbolic link; an existing one is made 0700. */
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

/**
 * Writes `text` to `file` through a new temporary file renamed into place (a rename replaces a link, never follows it).
 * The file is 0600, whatever the umask.
 */
export async function replaceFile(file: string, text: string | Uint8Array): Promise<void> {
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(temp, text, { flag: 'wx', mode: PRIVATE_FILE });
    await restrict(temp, PRIVATE_FILE);
    await rename(temp, file);
}

/**
 * The session directory of a workspace, made if absent: `.domaintrail/session/` with its `.gitignore` (`*`), and a
 * `.gitignore` (`*`) in `.domaintrail` when it has none (one there is left as it is), so that nothing of it is
 * committed by accident (files already tracked stay tracked). Both directories and both files are made the user's alone
 * (0700, 0600), existing ones too.
 * Throws `UnsafeSessionPath` when `.domaintrail`, `.domaintrail/session` or a `.gitignore` is a symbolic link.
 */
export async function sessionDirectory(root: string): Promise<string> {
    const top = path.join(path.resolve(root), '.domaintrail');
    const dir = path.join(path.resolve(root), SESSION_DIR);
    await plainDirectory(top);
    const topIgnore = path.join(top, '.gitignore');
    if ((await checkPlain(topIgnore, 'file')) === 'absent') await replaceFile(topIgnore, GITIGNORE);
    else await restrict(topIgnore, PRIVATE_FILE);
    await plainDirectory(dir);
    const ignore = path.join(dir, '.gitignore');
    if ((await checkPlain(ignore, 'file')) === 'absent' || (await readFile(ignore, 'utf8')) !== GITIGNORE) await replaceFile(ignore, GITIGNORE);
    else await restrict(ignore, PRIVATE_FILE);
    return dir;
}
