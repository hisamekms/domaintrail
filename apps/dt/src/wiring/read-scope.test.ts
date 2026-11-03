// What the agents of `dt session subscribe` may read, as wired (ADR 0030, as built in M4b): in a git repository, the
// answerer's view and the runner's deny list come from git itself, so a file the user ignores globally
// (`core.excludesFile`) or in `.git/info/exclude` is out of the view and denied to the runner; a nested `.git` or
// `.domaintrail` is never in the view; a workspace that is no git repository falls back to `GitIgnore` with the user's
// excludes file. A nested repository or a submodule is out of the view and denied to the runner as a whole.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { claudeArguments, MAX_IGNORED_ENTRIES, readTargets, TooManyDeniedEntries, UnexpressiblePath } from '@domaintrail/agent';
import { answererExtraViews, runnerReadScope } from './read-scope.js';
import { answererView, runnerDeniedPaths } from './subscriber.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const scratch = async (): Promise<string> => {
    const d = await realpath(await mkdtemp(path.join(tmpdir(), 'domaintrail-read-scope-')));
    dirs.push(d);
    return d;
};

async function put(root: string, files: Record<string, string>): Promise<void> {
    for (const [rel, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await writeFile(path.join(root, rel), text);
    }
}

async function listed(d: string, rel = ''): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...(await listed(path.join(d, e.name), r)));
        else out.push(r);
    }
    return out.sort();
}

/** A git environment of the test's: the user's excludes file given by a global config of its own. */
async function userGit(excludes: string): Promise<NodeJS.ProcessEnv> {
    const home = await scratch();
    await writeFile(path.join(home, 'ignore'), excludes);
    await writeFile(path.join(home, 'gitconfig'), `[core]\n\texcludesFile = ${path.join(home, 'ignore')}\n`);
    return {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
    };
}

const WORKSPACE = {
    'README.md': 'README_OK',
    'shop.dt': 'context Shop {}\n',
    '.gitignore': 'dist/\n',
    '.env.local': 'GLOBAL_CANARY',
    'scratch.txt': 'INFO_EXCLUDE_CANARY',
    'dist/out.js': 'x',
    'sub/.git/config': 'NESTED_GIT_CANARY',
    'sub/.domaintrail/x': 'NESTED_DT_CANARY',
    'sub/notes.md': 'n',
    'mod/.git': 'gitdir: ../.git/modules/mod',
    '.domaintrail/session/agent.json': '{"token":"t"}',
};

describe('the read scope of the agents, as wired', () => {
    test("a git repository: the user's global excludes and .git/info/exclude apply to the view and to the runner's deny list", async () => {
        const root = await scratch();
        const env = await userGit('.env.local\n');
        execFileSync('git', ['init', '-q'], { cwd: root, env });
        await put(root, WORKSPACE);
        await writeFile(path.join(root, '.git', 'info', 'exclude'), 'scratch.txt\n.domaintrail/\n');
        const view = answererView(root, env);
        try {
            // sub/.git is no valid repository here, so git lists below sub/: never its .git nor .domaintrail, nor mod/.git
            expect(await listed(await view.refresh())).toEqual(['.gitignore', 'README.md', 'shop.dt', 'sub/notes.md']);
        } finally {
            await view.dispose();
        }
        expect((await runnerDeniedPaths(root, env)).sort()).toEqual(['.env.local', 'dist', 'scratch.txt']);
    });

    test("nested repositories and submodules: out of the view, and denied to the runner as a whole (their ignores are not git's for us)", async () => {
        const root = await scratch();
        const env = await userGit('');
        const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
        git(root, 'init', '-q');
        await put(root, { 'README.md': 'r', 'vendor/lib/.gitignore': '.env\n', 'vendor/lib/.env': 'NESTED_ENV_CANARY', 'vendor/lib/a.md': 'a' });
        // an untracked repository inside the workspace: git lists it as vendor/lib/ and does not descend
        git(path.join(root, 'vendor', 'lib'), 'init', '-q');
        // a submodule: a gitlink (mode 160000) in the index, its directory checked out with a .git file
        await put(root, { 'mod/.git': 'gitdir: ../.git/modules/mod', 'mod/.env': 'SUBMODULE_ENV_CANARY', 'mod/b.md': 'b' });
        git(root, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},mod`);
        // a gitlink whose directory is not there: nothing to deny
        git(root, 'update-index', '--add', '--cacheinfo', `160000,${'2'.repeat(40)},gone`);
        // an ignored case variant of ours: not covered by the static rules (exact names), so it keeps its own rule
        await put(root, { '.gitignore': '.DomainTrail/\n', 'sub/.DomainTrail/x': 'CASE_CANARY', 'sub/notes.md': 'n' });
        const view = answererView(root, env);
        try {
            expect(await listed(await view.refresh())).toEqual(['.gitignore', 'README.md', 'sub/notes.md']);
        } finally {
            await view.dispose();
        }
        // the nested repositories first, then git's ignored entries in its order
        expect(await runnerDeniedPaths(root, env)).toEqual(['mod', 'vendor/lib', 'sub/.DomainTrail']);
    });

    test('no git repository: GitIgnore with the user excludes file; nested .git and .domaintrail never in the view', async () => {
        const root = await scratch();
        const env = await userGit('.env.local\n');
        await put(root, WORKSPACE);
        const view = answererView(root, env);
        try {
            // sub/ and mod/ hold a .git: kept out as git keeps a nested repository out
            expect(await listed(await view.refresh())).toEqual(['.gitignore', 'README.md', 'scratch.txt', 'shop.dt']);
        } finally {
            await view.dispose();
        }
        expect((await runnerDeniedPaths(root, env)).sort()).toEqual(['.env.local', 'dist', 'mod', 'sub']);
    });
});

describe('what the agents read outside the workspace (agent.read.paths), as wired', () => {
    /** A workspace, and beside it `specs/` (a git repository of its own), `loose/` (in none) and `glossary.md`. */
    async function beside(): Promise<{ base: string; ws: string; env: NodeJS.ProcessEnv }> {
        const base = await scratch();
        const env = await userGit('.env.local\n');
        const ws = path.join(base, 'ws');
        await put(ws, { 'shop.dt': 'context Shop {}\n', '.env': 'WS_ENV_CANARY' });
        const specs = path.join(base, 'specs');
        await put(specs, {
            'notes.md': 'SPEC_NOTES',
            'deep/a/b.md': 'b',
            '.gitignore': 'build/\nsecret.txt\n',
            'secret.txt': 'IGNORED_CANARY',
            '.env.local': 'GLOBAL_CANARY',
            'build/out.js': 'x',
            'deep/.domaintrail/x': 'DT_CANARY',
        });
        execFileSync('git', ['init', '-q'], { cwd: specs, env });
        await put(specs, { 'nested/n.md': 'n', 'nested/.gitignore': '' });
        execFileSync('git', ['init', '-q'], { cwd: path.join(specs, 'nested'), env });
        // a link back into what the workspace keeps out
        await symlink(path.join(ws, '.env'), path.join(specs, 'envlink'));
        await put(path.join(base, 'loose'), {
            'a.md': 'LOOSE',
            // no repository: a stray .gitignore ignores nothing here
            '.gitignore': 'x.txt\n',
            'x.txt': 'X',
            '.domaintrail/y': 'DT_CANARY',
            'inner/.git/config': 'GIT_CANARY',
            'inner/c.md': 'c',
            'sub/.GIT/config': 'CASE_CANARY',
        });
        await put(base, { 'glossary.md': 'GLOSSARY', 'ignored/repo-file.md': 'R' });
        return { base, ws, env };
    }

    test('the answerer: views named after what they copy, the files git does not ignore there (else every file); never .git, .domaintrail, a nested repository or a link', async () => {
        const { base, ws, env } = await beside();
        const { targets } = readTargets([path.join(base, 'specs'), path.join(base, 'loose'), path.join(base, 'glossary.md')], ws);
        const views = await answererExtraViews(targets, env);
        if (!views) throw new Error('no views');
        try {
            const [specs, loose, glossary] = views.extra.dirs;
            expect(path.basename(specs)).toBe('specs');
            expect(path.dirname(specs)).toBe(path.dirname(loose));
            expect(await listed(specs)).toEqual(['.gitignore', 'deep/a/b.md', 'notes.md']);
            expect(await listed(loose)).toEqual(['.gitignore', 'a.md', 'x.txt']);
            // a file: in a directory named after its own
            expect(path.basename(glossary)).toBe(path.basename(base));
            expect(await listed(glossary)).toEqual(['glossary.md']);
            expect(views.extra.files).toEqual([]);
            expect(views.extra.note).toContain(`${specs}${path.sep}: a copy of ${path.join(base, 'specs')}${path.sep}`);
            expect(views.extra.note).toContain(`${path.join(glossary, 'glossary.md')}: a copy of ${path.join(base, 'glossary.md')}`);
            // refreshed before each turn
            await writeFile(path.join(base, 'specs', 'later.md'), 'L');
            await views.refresh();
            expect(await readFile(path.join(specs, 'later.md'), 'utf8')).toBe('L');
        } finally {
            await views.dispose();
        }
        expect(await answererExtraViews([], env)).toBeUndefined();
    });

    test('the runner: the directories and files in place; what git ignores there, nested repositories and links denied as a whole', async () => {
        const { base, ws, env } = await beside();
        const { targets } = readTargets([path.join(base, 'specs'), path.join(base, 'loose'), path.join(base, 'glossary.md')], ws);
        const scope = await runnerReadScope(() => runnerDeniedPaths(ws, env), targets, env);
        const specs = path.join(base, 'specs');
        const loose = path.join(base, 'loose');
        expect(scope.deniedPaths).toEqual([]);
        expect(scope.extra?.dirs).toEqual([specs, loose]);
        expect(scope.extra?.files).toEqual([path.join(base, 'glossary.md')]);
        expect([...(scope.extra?.denied ?? [])].sort()).toEqual(
            [
                // specs: the nested repository, git's ignored entries (the user's excludes file included), the link
                'nested',
                '.env.local',
                'build',
                'secret.txt',
                'envlink',
                // loose: no repository, so nothing ignored; the nested repositories, whatever the case of their .git
                'inner',
                'sub',
            ]
                .map((rel, i) => path.join(i < 5 ? specs : loose, rel))
                .sort(),
        );
        expect(scope.extra?.note).toContain('never edit, write, move or delete anything there');
        // nothing outside: no extra at all
        expect(await runnerReadScope(() => runnerDeniedPaths(ws, env), [], env)).toEqual({ deniedPaths: [] });
    });

    test('a file git ignores is not read; a path inside a repository its repository ignores: GitIgnore, as the workspace', async () => {
        const base = await scratch();
        const env = await userGit('');
        execFileSync('git', ['init', '-q'], { cwd: base, env });
        await put(base, {
            '.gitignore': 'private.md\nshelf/\n',
            'private.md': 'P',
            'shelf/.gitignore': 'tmp/\n',
            'shelf/s.md': 's',
            'shelf/tmp/t.md': 't',
            'ws/shop.dt': '',
        });
        const ws = path.join(base, 'ws');
        const { targets } = readTargets([path.join(base, 'private.md'), path.join(base, 'shelf')], ws);
        const scope = await runnerReadScope(async () => [], targets, env);
        expect(scope.extra?.files).toEqual([]);
        expect(scope.extra?.denied).toEqual([path.join(base, 'shelf', 'tmp')]);
        const views = await answererExtraViews(targets, env);
        try {
            expect(await listed(views!.extra.dirs[0])).toEqual([]);
            expect(await listed(views!.extra.dirs[1])).toEqual(['.gitignore', 's.md']);
        } finally {
            await views?.dispose();
        }
    });

    test(`the deny list fails closed past ${MAX_IGNORED_ENTRIES} entries, the workspace's and the paths outside it together`, async () => {
        const base = await scratch();
        const env = await userGit('');
        const ws = path.join(base, 'ws');
        await put(ws, { '.gitignore': '*.tmp\n' });
        for (let i = 0; i < 300; i++) await writeFile(path.join(ws, `w${i}.tmp`), '');
        const loose = path.join(base, 'loose');
        await mkdir(loose);
        for (let i = 0; i < 200; i++) await symlink(path.join(ws, `w${i}.tmp`), path.join(loose, `l${i}`));
        const { targets } = readTargets([loose], ws);
        // 300 + 200: at the limit
        expect((await runnerReadScope(() => runnerDeniedPaths(ws, env), targets, env)).extra?.denied).toHaveLength(200);
        await symlink(path.join(ws, 'w0.tmp'), path.join(loose, 'one-more'));
        const refused: unknown = await runnerReadScope(() => runnerDeniedPaths(ws, env), targets, env).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(TooManyDeniedEntries);
        expect(String(refused)).toContain('agent.read.paths');
    });

    test('an entry no permission rule can name (a line break in its name) refuses the run, in the workspace or outside it', async () => {
        const base = await scratch();
        const env = await userGit('');
        const ws = path.join(base, 'ws');
        await put(ws, { '.gitignore': '*.tmp\n', 'a\nb.tmp': 'x' });
        const loose = path.join(base, 'loose');
        await mkdir(loose);
        await symlink(path.join(ws, 'a\nb.tmp'), path.join(loose, 'odd\nlink'));
        const workspace = await runnerReadScope(() => runnerDeniedPaths(ws, env), [], env);
        expect(workspace.deniedPaths).toEqual(['a\nb.tmp']);
        expect(() => claudeArguments(['Read'], 1, { deniedPaths: workspace.deniedPaths })).toThrow(UnexpressiblePath);
        const { targets } = readTargets([loose], ws);
        const outside = await runnerReadScope(async () => [], targets, env);
        expect(() => claudeArguments(['Read'], 1, { deniedPaths: [], ...(outside.extra && { extraRead: outside.extra }) })).toThrow(UnexpressiblePath);
    });

    test('a path replaced since the agent started: the next turn of the answerer and the next run fail', async () => {
        const { base, ws, env } = await beside();
        const { targets } = readTargets([path.join(base, 'loose')], ws);
        const views = await answererExtraViews(targets, env);
        if (!views) throw new Error('no views');
        try {
            await views.refresh();
            await rm(path.join(base, 'loose'), { recursive: true });
            await put(path.join(base, 'loose'), { 'other.md': 'OTHER' });
            const failure = (p: Promise<unknown>): Promise<string> =>
                p.then(
                    () => 'resolved',
                    (e: unknown) => String(e),
                );
            expect(await failure(views.refresh())).toContain('changed since the agent started');
            expect(await failure(runnerReadScope(async () => [], targets, env))).toContain('changed since the agent started');
        } finally {
            await views.dispose();
        }
    });
});
