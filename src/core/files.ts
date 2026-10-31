import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { SourceFile } from './analyze.js';
import { DEFAULT_SOURCES, IGNORED_DIRS, sourceMatcher } from './config.js';
import { GitIgnore } from './gitignore.js';

/** Whether a source is an Event Storming file (`.dtes`, ADR 0024); every other source is a `.dt` file. */
export function isStormingFile(file: string): boolean {
    return file.endsWith('.dtes');
}

/**
 * Which files below a root are the workspace's sources: those matching `sources`, outside the directories never scanned
 * (`IGNORED_DIRS`) and, with `respectGitignore`, not ignored by `.gitignore` (see `GitIgnore`). `dt check`, the other
 * commands, the Live View's watcher and the language server all decide with it.
 */
export class SourceScope {
    readonly root: string;
    private readonly matches: (relPath: string) => boolean;
    private readonly gitignore: GitIgnore | undefined;

    constructor(root: string, sources: readonly string[] = DEFAULT_SOURCES, respectGitignore = true) {
        this.root = path.resolve(root);
        this.matches = sourceMatcher(sources);
        this.gitignore = respectGitignore ? new GitIgnore(this.root) : undefined;
    }

    /** Whether the directory `dir` (absolute, below the root) is walked. */
    includesDirectory(dir: string): boolean {
        return !IGNORED_DIRS.has(path.basename(dir)) && !this.gitignore?.ignores(dir, true);
    }

    /** Path of `file` (absolute) relative to the root, when it is one of the sources. */
    sourcePath(file: string): string | undefined {
        const rel = path.relative(this.root, file);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !this.matches(rel)) return undefined;
        return this.gitignore?.ignores(file, false) ? undefined : rel;
    }
}

/**
 * Finds DSL files below `root` matching `sources` globs, returning paths relative to `root`, sorted. Directories never
 * scanned and, unless `respectGitignore` is false, files and directories ignored by `.gitignore` are skipped.
 */
export async function findDomainFiles(root: string, sources: readonly string[] = DEFAULT_SOURCES, respectGitignore = true): Promise<string[]> {
    const scope = new SourceScope(root, sources, respectGitignore);
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (scope.includesDirectory(full)) await walk(full);
            } else if (entry.isFile()) {
                const rel = scope.sourcePath(full);
                if (rel !== undefined) out.push(rel);
            }
        }
    };
    await walk(scope.root);
    return out.sort();
}

export async function readSources(root: string, files: readonly string[]): Promise<SourceFile[]> {
    return Promise.all(files.map(async (f) => ({ path: f, text: await readFile(path.join(root, f), 'utf8') })));
}

export async function loadWorkspace(root: string, sources: readonly string[] = DEFAULT_SOURCES, respectGitignore = true): Promise<SourceFile[]> {
    return readSources(root, await findDomainFiles(root, sources, respectGitignore));
}
