/**
 * The contracts of `dt view` and `dt generate ts` the M0 refactoring keeps (ADR 0025, T1): what the other tests of the
 * Live View do not pin down yet. A deliberate change to one of them updates the snapshots with `bun test -u`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import * as path from 'node:path';
import { runCli } from '../src/cli/main.js';
import type { ViewPayload } from '../src/server/protocol.js';
import { startViewServer, type ViewServer } from '../src/server/server.js';
import { tempCopyOfExamples } from './helpers.js';

let dir: string;
let server: ViewServer;
let ws: WebSocket;
const received: ViewPayload[] = [];

const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
};

async function nextUpdate(pred: (p: ViewPayload) => boolean, timeoutMs = 8000): Promise<ViewPayload> {
    const start = received.length;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const hit = received.slice(start).find(pred);
        if (hit) return hit;
        await Bun.sleep(20);
    }
    throw new Error('timed out waiting for an update');
}

beforeAll(async () => {
    dir = await tempCopyOfExamples();
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-qm', 'first');
    server = await startViewServer({ root: dir, port: 0, debounceMs: 30 });
    await server.ready;
    ws = new WebSocket(server.url.replace('http', 'ws') + 'ws');
    ws.onmessage = (ev) => received.push(JSON.parse(ev.data as string));
    await new Promise((r) => (ws.onopen = r));
    while (received.length === 0) await Bun.sleep(10);
});

afterAll(async () => {
    ws?.close();
    await server?.stop();
    await rm(dir, { recursive: true, force: true });
});

const API = ['api/state', 'api/focus?contexts=Billing', 'api/git/refs', 'api/baseline'];

describe('the Live View server', () => {
    test('rejects a foreign Host and a cross-origin request on every endpoint', async () => {
        for (const api of API) {
            const method = api === 'api/baseline' ? 'POST' : 'GET';
            const body = method === 'POST' ? JSON.stringify({ kind: 'previous' }) : undefined;
            expect((await fetch(server.url + api, { method, body, headers: { Host: 'attacker.example' } })).status).toBe(403);
            expect((await fetch(server.url + api, { method, body, headers: { Origin: 'https://evil.example' } })).status).toBe(403);
        }
        const upgrade = new WebSocket(server.url.replace('http', 'ws') + 'ws', { headers: { Host: 'attacker.example' } } as never);
        expect(await new Promise<boolean>((r) => ((upgrade.onopen = () => r(false)), (upgrade.onerror = () => r(true))))).toBe(true);
    });

    test('answers unknown paths, other methods and other upgrades with an error', async () => {
        expect((await fetch(`${server.url}nope.js`)).status).toBe(404);
        expect((await fetch(server.url, { method: 'POST' })).status).toBe(404);
        expect((await fetch(`${server.url}api/baseline`)).status).toBe(405);
        expect((await fetch(`${server.url}api/baseline`, { method: 'POST', body: 'x'.repeat(5000) })).status).toBe(400);
        expect((await fetch(`${server.url}api/baseline`, { method: 'POST', body: '{"kind":"git","ref":" "}' })).status).toBe(400);
        const other = new WebSocket(server.url.replace('http', 'ws') + 'other');
        expect(await new Promise<boolean>((r) => ((other.onopen = () => r(false)), (other.onerror = () => r(true))))).toBe(true);
    });

    test('lists the git revisions offered as baselines', async () => {
        const refs = await (await fetch(`${server.url}api/git/refs`)).json();
        expect(refs).toMatchObject({ branches: ['main'], commits: [{ subject: 'first' }] });
    });

    test('pushes the same payload shape as /api/state, with the stormings', async () => {
        const state = (await (await fetch(`${server.url}api/state`)).json()) as ViewPayload;
        expect(Object.keys(state).sort()).toMatchSnapshot();
        expect(Object.keys(received.at(-1)!).sort()).toEqual(Object.keys(state).sort());
        expect(state.stormings.map((s) => [s.id, Object.keys(s.views).sort()])).toMatchSnapshot();
    });

    test('pushes an update after a .dtes file is saved', async () => {
        const file = path.join(dir, 'stormings', 'order-to-cash.dtes');
        await writeFile(file, (await readFile(file, 'utf8')).replace('  actor Customer "顧客"', '  actor Customer "顧客"\n  actor Clerk "店員"'));
        const p = await nextUpdate((u) => u.stormings.some((s) => s.storming.elements.some((e) => e.id === 'Clerk')));
        expect(p.status).toBe('ok');
    });

    test('stops: closes the sockets and the port, and no longer watches the files', async () => {
        const local = await startViewServer({ root: dir, port: 0, debounceMs: 30 });
        await local.ready;
        const socket = new WebSocket(local.url.replace('http', 'ws') + 'ws');
        await new Promise((r) => (socket.onopen = r));
        const closed = new Promise((r) => (socket.onclose = r));
        const { port } = new URL(local.url);
        const version = local.session.state.version;
        await local.stop();
        await closed;
        const refused = await new Promise<boolean>((r) => {
            const c = connect(Number(port), '127.0.0.1');
            c.on('connect', () => (c.destroy(), r(false)));
            c.on('error', () => r(true));
        });
        expect(refused).toBe(true);
        await writeFile(path.join(dir, 'later.dt'), 'context Later { value V { a: String } }');
        await Bun.sleep(300);
        expect(local.session.state.version).toBe(version);
        await rm(path.join(dir, 'later.dt'));
    });
});

describe('dt generate ts', () => {
    test('writes the same files with the same contents for the example', async () => {
        const out = path.join(dir, 'generated-snapshot');
        expect(await runCli(['-r', dir, 'generate', 'ts', '--out', 'generated-snapshot'], { out: () => {}, err: () => {} })).toBe(0);
        const files = (await readdir(out, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
        const hashes: Record<string, string> = {};
        for (const f of files) {
            const file = path.join(f.parentPath, f.name);
            hashes[path.relative(out, file).split(path.sep).join('/')] = createHash('sha256')
                .update(await readFile(file))
                .digest('hex');
        }
        expect(Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)))).toMatchSnapshot();
    });
});
