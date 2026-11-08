// `dt publish` wired: the stormings sent to the `cloudflare` store's Worker only with the approval of the settings and
// the service token, dated by their last commit (now, without a commit, when the file differs from it); written as
// files with --out, sending nothing; refused for the `files` store; with --prune, the stormings no longer in the
// workspace removed from the Worker afterwards.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { publishedStorming } from '@domaintrail/knowledge/protocol';
import { resolveConfig, type ResolvedConfig } from '../config/config.js';
import { checkApproved } from '../cli/trust.js';
import { PublishError } from '../cli/publish.js';
import { publishStormings, type PublishDeps } from './publish.js';

let root: string;
beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'domaintrail-publish-wiring-'));
    await writeFile(path.join(root, 'returns.dtes'), 'storming Returns "返品" {\n  event ReturnRequested "返品が依頼された"\n}\n');
    await writeFile(path.join(root, 'billing.dtes'), 'storming Billing {\n  event Paid\n}\n');
});
afterEach(() => rm(root, { recursive: true, force: true }));

const config = (knowledge: object): ResolvedConfig =>
    resolveConfig(JSON.stringify({ sources: ['**/*.dtes'], knowledge }), path.join(root, 'domaintrail.jsonc'));
const cloudflare = { store: 'cloudflare', project: 'shop', url: 'https://knowledge.example.com' };
const TOKEN = { DOMAINTRAIL_KNOWLEDGE_CLIENT_ID: 'writer.access', DOMAINTRAIL_KNOWLEDGE_CLIENT_SECRET: 'secret' };
const now = (): Date => new Date('2026-11-05T12:00:00.000Z');

/** A Worker that keeps what is put (and what was published before, `kept`), answering as the template does. */
function fakeWorker(kept: readonly string[] = []): { fetch: typeof globalThis.fetch; seen: Request[]; bodies: unknown[] } {
    const seen: Request[] = [];
    const bodies: unknown[] = [];
    const published = new Map<string, object>(kept.map((storming) => [storming, { storming, version: 'v-old', drawing: { at: now() }, publishedAt: now() }]));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stand-in with fetch's call signature only
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        seen.push(request);
        const storming = /\/published\/([^/]+)$/.exec(new URL(request.url).pathname)?.[1];
        if (request.method === 'GET') return Response.json({ stormings: [...published.keys()].sort().map((k) => published.get(k)) });
        if (request.method === 'DELETE') return Response.json({ storming, removed: storming !== undefined && published.delete(storming) });
        const form = publishedStorming(await request.json(), 'body');
        bodies.push(form);
        const entry = { storming: form.storming, version: form.version, drawing: form.drawing, publishedAt: now() };
        published.set(form.storming, entry);
        return Response.json({ entry, changed: true });
    }) as typeof globalThis.fetch;
    return { fetch, seen, bodies };
}

const commits: PublishDeps['lastCommit'] = async (_root, file) =>
    file === 'returns.dtes'
        ? { commit: 'abc1234def', at: new Date('2026-11-04T10:00:00.000Z'), changed: false }
        : { commit: 'fff0000', at: now(), changed: true };

test('sends each storming to the Worker with the service token, dated by its last commit (now, when it differs from it)', async () => {
    const cfg = config(cloudflare);
    const worker = fakeWorker();
    const log: string[] = [];
    const report = await publishStormings(
        { config: cfg, approval: await checkApproved(cfg, undefined), log: (l) => log.push(l) },
        { env: TOKEN, fetch: worker.fetch, lastCommit: commits, now },
    );
    expect(report.published.map((p) => [p.storming, p.commit, p.changed])).toEqual([
        ['Billing', undefined, true],
        ['Returns', 'abc1234def', true],
    ]);
    expect(worker.seen.map((r) => [r.method, new URL(r.url).pathname, r.headers.get('CF-Access-Client-Id')])).toEqual([
        ['PUT', '/v1/projects/shop/published/Billing', 'writer.access'],
        ['PUT', '/v1/projects/shop/published/Returns', 'writer.access'],
    ]);
    expect(worker.bodies[0]).toMatchObject({ storming: 'Billing', drawing: { at: now() } });
    expect(worker.bodies[1]).toMatchObject({ storming: 'Returns', drawing: { at: new Date('2026-11-04T10:00:00.000Z'), commit: 'abc1234def' } });
    expect(log).toEqual(['Billing: billing.dtes differs from its last commit; dated now, without a commit']);
});

test('without the approval of the settings, or for the files store, nothing is laid out or sent', async () => {
    const worker = fakeWorker();
    const refused = await publishStormings({ config: config(cloudflare), approval: undefined, log: () => {} }, { env: TOKEN, fetch: worker.fetch }).catch(
        (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(PublishError);
    expect(String(refused)).toContain('not approved');
    const files = config({});
    const none = await publishStormings(
        { config: files, approval: await checkApproved(files, undefined), log: () => {} },
        { stateDir: async () => root },
    ).catch((e: unknown) => e);
    expect(String(none)).toContain('publishing needs knowledge.store "cloudflare"');
    expect(worker.seen).toEqual([]);
});

test('--out writes the forms as files, sending nothing, whatever the store; an unknown storming is named', async () => {
    const out = path.join(root, 'published');
    const report = await publishStormings(
        { config: config({}), approval: undefined, stormings: ['Returns'], out, log: () => {} },
        { lastCommit: commits, now },
    );
    expect(report.published).toEqual([
        { storming: 'Returns', version: expect.any(String) as string, commit: 'abc1234def', file: path.join(out, 'Returns.json') },
    ]);
    const written = publishedStorming(JSON.parse(await readFile(path.join(out, 'Returns.json'), 'utf8')), 'file');
    expect(JSON.parse(JSON.stringify(written.stickies)) as unknown).toEqual([{ ref: 'Returns.ReturnRequested', label: '返品が依頼された' }]);
    const unknown = await publishStormings({ config: config({}), approval: undefined, stormings: ['Ordering'], out, log: () => {} }).catch((e: unknown) => e);
    expect(String(unknown)).toContain("Unknown storming 'Ordering'");
});

test('--prune removes the published stormings the workspace no longer has, after publishing its own', async () => {
    const cfg = config(cloudflare);
    const worker = fakeWorker(['Returns', 'Shipping', 'Ordering']);
    const report = await publishStormings(
        { config: cfg, approval: await checkApproved(cfg, undefined), stormings: ['Billing'], prune: true, log: () => {} },
        { env: TOKEN, fetch: worker.fetch, lastCommit: commits, now },
    );
    // Returns is the workspace's, though not published this time: it stays
    expect(report.published.map((p) => p.storming)).toEqual(['Billing']);
    expect(report.removed).toEqual(['Ordering', 'Shipping']);
    expect(worker.seen.map((r) => [r.method, new URL(r.url).pathname, r.headers.get('CF-Access-Client-Id')])).toEqual([
        ['PUT', '/v1/projects/shop/published/Billing', 'writer.access'],
        ['GET', '/v1/projects/shop/published', 'writer.access'],
        ['DELETE', '/v1/projects/shop/published/Ordering', 'writer.access'],
        ['DELETE', '/v1/projects/shop/published/Shipping', 'writer.access'],
    ]);
});

test('--prune does not go with --out, and removes nothing when a storming cannot be published', async () => {
    const out = await publishStormings({ config: config({}), approval: undefined, out: path.join(root, 'out'), prune: true, log: () => {} }).catch(
        (e: unknown) => e,
    );
    expect(out).toBeInstanceOf(PublishError);
    expect((out as PublishError).exitCode).toBe(2);
    await writeFile(path.join(root, 'billing.dtes'), 'storming Billing {\n  event\n');
    const cfg = config(cloudflare);
    const worker = fakeWorker(['Ordering']);
    const broken = await publishStormings(
        { config: cfg, approval: await checkApproved(cfg, undefined), prune: true, log: () => {} },
        { env: TOKEN, fetch: worker.fetch, lastCommit: commits, now },
    ).catch((e: unknown) => e);
    expect(String(broken)).toContain('--prune needs every .dtes file without errors (billing.dtes)');
    expect(worker.seen).toEqual([]);
});
