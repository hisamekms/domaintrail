// `dt session prune`: the state and cache directories of workspaces that are gone (or unused for the days asked),
// listed (a dry run) or removed; a running server's state, an existing workspace's and a directory without a record
// are kept; a move's leftover copy goes.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { StateEnvironment } from './state-dirs.js';
import { openWorkspaceState, pruneStateDirs } from './workspace-state.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
    const d = await realpath(await mkdtemp(path.join(tmpdir(), 'domaintrail-prune-')));
    dirs.push(d);
    return d;
}
const environment = (base: string): StateEnvironment => ({
    env: { XDG_STATE_HOME: path.join(base, 'state'), XDG_CACHE_HOME: path.join(base, 'cache') },
    platform: process.platform,
    home: path.join(base, 'home'),
});
const exists = async (p: string): Promise<boolean> => (await lstat(p).catch(() => undefined)) !== undefined;

/** Two workspaces with their state: `kept` exists, `gone` was deleted. */
async function twoWorkspaces(
    base: string,
): Promise<{ kept: Awaited<ReturnType<typeof openWorkspaceState>>; gone: Awaited<ReturnType<typeof openWorkspaceState>> }> {
    const e = environment(base);
    await mkdir(path.join(base, 'kept'));
    await mkdir(path.join(base, 'gone'));
    const kept = await openWorkspaceState(path.join(base, 'kept'), { environment: e });
    const gone = await openWorkspaceState(path.join(base, 'gone'), { environment: e });
    await writeFile(path.join(gone.state, 'session.db'), 'x');
    await rm(path.join(base, 'gone'), { recursive: true });
    return { kept, gone };
}

describe('dt session prune', () => {
    test('a dry run lists the state and cache of the workspaces that are gone, and removes nothing', async () => {
        const base = await scratch();
        const { kept, gone } = await twoWorkspaces(base);
        const found = await pruneStateDirs({ remove: false, environment: environment(base) });
        expect(found.map((p) => [p.kind, p.dir, p.workspace, p.reason])).toEqual([
            ['state', gone.state, path.join(base, 'gone'), 'gone'],
            ['cache', gone.cache, path.join(base, 'gone'), 'gone'],
        ]);
        for (const d of [gone.state, gone.cache, kept.state, kept.cache]) expect(await exists(d)).toBe(true);
    });

    test('with --yes they are removed; the existing workspace’s are kept', async () => {
        const base = await scratch();
        const { kept, gone } = await twoWorkspaces(base);
        expect(await pruneStateDirs({ remove: true, environment: environment(base) })).toHaveLength(2);
        for (const d of [gone.state, gone.cache]) expect(await exists(d)).toBe(false);
        for (const d of [kept.state, kept.cache]) expect(await exists(d)).toBe(true);
        expect(await pruneStateDirs({ remove: true, environment: environment(base) })).toEqual([]);
    });

    test('--older-than: also the existing workspaces not used for that many days', async () => {
        const base = await scratch();
        const { kept } = await twoWorkspaces(base);
        const now = new Date();
        const old = new Date(now.getTime() - 40 * 86_400_000);
        for (const d of [kept.state, kept.cache]) {
            await utimes(path.join(d, 'workspace.json'), old, old);
            await utimes(d, old, old);
        }
        const unused = (await pruneStateDirs({ remove: false, olderThanDays: 30, environment: environment(base), now })).filter((p) => p.reason === 'unused');
        expect(unused.map((p) => p.dir)).toEqual([kept.state, kept.cache]);
        expect(await pruneStateDirs({ remove: false, olderThanDays: 60, environment: environment(base), now })).toHaveLength(2);
    });

    test('the state of a running server is kept, and a directory without a record (not dt’s to judge)', async () => {
        const base = await scratch();
        const { gone } = await twoWorkspaces(base);
        await writeFile(path.join(gone.state, 'server.json'), JSON.stringify({ url: 'http://127.0.0.1:1/', session: 's', pid: process.pid }));
        await mkdir(path.join(base, 'state', 'domaintrail', 'something-else'));
        const found = await pruneStateDirs({ remove: true, environment: environment(base) });
        expect(found.map((p) => p.dir)).toEqual([gone.cache]);
        expect(await exists(gone.state)).toBe(true);
        expect(await exists(path.join(base, 'state', 'domaintrail', 'something-else'))).toBe(true);
    });

    test('a copy left by a move that was killed half way is removed; one of a running move is not', async () => {
        const base = await scratch();
        const root = path.join(base, 'state', 'domaintrail');
        const dead = spawnSync(process.execPath, ['-e', '0']).pid;
        await mkdir(path.join(root, `.shop-01234567.moving-${dead}-0badc0de`), { recursive: true });
        await mkdir(path.join(root, `.shop-01234567.moving-${process.pid}-0badc0de`), { recursive: true });
        const found = await pruneStateDirs({ remove: true, environment: environment(base) });
        expect(found.map((p) => [path.basename(p.dir), p.reason])).toEqual([[`.shop-01234567.moving-${dead}-0badc0de`, 'unfinished']]);
        expect(await exists(path.join(root, `.shop-01234567.moving-${process.pid}-0badc0de`))).toBe(true);
    });

    test('no roots yet: nothing to prune', async () => {
        const base = await scratch();
        expect(await pruneStateDirs({ remove: true, environment: environment(base) })).toEqual([]);
    });
});
