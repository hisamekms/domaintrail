// The one factory of the knowledge store: `files` in `<root>/knowledge` with its state in `<state>/knowledge`, and
// `cloudflare` refused as not available yet.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Knowledge, resolveKnowledgeConfig } from '@domaintrail/knowledge';
import { CLOUDFLARE_NOT_AVAILABLE, openKnowledgeStore } from './knowledge.js';

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

    test('cloudflare: not available yet, said in one line', async () => {
        const opened = await openKnowledgeStore(
            resolveKnowledgeConfig({ store: 'cloudflare', project: 'shop', url: 'https://knowledge.example.com' }, 'shop'),
            root,
            { stateDir: () => Promise.reject(new Error('the state directory is not opened for cloudflare')) },
        );
        expect(opened).toEqual({ ok: false, error: { type: 'KnowledgeStoreUnavailable', store: 'cloudflare', message: CLOUDFLARE_NOT_AVAILABLE } });
    });
});
