// Where dt keeps a workspace's state and cache, outside it: the roots by platform and environment (XDG on Linux and
// macOS, %LOCALAPPDATA% on Windows, DOMAINTRAIL_STATE_DIR over the state's), the directories' names, and the
// directories made, recorded and refused (another workspace's, a gone one's, inside the workspace, links).
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { STATE_DIR_ENV, StateDirError, type StateEnvironment, stateRoots, workspaceDirName, workspaceDirs } from './state-dirs.js';
import { openWorkspaceState } from './workspace-state.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
    const d = await realpath(await mkdtemp(path.join(tmpdir(), 'domaintrail-state-')));
    dirs.push(d);
    return d;
}

const modeOf = async (p: string): Promise<number> => (await lstat(p)).mode & 0o777;

/** An environment whose state and cache are below `base` (never the user's). */
const environment = (base: string, env: Record<string, string> = {}): StateEnvironment => ({
    env: { XDG_STATE_HOME: path.join(base, 'state'), XDG_CACHE_HOME: path.join(base, 'cache'), ...env },
    platform: process.platform,
    home: path.join(base, 'home'),
});

describe('the roots', () => {
    const home = '/home/ada';
    test('XDG_STATE_HOME and XDG_CACHE_HOME when set, else ~/.local/state and ~/.cache; on macOS too', () => {
        for (const platform of ['linux', 'darwin'] as const) {
            expect(stateRoots({ env: {}, platform, home })).toEqual({ state: '/home/ada/.local/state/domaintrail', cache: '/home/ada/.cache/domaintrail' });
            expect(stateRoots({ env: { XDG_STATE_HOME: '/x/state', XDG_CACHE_HOME: '/x/cache' }, platform, home })).toEqual({
                state: '/x/state/domaintrail',
                cache: '/x/cache/domaintrail',
            });
        }
    });

    test('a relative XDG_* is ignored, as the XDG specification asks', () => {
        expect(stateRoots({ env: { XDG_STATE_HOME: 'state', XDG_CACHE_HOME: '' }, platform: 'linux', home })).toEqual({
            state: '/home/ada/.local/state/domaintrail',
            cache: '/home/ada/.cache/domaintrail',
        });
    });

    test('DOMAINTRAIL_STATE_DIR replaces the state root (not the cache), taken from the working directory when relative', () => {
        expect(stateRoots({ env: { [STATE_DIR_ENV]: '/ci/dt', XDG_STATE_HOME: '/x/state' }, platform: 'linux', home })).toEqual({
            state: '/ci/dt',
            cache: '/home/ada/.cache/domaintrail',
        });
        expect(stateRoots({ env: { [STATE_DIR_ENV]: 'dt-state' }, platform: process.platform, home }).state).toBe(path.resolve('dt-state'));
    });

    test('Windows: below %LOCALAPPDATA% (else ~\\AppData\\Local), XDG_* not read; DOMAINTRAIL_STATE_DIR too', () => {
        const winHome = 'C:\\Users\\ada';
        expect(stateRoots({ env: { LOCALAPPDATA: 'D:\\Local', XDG_STATE_HOME: '/x' }, platform: 'win32', home: winHome })).toEqual({
            state: 'D:\\Local\\domaintrail\\state',
            cache: 'D:\\Local\\domaintrail\\cache',
        });
        expect(stateRoots({ env: {}, platform: 'win32', home: winHome })).toEqual({
            state: 'C:\\Users\\ada\\AppData\\Local\\domaintrail\\state',
            cache: 'C:\\Users\\ada\\AppData\\Local\\domaintrail\\cache',
        });
        expect(stateRoots({ env: { [STATE_DIR_ENV]: 'E:\\ci' }, platform: 'win32', home: winHome }).state).toBe('E:\\ci');
    });
});

describe('the name of a workspace’s directories', () => {
    test('its directory name and 8 hexadecimal digits of the hash of its real path: stable, another path another hash', () => {
        expect(workspaceDirName('/src/shop', 'linux')).toMatch(/^shop-[0-9a-f]{8}$/);
        expect(workspaceDirName('/src/shop', 'linux')).toBe(workspaceDirName('/src/shop', 'linux'));
        expect(workspaceDirName('/other/shop', 'linux')).not.toBe(workspaceDirName('/src/shop', 'linux'));
        expect(workspaceDirName('C:\\src\\shop', 'win32')).toMatch(/^shop-[0-9a-f]{8}$/);
    });

    test('a name safe on every file system: no leading dot, other characters _, at most 48 of them, never empty', () => {
        expect(workspaceDirName('/src/.hidden', 'linux')).toMatch(/^hidden-/);
        expect(workspaceDirName('/src/販売 model', 'linux')).toMatch(/^_model-|^_+model-/);
        expect(workspaceDirName(`/src/${'a'.repeat(100)}`, 'linux')).toMatch(/^a{48}-[0-9a-f]{8}$/);
        expect(workspaceDirName('/', 'linux')).toMatch(/^workspace-[0-9a-f]{8}$/);
    });

    test('taken from the real path: a workspace reached through a link has the same directories', async () => {
        const base = await scratch();
        await mkdir(path.join(base, 'shop'));
        await symlink(path.join(base, 'shop'), path.join(base, 'link'));
        const e = environment(base);
        expect(workspaceDirs(path.join(base, 'link'), e)).toEqual(workspaceDirs(path.join(base, 'shop'), e));
        expect(workspaceDirs(path.join(base, 'link'), e).workspace).toBe(path.join(base, 'shop'));
    });
});

describe('the directories, opened', () => {
    test.skipIf(process.platform === 'win32')('made 0700 with a workspace.json of 0600 recording the real path, whatever the umask', async () => {
        const base = await scratch();
        const ws = path.join(base, 'shop');
        await mkdir(ws);
        const umask = process.umask(0o000);
        try {
            const d = await openWorkspaceState(ws, { environment: environment(base) });
            expect(d.state).toBe(path.join(base, 'state', 'domaintrail', d.name));
            expect(d.cache).toBe(path.join(base, 'cache', 'domaintrail', d.name));
            for (const dir of [d.state, d.cache, path.join(base, 'state', 'domaintrail')]) expect(await modeOf(dir)).toBe(0o700);
            for (const dir of [d.state, d.cache]) {
                expect(JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8'))).toEqual({ version: 1, path: ws });
                expect(await modeOf(path.join(dir, 'workspace.json'))).toBe(0o600);
            }
            // opened again: the same, nothing said
            const lines: string[] = [];
            expect(await openWorkspaceState(ws, { environment: environment(base), log: (l) => lines.push(l) })).toEqual(d);
            expect(lines).toEqual([]);
        } finally {
            process.umask(umask);
        }
    });

    test.skipIf(process.platform === 'win32')('a directory an older run left readable by others is tightened', async () => {
        const base = await scratch();
        const ws = path.join(base, 'shop');
        await mkdir(ws);
        const d = await openWorkspaceState(ws, { environment: environment(base) });
        await chmod(d.state, 0o755);
        await openWorkspaceState(ws, { environment: environment(base) });
        expect(await modeOf(d.state)).toBe(0o700);
    });

    test('nothing is written in the workspace', async () => {
        const base = await scratch();
        const ws = path.join(base, 'shop');
        await mkdir(ws);
        await writeFile(path.join(ws, 'a.dt'), 'context A {}\n');
        await openWorkspaceState(ws, { environment: environment(base) });
        expect(await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: ws, dot: true, onlyFiles: false }))).toEqual(['a.dt']);
    });

    test('the directory of another workspace with the same name and hash is refused, and said', async () => {
        const base = await scratch();
        const ws = path.join(base, 'shop');
        const other = path.join(base, 'other');
        await mkdir(ws);
        await mkdir(other);
        const d = workspaceDirs(ws, environment(base));
        await mkdir(d.state, { recursive: true });
        await writeFile(path.join(d.state, 'workspace.json'), JSON.stringify({ version: 1, path: other }));
        const e = await openWorkspaceState(ws, { environment: environment(base) }).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(StateDirError);
        expect(String(e)).toContain(`holds the files of another workspace, ${other}`);
        expect(String(e)).toContain(STATE_DIR_ENV);
    });

    test('the directory of a workspace that is gone (recorded under this hash) is refused, naming dt session prune', async () => {
        const base = await scratch();
        const ws = path.join(base, 'shop');
        await mkdir(ws);
        const d = workspaceDirs(ws, environment(base));
        await mkdir(d.state, { recursive: true });
        await writeFile(path.join(d.state, 'workspace.json'), JSON.stringify({ version: 1, path: path.join(base, 'gone') }));
        expect(String(await openWorkspaceState(ws, { environment: environment(base) }).catch((x: unknown) => x))).toContain('dt session prune --yes');
    });

    test('a moved workspace: the state of the gone one of the same name is said once, when this one’s is made', async () => {
        const base = await scratch();
        const old = path.join(base, 'old', 'shop');
        await mkdir(old, { recursive: true });
        const before = await openWorkspaceState(old, { environment: environment(base) });
        await rm(path.join(base, 'old'), { recursive: true });
        const moved = path.join(base, 'new', 'shop');
        await mkdir(moved, { recursive: true });
        const lines: string[] = [];
        const after = await openWorkspaceState(moved, { environment: environment(base), log: (l) => lines.push(l) });
        expect(after.state).not.toBe(before.state);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(`holds the files of ${old}, which no longer exists`);
        expect(lines[0]).toContain('dt session prune --yes');
        lines.length = 0;
        await openWorkspaceState(moved, { environment: environment(base), log: (l) => lines.push(l) });
        expect(lines).toEqual([]);
    });

    test('a state or cache root inside the workspace (or the workspace inside one) is refused: the AI reads the workspace', async () => {
        const base = await scratch();
        const ws = path.join(base, 'shop');
        await mkdir(ws);
        const inside = await openWorkspaceState(ws, { environment: environment(base, { [STATE_DIR_ENV]: path.join(ws, '.state') }) }).catch((x: unknown) => x);
        expect(inside).toBeInstanceOf(StateDirError);
        expect(String(inside)).toContain(`Set ${STATE_DIR_ENV} to a directory outside it`);
        const cacheInside = await openWorkspaceState(ws, { environment: environment(base, { XDG_CACHE_HOME: path.join(ws, 'cache') }) }).catch(
            (x: unknown) => x,
        );
        expect(cacheInside).toBeInstanceOf(StateDirError);
        // the workspace below the state root (a workspace in ~/.local/state, say)
        const below = path.join(base, 'state', 'domaintrail', 'shop');
        await mkdir(below, { recursive: true });
        expect(await openWorkspaceState(below, { environment: environment(base) }).catch((x: unknown) => x)).toBeInstanceOf(StateDirError);
        // a root that reaches the workspace through a link
        await symlink(ws, path.join(base, 'link'));
        const linked = await openWorkspaceState(ws, { environment: environment(base, { [STATE_DIR_ENV]: path.join(base, 'link', 'st') }) }).catch(
            (x: unknown) => x,
        );
        expect(linked).toBeInstanceOf(StateDirError);
        expect(await lstat(path.join(ws, '.state')).catch(() => 'absent')).toBe('absent');
    });

    test('a workspace directory that is a symbolic link is refused (the roots may be links: the user’s own)', async () => {
        const base = await scratch();
        const ws = path.join(base, 'shop');
        await mkdir(ws);
        const outside = path.join(base, 'outside');
        await mkdir(outside);
        const d = workspaceDirs(ws, environment(base));
        await mkdir(path.dirname(d.state), { recursive: true });
        await symlink(outside, d.state);
        expect(await openWorkspaceState(ws, { environment: environment(base) }).catch((x: unknown) => x)).toBeInstanceOf(StateDirError);
        // a linked root is the user's choice: followed
        const real = path.join(base, 'elsewhere');
        await mkdir(real);
        await symlink(real, path.join(base, 'linked-root'));
        const e = environment(base, { [STATE_DIR_ENV]: path.join(base, 'linked-root') });
        const opened = await openWorkspaceState(ws, { environment: e });
        expect(JSON.parse(await readFile(path.join(real, opened.name, 'workspace.json'), 'utf8')).path).toBe(ws);
    });
});
