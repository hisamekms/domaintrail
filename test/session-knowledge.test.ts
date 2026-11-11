/**
 * Knowledge taken from a session (ADR 0031, section 3; plan task K4) over a real session server (dev identity), with a
 * store in memory in place of the workspace's and the extractor role connected through the agent API with a fake agent:
 * nothing extracted while the extraction is off (the config's default), until the facilitator — only the facilitator —
 * switches it on; then a person's message extracted once the talk is quiet, after the light model named it, the item
 * applied with the session and the extraction's number, its source the message; a mere acknowledgement stopped at the
 * mechanical stage, with no model asked; the last extraction when the session closes, after which the extractor is told
 * the session closed; an item about a sticky nobody pointed at, chosen among the workspace's stickies the extractor is
 * given in its system prompt. Without a store — none configured, or a `cloudflare` one whose settings are not approved, which is said —
 * the extraction entry point answers 404 and the extractor ends.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { type AnswerTurn, createHttpAgentApi, DEFAULT_AGENT_TOOLS, type ExtractTurn, startExtractor } from '@domaintrail/agent';
import { resolveConfig, type SessionSettings, startSessionServer } from '@domaintrail/dt';
import { type AppliedExtraction, applyExtraction, idempotencyKey, Knowledge, type KnowledgeStore } from '@domaintrail/knowledge';

const dirs: string[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});
afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const project = Knowledge.makeProjectName('shop');
if (!project.ok) throw new Error('not a project name');

const sessionConfig = (knowledge: boolean): SessionSettings => ({
    port: 0,
    host: '127.0.0.1',
    identity: 'dev',
    agent: { port: 0, allowedTools: [...DEFAULT_AGENT_TOOLS], maxPreviousRunDiff: 20 * 1024, extractTimeout: 10 },
    maxParticipants: 50,
    quickReactions: ['👍'],
    classifier: { enabled: false, provider: 'cloudflare-clef', model: 'clef-flash', apiTokenEnv: 'CLOUDFLARE_API_TOKEN', threshold: 0.9 },
    ...(knowledge && {
        knowledge: {
            store: 'files',
            project: project.value,
            projectFrom: 'config',
            extraction: { enabled: false, quietSeconds: 0.2, minIntervalSeconds: 0, contextMinutes: 10, gateContextMinutes: 3, settleSeconds: 120 },
        },
    }),
});

/** A store in memory: the extraction's reads and `applyExtraction`, idempotent by its key. */
function memoryStore(): KnowledgeStore & { readonly extractions: Knowledge.Extraction[]; readonly items: Map<string, Knowledge.KnowledgeItem> } {
    const items = new Map<string, Knowledge.KnowledgeItem>();
    const results = new Map<string, AppliedExtraction>();
    const extractions: Knowledge.Extraction[] = [];
    const live = (): Knowledge.LiveKnowledgeItem[] => [...items.values()].filter((i): i is Knowledge.LiveKnowledgeItem => i.state === 'Live');
    const unused = (): never => {
        throw new Error('not used by the extraction');
    };
    return {
        extractions,
        items,
        about: async (_p, stickies) => live().filter((i) => i.content.about.some((a) => stickies.includes(a))),
        search: async (_p, query) => ({
            items: live().filter((i) => (query.session === undefined || i.createdIn === query.session) && (!query.bookmarked || i.bookmarked)),
        }),
        async applyExtraction(_p, extraction) {
            const before = results.get(idempotencyKey(extraction.by));
            if (before) return { ...before, replayed: true };
            extractions.push(extraction);
            const outcome = applyExtraction(extraction, (id) => items.get(id), new Date());
            for (const item of outcome.items) items.set(item.id, item);
            const result = { items: live(), dropped: outcome.dropped, replayed: false };
            results.set(idempotencyKey(extraction.by), result);
            return result;
        },
        counts: unused,
        get: async (_p, id) => {
            const item = items.get(id);
            return item?.state === 'Live' ? { item } : undefined;
        },
        correct: unused,
        setBookmark: async (_p, id, bookmarked) => {
            const item = items.get(id);
            if (!item) return { ok: false, error: { type: 'Knowledge.KnowledgeItemNotFound' as const, itemId: id } };
            if (item.state !== 'Live') return { ok: false, error: { type: 'Knowledge.KnowledgeItemGone' as const, itemId: id } };
            const next = { ...item, bookmarked };
            items.set(id, next);
            return { ok: true, value: next };
        },
        unlinkConflict: unused,
        handOverToHotspot: unused,
        delete: unused,
        deleteSession: unused,
        restore: unused,
        redactions: unused,
        audit: unused,
        putImage: unused,
        getImage: unused,
        retire: unused,
        unretire: unused,
        propose: unused,
        proposals: unused,
        approveProposal: unused,
        dismissProposal: unused,
    };
}

async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, ms = 15_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
        const v = await probe();
        if (v !== undefined) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

const json = { 'content-type': 'application/json' };

describe('knowledge taken from a session', () => {
    test("a person's message is extracted once the talk is quiet, and the last messages when the session closes", async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-knowledge-'));
        dirs.push(root);
        await writeFile(path.join(root, 'shop.dt'), 'context Shop {\n  id OrderId: UUID\n}\n');
        const store = memoryStore();
        const lines: string[] = [];
        const server = await startSessionServer({ root, debounceMs: 30, session: sessionConfig(true), knowledgeStore: store, log: (l) => lines.push(l) });
        cleanups.push(() => server.stop());
        await server.ready;
        const joined = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Ada' }) });
        const ada = (joined.headers.get('set-cookie') ?? '').split(';')[0];
        expect((await fetch(server.facilitatorLink, { headers: { cookie: ada }, redirect: 'manual' })).status).toBe(303);
        const say = async (body: string): Promise<string> => {
            const res = await fetch(`${server.url}api/session/requests`, {
                method: 'POST',
                headers: { cookie: ada, ...json },
                body: JSON.stringify({ targets: [], body }),
            });
            expect(res.status).toBe(201);
            return ((await res.json()) as { request: { id: string } }).request.id;
        };

        // the extractor: a fake agent that finds one rule in the first new message of each job; its light model names them all
        const prompts: string[] = [];
        const gates: string[] = [];
        const extractor = startExtractor({
            api: createHttpAgentApi({ url: server.agentUrl, token: server.agentToken }),
            agent: {
                async gate(turn: AnswerTurn) {
                    gates.push(turn.prompt);
                    const block = turn.prompt.slice(turn.prompt.indexOf('{'), turn.prompt.lastIndexOf('}') + 1);
                    const data = JSON.parse(block) as { messages: { key: string; isNew: boolean }[] };
                    const verdict = { verdict: 'yes', messages: data.messages.filter((m) => m.isNew).map((m) => m.key) };
                    return { text: JSON.stringify(verdict), structured: verdict, model: 'light' };
                },
                async extract(turn: AnswerTurn) {
                    prompts.push(turn.prompt);
                    const block = turn.prompt.slice(turn.prompt.indexOf('{'), turn.prompt.lastIndexOf('}') + 1);
                    const data = JSON.parse(block) as { messages: { key: string; isNew: boolean; text: string }[] };
                    const first = data.messages.find((m) => m.isNew);
                    const reply = {
                        operations: first
                            ? [
                                  {
                                      op: 'add',
                                      title: `決まり: ${first.text}`.slice(0, 40),
                                      text: `決まり: ${first.text}`,
                                      when: 'as_is',
                                      kind: 'rule',
                                      origin: 'said',
                                      about: [],
                                      sources: [{ message: first.key, quote: first.text }],
                                      reason: '決まりが言われた',
                                  },
                              ]
                            : [],
                    };
                    return { text: JSON.stringify(reply), structured: reply, model: 'fake', usage: { inputTokens: 100, outputTokens: 10 } };
                },
            },
            clock: { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), every: () => () => {} },
            nonce: () => 'n0nce',
            log: () => {},
        });
        cleanups.push(() => extractor.stop());

        // off unless enabled: nothing is extracted, and only the facilitator switches it on
        const first = await say('見積もりは営業が当日中に出す');
        await new Promise((r) => setTimeout(r, 500));
        expect<unknown>([store.extractions.length, gates.length]).toEqual([0, 0]);
        const switchUrl = `${server.url}api/session/extraction`;
        expect(await (await fetch(switchUrl, { headers: { cookie: ada } })).json()).toEqual({ enabled: false });
        const bobJoined = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Bob' }) });
        const bob = (bobJoined.headers.get('set-cookie') ?? '').split(';')[0];
        const byBob = await fetch(switchUrl, { method: 'POST', headers: { cookie: bob, ...json }, body: JSON.stringify({ enabled: true }) });
        expect(byBob.status).toBe(403);
        const bad = await fetch(switchUrl, { method: 'POST', headers: { cookie: ada, ...json }, body: JSON.stringify({ enabled: 'yes' }) });
        expect(bad.status).toBe(400);
        const on = await fetch(switchUrl, { method: 'POST', headers: { cookie: ada, ...json }, body: JSON.stringify({ enabled: true }) });
        expect(await on.json()).toEqual({ enabled: true });
        expect(await (await fetch(switchUrl, { headers: { cookie: bob } })).json()).toEqual({ enabled: true });

        // switched on: the message said within the usual window is extracted, the light model asked first
        await until('the first extraction', () => (store.extractions.length === 1 ? true : undefined));
        expect<unknown>(gates).toHaveLength(1);
        expect(prompts[0]).toContain('"likely": true');
        const [extraction] = store.extractions;
        expect<unknown>([extraction.by.session, extraction.by.number]).toEqual([server.session, 1]);
        const [op] = extraction.operations;
        expect<unknown>(op.kind === 'Add' && [op.content.text, op.sources[0].message, op.sources[0].quote]).toEqual([
            '決まり: 見積もりは営業が当日中に出す',
            first,
            '見積もりは営業が当日中に出す',
        ]);
        expect(prompts[0]).toContain('<talk-n0nce>');

        // A participant's shared bookmark is visible to another participant through the session API.
        const bookmarkedId = [...store.items.values()][0].id;
        const bookmarkUrl = `${server.url}api/session/knowledge/items/${bookmarkedId}/bookmark`;
        const set = await fetch(bookmarkUrl, { method: 'POST', headers: { cookie: bob, ...json }, body: JSON.stringify({ bookmarked: true }) });
        expect(set.status).toBe(200);
        expect(((await set.json()) as Knowledge.LiveKnowledgeItem).bookmarked).toBe(true);
        const list = await fetch(`${server.url}api/session/knowledge?bookmarked=true`, { headers: { cookie: ada } });
        expect(list.status).toBe(200);
        expect(((await list.json()) as { items: Knowledge.LiveKnowledgeItem[] }).items.map((i) => i.id)).toEqual([bookmarkedId]);
        const unset = await fetch(bookmarkUrl, { method: 'POST', headers: { cookie: ada, ...json }, body: JSON.stringify({ bookmarked: false }) });
        expect(unset.status).toBe(200);
        const invalidBookmark = await fetch(bookmarkUrl, { method: 'POST', headers: { cookie: ada, ...json }, body: JSON.stringify({ bookmarked: 'yes' }) });
        expect(invalidBookmark.status).toBe(400);

        // a mere acknowledgement: stopped at the mechanical stage, no model asked
        await say('ありがとうございます！');
        await until('the mechanical stop', () => (lines.some((l) => l.includes('stopped at the mechanical stage')) ? true : undefined));
        expect<unknown>([gates.length, prompts.length]).toEqual([1, 1]);

        // the session closes: what was said since is extracted before the extractor is told
        const second = await say('急ぎは17時まで');
        const closed = await fetch(`${server.url}api/session/close`, { method: 'POST', headers: { cookie: ada, ...json }, body: '{}' });
        expect(closed.status).toBe(200);
        await server.closed;
        expect(await extractor.done).toBe('closed');
        // extraction 2 was the acknowledgement's, stopped before any model
        expect<unknown>(store.extractions.map((e) => e.by.number)).toEqual([1, 3]);
        const last = store.extractions[1].operations[0];
        expect<unknown>(last.kind === 'Add' && last.sources[0].message).toBe(second);
    });

    test("an item is about a sticky nobody pointed at: the extractor is given the workspace's stickies, its light model their names", async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-knowledge-'));
        dirs.push(root);
        await writeFile(path.join(root, 'shop.dt'), 'context Shop {\n  id OrderId: UUID\n}\n');
        await writeFile(
            path.join(root, 'returns.dtes'),
            'storming Returns "返品" {\n  event ReturnRequested "返品が依頼された"\n  event RefundPaid "返金した"\n  actor Clerk "窓口担当"\n}\n',
        );
        const store = memoryStore();
        const settings = sessionConfig(true);
        const knowledge = settings.knowledge && { ...settings.knowledge, extraction: { ...settings.knowledge.extraction, enabled: true } };
        const server = await startSessionServer({
            root,
            debounceMs: 30,
            session: { ...settings, ...(knowledge && { knowledge }) },
            knowledgeStore: store,
            log: () => {},
        });
        cleanups.push(() => server.stop());
        await server.ready;
        const joined = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Ada' }) });
        const ada = (joined.headers.get('set-cookie') ?? '').split(';')[0];
        expect((await fetch(server.facilitatorLink, { headers: { cookie: ada }, redirect: 'manual' })).status).toBe(303);

        // the fake extractor puts the finding on the sticky whose label the message is about, from the system prompt's list
        const contexts: (string | undefined)[] = [];
        const gateContexts: (string | undefined)[] = [];
        const extractor = startExtractor({
            api: createHttpAgentApi({ url: server.agentUrl, token: server.agentToken }),
            agent: {
                async gate(turn: ExtractTurn) {
                    gateContexts.push(turn.context);
                    const verdict = { verdict: 'yes', messages: [] };
                    return { text: JSON.stringify(verdict), structured: verdict };
                },
                async extract(turn: ExtractTurn) {
                    contexts.push(turn.context);
                    const listed = JSON.parse((turn.context ?? '').replace('<workspace-stickies>', '').replace('</workspace-stickies>', '')) as {
                        ref: string;
                        label?: string;
                    }[];
                    const block = turn.prompt.slice(turn.prompt.indexOf('{'), turn.prompt.lastIndexOf('}') + 1);
                    const data = JSON.parse(block) as { messages: { key: string; isNew: boolean; text: string }[]; targeted: unknown[] };
                    const first = data.messages.find((m) => m.isNew);
                    const refund = listed.find((s) => s.label === '返金した');
                    const reply = {
                        operations:
                            first && refund && data.targeted.length === 0
                                ? [
                                      {
                                          op: 'add',
                                          title: '返金は検品の翌営業日',
                                          text: '返金は検品の翌営業日に行う',
                                          when: 'as_is',
                                          kind: 'rule',
                                          origin: 'said',
                                          about: [refund.ref, 'Returns.Unknown'],
                                          sources: [{ message: first.key, quote: first.text }],
                                          reason: '決まりが言われた',
                                      },
                                  ]
                                : [],
                    };
                    return { text: JSON.stringify(reply), structured: reply };
                },
            },
            clock: { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), every: () => () => {} },
            nonce: () => 'n0nce',
            log: () => {},
        });
        cleanups.push(() => extractor.stop());
        const sent = await fetch(`${server.url}api/session/requests`, {
            method: 'POST',
            headers: { cookie: ada, ...json },
            body: JSON.stringify({ targets: [], body: '返金は検品が終わった翌営業日にしています' }),
        });
        expect(sent.status).toBe(201);
        await until('the extraction', () => (store.extractions.length === 1 ? true : undefined));
        const [op] = store.extractions[0].operations;
        // the unknown ref is still left out
        expect<unknown>(op.kind === 'Add' && op.content.about).toEqual(['Returns.RefundPaid']);
        // no page has a storming open, no journey: every storming's stickies
        expect(contexts[0]).toContain('"ref": "Returns.Clerk"');
        expect(gateContexts[0]).toContain('"窓口担当"');
    });

    test('a store that cannot be opened (cloudflare, its settings not approved) is said in one line, and nothing is extracted', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-knowledge-'));
        dirs.push(root);
        await writeFile(path.join(root, 'shop.dt'), 'context Shop {\n  id OrderId: UUID\n}\n');
        const file = path.join(root, 'domaintrail.jsonc');
        const text = JSON.stringify({ knowledge: { store: 'cloudflare', project: 'shop', url: 'https://knowledge.example.com' } });
        await writeFile(file, text);
        const lines: string[] = [];
        const server = await startSessionServer({
            root,
            debounceMs: 30,
            session: sessionConfig(false),
            knowledge: { config: resolveConfig(text, file), approval: undefined },
            log: (line) => lines.push(line),
        });
        cleanups.push(() => server.stop());
        await server.ready;
        expect(lines.filter((l) => l.startsWith('knowledge:'))).toEqual([
            expect.stringContaining('knowledge: not extracted in this session (') as unknown as string,
        ]);
        const res = await fetch(`${server.agentUrl}agent/extractions/events`, { headers: { authorization: `Bearer ${server.agentToken}` } });
        expect(res.status).toBe(404);
    });

    test('without a store, the extraction entry point answers 404 and the extractor ends', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-knowledge-'));
        dirs.push(root);
        await writeFile(path.join(root, 'shop.dt'), 'context Shop {\n  id OrderId: UUID\n}\n');
        const server = await startSessionServer({ root, debounceMs: 30, session: sessionConfig(false) });
        cleanups.push(() => server.stop());
        await server.ready;
        const extractor = startExtractor({
            api: createHttpAgentApi({ url: server.agentUrl, token: server.agentToken }),
            agent: { extract: () => Promise.reject(new Error('never asked')), gate: () => Promise.reject(new Error('never asked')) },
            clock: { sleep: async () => {}, every: () => () => {} },
            nonce: () => 'n',
            log: () => {},
        });
        expect(await extractor.done).toBe('off');
    });
});
