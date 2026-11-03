// What git itself says of a workspace's files (ADR 0030, as built in M4b): every source of ignores applies — the
// user's `core.excludesFile` (set, or the XDG default) and `.git/info/exclude` as well as `.gitignore` — nothing of a
// `.git` or `.domaintrail` at any depth is listed, and where git does not speak for the root (no repository, a root
// its repository ignores) the answer is none, for the caller's fallback (`GitIgnore` with `userExcludes`).
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { gitExposedEntries, gitIgnoredEntries, gitReadableFiles } from './git-files.js';
import { GitIgnore } from './gitignore.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const scratch = async (): Promise<string> => {
    const d = await mkdtemp(path.join(tmpdir(), 'domaintrail-git-files-'));
    dirs.push(d);
    return d;
};

async function put(root: string, files: Record<string, string>): Promise<void> {
    for (const [rel, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await writeFile(path.join(root, rel), text);
    }
}

/** A git environment of its own: a global config file of the test's, no system one, the XDG directory given. */
async function gitEnv(globalConfig: string, xdg?: string): Promise<NodeJS.ProcessEnv> {
    const home = await scratch();
    return { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: xdg ?? path.join(home, '.config') };
}

function gitInit(root: string, env: NodeJS.ProcessEnv): void {
    execFileSync('git', ['init', '-q'], { cwd: root, env });
}

describe("git's own lists of a workspace's files", () => {
    test('core.excludesFile and .git/info/exclude apply; nested .git and .domaintrail never listed; tracked files are readable', async () => {
        const root = await scratch();
        const home = await scratch();
        await put(home, { 'global-ignore': 'secrets.local\n*.pem\n' });
        await writeFile(path.join(home, 'gitconfig'), `[core]\n\texcludesFile = ${path.join(home, 'global-ignore')}\n`);
        const env = await gitEnv(path.join(home, 'gitconfig'));
        gitInit(root, env);
        await put(root, {
            'README.md': 'readme',
            '.gitignore': 'dist/\n',
            'shop.dt': 'context Shop {}\n',
            'secrets.local': 'GLOBAL_CANARY',
            'keys/server.pem': 'PEM_CANARY',
            'excluded.txt': 'INFO_CANARY',
            'dist/out.js': 'x',
            'sub/.git/config': '[core]',
            'sub/.domaintrail/x': 'x',
            'docs/notes.md': 'notes',
        });
        await writeFile(path.join(root, '.git', 'info', 'exclude'), 'excluded.txt\n');
        const readable = (await gitReadableFiles(root, { env }))!.sort();
        expect(readable).toEqual(['.gitignore', 'README.md', 'docs/notes.md', 'shop.dt']);
        const ignored = (await gitIgnoredEntries(root, { env }))!.sort();
        expect(ignored).toEqual(['dist', 'excluded.txt', 'keys', 'secrets.local']);
        // a tracked file is readable even when a rule ignores it (git does not ignore tracked files)
        execFileSync('git', ['add', '-f', 'secrets.local'], { cwd: root, env });
        expect(await gitReadableFiles(root, { env })).toContain('secrets.local');
        // from a subdirectory: relative to it
        expect((await gitReadableFiles(path.join(root, 'docs'), { env }))!.sort()).toEqual(['notes.md']);
    });

    test('the XDG default excludes file when core.excludesFile is unset', async () => {
        const root = await scratch();
        const xdg = await scratch();
        await put(xdg, { 'git/ignore': '.env\n' });
        const config = path.join(await scratch(), 'gitconfig');
        await writeFile(config, '');
        const env = await gitEnv(config, xdg);
        gitInit(root, env);
        await put(root, { '.env': 'XDG_CANARY', 'README.md': 'r' });
        expect(await gitReadableFiles(root, { env })).toEqual(['README.md']);
        expect(await gitIgnoredEntries(root, { env })).toEqual(['.env']);
    });

    test('no repository, or a root its repository ignores: git does not speak for it (the fallback); git failing is an error', async () => {
        const plain = await scratch();
        await put(plain, { 'README.md': 'r' });
        expect(await gitReadableFiles(plain)).toBeUndefined();
        expect(await gitIgnoredEntries(plain)).toBeUndefined();
        const top = await scratch();
        const config = path.join(await scratch(), 'gitconfig');
        await writeFile(config, '');
        const env = await gitEnv(config);
        gitInit(top, env);
        await put(top, { '.gitignore': 'copies/\n', 'copies/proj/README.md': 'r' });
        expect(await gitReadableFiles(path.join(top, 'copies', 'proj'), { env })).toBeUndefined();
        expect(await gitIgnoredEntries(path.join(top, 'copies', 'proj'), { env })).toBeUndefined();
        const failed = await gitReadableFiles(top, { env: { ...env, PATH: '/nonexistent' } }).then(
            () => undefined,
            (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
        expect(failed).toMatch(/git could not be run/);
    });

    test("GitIgnore with userExcludes: the user's excludes file applies (outside a repository too), below .gitignore", async () => {
        const root = await scratch();
        const home = await scratch();
        await put(home, { ignore: 'secrets.local\n*.pem\n' });
        await writeFile(path.join(home, 'gitconfig'), `[core]\n\texcludesFile = ${path.join(home, 'ignore')}\n`);
        await put(root, { '.gitignore': '!keep.pem\n', 'secrets.local': 'x', 'a.pem': 'x', 'keep.pem': 'x', 'README.md': 'x' });
        const env = await gitEnv(path.join(home, 'gitconfig'));
        const withUser = new GitIgnore(root, { userExcludes: true, env });
        expect(withUser.ignores(path.join(root, 'secrets.local'), false)).toBe(true);
        expect(withUser.ignores(path.join(root, 'a.pem'), false)).toBe(true);
        expect(withUser.ignores(path.join(root, 'keep.pem'), false)).toBe(false);
        expect(withUser.ignores(path.join(root, 'README.md'), false)).toBe(false);
        expect(new GitIgnore(root).ignores(path.join(root, 'secrets.local'), false)).toBe(false);
        // the XDG default when unset
        const xdg = await scratch();
        await put(xdg, { 'git/ignore': 'README.md\n' });
        const empty = path.join(home, 'empty');
        await writeFile(empty, '');
        expect(new GitIgnore(root, { userExcludes: true, env: await gitEnv(empty, xdg) }).ignores(path.join(root, 'README.md'), false)).toBe(true);
    });
});

describe('what a commit may hold of a directory (an older .domaintrail/)', () => {
    test('tracked or not ignored, the name in any case; none when all of it is ignored; undefined outside a repository', async () => {
        const root = await scratch();
        const home = await scratch();
        await writeFile(path.join(home, 'gitconfig'), '');
        const env = await gitEnv(path.join(home, 'gitconfig'));
        expect(await gitExposedEntries(root, '.domaintrail', { env })).toBeUndefined();
        gitInit(root, env);
        await put(root, { '.domaintrail/.gitignore': '*\n', '.domaintrail/session/session.db': 'x', 'README.md': 'r' });
        expect(await gitExposedEntries(root, '.domaintrail', { env })).toEqual([]);
        // a case variant tracked (on a case-insensitive file system the same directory)
        await put(root, { '.DomainTrail-tracked/x': 'x' });
        execFileSync('git', ['add', '-f', '.DomainTrail-tracked/x'], { cwd: root, env });
        execFileSync('git', ['mv', '.DomainTrail-tracked', '.DOMAINTRAIL2'], { cwd: root, env });
        expect(await gitExposedEntries(root, '.domaintrail', { env })).toEqual([]);
        await put(root, { '.DomainTrail/y': 'y' });
        execFileSync('git', ['add', '-f', '.DomainTrail/y'], { cwd: root, env });
        expect(await gitExposedEntries(root, '.domaintrail', { env })).toEqual(['.DomainTrail/y']);
    });
});
