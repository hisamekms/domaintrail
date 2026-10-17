import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { SourceFile } from './analyze.js';
import { DEFAULT_SOURCES, IGNORED_DIRS, sourceMatcher } from './config.js';

/** Finds DSL files below `root` matching `sources` globs, returning paths relative to `root`, sorted. */
export async function findDomainFiles(root: string, sources: readonly string[] = DEFAULT_SOURCES): Promise<string[]> {
    const matches = sourceMatcher(sources);
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!IGNORED_DIRS.has(entry.name)) await walk(full);
            } else if (entry.isFile() && matches(path.relative(root, full))) {
                out.push(path.relative(root, full));
            }
        }
    };
    await walk(root);
    return out.sort();
}

export async function readSources(root: string, files: readonly string[]): Promise<SourceFile[]> {
    return Promise.all(files.map(async (f) => ({ path: f, text: await readFile(path.join(root, f), 'utf8') })));
}

export async function loadWorkspace(root: string, sources: readonly string[] = DEFAULT_SOURCES): Promise<SourceFile[]> {
    return readSources(root, await findDomainFiles(root, sources));
}
