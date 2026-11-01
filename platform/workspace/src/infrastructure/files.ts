import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { SourceFile } from '@domaintrail/modeling';
import type { SourceSelection } from '../ports.js';
import { GitIgnore } from './gitignore.js';

/**
 * Which files below a root are the workspace's sources: those the selection matches, outside the directories never
 * scanned (`ignoredDirs`) and, with `respectGitignore`, not ignored by `.gitignore` (see `GitIgnore`). `dt check`, the other
 * commands, the Live View's watcher and the language server all decide with it.
 */
export class SourceScope {
    readonly root: string;
    private readonly selection: SourceSelection;
    private readonly gitignore: GitIgnore | undefined;

    constructor(root: string, selection: SourceSelection) {
        this.root = path.resolve(root);
        this.selection = selection;
        this.gitignore = selection.respectGitignore ? new GitIgnore(this.root) : undefined;
    }

    /** Whether `p` (a file or a directory) is named like a directory never scanned. */
    ignoresName(p: string): boolean {
        return this.selection.ignoredDirs.has(path.basename(p));
    }

    /** Whether the directory `dir` (absolute, below the root) is walked. */
    includesDirectory(dir: string): boolean {
        return !this.ignoresName(dir) && !this.gitignore?.ignores(dir, true);
    }

    /** Path of `file` (absolute) relative to the root, when it is one of the sources. */
    sourcePath(file: string): string | undefined {
        const rel = path.relative(this.root, file);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !this.selection.matches(rel)) return undefined;
        return this.gitignore?.ignores(file, false) ? undefined : rel;
    }
}

/**
 * Finds the sources below `root` (see `SourceScope`), returning paths relative to `root`, sorted. Directories never
 * scanned and, with `respectGitignore`, files and directories ignored by `.gitignore` are skipped.
 */
export async function findDomainFiles(root: string, selection: SourceSelection): Promise<string[]> {
    const scope = new SourceScope(root, selection);
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

export async function loadWorkspace(root: string, selection: SourceSelection): Promise<SourceFile[]> {
    return readSources(root, await findDomainFiles(root, selection));
}

/** The sources below `root` (see `loadWorkspace`): a `WorkspaceReader` of the Live View (`@domaintrail/visualization`). */
export function createWorkspaceReader(root: string, selection: SourceSelection): { readSources(): Promise<SourceFile[]> } {
    return { readSources: () => loadWorkspace(root, selection) };
}
