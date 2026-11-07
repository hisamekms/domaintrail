/**
 * The review at a run's end with knowledge (ADR 0034) over a real session server (dev identity) on a copy of
 * examples/shop, a `files` store in it with the extraction on, and the runner with a fake agent (`fake-claude.mjs`):
 * the run renames a sticky; the review's turn is given the decisions and rules about its neighbourhood (never AS-IS),
 * and flags an item at odds with the stickies; once the run ends, the items about the renamed sticky name its new name
 * (by dt, a new version), and the flag waits for the next extraction.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DEFAULT_AGENT_TOOLS } from '@domaintrail/agent';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { type SessionServer, type SessionSettings, startSessionServer, startSubscriber } from '@domaintrail/dt';
import { createFilesKnowledgeStore } from '@domaintrail/knowledge';
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
        // on, so that the review is given knowledge; never due during the test
        extraction: { enabled: true, quietSeconds: 3600, minIntervalSeconds: 3600, contextMinutes: 10, gateContextMinutes: 3, settleSeconds: 120 },
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
const RETURNS = 'stormings/returns.dtes';
const id = (n: number): string => `kn_${String(n).padStart(8, '0')}`;

describe("the review at a run's end, with knowledge", () => {
    test('decisions and rules about the neighbourhood are given, never AS-IS; the renamed sticky’s items follow it; a flag waits for the extraction', async () => {
        const root = await tempCopyOfExamples();
        dirs.push(root);
        const store = createFilesKnowledgeStore({ dir: path.join(root, 'knowledge'), project, stateDir: path.join(root, '.state-knowledge') });
        const at = new Date().toISOString();
        const items: [number, string, string, string][] = [
            [1, 'decision', 'to_be', '返品は注文から14日まで'],
            [2, 'rule', 'as_is', '今は電話で返品を受けている'],
        ];
        for (const [n, kind, when, text] of items)
            await store.applyExtraction(
                project,
                wire.extraction(
                    {
                        by: { session: 'earlier', number: n },
                        operations: [
                            {
                                kind: 'Add',
                                id: id(n),
                                content: { title: text, text, labels: { when, kind, origin: 'agreed' }, about: ['Returns.ReturnRequested'] },
                                sources: [{ session: 'earlier', message: `m${n}`, at, quote: text }],
                            },
                        ],
                    },
                    'test',
                ),
            );
        const lines: string[] = [];
        const server: SessionServer = await startSessionServer({
            root,
            debounceMs: 30,
            session: sessionConfig,
            knowledgeStore: store,
            log: (l) => lines.push(l),
        });
        cleanups.push(() => server.stop());
        await server.ready;
        const joined = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Ada' }) });
        const ada = (joined.headers.get('set-cookie') ?? '').split(';')[0];
        expect((await fetch(server.facilitatorLink, { headers: { cookie: ada }, redirect: 'manual' })).status).toBe(303);
        const api = (p: string, body?: unknown): Promise<Response> =>
            fetch(`${server.url}api/session/${p}`, {
                method: body === undefined ? 'GET' : 'POST',
                headers: { cookie: ada, ...(body !== undefined && json) },
                ...(body !== undefined && { body: JSON.stringify(body) }),
            });

        // the run renames ReturnRequested (every reference); its review flags the decision of 14 days
        const renamed = (await readFile(path.join(root, RETURNS), 'utf8')).replaceAll('ReturnRequested', 'ReturnAsked');
        const planFile = path.join(await mkdtemp(path.join(tmpdir(), 'domaintrail-review-plan-')), 'plan.json');
        dirs.push(path.dirname(planFile));
        await writeFile(
            planFile,
            JSON.stringify({
                runs: [
                    {
                        edits: [{ path: RETURNS, write: renamed }],
                        reply: { outcome: 'done', title: '名前', summary: '名前を変えた', requests: [{ request: 1, status: 'done' }] },
                    },
                    {
                        reply: {
                            outcome: 'done',
                            title: '名前',
                            summary: '見直した',
                            requests: [],
                            review: {
                                fixed: [],
                                kept: [],
                                knowledge: [{ item: id(1), sticky: 'Returns.ReturnAsked', why: '今日30日に決めた' }],
                                retire: [
                                    {
                                        item: id(1),
                                        reason: 'obsolete',
                                        explanation: '期限は30日になった',
                                        evidence: [{ kind: 'StickyChange', sticky: 'Returns.ReturnAsked', change: '名前を変え、期限を30日にした' }],
                                    },
                                    // the AS-IS item, never given to the review: left out
                                    {
                                        item: id(2),
                                        reason: 'wrong',
                                        explanation: '電話ではない',
                                        evidence: [{ kind: 'StickyChange', sticky: 'Returns.ReturnAsked', change: '名前を変えた' }],
                                    },
                                ],
                            },
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

        const sent = await api('requests', { targets: [], body: 'ReturnRequested を ReturnAsked に改名して' });
        const request = ((await sent.json()) as { request: { id: string } }).request.id;
        const queued = await api('runs', { requests: [request] });
        const run = ((await queued.json()) as { run: { id: string } }).run.id;
        const ended = await until('the run', async () => {
            const s = (await (await api('state')).json()) as SessionStateBody;
            const r = s.runs.find((x) => x.id === run);
            return r && (r.state === 'Completed' || r.state === 'Failed') ? r : undefined;
        });
        expect(ended.state).toBe('Completed');

        const log = (await readFile(`${planFile}.log`, 'utf8')).split('\n').filter(Boolean);
        expect(log).toHaveLength(2);
        const review = (JSON.parse(log[1]) as { prompt: string }).prompt;
        const block = JSON.parse(review.slice(review.indexOf('<review-') + '<review-'.length + 33, review.indexOf('</review-'))) as {
            review: { knowledge: { id: string; kind: string; when: string }[] };
        };
        // the decision about the sticky (by its old name, which the items still name), never the AS-IS rule
        expect(block.review.knowledge.map((k) => [k.id, k.kind, k.when])).toEqual([[id(1), 'decision', 'to_be']]);

        // relinked by dt once the run ended: both items name the new name
        await until('the relink', async () => ((await store.about(project, [wire.stickyRef('Returns.ReturnAsked', 'test')])).length === 2 ? true : undefined));
        expect(await store.about(project, [wire.stickyRef('Returns.ReturnRequested', 'test')])).toEqual([]);
        expect(lines.some((l) => l.includes(`2 item(s) relinked to the stickies run ${run} renamed`))).toBe(true);
        // the flag is the extraction's: logged, waiting for the next one
        expect(lines.some((l) => l.includes("1 item(s) flagged by a run's review"))).toBe(true);
        // the retirement it proposed is in 廃止の候補 at once, the review's; the item not given was not proposed
        const proposals = await until('the proposal', async () => {
            const open = await store.proposals(project);
            return open.length > 0 ? open : undefined;
        });
        expect<unknown>(proposals.map((p) => [p.item, p.action, p.reason, p.proposedBy])).toEqual([
            [id(1), 'retire', 'obsolete', { kind: 'Review', review: `run:${run}` }],
        ]);
        expect(lines.some((l) => l.includes('1 retirement(s) of items the review was not given left out'))).toBe(true);
        expect((await store.get(project, wire.itemId(id(1), 'test')))?.item.retirement).toBeUndefined();
    }, 30_000);
});
