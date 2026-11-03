// The workspace's state outside it (ADR 0026, State outside the workspace), end to end: `dt open`, `dt collab`,
// `dt check` and `dt generate ts` write nothing into the workspace but the generated sources; an older version's
// `.domaintrail/` is moved on the first run (the session resumed with its chat) or refused while its server runs; the
// links find the running server in the state directory; `dt session prune` lists and removes the state of workspaces
// that are gone. The state goes to the test run's directories (test/preload.ts).
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cp, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { DEFAULT_AGENT_TOOLS } from '@domaintrail/agent';
import { cliDeps, runCli, type SessionServerOptions, startSessionServer } from '@domaintrail/dt';
import { workspaceDirs } from '@domaintrail/workspace';
import { tempCopyOfExamples } from './helpers.js';

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function copy(): Promise<string> {
    const dir = await tempCopyOfExamples();
    dirs.push(dir);
    return dir;
}

async function run(...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, cliDeps());
    return { code, out, err };
}

const settings: SessionServerOptions['session'] = {
    port: 0,
    host: '127.0.0.1',
    identity: 'dev',
    agent: { port: 0, allowedTools: [...DEFAULT_AGENT_TOOLS], maxPreviousRunDiff: 20 * 1024 },
    maxParticipants: 50,
    quickReactions: ['👍'],
    classifier: { enabled: false, provider: 'cloudflare-clef', model: 'clef-flash', apiTokenEnv: 'CLOUDFLARE_API_TOKEN', threshold: 0.5 },
};

/** Every entry below `root` (directories end in `/`) with a hash of each file's bytes. */
async function tree(root: string): Promise<Record<string, string>> {
    const entries: Record<string, string> = {};
    for await (const rel of new Bun.Glob('**/*').scan({ cwd: root, dot: true, onlyFiles: false, followSymlinks: false })) {
        const s = await lstat(path.join(root, rel));
        entries[s.isDirectory() ? `${rel}/` : rel] = s.isFile()
            ? createHash('sha256')
                  .update(await readFile(path.join(root, rel)))
                  .digest('hex')
            : 'other';
    }
    return entries;
}

/** Posts a message to the session as `cookie`'s person. */
async function say(url: string, cookie: string, text: string): Promise<void> {
    const res = await fetch(`${url}api/session/requests`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ targets: [], body: text }),
    });
    expect(res.status).toBeLessThan(300);
}

async function join(url: string, name: string): Promise<string> {
    const res = await fetch(`${url}api/session/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

/** The session's messages, as the page gets them. */
const messages = async (url: string, cookie: string): Promise<string> => {
    const state = (await (await fetch(`${url}api/session/state`, { headers: { cookie } })).json()) as { requests: unknown[] };
    return JSON.stringify(state.requests);
};

describe('nothing of dt in the workspace', () => {
    test('dt open, dt collab, dt check and dt generate ts change nothing in it but the generated sources', async () => {
        const root = await copy();
        const before = await tree(root);
        for (const mode of ['Solo', 'Collab'] as const) {
            const server = await startSessionServer({ root, debounceMs: 30, mode, session: settings });
            await server.ready;
            await server.stop();
        }
        expect((await run('-r', root, 'check')).code).toBe(0);
        expect((await run('-r', root, 'generate', 'ts')).code).toBe(0);
        const after = await tree(root);
        const outside = (rel: string): boolean => !rel.startsWith('generated/') && rel !== 'generated/';
        expect(Object.fromEntries(Object.entries(after).filter(([rel]) => outside(rel)))).toEqual(before);
        expect(Object.keys(after).some((rel) => rel.startsWith('generated/'))).toBe(true);
        // all of it in the state and cache directories
        const { state, cache } = workspaceDirs(root);
        for (const f of ['session.db', 'blobs/', 'generated.json', 'workspace.json']) expect(Object.keys(await tree(state))).toContain(f);
        expect(Object.keys(await tree(cache))).toContain('layout.json');
    }, 60_000);
});

describe('an older version’s .domaintrail/', () => {
    test('moved on the first run: said once, the session resumed with its chat, nothing left in the workspace', async () => {
        const root = await copy();
        // a session of the older layout: made by this version, then put where the older one kept it
        const first = await startSessionServer({ root, debounceMs: 30, mode: 'Collab', session: settings });
        const ada = await join(first.url, 'Ada');
        await say(first.url, ada, 'Keep me across the move.');
        const id = first.session;
        await first.stop();
        const { state, cache } = workspaceDirs(root);
        await cp(state, path.join(root, '.domaintrail', 'session'), { recursive: true });
        await rm(path.join(root, '.domaintrail', 'session', 'workspace.json'));
        await cp(path.join(cache, 'layout.json'), path.join(root, '.domaintrail', 'layout.json'));
        await writeFile(path.join(root, '.domaintrail', '.gitignore'), '*\n');
        await rm(state, { recursive: true });
        await rm(cache, { recursive: true });

        const lines: string[] = [];
        const again = await startSessionServer({ root, debounceMs: 30, mode: 'Collab', session: settings, log: (l) => lines.push(l) });
        try {
            expect(lines.filter((l) => l.startsWith('Moved '))).toEqual([`Moved .domaintrail/ to ${state}${path.sep}`.replace(process.env.HOME ?? '\0', '~')]);
            expect(again.session).toBe(id);
            expect(again.resumed).toBe(true);
            // the chat is kept; the sign-ins are not (credentials are made again): Ada's cookie is no one now
            expect((await fetch(`${again.url}api/session/me`, { headers: { cookie: ada } })).status).toBe(401);
            expect(await messages(again.url, await join(again.url, 'Bob'))).toContain('Keep me across the move.');
            expect(await lstat(path.join(root, '.domaintrail')).catch(() => 'gone')).toBe('gone');
            expect(await lstat(path.join(cache, 'layout.json')).catch(() => 'missing')).not.toBe('missing');
        } finally {
            await again.stop();
        }
    }, 60_000);

    test('while a server of an older version runs on it: refused by the commands, nothing moved', async () => {
        const root = await copy();
        const legacy = path.join(root, '.domaintrail', 'session');
        await Bun.write(path.join(legacy, 'session.db'), '');
        await writeFile(path.join(legacy, 'server.json'), JSON.stringify({ url: 'http://127.0.0.1:1/', session: 's', pid: process.ppid }));
        for (const args of [
            ['open', 'link'],
            ['collab', 'link'],
            ['generate', 'ts'],
        ]) {
            const r = await run('-r', root, ...args);
            expect(r.code).toBe(1);
            expect(r.err.join('\n')).toContain(`A session server of an older dt (pid ${process.ppid}) runs on this workspace`);
        }
        expect(await lstat(path.join(legacy, 'session.db')).catch(() => 'gone')).not.toBe('gone');
    });
});

describe('the running server, found in the state directory', () => {
    test('dt open link and dt open agent-link reach the server dt open started', async () => {
        const root = await copy();
        const server = await startSessionServer({ root, debounceMs: 30, mode: 'Solo', session: settings });
        try {
            const link = await run('-r', root, 'open', 'link');
            expect(link.code).toBe(0);
            expect(link.out[0]).toStartWith(`Sign-in link (single use, expires in 60 minutes): ${server.url}`);
            const agent = await run('-r', root, 'open', 'agent-link');
            expect(agent.code).toBe(0);
            expect(agent.out).toContain(`Agent API: ${server.agentUrl}`);
        } finally {
            await server.stop();
        }
        expect((await run('-r', root, 'open', 'link')).err).toEqual(['No session server is running for this workspace (start one with `dt open`).']);
    });
});

describe('dt session prune', () => {
    test('lists the state of a workspace that is gone (a dry run), removes it with --yes; an existing one is kept', async () => {
        const kept = await copy();
        const gone = await copy();
        expect((await run('-r', kept, 'generate', 'ts')).code).toBe(0);
        expect((await run('-r', gone, 'generate', 'ts')).code).toBe(0);
        const goneDirs = workspaceDirs(gone);
        const keptDirs = workspaceDirs(kept);
        await rm(gone, { recursive: true });

        const dry = await run('session', 'prune');
        expect(dry.code).toBe(0);
        expect(dry.out[0]).toBe('Would remove (dry run):');
        expect(dry.out.filter((l) => l.includes(path.basename(goneDirs.state)))).toEqual([
            `  ${goneDirs.state}  (state; ${goneDirs.workspace}: no longer exists)`,
            `  ${goneDirs.cache}  (cache; ${goneDirs.workspace}: no longer exists)`,
        ]);
        expect(dry.out.join('\n')).not.toContain(path.basename(keptDirs.state));
        expect(dry.out.at(-1)).toMatch(/^Run `dt session prune --yes` to remove /);
        expect(await lstat(goneDirs.state).catch(() => 'gone')).not.toBe('gone');

        const yes = await run('session', 'prune', '--yes');
        expect(yes.out[0]).toBe('Removed:');
        expect(await lstat(goneDirs.state).catch(() => 'gone')).toBe('gone');
        expect(await lstat(goneDirs.cache).catch(() => 'gone')).toBe('gone');
        expect(await lstat(keptDirs.state).catch(() => 'gone')).not.toBe('gone');

        const none = await run('session', 'prune', '--older-than', '3650');
        expect(none.out.join('\n')).not.toContain(path.basename(keptDirs.state));
        expect((await run('session', 'prune', '--older-than', 'x')).code).not.toBe(0);
    }, 60_000);
});
