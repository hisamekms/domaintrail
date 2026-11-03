// What the agents read outside the workspace (`agent.read.paths`, `agent.answer.read.paths`, `agent.run.read.paths`;
// the maintainer's decision of 2026-11-03), read-only, by role, with the workspace's own semantics inside each path:
//
// - in a git work tree, the files git does not ignore there (`git ls-files`, so `core.excludesFile` and
//   `.git/info/exclude` apply; a path its repository ignores as a whole: `GitIgnore` with the user's excludes file, as
//   the workspace); elsewhere every file; never `.git` nor `.domaintrail` at any depth, in any case; a nested
//   repository inside a path denied as a whole (the path itself may be a repository);
// - the answerer reads **views** of them (private copies, refreshed before each turn, as its view of the workspace),
//   each named after what it copies, in one private directory, added to its working directories;
// - the runner reads them in place: each directory added to its working directories, each file allowed by itself;
//   nothing of them may be edited (deny rules: Claude Code's deny wins over everything), and what git ignores there,
//   the nested repositories and the symbolic links are denied as a whole. Those entries count with the workspace's
//   against `MAX_IGNORED_ENTRIES` (`TooManyDeniedEntries`: the run fails, never a list cut short).
//
// The paths are taken by their real paths when the agent starts (`readTargets`): one missing is skipped and said.
import { chmod, lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
    checkTarget,
    createWorkspaceView,
    type ExtraRead,
    holdsRepository,
    ignoredEntries,
    MAX_IGNORED_ENTRIES,
    type ReadTarget,
    type RunnerReadScope,
    TooManyDeniedEntries,
    type WorkspaceView,
} from '@domaintrail/agent';
import { processAlive } from './process.js';
import { GitIgnore, gitFileState, gitIgnoredEntries, gitNestedRepositories, gitReadableFiles, repositoryTop } from '@domaintrail/workspace';

/** Whether a name is `.git` or `.domaintrail` in any case or Unicode form. */
const ownName = (name: string): boolean => ['.git', '.domaintrail'].includes(name.normalize('NFC').toLowerCase());

/** Whether `file` (a real path) may be read: in a git work tree, unless git ignores it; elsewhere always. */
async function fileReadable(file: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
    if (!repositoryTop(path.dirname(file))) return true;
    return (await gitFileState(file, { env })) !== 'ignored';
}

/**
 * A view of the directory `dir` (a real path): git's allowlist where git speaks for it, else, in a git work tree,
 * `GitIgnore` with the user's excludes file, else every file (never `.git`, `.domaintrail`, a nested repository, a link).
 */
function directoryView(dir: string, parent: string, name: string, maxTotalBytes: () => number, env?: NodeJS.ProcessEnv): WorkspaceView {
    const inRepository = repositoryTop(dir) !== undefined;
    let gitignore: GitIgnore | undefined;
    return createWorkspaceView({
        root: dir,
        parent,
        name,
        maxTotalBytes,
        list: async () => {
            gitignore = undefined;
            return inRepository ? gitReadableFiles(dir, { env }) : undefined;
        },
        ignores: (p, directory) => inRepository && (gitignore ??= new GitIgnore(dir, { userExcludes: true, env })).ignores(p, directory),
    });
}

/** A view of the one file `file` (a real path), in a directory named after the file's own. */
function fileView(file: string, parent: string, name: string, maxTotalBytes: () => number, env?: NodeJS.ProcessEnv): WorkspaceView {
    return createWorkspaceView({
        root: path.dirname(file),
        parent,
        maxTotalBytes,
        name,
        list: async () => ((await fileReadable(file, env)) ? [path.basename(file)] : []),
    });
}

/** The most bytes the answerer's copies of what it reads outside the workspace come to, all together (200 MiB). */
export const MAX_EXTRA_VIEW_BYTES = 200 * 1024 * 1024;

/** The prefix of the private directories holding those copies, in the temporary directory. */
const READ_VIEWS_PREFIX = 'dt-answerer-read-';
/** The file in such a directory naming the process that made it. */
const OWNER_FILE = '.owner';
/** How long a directory without its owner file may be another agent's that is starting. */
const STARTING_MS = 60_000;

/**
 * Removes the copies an agent that is gone left (its process killed before it could): this user's directories of
 * `READ_VIEWS_PREFIX` in `tmp` whose owner process no longer runs, or that have no owner file past `STARTING_MS`.
 */
export async function sweepStaleReadViews(tmp: string = tmpdir(), alive: (pid: number) => boolean = processAlive): Promise<string[]> {
    const removed: string[] = [];
    const uid = process.getuid?.();
    for (const name of await readdir(tmp).catch(() => [] as string[])) {
        if (!name.startsWith(READ_VIEWS_PREFIX)) continue;
        const dir = path.join(tmp, name);
        const s = await lstat(dir).catch(() => undefined);
        if (!s?.isDirectory() || (uid !== undefined && s.uid !== uid)) continue;
        const owner = Number((await readFile(path.join(dir, OWNER_FILE), 'utf8').catch(() => '')).trim());
        const stale = Number.isInteger(owner) && owner > 0 ? !alive(owner) : Date.now() - s.mtimeMs > STARTING_MS;
        if (!stale) continue;
        await rm(dir, { recursive: true, force: true });
        removed.push(dir);
    }
    return removed;
}

/** What the answerer reads outside the workspace: its views, the `ExtraRead` that adds them, and their lifetime. */
export interface AnswererExtraViews {
    readonly extra: ExtraRead;
    /** Brings every view up to date (before each turn). */
    refresh(): Promise<void>;
    dispose(): Promise<void>;
}

/**
 * The answerer's views of `targets` (none: undefined), in one private directory (0700, outside the workspace), each
 * named after the directory it copies (a file: after its own directory) and made at once.
 */
export async function answererExtraViews(
    targets: readonly ReadTarget[],
    env?: NodeJS.ProcessEnv,
    options: { readonly maxTotalBytes?: number; readonly tmp?: string } = {},
): Promise<AnswererExtraViews | undefined> {
    if (targets.length === 0) return undefined;
    const tmp = options.tmp ?? tmpdir();
    const maxTotal = options.maxTotalBytes ?? MAX_EXTRA_VIEW_BYTES;
    // what an agent that died left behind (its copies of files outside the workspace)
    await sweepStaleReadViews(tmp);
    const parent = await mkdtemp(path.join(tmp, READ_VIEWS_PREFIX));
    await chmod(parent, 0o700);
    await writeFile(path.join(parent, OWNER_FILE), String(process.pid), { mode: 0o600 });
    const taken = new Set<string>();
    const unique = (base: string): string => {
        const clean = base.replace(/[^\w.@+-]/g, '_').replace(/^\.+/, '_') || 'read';
        let name = clean;
        for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${clean}-${i}`;
        taken.add(name.toLowerCase());
        return name;
    };
    const views: { view: WorkspaceView; dir: string; shown: string }[] = [];
    /** What a view may still hold: the cap less what the others hold. */
    const left = (self: () => WorkspaceView | undefined) => (): number =>
        maxTotal - views.reduce((sum, v) => (v.view === self() ? sum : sum + v.view.bytes()), 0);
    try {
        for (const t of targets) {
            const name = unique(path.basename(t.directory ? t.real : path.dirname(t.real)));
            let made: WorkspaceView | undefined;
            const bound = left(() => made);
            const view = t.directory ? directoryView(t.real, parent, name, bound, env) : fileView(t.real, parent, name, bound, env);
            made = view;
            const dir = await view.refresh();
            views.push({ view, dir, shown: t.directory ? `${dir}${path.sep}` : path.join(dir, path.basename(t.real)) });
        }
    } catch (e) {
        await Promise.all(views.map((v) => v.view.dispose()));
        await rm(parent, { recursive: true, force: true });
        throw e;
    }
    const lines = views.map((v, i) => `- ${v.shown}: a copy of ${targets[i].configured}${targets[i].directory ? path.sep : ''}`);
    return {
        extra: {
            dirs: views.map((v) => v.dir),
            files: [],
            denied: [],
            note:
                'Besides your working directory (the workspace), you may read these copies of files outside the workspace, ' +
                'read-only (the files git does not ignore there). Name them by the original path when you quote them:\n' +
                lines.join('\n'),
        },
        async refresh() {
            // each path still what it was when the agent started (else the turn fails)
            for (const t of targets) checkTarget(t);
            for (const v of views) await v.view.refresh();
        },
        async dispose() {
            await Promise.all(views.map((v) => v.view.dispose()));
            await rm(parent, { recursive: true, force: true });
        },
    };
}

/**
 * The symbolic links below `dir` that may be read (relative, `/`-separated): among git's allowlist where it speaks
 * for `dir`, else found by a walk (not below `.git`, `.domaintrail`, a nested repository, nor what `ignores` says).
 * Denied to the runner as a whole: a link may point back into what the workspace keeps out.
 */
async function linkEntries(
    dir: string,
    listed: readonly string[] | undefined,
    ignores: (p: string, directory: boolean) => boolean,
    max: number,
): Promise<string[]> {
    const out: string[] = [];
    const add = (rel: string): void => {
        out.push(rel);
        if (out.length > max) throw new TooManyDeniedEntries();
    };
    if (listed) {
        for (const rel of listed) {
            const clean = rel.replace(/\/$/, '');
            if (!clean || clean.split('/').some((s) => s === '..' || ownName(s))) continue;
            if ((await lstat(path.join(dir, ...clean.split('/'))).catch(() => undefined))?.isSymbolicLink()) add(clean);
        }
        return out;
    }
    const walk = async (from: string, rel: string): Promise<void> => {
        const entries = (await readdir(from, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            if (ownName(entry.name)) continue;
            const full = path.join(from, entry.name);
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink()) add(relPath);
            else if (entry.isDirectory() && !ignores(full, true) && !(await holdsRepository(full))) await walk(full, relPath);
        }
    };
    await walk(dir, '');
    return out;
}

/**
 * The entries of the directory `dir` (a real path) denied to the runner, absolute: the nested repositories, what git
 * ignores (in a git work tree; elsewhere nothing is ignored) and the links; at most `max` (`TooManyDeniedEntries`).
 */
async function directoryDenied(dir: string, max: number, env?: NodeJS.ProcessEnv): Promise<string[]> {
    const inRepository = repositoryTop(dir) !== undefined;
    let gitignore: GitIgnore | undefined;
    const ignores = (p: string, d: boolean): boolean => inRepository && (gitignore ??= new GitIgnore(dir, { userExcludes: true, env })).ignores(p, d);
    const denied = await ignoredEntries(
        dir,
        {
            list: async () => {
                if (!inRepository) return undefined;
                const [nested, ignored] = await Promise.all([gitNestedRepositories(dir, { env }), gitIgnoredEntries(dir, { env })]);
                return nested && ignored && [...nested, ...ignored];
            },
            ignores,
        },
        max,
    );
    const links = await linkEntries(dir, inRepository ? await gitReadableFiles(dir, { env }) : undefined, ignores, max - denied.length);
    return [...denied, ...links].map((rel) => path.join(dir, ...rel.split('/')));
}

/**
 * What the runner may read, asked at each run's start: the workspace's denied paths (`workspaceDenied`), and, for
 * `targets`, the directories and files it reads outside the workspace with what is denied in them, all counted
 * against `MAX_IGNORED_ENTRIES`. A file git ignores is left out.
 */
export async function runnerReadScope(
    workspaceDenied: () => Promise<string[]>,
    targets: readonly ReadTarget[],
    env?: NodeJS.ProcessEnv,
): Promise<RunnerReadScope> {
    const deniedPaths = await workspaceDenied();
    if (targets.length === 0) return { deniedPaths };
    let budget = MAX_IGNORED_ENTRIES - deniedPaths.length;
    const dirs: string[] = [];
    const files: string[] = [];
    const denied: string[] = [];
    const lines: string[] = [];
    // each path still what it was when the agent started (else the run fails)
    for (const t of targets) checkTarget(t);
    for (const t of targets) {
        if (!t.directory) {
            if (!(await fileReadable(t.real, env))) continue;
            files.push(t.real);
            lines.push(`- ${t.real}${t.real === t.configured ? '' : ` (${t.configured})`}`);
            continue;
        }
        const entries = await directoryDenied(t.real, budget, env);
        budget -= entries.length;
        dirs.push(t.real);
        denied.push(...entries);
        lines.push(`- ${t.real}${path.sep}${t.real === t.configured ? '' : ` (${t.configured})`}`);
    }
    if (lines.length === 0) return { deniedPaths };
    const note =
        'Besides the workspace, you may read these paths outside it, for context: never edit, write, move or delete anything there ' +
        '(your changes belong in the workspace only):\n' +
        lines.join('\n');
    return { deniedPaths, extra: { dirs, files, denied, note } };
}
