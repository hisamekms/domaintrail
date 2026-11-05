// The one factory of the knowledge store: `files` in `<root>/knowledge` with its state in `<state>/knowledge`, and
// `cloudflare` at `knowledge.url` with the environment's service token (refused, in one line, without one).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Knowledge, resolveKnowledgeConfig } from '@domaintrail/knowledge';
import { openKnowledgeStore } from './knowledge.js';

const made = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
};

let root: string;
let state: string;
beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'domaintrail-knowledge-store-'));
    state = await mkdtemp(path.join(tmpdir(), 'domaintrail-knowledge-state-'));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
});

describe('openKnowledgeStore', () => {
    test('files: the items in <root>/knowledge, the deleted ones in <state>/knowledge, the project of the config', async () => {
        const opened = await openKnowledgeStore(resolveKnowledgeConfig({ project: 'shop' }, 'whatever'), root, { stateDir: async () => state });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const { store, project, kind, sweep } = opened.value;
        expect(kind).toBe('files');
        expect(project).toBe(made(Knowledge.makeProjectName('shop')));
        expect(sweep).toBeFunction();
        // nothing is made until a call writes
        expect(await readdir(root)).toEqual([]);
        const id = made(Knowledge.makeKnowledgeItemId('kn_00000001'));
        await store.applyExtraction(project, {
            by: { session: made(Knowledge.makeSessionRef('s1')), number: made(Knowledge.makeExtractionNumber(1)) },
            operations: [
                {
                    kind: 'Add',
                    id,
                    content: {
                        text: made(Knowledge.makeItemText('A finding.')),
                        labels: { when: 'as_is', kind: 'rule', origin: 'said' },
                        about: [made(Knowledge.makeStickyRef('Ordering.Placed'))],
                    },
                    sources: [
                        {
                            session: made(Knowledge.makeSessionRef('s1')),
                            message: made(Knowledge.makeMessageRef('m1')),
                            at: new Date('2026-11-05T09:00:00Z'),
                            quote: made(Knowledge.makeQuote('so it is')),
                        },
                    ],
                },
            ],
        });
        expect(await readdir(path.join(root, 'knowledge'))).toContain('kn_00000001.md');
        await store.delete(project, id, made(Knowledge.makeUserName('alice@example.com')));
        expect(await readdir(path.join(state, 'knowledge', 'deleted'))).toEqual(['kn_00000001.md']);
    });

    test('files without a project: the one named after the workspace directory', async () => {
        const opened = await openKnowledgeStore(resolveKnowledgeConfig({}, 'My Shop'), root, { stateDir: async () => state });
        expect(opened.ok && opened.value.project).toBe(made(Knowledge.makeProjectName('my-shop')));
    });

    const cloudflare = (url = 'https://knowledge.example.com') => resolveKnowledgeConfig({ store: 'cloudflare', project: 'shop', url }, 'shop');
    const noState = { stateDir: () => Promise.reject(new Error('the state directory is not opened for cloudflare')) };

    test('cloudflare: the Worker at knowledge.url, with the service token of the environment', async () => {
        const seen: Request[] = [];
        const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            seen.push(new Request(input, init));
            return Response.json({ items: [] });
        }) as typeof globalThis.fetch;
        const env = { DOMAINTRAIL_KNOWLEDGE_CLIENT_ID: 'id.access', DOMAINTRAIL_KNOWLEDGE_CLIENT_SECRET: 'secret' };
        const opened = await openKnowledgeStore(cloudflare(), root, { ...noState, env, fetch });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        expect(opened.value.kind).toBe('cloudflare');
        expect(opened.value.sweep).toBeUndefined();
        await opened.value.store.search(opened.value.project, {});
        expect(seen).toHaveLength(1);
        expect(new URL(seen[0].url).origin).toBe('https://knowledge.example.com');
        expect(seen[0].headers.get('CF-Access-Client-Id')).toBe('id.access');
        expect(seen[0].headers.get('CF-Access-Client-Secret')).toBe('secret');
    });

    test('cloudflare without a service token: the variables to set, in one line (none needed on loopback)', async () => {
        const opened = await openKnowledgeStore(cloudflare(), root, { ...noState, env: { DOMAINTRAIL_KNOWLEDGE_CLIENT_ID: 'id.access' } });
        expect(opened).toEqual({
            ok: false,
            error: {
                type: 'KnowledgeStoreUnavailable',
                store: 'cloudflare',
                message: "the knowledge store 'cloudflare' needs an Access service token: set DOMAINTRAIL_KNOWLEDGE_CLIENT_SECRET",
            },
        });
        const local = await openKnowledgeStore(cloudflare('http://localhost:8787'), root, { ...noState, env: {} });
        expect(local.ok).toBe(true);
    });
});
