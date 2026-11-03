// The workspace's state outside it (ADR 0026, State outside the workspace), end to end: `dt open`, `dt collab`,
// `dt check` and `dt generate ts` write nothing into the workspace but the generated sources; the links find the
// running server in the state directory. The state goes to the test run's directories (test/preload.ts).
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
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
