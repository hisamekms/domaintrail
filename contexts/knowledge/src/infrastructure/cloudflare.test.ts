// The `cloudflare` adapter against a stand-in of the Worker on a loopback port: what it sends (the service token, the
// person, the idempotency key) and how it maps the answers to the port (the domain's errors as results, anything else
// as a KnowledgeStoreError). The adapter against the real Worker is apps/knowledge-worker's test.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Knowledge } from '../generated/index.js';
import { content, extraction, itemId, liveItem, source, stickyRef, userName } from '../test-helpers.js';
import { cloudflareKnowledgeStore, KnowledgeStoreError } from './cloudflare.js';

/** The error a promise rejects with (fails when it resolves). */
async function thrown(p: Promise<unknown>): Promise<Error> {
    const e = await p.then(
        () => undefined,
        (x: unknown) => x,
    );
    if (!(e instanceof Error)) throw new Error('expected a rejection with an Error');
    return e;
}

interface Seen {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
}

let seen: Seen[] = [];
let answer: (req: Request) => Response = () => Response.json({});
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
    server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(req) {
            const url = new URL(req.url);
            seen.push({ method: req.method, path: url.pathname + url.search, headers: Object.fromEntries(req.headers), body: await req.text() });
            return answer(req);
        },
    });
});
afterAll(() => server?.stop(true));

const project = 'dmcore' as Knowledge.ProjectName;
const store = (): ReturnType<typeof cloudflareKnowledgeStore> =>
    cloudflareKnowledgeStore({ url: `http://127.0.0.1:${server.port}/base/`, serviceToken: { clientId: 'id.access', clientSecret: 'shh' } });
const reset = (respond: (req: Request) => Response): void => {
    seen = [];
    answer = respond;
};
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

describe('the cloudflare adapter', () => {
    test('sends the service token, the idempotency key and the operations, and reads the result', async () => {
        const item = liveItem('kn_00000001', { createdIn: 's1' });
        reset(() => Response.json({ items: [item], dropped: [], replayed: false }));
        const ops: Knowledge.Extraction = {
            by: extraction('s1', 2),
            operations: [{ kind: 'Add', id: item.id, content: content('a rule'), sources: [source('s1', 'm1')] }],
        };
        const applied = await store().applyExtraction(project, ops);
        expect(applied).toEqual({ items: [item], dropped: [], replayed: false });
        expect(seen[0]).toMatchObject({
            method: 'POST',
            path: '/base/v1/projects/dmcore/extractions',
            headers: { 'cf-access-client-id': 'id.access', 'cf-access-client-secret': 'shh', 'idempotency-key': 's1#2', 'content-type': 'application/json' },
        });
        expect(JSON.parse(seen[0].body)).toEqual(plain(ops));
    });

    test('names the person a correction is by, and maps 404 and 410 to the domain’s errors', async () => {
        reset(() => Response.json({ error: { type: 'Knowledge.KnowledgeItemGone', itemId: 'kn_00000001' } }, { status: 410 }));
        const corrected = await store().correct(project, itemId('kn_00000001'), content('fixed'), userName('山田@example.com'));
        expect(corrected).toEqual({ ok: false, error: { type: 'Knowledge.KnowledgeItemGone', itemId: itemId('kn_00000001') } });
        expect(seen[0]).toMatchObject({ method: 'PATCH', path: '/base/v1/projects/dmcore/knowledge/kn_00000001' });
        expect(decodeURIComponent(seen[0].headers['x-knowledge-actor'])).toBe('山田@example.com');

        reset(() => Response.json({ error: { type: 'Knowledge.KnowledgeItemNotFound', itemId: 'kn_00000001' } }, { status: 404 }));
        expect(await store().delete(project, itemId('kn_00000001'), userName('a@example.com'))).toEqual({
            ok: false,
            error: { type: 'Knowledge.KnowledgeItemNotFound', itemId: itemId('kn_00000001') },
        });
        expect(await store().get(project, itemId('kn_00000001'))).toBeUndefined();
    });

    test('unlinks a conflict with the other item in the body, and reads both sides back', async () => {
        const a = liveItem('kn_00000001');
        const b = liveItem('kn_00000002');
        reset(() => Response.json({ items: [a, b] }));
        const r = await store().unlinkConflict(project, a.id, b.id, userName('a@example.com'));
        expect(r).toEqual({ ok: true, value: [a, b] });
        expect(seen[0]).toMatchObject({ method: 'POST', path: '/base/v1/projects/dmcore/knowledge/kn_00000001/unlink' });
        expect(JSON.parse(seen[0].body)).toEqual({ other: 'kn_00000002' });
    });

    test('hands a conflict over to a hotspot with the other item and the hotspot in the body, and reads both sides back', async () => {
        const a = liveItem('kn_00000001');
        const b = liveItem('kn_00000002');
        reset(() => Response.json({ items: [a, b] }));
        const r = await store().handOverToHotspot(project, a.id, b.id, stickyRef('Ordering.CutOffUnclear'), userName('a@example.com'));
        expect(r).toEqual({ ok: true, value: [a, b] });
        expect(seen[0]).toMatchObject({ method: 'POST', path: '/base/v1/projects/dmcore/knowledge/kn_00000001/hand-over' });
        expect(JSON.parse(seen[0].body)).toEqual({ other: 'kn_00000002', hotspot: 'Ordering.CutOffUnclear' });
    });

    test('pages through a search to list the items about stickies, newest first', async () => {
        const older = liveItem('kn_00000001');
        const newer = { ...liveItem('kn_00000002'), updatedAt: new Date('2026-11-06T00:00:00Z') };
        reset((req) => (new URL(req.url).searchParams.get('cursor') ? Response.json({ items: [older] }) : Response.json({ items: [newer], next: 'c1' })));
        const items = await store().about(project, content('x', 'said', ['Ordering.Accept']).about);
        expect(items.map((i) => i.id)).toEqual([newer.id, older.id]);
        expect(seen.map((s) => s.path)).toEqual([
            '/base/v1/projects/dmcore/knowledge?about=Ordering.Accept&limit=200',
            '/base/v1/projects/dmcore/knowledge?about=Ordering.Accept&limit=200&cursor=c1',
        ]);
    });

    test('fails on Access’s redirect to sign in, on the Worker’s errors, and on answers that are not the API’s', async () => {
        reset(() => new Response(null, { status: 302, headers: { Location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' } }));
        const redirected = await store()
            .search(project, {})
            .catch((e: unknown) => e);
        expect(redirected).toBeInstanceOf(KnowledgeStoreError);
        expect(redirected).toMatchObject({ status: 302, type: 'Unauthenticated' });

        reset(() => Response.json({ error: { type: 'StoreNotMigrated', message: 'apply its migrations' } }, { status: 503 }));
        expect(await thrown(store().counts(project, 'Ordering'))).toMatchObject({ status: 503, type: 'StoreNotMigrated' });

        reset(() => new Response('<html>sign in</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
        expect((await thrown(store().search(project, {}))).message).toContain('what is not JSON');

        reset(() => Response.json({ items: [{ id: 'nope' }] }));
        expect((await thrown(store().search(project, {}))).message).toContain('body.items[0]');

        // a 404 that is not the domain's (no such route) is a failure, not a missing item
        reset(() => Response.json({ error: { type: 'NotFound' } }, { status: 404 }));
        expect(await thrown(store().restore(project, itemId('kn_00000001'), userName('a@example.com')))).toMatchObject({ status: 404, type: 'NotFound' });
    });

    test('sends and reads an image as bytes', async () => {
        reset((req) =>
            req.method === 'POST'
                ? Response.json({ id: 'img_00000001' }, { status: 201 })
                : new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'image/png' } }),
        );
        const id = await store().putImage(project, { mediaType: 'image/png', bytes: new Uint8Array([1, 2]) });
        expect(plain(id)).toBe('img_00000001');
        expect(seen[0].headers['content-type']).toBe('image/png');
        expect(await store().getImage(project, id)).toEqual({ mediaType: 'image/png', bytes: new Uint8Array([1, 2]) });
    });
});
