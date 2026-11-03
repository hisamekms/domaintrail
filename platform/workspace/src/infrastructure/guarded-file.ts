// A text file dt writes itself, next to the sources (the journey file, `domaintrail.journey.json`): read whole, and
// written whole and atomically (a temporary file in the same directory, renamed over it) only when its content is
// still the one read — a write of another tool or of git meanwhile is never overwritten. Writes of this process are
// serialized; the check and the rename are as close as the file system allows. Watched on its own (one file, not the
// tree): its directory's events for that name, settled after a short burst.
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { watch } from 'chokidar';
import type { Unsubscribe } from '../ports.js';

/** A text file read and written whole: `write` only over the content `expected` (undefined: no file). */
export interface GuardedTextFile {
    readonly path: string;
    /** The file's text now; undefined when there is none. */
    read(): Promise<string | undefined>;
    /** Writes `text` atomically when the file's text is still `expected`; false (nothing written) when it changed. */
    write(text: string, expected: string | undefined): Promise<boolean>;
}

const readText = async (file: string): Promise<string | undefined> => {
    try {
        return await readFile(file, 'utf8');
    } catch (e) {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return undefined;
        throw e;
    }
};

export function createGuardedTextFile(file: string): GuardedTextFile {
    let tail: Promise<unknown> = Promise.resolve();
    return {
        path: file,
        read: () => readText(file),
        write(text, expected) {
            const run = async (): Promise<boolean> => {
                if ((await readText(file)) !== expected) return false;
                const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
                try {
                    await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
                    // the last look before the rename: a write that came meanwhile wins
                    if ((await readText(file)) !== expected) return false;
                    await rename(tmp, file);
                    return true;
                } finally {
                    await rm(tmp, { force: true });
                }
            };
            const next = tail.then(run, run);
            tail = next.catch(() => undefined);
            return next;
        },
    };
}

/** Watches one file (its creation, change and removal), calling `onChanged` once a burst of events settles (default 80 ms). */
export function watchFile(file: string, onChanged: () => void, debounceMs = 80): Promise<Unsubscribe> {
    const name = path.basename(file);
    const watcher = watch(path.dirname(file), {
        ignoreInitial: true,
        depth: 0,
        ignored: (p, stats) => p !== path.dirname(file) && (path.basename(p) !== name || stats?.isDirectory() === true),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    watcher.on('all', (_event, p: string) => {
        if (path.basename(p) !== name) return;
        clearTimeout(timer);
        timer = setTimeout(onChanged, debounceMs);
    });
    return new Promise((resolve) =>
        watcher.once('ready', () =>
            resolve(async () => {
                clearTimeout(timer);
                await watcher.close();
                clearTimeout(timer);
            }),
        ),
    );
}
