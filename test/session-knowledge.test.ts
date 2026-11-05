/**
 * Knowledge taken from a session (ADR 0031, section 3; plan task K4) over a real session server (dev identity), with a
 * store in memory in place of the workspace's and the extractor role connected through the agent API with a fake agent:
 * a person's message extracted once the talk is quiet, the item applied with the session and the extraction's number,
 * its source the message; the last extraction when the session closes, after which the extractor is told the session
 * closed. Without a store — none configured, or a `cloudflare` one whose settings are not approved, which is said —
 * the extraction entry point answers 404 and the extractor ends.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { type AnswerTurn, createHttpAgentApi, DEFAULT_AGENT_TOOLS, startExtractor } from '@domaintrail/agent';
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
            extraction: { quietSeconds: 0.2, minIntervalSeconds: 0, contextMinutes: 10, settleSeconds: 120 },
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
        search: async (_p, query) => ({ items: live().filter((i) => query.session === undefined || i.createdIn === query.session) }),
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
        get: unused,
        correct: unused,
        unlinkConflict: unused,
        delete: unused,
        deleteSession: unused,
        restore: unused,
        redactions: unused,
        audit: unused,
        putImage: unused,
        getImage: unused,
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
        const server = await startSessionServer({ root, debounceMs: 30, session: sessionConfig(true), knowledgeStore: store });
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

        // the extractor: a fake agent that finds one rule in the first new message of each job
        const prompts: string[] = [];
        const extractor = startExtractor({
            api: createHttpAgentApi({ url: server.agentUrl, token: server.agentToken }),
            agent: {
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

        const first = await say('見積もりは営業が当日中に出す');
        await until('the first extraction', () => (store.extractions.length === 1 ? true : undefined));
        const [extraction] = store.extractions;
        expect<unknown>([extraction.by.session, extraction.by.number]).toEqual([server.session, 1]);
        const [op] = extraction.operations;
        expect<unknown>(op.kind === 'Add' && [op.content.text, op.sources[0].message, op.sources[0].quote]).toEqual([
            '決まり: 見積もりは営業が当日中に出す',
            first,
            '見積もりは営業が当日中に出す',
        ]);
        expect(prompts[0]).toContain('<talk-n0nce>');

        // the session closes: what was said since is extracted before the extractor is told
        const second = await say('急ぎは17時まで');
        const closed = await fetch(`${server.url}api/session/close`, { method: 'POST', headers: { cookie: ada, ...json }, body: '{}' });
        expect(closed.status).toBe(200);
        await server.closed;
        expect(await extractor.done).toBe('closed');
        expect<unknown>(store.extractions.map((e) => e.by.number)).toEqual([1, 2]);
        const last = store.extractions[1].operations[0];
        expect<unknown>(last.kind === 'Add' && last.sources[0].message).toBe(second);
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
            agent: { extract: () => Promise.reject(new Error('never asked')) },
            clock: { sleep: async () => {}, every: () => () => {} },
            nonce: () => 'n',
            log: () => {},
        });
        expect(await extractor.done).toBe('off');
    });
});
