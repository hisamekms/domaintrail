// What the agents of `dt session subscribe` may read, as wired (ADR 0030, as built in M4b): in a git repository, the
// answerer's view and the runner's deny list come from git itself, so a file the user ignores globally
// (`core.excludesFile`) or in `.git/info/exclude` is out of the view and denied to the runner; a nested `.git` or
// `.domaintrail` is never in the view; a workspace that is no git repository falls back to `GitIgnore` with the user's
// excludes file.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { answererView, runnerDeniedPaths } from './subscriber.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const scratch = async (): Promise<string> => {
    const d = await mkdtemp(path.join(tmpdir(), 'domaintrail-read-scope-'));
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

    test('no git repository: GitIgnore with the user excludes file; nested .git and .domaintrail never in the view', async () => {
        const root = await scratch();
        const env = await userGit('.env.local\n');
        await put(root, WORKSPACE);
        const view = answererView(root, env);
        try {
            expect(await listed(await view.refresh())).toEqual(['.gitignore', 'README.md', 'scratch.txt', 'shop.dt', 'sub/notes.md']);
        } finally {
            await view.dispose();
        }
        expect((await runnerDeniedPaths(root, env)).sort()).toEqual(['.env.local', 'dist']);
    });
});
