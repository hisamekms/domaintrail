/**
 * The Live View's knowledge (ADR 0031, sections 7 and 10; plan task K5) over a real session server (dev identity) and a
 * `files` store in a temporary workspace: the page's routes under `/api/session/knowledge` (counts, search, an item with
 * its versions, 直す, 画像を付ける and the image served, 食い違いではない, 消す and 元に戻す), every page told over the
 * WebSocket when the knowledge changed, and a deletion past its undo window redacting its source message in the
 * session database (the redaction log read on a timer, the `files` store swept first).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DEFAULT_AGENT_TOOLS } from '@domaintrail/agent';
import { type SessionSettings, startSessionServer } from '@domaintrail/dt';
import { createFilesKnowledgeStore, Knowledge } from '@domaintrail/knowledge';
import * as wire from '@domaintrail/knowledge/protocol';

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
        // no extraction while the test runs: the items are put in the store directly
        extraction: { quietSeconds: 3600, minIntervalSeconds: 3600, contextMinutes: 10, settleSeconds: 120 },
    },
};

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
const content = (text: string, about: string[]): unknown => ({ text, labels: { when: 'as_is', kind: 'rule', origin: 'said' }, about });
/** A 1×1 PNG. */
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

describe('the Live View’s knowledge', () => {
    test('reads, corrects, attaches an image, unlinks a conflict, deletes with undo, and redacts after the sweep', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-knowledge-live-'));
        dirs.push(root);
        await writeFile(path.join(root, 'shop.dt'), 'context Shop {\n  id OrderId: UUID\n}\n');
        const store = createFilesKnowledgeStore({ dir: path.join(root, 'knowledge'), project, stateDir: path.join(root, 'state'), undoWindowMs: 200 });
        const server = await startSessionServer({
            root,
            debounceMs: 30,
            session: sessionConfig,
            knowledgeStore: store,
            redactionEveryMs: 100,
        });
        cleanups.push(() => server.stop());
        await server.ready;
        const joined = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Ada' }) });
        const cookie = (joined.headers.get('set-cookie') ?? '').split(';')[0];
        const api = (p: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Response> =>
            fetch(`${server.url}api/session/knowledge${p}`, { ...init, headers: { cookie, ...(init.body !== undefined && json), ...init.headers } });
        const post = (p: string, body: unknown = {}): Promise<Response> => api(p, { method: 'POST', body: JSON.stringify(body) });

        // without signing in: nothing
        expect((await fetch(`${server.url}api/session/knowledge/counts?storming=Shop`)).status).toBe(401);

        // a message, and two items from it that conflict
        const sent = await fetch(`${server.url}api/session/requests`, {
            method: 'POST',
            headers: { cookie, ...json },
            body: JSON.stringify({ targets: [], body: '締めは前日17時、担当は山田さん' }),
        });
        const message = ((await sent.json()) as { request: { id: string } }).request.id;
        const session = server.session as unknown as string;
        const source = { session, message, at: new Date().toISOString(), quote: '締めは前日17時' };
        await store.applyExtraction(
            project,
            wire.extraction(
                {
                    by: { session, number: 1 },
                    operations: [{ kind: 'Add', id: 'kn_00000001', content: content('締めは前日17時', ['Shop.Placed']), sources: [source] }],
                },
                'test',
            ),
        );
        await store.applyExtraction(
            project,
            wire.extraction(
                {
                    by: { session: 'earlier', number: 1 },
                    operations: [
                        {
                            kind: 'Conflict',
                            id: 'kn_00000002',
                            content: content('締めは当日9時', ['Shop.Placed', 'Shop.Paid']),
                            sources: [{ ...source, session: 'earlier', message: 'm-earlier' }],
                            item: 'kn_00000001',
                            base: 1,
                        },
                    ],
                },
                'test',
            ),
        );

        // the pages are told of each change
        const told: string[] = [];
        const ws = new WebSocket(`${server.url.replace('http', 'ws')}ws`, {
            headers: { cookie, origin: server.url.replace(/\/$/, '') },
        } as unknown as string[]);
        ws.onmessage = (e) => {
            const m = JSON.parse(String(e.data)) as { type: string };
            if (m.type === 'knowledge.changed' || m.type === 'session.state') told.push(m.type);
        };
        await until('the socket', () => (told.includes('session.state') ? true : undefined));
        cleanups.push(async () => ws.close());

        const counts = wire.stickyCounts(await (await api('/counts?storming=Shop')).json(), 'counts');
        expect(counts.map((c) => [c.sticky, c.hasItems, c.hasConflict])).toEqual([
            ['Shop.Paid', true, true],
            ['Shop.Placed', true, true],
        ] as unknown as [Knowledge.StickyRef, boolean, boolean][]);
        const found = wire.page(wire.liveItem)(await (await api('/?about=Shop.Paid')).json(), 'page');
        expect(found.items.map((i) => i.id as string)).toEqual(['kn_00000002']);
        expect(
            wire
                .page(wire.liveItem)(await (await api('?q=%E5%BD%93%E6%97%A5')).json(), 'page')
                .items.map((i) => i.id as string),
        ).toEqual(['kn_00000002']);
        expect((await api('?kind=nonsense')).status).toBe(400);

        // 直す: a new version, the person who did it from the identity; every page told
        const corrected = await post('/items/kn_00000001/correct', { content: content('締めは前日の17時', ['Shop.Placed']) });
        expect(corrected.status).toBe(200);
        expect(wire.liveItem(await corrected.json(), 'item').version).toBe(wire.itemVersion(2, 'test'));
        await until('the change told', () => (told.includes('knowledge.changed') ? true : undefined));
        const audit = await store.audit(project, { item: wire.itemId('kn_00000001', 'test') });
        expect(audit.items[0]?.actor).toEqual({ kind: 'Person', user: wire.userName('guest:Ada', 'test') });

        // 画像を付ける: the image at the end of the text, served back
        const attached = await api('/items/kn_00000001/images', { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG });
        expect(attached.status).toBe(201);
        const text = wire.liveItem(await attached.json(), 'item').content.text;
        const image = /image:(img_[0-9a-z]+)/.exec(text)?.[1];
        expect(image).toBeString();
        const served = await api(`/images/${image}`);
        expect([served.status, served.headers.get('content-type'), served.headers.get('x-content-type-options')]).toEqual([200, 'image/png', 'nosniff']);
        expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
        expect((await api('/items/kn_00000001/images', { method: 'POST', headers: { 'content-type': 'image/svg+xml' }, body: '<svg/>' })).status).toBe(415);

        // the versions
        const got = wire.itemWithHistory(await (await api('/items/kn_00000001?history=1')).json(), 'item');
        expect(got.item.version).toBe(wire.itemVersion(3, 'test'));

        // 食い違いではない
        const unlinked = await post('/items/kn_00000002/unlink', { other: 'kn_00000001' });
        expect(wire.liveItems(await unlinked.json(), 'body').map((i) => i.conflictsWith)).toEqual([[], []]);
        expect(wire.stickyCounts(await (await api('/counts?storming=Shop')).json(), 'counts').some((c) => c.hasConflict)).toBe(false);

        // 消す, 元に戻す, 消す again: past the undo window, the sweep and the redaction log redact the message
        const deleted = wire.deletion(await (await post('/items/kn_00000001/delete')).json(), 'deletion');
        expect(deleted.messages.map((m) => m.message as string)).toEqual([message]);
        expect((await api('/items/kn_00000001')).status).toBe(404);
        expect((await post('/items/kn_00000001/restore')).status).toBe(200);
        expect((await api('/items/kn_00000001')).status).toBe(200);
        expect((await post('/items/kn_00000001/delete')).status).toBe(200);
        const body = async (): Promise<string | undefined> => {
            const state = (await (await fetch(`${server.url}api/session/state`, { headers: { cookie } })).json()) as {
                requests: { id: string; body: string }[];
            };
            return state.requests.find((r) => r.id === message)?.body;
        };
        expect(await body()).toBe('締めは前日17時、担当は山田さん');
        expect(await until('the redaction', async () => ((await body()) === '（墨消し）' ? true : undefined))).toBe(true);
        expect((await post('/items/kn_00000001/restore')).status).toBe(404);
    });
});
