/**
 * A hotspot a person writes on a sticky is named by the light model (ADR 0033): over a real session server (dev
 * identity) without any knowledge configured, the helper (the light model's small jobs, on a stream of the agent API of
 * their own) connected with a fake agent. Its name is
 * made an ID (PascalCase, letters and digits) and suffixed when taken; with no extractor connected, or one that does
 * not answer in time, dt names it after the sticky, and writing never waits longer than that.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHttpAgentApi, DEFAULT_AGENT_TOOLS, type ExtractTurn, helperStream, startExtractor } from '@domaintrail/agent';
import { type SessionSettings, startSessionServer } from '@domaintrail/dt';

const dirs: string[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});
afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const config: SessionSettings = {
    port: 0,
    host: '127.0.0.1',
    identity: 'dev',
    agent: { port: 0, allowedTools: [...DEFAULT_AGENT_TOOLS], maxPreviousRunDiff: 20 * 1024, extractTimeout: 10 },
    maxParticipants: 50,
    quickReactions: ['👍'],
    classifier: { enabled: false, provider: 'cloudflare-clef', model: 'clef-flash', apiTokenEnv: 'CLOUDFLARE_API_TOKEN', threshold: 0.9 },
};

const RETURNS = 'storming Returns "返品" {\n  event ReturnRequested "返品が依頼された"\n}\n';
const json = { 'content-type': 'application/json' };

async function session(hotspotNameTimeoutMs?: number) {
    const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-hotspot-'));
    dirs.push(root);
    await mkdir(path.join(root, 'stormings'));
    await writeFile(path.join(root, 'stormings', 'returns.dtes'), RETURNS);
    const server = await startSessionServer({
        root,
        debounceMs: 30,
        session: config,
        ...(hotspotNameTimeoutMs !== undefined && { hotspotNameTimeoutMs }),
    });
    cleanups.push(() => server.stop());
    await server.ready;
    const joined = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Bob' }) });
    const bob = (joined.headers.get('set-cookie') ?? '').split(';')[0];
    /** Bob puts a hotspot on the event, without a name: the name written, and how long it took. */
    const put = async (question: string): Promise<{ status: number; hotspot: string | undefined; ms: number }> => {
        const started = Date.now();
        const res = await fetch(`${server.url}api/session/stickies`, {
            method: 'POST',
            headers: { cookie: bob, ...json },
            body: JSON.stringify({
                kind: 'addHotspot',
                storming: 'Returns',
                on: 'ReturnRequested',
                label: question,
                onLabel: '返品が依頼された',
                onKind: 'event',
                body: 'ホットスポットを付ける',
            }),
        });
        const body = (await res.json()) as { request?: { edit?: { hotspot?: string } } };
        return { status: res.status, hotspot: body.request?.edit?.hotspot, ms: Date.now() - started };
    };
    const file = (): Promise<string> => readFile(path.join(root, 'stormings', 'returns.dtes'), 'utf8');
    return { server, put, file };
}

/** The extractor role with a fake agent whose light model answers a hotspot's name with `name` (after `delayMs`). */
function extractor(server: Awaited<ReturnType<typeof session>>['server'], name: string, prompts: string[], delayMs = 0) {
    const x = startExtractor({
        api: helperStream(createHttpAgentApi({ url: server.agentUrl, token: server.agentToken })),
        agent: {
            gate: () => Promise.reject(new Error('never asked')),
            extract: () => Promise.reject(new Error('never asked')),
            async hotspotName(turn: ExtractTurn) {
                prompts.push(turn.prompt);
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, delayMs);
                    turn.signal.addEventListener('abort', () => {
                        clearTimeout(timer);
                        reject(new Error('stopped'));
                    });
                });
                return { text: JSON.stringify({ name }), structured: { name }, model: 'light' };
            },
        },
        clock: { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), every: () => () => {} },
        nonce: () => 'n0nce',
        log: () => {},
    });
    cleanups.push(() => x.stop());
    return x;
}

const connected = async (server: Awaited<ReturnType<typeof session>>['server']): Promise<void> => {
    // the extraction stream opens shortly after the extractor starts
    await new Promise((r) => setTimeout(r, 300));
    void server;
};

describe("a hotspot's name (ADR 0033)", () => {
    test('the light model names it from the question and the sticky; made an ID, suffixed when taken; a question on several lines', async () => {
        const s = await session();
        // the session keeps no knowledge: its extraction stream is not there, the helpers' is
        const off = await fetch(`${s.server.agentUrl}agent/extractions/events`, { headers: { authorization: `Bearer ${s.server.agentToken}` } });
        expect(off.status).toBe(404);
        const prompts: string[] = [];
        extractor(s.server, 'Double returns!', prompts);
        await connected(s.server);
        expect(await s.put('同じ返品が\n二度来たら？')).toMatchObject({ status: 201, hotspot: 'DoubleReturns' });
        expect(prompts[0]).toContain('"question": "同じ返品が\\n二度来たら？"');
        expect(prompts[0]).toContain('"id": "ReturnRequested"');
        expect(await s.put('もう一度？')).toMatchObject({ status: 201, hotspot: 'DoubleReturns2' });
        const text = await s.file();
        expect(text).toContain('  hotspot DoubleReturns "同じ返品が\\n二度来たら？" {\n    on ReturnRequested\n  }\n');
        expect(text).toContain('  hotspot DoubleReturns2 "もう一度？" {');
    });

    test('no extractor connected: dt names it after the sticky, at once', async () => {
        const s = await session();
        const put = await s.put('壊れていたら？');
        expect(put).toMatchObject({ status: 201, hotspot: 'ReturnRequestedQuestion' });
        expect(put.ms).toBeLessThan(2_000);
        expect((await s.put('汚れていたら？')).hotspot).toBe('ReturnRequestedQuestion2');
    });

    test('a light model that does not answer in time, or answers no ID: dt names it, and the write does not wait longer', async () => {
        const s = await session(300);
        extractor(s.server, 'Late', [], 5_000);
        await connected(s.server);
        const put = await s.put('遅れたら？');
        expect(put).toMatchObject({ status: 201, hotspot: 'ReturnRequestedQuestion' });
        expect(put.ms).toBeLessThan(2_000);

        const t = await session();
        extractor(t.server, '日本語だけ', []);
        await connected(t.server);
        expect((await t.put('名前が付かなかったら？')).hotspot).toBe('ReturnRequestedQuestion');
    });
});
