/**
 * A conflict made a hotspot is handed over to it (ADR 0031, section 4; plan task K5c) over a real session server (dev
 * identity) on a copy of examples/shop, a `files` store in it, and the runner with a fake agent (`fake-claude.mjs`):
 * ホットスポットにする pressed (its message sent, then the press kept, seen by every page), the facilitator queues the
 * message's run, and
 * - the run adds one hotspot: both items about it, their conflict unlinked, audited by the person who pressed, the press gone;
 * - the run adds two hotspots: nothing handed over, the press gone (the conflict gets its buttons back, with why);
 * - the run declines: the same;
 * - the hotspot already exists and the run only names it in its reply: handed over to it.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DEFAULT_AGENT_TOOLS } from '@domaintrail/agent';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { type SessionServer, type SessionSettings, startSessionServer, startSubscriber } from '@domaintrail/dt';
import { createFilesKnowledgeStore, type Knowledge } from '@domaintrail/knowledge';
import * as wire from '@domaintrail/knowledge/protocol';
import { tempCopyOfExamples } from './helpers';

const ROOT = path.join(import.meta.dir, '..');
const FAKE = path.join(import.meta.dir, 'fixtures', 'agent', 'fake-claude.mjs');
const DT = { command: process.execPath, args: [path.join(ROOT, 'bin', 'dt.ts')] };

const dirs: string[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});
afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const project = wire.projectName('shop', 'test');

const sessionConfig: SessionSettings = {
    port: 0,
    host: '127.0.0.1',
    identity: 'dev',
    agent: { port: 0, allowedTools: [...DEFAULT_AGENT_TOOLS], maxPreviousRunDiff: 20 * 1024, extractTimeout: 10 },
    maxParticipants: 50,
    quickReactions: ['👍'],
    classifier: { enabled: false, provider: 'cloudflare-clef', model: 'clef-flash', apiTokenEnv: 'CLOUDFLARE_API_TOKEN', threshold: 0.9 },
    knowledge: {
        store: 'files',
        project,
        projectFrom: 'config',
        extraction: { enabled: false, quietSeconds: 3600, minIntervalSeconds: 3600, contextMinutes: 10, gateContextMinutes: 3, settleSeconds: 120 },
    },
};

async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, ms = 20_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
        const v = await probe();
        if (v !== undefined) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 50));
    }
}

const json = { 'content-type': 'application/json' };
const content = (text: string): unknown => ({
    title: text.slice(0, 40),
    text,
    labels: { when: 'as_is', kind: 'rule', origin: 'said' },
    about: ['Returns.ReturnRequested'],
});
const id = (n: number): string => `kn_${String(n).padStart(8, '0')}`;

const RETURNS = 'stormings/returns.dtes';
const LAST_HOTSPOT = '  hotspot RefundAndOrder "返金は Sales の返金依頼（RefundRequested）と同じもの？"\n';
const addHotspots = (...names: string[]): unknown[] => [
    { path: RETURNS, replace: [LAST_HOTSPOT, LAST_HOTSPOT + names.map((n) => `  hotspot ${n} "返品の期限は？" {\n    on ReturnRequested\n  }\n`).join('')] },
];

describe('a conflict made a hotspot', () => {
    test('one hotspot added, or an existing one only named: handed over; two added, or the run declined: the press cleared with why, the conflict kept', async () => {
        const root = await tempCopyOfExamples();
        dirs.push(root);
        const store = createFilesKnowledgeStore({ dir: path.join(root, 'knowledge'), project, stateDir: path.join(root, '.state-knowledge') });
        const lines: string[] = [];
        const server: SessionServer = await startSessionServer({
            root,
            debounceMs: 30,
            session: sessionConfig,
            knowledgeStore: store,
            leaseMs: 5000,
            expireEveryMs: 200,
            log: (l) => lines.push(l),
        });
        cleanups.push(() => server.stop());
        await server.ready;
        const joined = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Ada' }) });
        const ada = (joined.headers.get('set-cookie') ?? '').split(';')[0];
        expect((await fetch(server.facilitatorLink, { headers: { cookie: ada }, redirect: 'manual' })).status).toBe(303);
        const bob = (
            (await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Bob' }) })).headers.get(
                'set-cookie',
            ) ?? ''
        ).split(';')[0];
        const api = (cookie: string, p: string, body?: unknown): Promise<Response> =>
            fetch(`${server.url}api/session/${p}`, {
                method: body === undefined ? 'GET' : 'POST',
                headers: { cookie, ...(body !== undefined && json) },
                ...(body !== undefined && { body: JSON.stringify(body) }),
            });
        const state = async (): Promise<SessionStateBody> => (await (await api(ada, 'state')).json()) as SessionStateBody;
        type HandOversBody = { handOvers: { request: string; items: string[] }[]; cleared: { items: string[]; reason: string }[] };
        const handOvers = async (): Promise<HandOversBody> => (await (await api(bob, 'knowledge/hand-overs')).json()) as HandOversBody;
        const pending = async (): Promise<{ request: string; items: string[] }[]> => (await handOvers()).handOvers;

        // three conflicts about the same sticky, each from two sessions
        const session = server.session as unknown as string;
        for (const n of [1, 3, 5, 7]) {
            const at = new Date().toISOString();
            await store.applyExtraction(
                project,
                wire.extraction(
                    {
                        by: { session: `earlier${n}`, number: 1 },
                        operations: [
                            {
                                kind: 'Add',
                                id: id(n),
                                content: content(`締めは前日17時 (${n})`),
                                sources: [{ session: `earlier${n}`, message: 'm1', at, quote: '締めは前日17時' }],
                            },
                        ],
                    },
                    'test',
                ),
            );
            await store.applyExtraction(
                project,
                wire.extraction(
                    {
                        by: { session, number: n },
                        operations: [
                            {
                                kind: 'Conflict',
                                id: id(n + 1),
                                content: content(`締めは当日9時 (${n})`),
                                sources: [{ session, message: `m${n}`, at, quote: '締めは当日9時' }],
                                item: id(n),
                                base: 1,
                            },
                        ],
                    },
                    'test',
                ),
            );
        }

        const planFile = path.join(await mkdtemp(path.join(tmpdir(), 'domaintrail-hotspot-plan-')), 'plan.json');
        dirs.push(path.dirname(planFile));
        await writeFile(
            planFile,
            JSON.stringify({
                runs: [
                    { edits: addHotspots('CutOff'), reply: { outcome: 'done', summary: 'Added a hotspot.', requests: [{ request: 1, status: 'done' }] } },
                    { edits: addHotspots('CutOffA', 'CutOffB'), reply: { outcome: 'done', summary: 'Added two.', requests: [{ request: 1, status: 'done' }] } },
                    { reply: { outcome: 'declined', summary: 'Not a model change.', requests: [{ request: 1, status: 'skipped', note: 'Out of scope.' }] } },
                    {
                        reply: {
                            outcome: 'done',
                            summary: '同じ問いの @{es:Returns/RefundAndOrder} がすでにあるので、それを使いました。',
                            requests: [{ request: 1, status: 'done' }],
                        },
                    },
                ],
            }),
        );
        const subscriber = await startSubscriber({
            root,
            agent: 'claude',
            connect: { credential: { url: server.agentUrl, token: server.agentToken, session: server.session } },
            dt: DT,
            agentCommand: { command: process.execPath, args: [FAKE, planFile] },
            run: { warm: false, restartAfter: 20, idleTimeout: 30 },
            roles: ['run'],
            log: (l) => lines.push(l),
            reconnect: { minMs: 100, maxMs: 500, giveUpMs: 5_000 },
        });
        cleanups.push(() => subscriber.stop());

        /** ホットスポットにする as Ada on the conflict of items n and n+1, the facilitator's run queued: the run's ID. */
        const press = async (n: number): Promise<string> => {
            const sent = await api(ada, 'requests', { targets: [], body: `食い違い ${n} をホットスポットにしてください` });
            expect(sent.status).toBe(201);
            const request = ((await sent.json()) as { request: { id: string } }).request.id;
            const pressed = await api(ada, 'knowledge/hand-overs', { request, items: [id(n + 1), id(n)] });
            expect(pressed.status).toBe(201);
            // every page sees it (Bob's too)
            expect((await pending()).map((p) => p.items)).toEqual([[id(n + 1), id(n)]]);
            const queued = await api(ada, 'runs', { requests: [request] });
            expect(queued.status).toBe(201);
            return ((await queued.json()) as { run: { id: string } }).run.id;
        };
        const ended = (run: string): Promise<string> =>
            until(`run ${run} to end`, async () => {
                const r = (await state()).runs.find((x) => x.id === run);
                return r && ['Completed', 'Declined', 'Failed'].includes(r.state) ? r.state : undefined;
            });
        const settled = (): Promise<true> => until('the press settled', async () => ((await pending()).length === 0 ? true : undefined));

        // only a message of one's own can be pressed for
        const others = await api(ada, 'requests', { targets: [], body: 'Ada の発言' });
        const adas = ((await others.json()) as { request: { id: string } }).request.id;
        expect((await api(bob, 'knowledge/hand-overs', { request: adas, items: [id(2), id(1)] })).status).toBe(404);

        // one hotspot added: handed over
        expect(await ended(await press(1))).toBe('Completed');
        await settled();
        for (const n of [1, 2]) {
            const item = (await store.get(project, wire.itemId(id(n), 'test')))?.item;
            expect(item?.content.about).toEqual(['Returns.ReturnRequested', 'Returns.CutOff'] as unknown as Knowledge.StickyRef[]);
            expect(item?.conflictsWith).toEqual([]);
        }
        const audit = (await store.audit(project, { item: wire.itemId(id(1), 'test') })).items[0];
        expect(audit?.operation).toBe('handOverToHotspot');
        expect(audit?.actor).toEqual({ kind: 'Person', user: wire.userName('guest:Ada', 'test') });
        expect(String(audit?.reason)).toBe('hotspot Returns.CutOff');
        expect(await readFile(path.join(root, 'stormings', 'returns.dtes'), 'utf8')).toContain('hotspot CutOff ');

        // two hotspots added: not handed over, the conflict kept
        expect(await ended(await press(3))).toBe('Completed');
        await settled();
        expect((await store.get(project, wire.itemId(id(3), 'test')))?.item.conflictsWith).toEqual([wire.itemId(id(4), 'test')]);
        expect(lines.some((l) => l.includes('was not made a hotspot (the run added 2 hotspots)'))).toBe(true);
        // every page is told why its buttons came back
        expect((await handOvers()).cleared).toEqual([{ items: [id(4), id(3)], reason: 'several' }]);

        // the run declined: the same
        expect(await ended(await press(5))).toBe('Declined');
        await settled();
        expect((await store.get(project, wire.itemId(id(5), 'test')))?.item.conflictsWith).toEqual([wire.itemId(id(6), 'test')]);
        expect(lines.some((l) => l.includes('was not made a hotspot (the run declined)'))).toBe(true);
        expect((await handOvers()).cleared.map((c) => c.reason)).toEqual(['several', 'ended']);

        // the hotspot already exists, the run changes nothing and only names it: handed over to it
        const before = await readFile(path.join(root, 'stormings', 'returns.dtes'), 'utf8');
        expect(await ended(await press(7))).toBe('Completed');
        await settled();
        for (const n of [7, 8]) {
            const item = (await store.get(project, wire.itemId(id(n), 'test')))?.item;
            expect(item?.content.about).toEqual(['Returns.ReturnRequested', 'Returns.RefundAndOrder'] as unknown as Knowledge.StickyRef[]);
            expect(item?.conflictsWith).toEqual([]);
        }
        expect(await readFile(path.join(root, 'stormings', 'returns.dtes'), 'utf8')).toBe(before);
        expect((await handOvers()).cleared.map((c) => c.reason)).toEqual(['several', 'ended']);
    }, 60_000);
});
