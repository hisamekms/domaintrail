// The bytes of the snapshots' files, content addressed: `.domaintrail/session/blobs/<first two hex digits>/<sha256>`.
// A content stored once is never stored again; a blob is written through a temporary file renamed into place, never
// through a symbolic link, and read back only when it still has its hash. Blobs are 0600 in directories 0700.
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { SnapshotBlobs } from '../application/ports.js';
import { BLOBS_DIR, PRIVATE_DIR, PRIVATE_FILE, checkPlain, plainDirectory, replaceFile, restrict, sessionDirectory } from './session-dir.js';

const SHA256 = /^[0-9a-f]{64}$/;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The blobs below `dir` (made if absent, its parent must exist). */
export function createFileBlobs(dir: string): SnapshotBlobs {
    const where = (hash: string): string => {
        // the hash names a file: only a SHA-256 may
        if (!SHA256.test(hash)) throw new Error(`Not a SHA-256: ${JSON.stringify(hash)}`);
        return path.join(dir, hash.slice(0, 2), hash);
    };
    return {
        async put(files) {
            const done = new Set<string>();
            for (const { hash, bytes } of files) {
                if (done.has(hash)) continue;
                const file = where(hash);
                if (sha256(bytes) !== hash) throw new Error(`The bytes given for blob ${hash} have another hash`);
                if ((await checkPlain(file, 'file')) === 'absent') {
                    await plainDirectory(dir);
                    await plainDirectory(path.dirname(file));
                    await replaceFile(file, bytes);
                }
                done.add(hash);
            }
        },
        async get(hash) {
            const file = where(hash);
            if ((await checkPlain(file, 'file')) === 'absent') return undefined;
            const bytes = new Uint8Array(await readFile(file));
            return sha256(bytes) === hash ? bytes : undefined;
        },
    };
}

/**
 * Makes the blobs already below `dir` (written by older versions, 0755 and 0644) the user's alone. Links are left
 * alone: a linked `dir` is refused when a blob is put.
 */
async function tightenBlobs(dir: string): Promise<void> {
    if (!(await lstat(dir).catch(() => undefined))?.isDirectory()) return;
    await restrict(dir, PRIVATE_DIR);
    for (const sub of await readdir(dir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const subDir = path.join(dir, sub.name);
        await restrict(subDir, PRIVATE_DIR);
        for (const blob of await readdir(subDir, { withFileTypes: true })) {
            if (blob.isFile()) await restrict(path.join(subDir, blob.name), PRIVATE_FILE);
        }
    }
}

/** The blobs of a workspace's session: `.domaintrail/session/blobs`, the existing ones made the user's alone. */
export async function openSessionBlobs(root: string): Promise<SnapshotBlobs> {
    const dir = path.join(await sessionDirectory(root), BLOBS_DIR);
    await tightenBlobs(dir);
    return createFileBlobs(dir);
}
