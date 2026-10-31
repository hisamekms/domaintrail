// Where a session keeps its state: `.domaintrail/session/` below the workspace's root, with a `.gitignore` that
// ignores everything in it. Like the layout file (`.domaintrail/layout.json`), nothing is ever written through a
// symbolic link: a checked-out repository may contain `.domaintrail` or its children as links.
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export const SESSION_DIR = path.join('.domaintrail', 'session');
export const DATABASE_FILE = 'session.db';
export const BLOBS_DIR = 'blobs';
const GITIGNORE = '*\n';

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

/** Makes the directory `dir` if it is absent (its parent must exist), refusing a symbolic link. */
export async function plainDirectory(dir: string): Promise<void> {
    if ((await checkPlain(dir, 'directory')) === 'absent') {
        await mkdir(dir).catch((e: unknown) => {
            // made at the same time by someone else: checked again below
            if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
        });
        await checkPlain(dir, 'directory');
    }
}

/** Writes `text` to `file` through a new temporary file renamed into place (a rename replaces a link, never follows it). */
export async function replaceFile(file: string, text: string | Uint8Array): Promise<void> {
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(temp, text, { flag: 'wx' });
    await rename(temp, file);
}

/**
 * The session directory of a workspace, made if absent: `.domaintrail/session/` with its `.gitignore` (`*`). Throws
 * `UnsafeSessionPath` when `.domaintrail`, `.domaintrail/session` or the `.gitignore` is a symbolic link.
 */
export async function sessionDirectory(root: string): Promise<string> {
    const top = path.join(path.resolve(root), '.domaintrail');
    const dir = path.join(path.resolve(root), SESSION_DIR);
    await plainDirectory(top);
    await plainDirectory(dir);
    const ignore = path.join(dir, '.gitignore');
    if ((await checkPlain(ignore, 'file')) === 'absent' || (await readFile(ignore, 'utf8')) !== GITIGNORE) await replaceFile(ignore, GITIGNORE);
    return dir;
}
