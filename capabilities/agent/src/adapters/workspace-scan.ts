// What files an agent run changed (ADR 0026, S6: the agent edits DSL sources only): every file below the root with a
// fingerprint of its metadata (type, size, mode, modification and change times in nanoseconds; a link's target),
// scanned before and after the agent. Symbolic links are recorded, never followed. `.domaintrail/` (where older
// versions kept the session's state and the layout; dt keeps them outside the workspace now), `.git` and
// `node_modules` are skipped, and the directories the caller names (`skip`): those only dt writes, which may change
// while the agent runs (the `files` knowledge store's `knowledge/`, written by the session's extractions and people's
// corrections).
import { lstat, readdir, readlink } from 'node:fs/promises';
import * as path from 'node:path';

/** Directory names never scanned, at any depth. */
const SKIPPED = new Set(['.domaintrail', '.git', 'node_modules']);
/** Most entries a scan records: beyond, the workspace is not one an agent should run in. */
const MAX_ENTRIES = 200_000;

export interface ScanOptions {
    /**
     * Directories of the root (relative, `/`-separated) never scanned: only a directory there is skipped, so that a
     * file or a link put in its place is still seen.
     */
    readonly skip?: readonly string[];
}

/** The files below `root` (relative, `/`-separated) and their fingerprints. */
export async function scanWorkspace(root: string, options: ScanOptions = {}): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    const skipped = new Set(options.skip ?? []);
    const walk = async (dir: string, rel: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (!SKIPPED.has(entry.name) && !skipped.has(relPath)) await walk(full, relPath);
                continue;
            }
            if (files.size >= MAX_ENTRIES) throw new Error(`More than ${MAX_ENTRIES} files below ${root}: too many to compare before and after the agent`);
            const s = await lstat(full, { bigint: true }).catch((e: unknown) => {
                // removed between the listing and now: absent
                if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return undefined;
                throw e;
            });
            if (!s) continue;
            const kind = s.isSymbolicLink() ? `link:${await readlink(full)}` : s.isFile() ? 'file' : 'other';
            files.set(relPath, `${kind}|${s.size}|${s.mode}|${s.mtimeNs}|${s.ctimeNs}`);
        }
    };
    await walk(path.resolve(root), '');
    return files;
}
