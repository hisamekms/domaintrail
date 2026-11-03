// The Live View's download of the sources (`GET /api/export/sources.zip`, 「ソース一式をダウンロード」): behind the same
// access check as the rest of the view's API — no identity, 401; a participant, the facilitator and `dt open`'s one
// person get it — an attachment named after the workspace, made from the files on disk at the request. What the
// archive holds: platform/workspace/src/infrastructure/source-archive.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DEFAULT_AGENT_TOOLS } from '@domaintrail/agent';
import { type SessionServer, type SessionSettings, startSessionServer, startViewServer, type ViewServer } from '@domaintrail/dt';

const settings: SessionSettings = {
    port: 0,
    host: '127.0.0.1',
    identity: 'dev',
    agent: { port: 0, allowedTools: [...DEFAULT_AGENT_TOOLS], maxPreviousRunDiff: 20 * 1024 },
    maxParticipants: 50,
    quickReactions: ['👍'],
    classifier: { enabled: false, provider: 'cloudflare-clef', model: 'clef-flash', apiTokenEnv: 'CLOUDFLARE_API_TOKEN', threshold: 0.5 },
};

const json = { 'content-type': 'application/json' };

/** The names in the central directory of a ZIP archive. */
function zipNames(archive: Buffer): string[] {
    const end = archive.length - 22;
    expect(archive.readUInt32LE(end)).toBe(0x06054b50);
    const names: string[] = [];
    let at = archive.readUInt32LE(end + 16);
    for (let i = 0; i < archive.readUInt16LE(end + 10); i++) {
        const length = archive.readUInt16LE(at + 28);
        names.push(archive.subarray(at + 46, at + 46 + length).toString('utf8'));
        at += 46 + length + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
    }
    return names;
}

/** A workspace named 販売店 with a config file, its local override and a source in a Japanese folder. */
async function workspace(): Promise<string> {
    const root = path.join(await mkdtemp(path.join(tmpdir(), 'domaintrail-export-route-')), '販売店');
    await mkdir(path.join(root, '注文'), { recursive: true });
    await writeFile(path.join(root, 'domaintrail.jsonc'), '{}\n');
    await writeFile(path.join(root, 'domaintrail.local.jsonc'), '{}\n');
    await writeFile(path.join(root, '注文', 'order.dt'), 'context Shop {\n  id OrderId: UUID\n}\n');
    return root;
}

const download = (url: string, init: RequestInit = {}): Promise<Response> => fetch(`${url}api/export/sources.zip`, init);

describe('the download of the sources in a collab', () => {
    let root: string;
    let server: SessionServer;
    let ada: string;
    let bob: string;
    const join = async (name: string): Promise<string> => {
        const res = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name }) });
        expect(res.status).toBe(201);
        return (res.headers.get('set-cookie') ?? '').split(';')[0];
    };

    beforeAll(async () => {
        root = await workspace();
        server = await startSessionServer({ root, configFile: path.join(root, 'domaintrail.jsonc'), debounceMs: 30, session: settings });
        await server.ready;
        ada = await join('Ada');
        bob = await join('Bob');
        expect((await fetch(server.facilitatorLink, { headers: { cookie: ada }, redirect: 'manual' })).status).toBe(303);
    });
    afterAll(async () => {
        await server?.stop();
        await rm(path.dirname(root), { recursive: true, force: true });
    });

    test('without an identity: 401, no archive', async () => {
        const res = await download(server.url);
        expect(res.status).toBe(401);
        expect(res.headers.get('content-type')).not.toBe('application/zip');
    });

    test('a Host the session does not answer to: 403', async () => {
        expect((await download(server.url, { headers: { cookie: bob, host: 'evil.example' } })).status).toBe(403);
    });

    test('a participant and the facilitator get the archive as an attachment, never cached', async () => {
        for (const cookie of [bob, ada]) {
            const res = await download(server.url, { headers: { cookie } });
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toBe('application/zip');
            expect(res.headers.get('content-disposition')).toBe(
                `attachment; filename="sources.zip"; filename*=UTF-8''${encodeURIComponent('販売店-sources.zip')}`,
            );
            expect(res.headers.get('cache-control')).toBe('no-store');
            expect(res.headers.get('x-content-type-options')).toBe('nosniff');
            const zip = Buffer.from(await res.arrayBuffer());
            expect(res.headers.get('content-length')).toBe(String(zip.length));
            expect(zipNames(zip)).toEqual(['販売店/domaintrail.jsonc', '販売店/注文/order.dt']);
        }
    });

    test('the files on disk at the request', async () => {
        await writeFile(path.join(root, 'later.dt'), 'context Later {}\n');
        const res = await download(server.url, { headers: { cookie: bob } });
        expect(zipNames(Buffer.from(await res.arrayBuffer()))).toEqual(['販売店/domaintrail.jsonc', '販売店/later.dt', '販売店/注文/order.dt']);
        await rm(path.join(root, 'later.dt'));
    });

    test('GET only', async () => {
        const res = await download(server.url, { method: 'POST', headers: { cookie: bob } });
        expect(res.status).toBe(405);
    });
});

describe('the download of the sources elsewhere', () => {
    const roots: string[] = [];
    afterAll(async () => {
        for (const r of roots) await rm(path.dirname(r), { recursive: true, force: true });
    });

    test("dt open's one person, signed in by the one-time link", async () => {
        const root = await workspace();
        roots.push(root);
        const server = await startSessionServer({ root, debounceMs: 30, mode: 'Solo', session: settings });
        try {
            expect((await download(server.url)).status).toBe(401);
            const signedIn = await fetch(server.facilitatorLink, { redirect: 'manual' });
            expect(signedIn.status).toBe(303);
            const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0];
            const res = await download(server.url, { headers: { cookie } });
            expect(res.status).toBe(200);
            // no config file given: the sources alone
            expect(zipNames(Buffer.from(await res.arrayBuffer()))).toEqual(['販売店/注文/order.dt']);
        } finally {
            await server.stop();
        }
    });

    test('the read-only Live View serves it to whoever it serves the view; a workspace without sources: 404', async () => {
        const root = await workspace();
        roots.push(root);
        let server: ViewServer | undefined = await startViewServer({ root, configFile: path.join(root, 'domaintrail.jsonc'), port: 0, debounceMs: 30 });
        try {
            const res = await download(server.url);
            expect(res.status).toBe(200);
            expect(zipNames(Buffer.from(await res.arrayBuffer()))).toEqual(['販売店/domaintrail.jsonc', '販売店/注文/order.dt']);
            await rm(path.join(root, '注文'), { recursive: true });
            expect((await download(server.url)).status).toBe(404);
        } finally {
            await server?.stop();
            server = undefined;
        }
    });
});
