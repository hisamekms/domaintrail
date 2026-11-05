// The published stormings in workerd (Miniflare), through the `cloudflare` adapter as `dt publish` sends them and as the
// read-only page reads them: `PUT /published/:storming` by the writing service token only, the list and the form, the
// items about stickies no published storming has, a person's writes from the Worker's own page only, and the page's
// files behind the Access check.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cloudflareKnowledgeStore, type CloudflareKnowledgeStore, type Knowledge, type PublishedStorming } from '@domaintrail/knowledge';
import * as wire from '@domaintrail/knowledge/protocol';
import { startWorker, type RunningWorker } from './test-helpers.js';

const WRITER = 'writer.access';
const READER = 'reader.access';
const PERSON = { 'Cf-Access-Authenticated-User-Email': 'reader@example.com' };

let worker: RunningWorker;
let store: CloudflareKnowledgeStore;
let reader: CloudflareKnowledgeStore;

beforeAll(async () => {
    const page = await mkdtemp(path.join(tmpdir(), 'knowledge-page-'));
    await writeFile(path.join(page, 'index.html'), '<!doctype html><title>page</title><script type="module" src="./main-abc.js"></script>');
    await writeFile(path.join(page, 'main-abc.js'), 'console.log("page")');
    worker = await startWorker({ INSECURE_SKIP_ACCESS_CHECK: 'true', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', WRITER_TOKENS: WRITER }, { page });
    store = cloudflareKnowledgeStore({ url: worker.url, serviceToken: { clientId: WRITER, clientSecret: 'secret' } });
    reader = cloudflareKnowledgeStore({ url: worker.url, serviceToken: { clientId: READER, clientSecret: 'secret' } });
});
afterAll(() => worker?.dispose());

let projects = 0;
const newProject = (): Knowledge.ProjectName => wire.projectName(`pub${++projects}`, 'test');
const ref = (s: string): Knowledge.StickyRef => wire.stickyRef(s, 'test');

const form = (over: Partial<PublishedStorming> = {}): PublishedStorming => ({
    format: 1,
    storming: 'Ordering',
    label: '受注',
    version: 'v-1',
    drawing: { at: new Date('2026-11-04T10:00:00.000Z'), commit: 'abc1234' },
    stickies: [{ ref: ref('Ordering.Placed'), label: '注文した' }, { ref: ref('Ordering.Place') }],
    views: { 'big-picture': { id: 'es-bp', nodes: [] }, 'design-level': { id: 'es-dl', nodes: [] } },
    ...over,
});

const add = (n: number, about: string[]): unknown => ({
    kind: 'Add',
    id: `kn_${String(n).padStart(8, '0')}`,
    content: { text: `finding ${n}`, labels: { when: 'as_is', kind: 'rule', origin: 'said' }, about },
    sources: [{ session: 's1', message: `m${n}`, at: '2026-11-05T09:00:00.000Z', quote: 'そういう決まりです' }],
});

describe('publishing', () => {
    test('the writing token publishes; the same drawing again changes nothing; readers list it and read it as sent', async () => {
        const project = newProject();
        const first = await store.publish(project, form());
        expect(first.changed).toBe(true);
        expect(first.entry).toMatchObject({ storming: 'Ordering', label: '受注', version: 'v-1', drawing: { commit: 'abc1234' } });
        expect(first.entry.drawing.at.toISOString()).toBe('2026-11-04T10:00:00.000Z');
        expect((await store.publish(project, form())).changed).toBe(false);
        expect((await store.publish(project, form({ version: 'v-2' }))).changed).toBe(true);

        const headers = { 'CF-Access-Client-Id': READER };
        const base = `${worker.url}${wire.projectPath(project)}`;
        const list = wire.publishedEntries(await (await fetch(`${base}/published`, { headers })).json(), 'body');
        expect(list.map((e) => [e.storming, e.version])).toEqual([['Ordering', 'v-2']]);
        const got = wire.publishedStorming(await (await fetch(`${base}/published/Ordering`, { headers })).json(), 'body');
        expect(got).toEqual(form({ version: 'v-2' }));
        expect((await fetch(`${base}/published/Billing`, { headers })).status).toBe(404);
        const projectsBody = wire.projectNames(await (await fetch(`${worker.url}/v1/projects`, { headers })).json(), 'body');
        expect(projectsBody).toContain(project);
    });

    test('only a writing service token publishes: not a reading one, not a person', async () => {
        const project = newProject();
        expect(await reader.publish(project, form()).catch((e: unknown) => e)).toMatchObject({ status: 403, type: 'Forbidden' });
        const res = await fetch(`${worker.url}${wire.projectPath(project)}/published/Ordering`, {
            method: 'PUT',
            headers: { ...PERSON, 'Content-Type': 'application/json' },
            body: JSON.stringify(form()),
        });
        expect(res.status).toBe(403);
        expect((await fetch(`${worker.url}${wire.projectPath(project)}/published`, { headers: PERSON }).then((r) => r.json())) as unknown).toEqual({
            stormings: [],
        });
    });

    test('a form that is not the API’s, of another storming, or too large is refused', async () => {
        const project = newProject();
        const put = (storming: string, body: string): Promise<Response> =>
            fetch(`${worker.url}${wire.projectPath(project)}/published/${storming}`, {
                method: 'PUT',
                headers: { 'CF-Access-Client-Id': WRITER, 'Content-Type': 'application/json' },
                body,
            });
        expect((await put('Billing', JSON.stringify(form()))).status).toBe(400);
        const foreign = await put('Ordering', JSON.stringify(form({ stickies: [{ ref: ref('Billing.Paid') }] })));
        expect(await foreign.json()).toMatchObject({ error: { type: 'BadRequest', message: expect.stringContaining('body.stickies[0].ref') } });
        expect((await put('Ordering', JSON.stringify({ ...form(), format: 2 }))).status).toBe(400);
        const huge = await put(
            'Ordering',
            JSON.stringify(form({ views: { 'big-picture': { pad: 'x'.repeat(wire.MAX_PUBLISHED_BYTES) }, 'design-level': {} } })),
        );
        expect(huge.status).toBe(413);
    });
});

describe('items about stickies missing from the drawing', () => {
    test('none before anything is published; then the items about stickies no published storming has', async () => {
        const project = newProject();
        await store.applyExtraction(
            project,
            wire.extraction(
                {
                    by: { session: 's1', number: 1 },
                    operations: [add(1, ['Ordering.Placed']), add(2, ['Ordering.Gone']), add(3, ['Billing.Paid', 'Ordering.Place'])],
                },
                'test',
            ),
        );
        const missing = async (): Promise<{ stickies: string[]; items: string[] }> => {
            const body = await (await fetch(`${worker.url}${wire.projectPath(project)}/missing`, { headers: PERSON })).json();
            const m = wire.missingStickies(body, 'body');
            return { stickies: [...m.stickies], items: m.items.map((i) => i.id) };
        };
        expect(await missing()).toEqual({ stickies: [], items: [] });
        await store.publish(project, form());
        // Billing is not published, Ordering.Gone not in its drawing; the item about Billing.Paid and Ordering.Place
        // names a missing sticky too
        expect(await missing()).toEqual({ stickies: ['Billing.Paid', 'Ordering.Gone'], items: ['kn_00000003', 'kn_00000002'] });
    });
});

describe("a person's writes", () => {
    test("are taken from the Worker's own page only", async () => {
        const project = newProject();
        await store.applyExtraction(
            project,
            wire.extraction({ by: { session: 's1', number: 1 }, operations: [add(1, ['Ordering.Placed']), add(2, ['Ordering.Placed'])] }, 'test'),
        );
        const del = (n: number, headers: Record<string, string>): Promise<Response> =>
            fetch(`${worker.url}${wire.projectPath(project)}/knowledge/kn_0000000${n}`, { method: 'DELETE', headers: { ...PERSON, ...headers } });
        const elsewhere = await del(1, { Origin: 'https://evil.example' });
        expect(elsewhere.status).toBe(403);
        expect(await elsewhere.json()).toMatchObject({ error: { type: 'CrossOrigin' } });
        expect((await del(1, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
        expect((await del(1, { Origin: worker.url, 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
        // a service token is no browser: dt's calls carry no Origin and are never refused for it
        expect((await store.delete(project, wire.itemId('kn_00000002', 'test'), wire.userName('p@example.com', 'test'))).ok).toBe(true);
    });
});

describe('the page', () => {
    test('is served behind the Access check, with its headers, on every path without an extension', async () => {
        const res = await fetch(`${worker.url}/`, { headers: PERSON });
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('<title>page</title>');
        expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
        expect(res.headers.get('Cache-Control')).toBe('no-cache');
        expect(await (await fetch(`${worker.url}/projects/p1`, { headers: PERSON })).text()).toContain('<title>page</title>');
        const script = await fetch(`${worker.url}/main-abc.js`, { headers: PERSON });
        expect(await script.text()).toContain('console.log');
        expect(script.headers.get('Cache-Control')).toContain('immutable');
        expect((await fetch(`${worker.url}/missing.js`, { headers: PERSON })).status).toBe(404);
        expect((await fetch(`${worker.url}/`)).status).toBe(401);
        expect((await fetch(`${worker.url}/`, { method: 'POST', headers: PERSON })).status).toBe(405);
    });
});
