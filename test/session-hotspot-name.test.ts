/**
 * A hotspot a person writes on a sticky is written at once under dt's provisional name, then renamed by the light model
 * (ADR 0033): over a real session server (dev
 * identity) without any knowledge configured, the helper (the light model's small jobs, on a stream of the agent API of
 * their own) connected with a fake agent. The person never waits for it; the AI's name is made an ID and
 * suffixed when taken, written over the provisional one as part of the same edit — unless it comes too late, gives no
 * ID, or the hotspot (or anything else) changed meanwhile.
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
    const runs = async (): Promise<{ state: string; hotspotName?: string }[]> =>
        ((await (await fetch(`${server.url}api/session/state`, { headers: { cookie: bob } })).json()) as { runs: { state: string; hotspotName?: string }[] })
            .runs;
    /** Bob relabels a sticky. */
    const relabel = async (element: string, from: string, to: string): Promise<number> =>
        (
            await fetch(`${server.url}api/session/stickies`, {
                method: 'POST',
                headers: { cookie: bob, ...json },
                body: JSON.stringify({ kind: 'wording', storming: 'Returns', element, expected: { name: element, label: from }, label: to, body: 'x' }),
            })
        ).status;
    return { server, put, file, runs, relabel };
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

/** Waits until `probe` holds. */
async function until(what: string, probe: () => Promise<boolean>, ms = 5_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!(await probe())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

describe("a hotspot's name (ADR 0033)", () => {
    test('written at once under the provisional name, then renamed by the light model as part of the same edit; suffixed when taken', async () => {
        const s = await session();
        // the session keeps no knowledge: its extraction stream is not there, the helpers' is
        const off = await fetch(`${s.server.agentUrl}agent/extractions/events`, { headers: { authorization: `Bearer ${s.server.agentToken}` } });
        expect(off.status).toBe(404);
        const prompts: string[] = [];
        extractor(s.server, 'Double returns!', prompts, 300);
        await connected(s.server);
        const put = await s.put('同じ返品が\n二度来たら？');
        // the person does not wait for the AI
        expect(put).toMatchObject({ status: 201, hotspot: 'ReturnRequestedQuestion' });
        expect(put.ms).toBeLessThan(300);
        expect(await s.file()).toContain('  hotspot ReturnRequestedQuestion "同じ返品が\\n二度来たら？" {\n    on ReturnRequested\n  }\n');
        await until('the AI name', async () => (await s.file()).includes('hotspot DoubleReturns '));
        expect(await s.file()).not.toContain('ReturnRequestedQuestion');
        expect(prompts[0]).toContain('"question": "同じ返品が\\n二度来たら？"');
        expect(prompts[0]).toContain('"id": "ReturnRequested"');
        // one edit, its name amended: no other record
        await until('the run named', async () => (await s.runs()).some((r) => r.hotspotName === 'DoubleReturns'));
        expect((await s.runs()).filter((r) => r.state === 'Edited')).toHaveLength(1);

        expect((await s.put('もう一度？')).hotspot).toBe('ReturnRequestedQuestion');
        await until('the second AI name', async () => (await s.file()).includes('hotspot DoubleReturns2 "もう一度？"'));
    });

    test('no helper connected, a helper too slow, or no ID: the provisional name stays', async () => {
        const s = await session();
        expect((await s.put('壊れていたら？')).hotspot).toBe('ReturnRequestedQuestion');
        expect((await s.put('汚れていたら？')).hotspot).toBe('ReturnRequestedQuestion2');

        const t = await session(200);
        extractor(t.server, 'Late', [], 2_000);
        await connected(t.server);
        expect((await t.put('遅れたら？')).hotspot).toBe('ReturnRequestedQuestion');
        await new Promise((r) => setTimeout(r, 600));
        expect(await t.file()).toContain('hotspot ReturnRequestedQuestion ');

        const u = await session();
        extractor(u.server, '日本語だけ', []);
        await connected(u.server);
        expect((await u.put('名前が付かなかったら？')).hotspot).toBe('ReturnRequestedQuestion');
        await new Promise((r) => setTimeout(r, 400));
        expect(await u.file()).toContain('hotspot ReturnRequestedQuestion ');
    });

    test("edited in between (the hotspot, or anything else): the AI name is dropped, the person's edit kept", async () => {
        const s = await session();
        extractor(s.server, 'DoubleReturns', [], 600);
        await connected(s.server);
        expect((await s.put('二度来たら？')).hotspot).toBe('ReturnRequestedQuestion');
        // someone rewords the hotspot before the AI answers
        expect(await s.relabel('ReturnRequestedQuestion', '二度来たら？', '同じ返品が二度来たら？')).toBe(201);
        await new Promise((r) => setTimeout(r, 1_000));
        const text = await s.file();
        expect(text).toContain('hotspot ReturnRequestedQuestion "同じ返品が二度来たら？"');
        expect(text).not.toContain('DoubleReturns');
        expect((await s.runs()).some((r) => r.hotspotName !== undefined)).toBe(false);
    });
});
