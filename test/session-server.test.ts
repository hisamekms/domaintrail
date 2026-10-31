/**
 * `dt session start` (ADR 0026, S4) over HTTP, the WebSocket and the agent API, on a temporary workspace with `.dt`
 * and `.dtes` sources: without an identity nothing is served; Host and Origin are checked; participants cannot reach
 * the facilitator's routes or the agent API; the agent API needs its credential and is not on the public port; SSE
 * resumes with `Last-Event-ID`; claim and finish are idempotent; the watcher holds around a write; presence; revoke.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { AccessClaims } from '@domaintrail/collaboration/infrastructure/identity';
import { createMockAccessVerifier } from '@domaintrail/collaboration/infrastructure/identity';
import type { ComparisonBody, Me, RestoredBody, SessionStateBody } from '@domaintrail/collaboration/protocol';
import {
    startSessionServer,
    issueFacilitatorLink,
    WS_REVOKED,
    WS_SESSION_CLOSED,
    type SessionServer,
    type SessionServerOptions,
} from '@domaintrail/composition/session';
import { createWatcherHold, ECHO_MS } from '@domaintrail/composition/watcher-hold';
import { listedParticipants } from '@domaintrail/web/session/presence';
import { DEFAULT_AGENT_TOOLS, type ResolvedSessionConfig } from '@domaintrail/modeling/core/config';
import { cliDeps } from '@domaintrail/composition/cli';
import { runCli } from '@domaintrail/presentation/cli/main';
import { SessionError } from '@domaintrail/presentation/cli/ports';
import type { ViewPayload } from '@domaintrail/visualization/protocol';

const DT = `context Shop {
  id OrderId: UUID

  aggregate Order {
    id: OrderId

    state Open
    state Placed

    create command start(id: OrderId) -> Open

    command place()
      Open -> Placed
      emits OrderPlaced
  }

  event OrderPlaced {
    orderId: OrderId
  }
}
`;

const DTES = `storming Ordering {
  event OrderOpened
  event OrderPlaced {
    ref Shop.OrderPlaced
  }

  timeline Normal {
    OrderOpened
    OrderPlaced
  }
}
`;

const dirs: string[] = [];
afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-session-server-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'shop.dt'), DT);
    await writeFile(path.join(dir, 'ordering.dtes'), DTES);
    return dir;
}

const sessionConfig = (overrides: Partial<ResolvedSessionConfig> = {}): ResolvedSessionConfig => ({
    port: 0,
    host: '127.0.0.1',
    identity: 'dev',
    agent: { port: 0, allowedTools: [...DEFAULT_AGENT_TOOLS] },
    maxParticipants: 50,
    ...overrides,
});

const accessConfig = (overrides: Partial<NonNullable<ResolvedSessionConfig['access']>> = {}): NonNullable<ResolvedSessionConfig['access']> => ({
    teamDomain: 'team.cloudflareaccess.com',
    audience: 'aud-tag',
    allowedHosts: [],
    allowedOrigins: [],
    acceptCookie: false,
    avatarHosts: [],
    ...overrides,
});

const start = (root: string, extra: Partial<SessionServerOptions> = {}): Promise<SessionServer> =>
    startSessionServer({ root, debounceMs: 30, session: sessionConfig(), ...extra });

const json = { 'content-type': 'application/json' };

/** Signs a browser in (dev) under `name`: its cookie. */
async function join(server: SessionServer, name: string): Promise<string> {
    const res = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name }) });
    expect(res.status).toBe(201);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    return cookie.split(';')[0];
}

/** Makes the browser of `cookie` the facilitator with the server's link. */
async function claim(server: SessionServer, cookie: string): Promise<void> {
    const res = await fetch(server.facilitatorLink, { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(303);
}

const api = (server: SessionServer, cookie: string, p: string, body?: unknown): Promise<Response> =>
    fetch(`${server.url}api/session/${p}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { cookie, ...(body !== undefined && json) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
    });

async function agentCredential(root: string): Promise<{ url: string; token: string }> {
    return JSON.parse(await readFile(path.join(root, '.domaintrail', 'session', 'agent.json'), 'utf8'));
}

const agent = (cred: { url: string; token: string }, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${cred.url}agent/${p}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${cred.token}`, ...(body !== undefined && json), ...headers },
        ...(body !== undefined && { body: JSON.stringify(body) }),
    });

interface Socket {
    ws: WebSocket;
    received: { type: string; [k: string]: unknown }[];
    closed: Promise<number>;
    next(type: string, timeoutMs?: number): Promise<{ type: string; [k: string]: unknown }>;
}

async function socket(server: SessionServer, cookie: string | Record<string, string>): Promise<Socket> {
    const headers = typeof cookie === 'string' ? { cookie } : cookie;
    const ws = new WebSocket(server.url.replace('http', 'ws') + 'ws', { headers } as never);
    const received: Socket['received'] = [];
    ws.onmessage = (ev) => received.push(JSON.parse(ev.data as string));
    const closed = new Promise<number>((resolve) => (ws.onclose = (ev) => resolve(ev.code)));
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });
    let seen = 0;
    return {
        ws,
        received,
        closed,
        async next(type, timeoutMs = 5000) {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                const i = received.findIndex((m, j) => j >= seen && m.type === type);
                if (i >= 0) {
                    seen = i + 1;
                    return received[i];
                }
                if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
                await Bun.sleep(10);
            }
        },
    };
}

/** Whether a WebSocket upgrade with these headers is refused. */
async function refused(server: SessionServer, headers: Record<string, string>): Promise<boolean> {
    const ws = new WebSocket(server.url.replace('http', 'ws') + 'ws', { headers } as never);
    const result = await new Promise<boolean>((resolve) => {
        ws.onopen = () => resolve(false);
        ws.onerror = () => resolve(true);
        ws.onclose = () => resolve(true);
    });
    ws.close();
    return result;
}

describe('a session in dev mode', () => {
    let root: string;
    let server: SessionServer;
    let ada: string;
    let bob: string;

    beforeAll(async () => {
        root = await workspace();
        server = await start(root);
        await server.ready;
        ada = await join(server, 'Ada');
        bob = await join(server, 'Bob');
        await claim(server, ada);
    });
    afterAll(() => server?.stop());

    test('serves nothing without an identity: the page is the join form, the APIs and the WebSocket answer 401', async () => {
        const page = await fetch(server.url);
        expect(page.status).toBe(401);
        const html = await page.text();
        expect(html).toContain('action="/session/join"');
        expect(html).not.toContain('<div id="root">');
        // a browser posts the form with its Origin (under `no-referrer` it would send `Origin: null`, which is refused)
        expect(page.headers.get('referrer-policy')).toBe('same-origin');
        for (const asset of ['index.html', 'index.js', 'nope']) expect((await fetch(server.url + asset)).status).toBe(401);
        for (const [method, p] of [
            ['GET', 'api/state'],
            ['GET', 'api/focus?contexts=Shop'],
            ['GET', 'api/git/refs'],
            ['POST', 'api/baseline'],
            ['GET', 'api/session/me'],
            ['GET', 'api/session/state'],
            ['GET', 'api/session/requests'],
            ['GET', 'api/session/revisions'],
            ['POST', 'api/session/runs'],
            ['GET', 'api/unknown'],
        ]) {
            const res = await fetch(server.url + p, { method, headers: json, ...(method === 'POST' && { body: '{}' }) });
            expect([method, p, res.status]).toEqual([method, p, 401]);
            expect(((await res.json()) as { error: { type: string } }).error.type).toBe('Unauthenticated');
        }
        expect(await refused(server, {})).toBe(true);
        // a forged cookie is no identity
        expect((await fetch(`${server.url}api/state`, { headers: { cookie: `dt_session=${'A'.repeat(43)}` } })).status).toBe(401);
    });

    test('serves the Live View to a participant, as dt view does', async () => {
        const res = await fetch(`${server.url}api/state`, { headers: { cookie: bob } });
        expect(res.status).toBe(200);
        expect(((await res.json()) as ViewPayload).files).toEqual(['ordering.dtes', 'shop.dt']);
        expect(await (await fetch(server.url, { headers: { cookie: bob } })).text()).toContain('<div id="root"></div>');
    });

    test('the baseline, shared by every page, is changed by the facilitator only; the view is read by any participant', async () => {
        for (const p of ['api/state', 'api/focus?contexts=Shop', 'api/git/refs']) {
            expect([p, (await fetch(server.url + p, { headers: { cookie: bob } })).status]).toEqual([p, 200]);
        }
        const baseline = (cookie: string): Promise<Response> =>
            fetch(`${server.url}api/baseline`, { method: 'POST', headers: { cookie, ...json }, body: JSON.stringify({ kind: 'previous' }) });
        const refusedBaseline = await baseline(bob);
        expect(refusedBaseline.status).toBe(403);
        expect(((await refusedBaseline.json()) as { error: { type: string } }).error.type).toBe('FacilitatorOnly');
        expect((await baseline(ada)).status).toBe(200);
    });

    test('refuses another Host or Origin, even with an identity', async () => {
        for (const p of ['', 'api/state', 'api/session/me', 'session/join']) {
            expect((await fetch(server.url + p, { headers: { cookie: bob, Host: 'attacker.example' } })).status).toBe(403);
            expect((await fetch(server.url + p, { headers: { cookie: bob, Origin: 'https://evil.example' } })).status).toBe(403);
        }
        expect(await refused(server, { cookie: bob, Origin: 'https://evil.example' })).toBe(true);
        expect(await refused(server, { cookie: bob, Host: 'attacker.example' })).toBe(true);
    });

    test('me: the participant and the role; the facilitator link made Ada the facilitator, once', async () => {
        expect(((await (await api(server, bob, 'me')).json()) as Me).participant).toMatchObject({ name: 'Bob', role: 'participant' });
        expect(((await (await api(server, ada, 'me')).json()) as Me).participant).toMatchObject({ name: 'Ada', role: 'facilitator' });
        // single use
        const again = await fetch(server.facilitatorLink, { headers: { cookie: bob }, redirect: 'manual' });
        expect(again.status).toBe(409);
        expect(((await (await api(server, bob, 'me')).json()) as Me).participant.role).toBe('participant');
        const bad = await api(server, bob, 'facilitator/claim', { code: 'x'.repeat(43) });
        expect(bad.status).toBe(409);
        expect(await bad.json()).toEqual({ error: { type: 'LinkInvalid' } });
    });

    test('a participant cannot reach the facilitator routes; dismisses only their own requests', async () => {
        const state = (await (await api(server, bob, 'state')).json()) as SessionStateBody;
        const revision = state.revisions[0].id;
        const target = { target: { kind: 'DtElement', element: 'Shop.Order' }, sourceRevision: revision, label: 'Order' };
        const mine = (await (await api(server, bob, 'requests', { target, body: 'Add a cancel command.' })).json()) as { request: { id: string } };
        const adas = (await (
            await api(server, ada, 'requests', { target: { target: { kind: 'Workspace' }, sourceRevision: revision }, body: 'Tidy up.' })
        ).json()) as {
            request: { id: string };
        };
        for (const [p, body] of [
            ['runs', { requests: [mine.request.id] }],
            [`runs/${mine.request.id}/cancel`, {}],
            ['revisions', {}],
            [`revisions/${revision}/confirm`, {}],
            [`revisions/${revision}/restore`, {}],
            ['close', {}],
        ] as const) {
            const res = await api(server, bob, p, body);
            expect([p, res.status, ((await res.json()) as { error: { type: string } }).error.type]).toEqual([p, 403, 'FacilitatorOnly']);
        }
        const others = await api(server, bob, `requests/${adas.request.id}/dismiss`, {});
        expect([others.status, ((await others.json()) as { error: { type: string } }).error.type]).toEqual([403, 'NotYourRequest']);
        expect((await api(server, bob, `requests/${mine.request.id}/dismiss`, {})).status).toBe(200);
        const dismissed = await api(server, bob, `requests/${mine.request.id}/dismiss`, {});
        expect([dismissed.status, ((await dismissed.json()) as { error: { type: string } }).error.type]).toEqual([409, 'NotAllowed']);
    });

    test('checks every input at the boundary, with typed errors and body limits', async () => {
        const state = (await (await api(server, bob, 'state')).json()) as SessionStateBody;
        const revision = state.revisions[0].id;
        const cases: [unknown, string][] = [
            [{ target: { target: { kind: 'Nope' }, sourceRevision: revision }, body: 'x' }, 'target.target.kind'],
            [{ target: { target: { kind: 'DtElement', element: '' }, sourceRevision: revision }, body: 'x' }, 'target.target.element'],
            [{ target: { target: { kind: 'Workspace' }, sourceRevision: 'not-a-uuid' }, body: 'x' }, 'target.sourceRevision'],
            [{ target: { target: { kind: 'Workspace' }, sourceRevision: revision }, body: '' }, 'body'],
            [{ target: { target: { kind: 'Workspace' }, sourceRevision: revision }, body: 'x'.repeat(10_001) }, 'body'],
            [{ target: { target: { kind: 'Workspace' }, sourceRevision: revision }, body: 'x', extra: 1 }, 'extra'],
            [
                {
                    target: {
                        target: { kind: 'DtesOccurrence', storming: 'Ordering', timeline: 'Normal', eventName: 'OrderPlaced', occurrence: '1..2' },
                        sourceRevision: revision,
                    },
                    body: 'x',
                },
                'target.target.occurrence',
            ],
            [
                {
                    target: {
                        target: { kind: 'Workspace' },
                        sourceRevision: revision,
                        range: { path: 'shop.dt', startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
                    },
                    body: 'x',
                },
                'target.range',
            ],
        ];
        for (const [body, field] of cases) {
            const res = await api(server, bob, 'requests', body);
            expect([field, res.status, await res.json()]).toEqual([field, 400, { error: expect.objectContaining({ type: 'InvalidInput', field }) }]);
        }
        // an occurrence's step path is the Live View's, 0-based: the first step is '0'
        const first = await api(server, bob, 'requests', {
            target: {
                target: { kind: 'DtesOccurrence', storming: 'Ordering', timeline: 'Normal', eventName: 'OrderOpened', occurrence: '0' },
                sourceRevision: revision,
            },
            body: 'x',
        });
        expect(first.status).toBe(201);
        const sentId = ((await first.json()) as { request: { id: string } }).request.id;
        const targets = (await (await api(server, bob, 'targets')).json()) as { statuses: Record<string, string> };
        expect(targets.statuses[sentId]).toBe('current');
        const unknownRevision = await api(server, bob, 'requests', {
            target: { target: { kind: 'Workspace' }, sourceRevision: crypto.randomUUID() },
            body: 'x',
        });
        expect(unknownRevision.status).toBe(400);
        const large = await fetch(`${server.url}api/session/requests`, { method: 'POST', headers: { cookie: bob, ...json }, body: 'x'.repeat(70_000) });
        expect(large.status).toBe(413);
        const form = await fetch(`${server.url}api/session/requests`, { method: 'POST', headers: { cookie: bob, 'content-type': 'text/plain' }, body: '{}' });
        expect(form.status).toBe(415);
        expect((await api(server, bob, 'requests/not-an-id/dismiss', {})).status).toBe(400);
        expect((await api(server, bob, 'nope')).status).toBe(404);
        expect((await fetch(`${server.url}api/session/runs`, { method: 'DELETE', headers: { cookie: bob } })).status).toBe(405);
    });

    test('the WebSocket: the view first as type "update", then the session state; events of changes as they happen', async () => {
        const s = await socket(server, bob);
        try {
            expect(s.received.length === 0 || s.received[0].type === 'update').toBe(true);
            expect((await s.next('update')).type).toBe('update');
            const state = (await s.next('session.state')) as unknown as { state: SessionStateBody; me: Me };
            expect(state.me.participant.name).toBe('Bob');
            expect(typeof state.state.seq).toBe('number');
            const revision = state.state.revisions[0].id;
            await api(server, bob, 'requests', { target: { target: { kind: 'Workspace' }, sourceRevision: revision }, body: 'Hello.' });
            const sent = (await s.next('request.sent')) as unknown as { seq: number; event: { body: string } };
            expect(sent.event.body).toBe('Hello.');
            expect(sent.seq).toBeGreaterThan(state.state.seq);
        } finally {
            s.ws.close();
        }
    });

    test('presence: sent to the others only, validated, at most ~20 Hz per participant with the last position kept', async () => {
        const a = await socket(server, ada);
        const b = await socket(server, bob);
        try {
            await a.next('presence.snapshot');
            await b.next('presence.snapshot');
            const location = {
                kind: 'dtes',
                stormingId: 'Ordering',
                level: 'big-picture',
                timelineId: 'Normal',
                layoutKey: 'storming:Ordering:big-picture:Normal#1',
            };
            a.ws.send('not json');
            a.ws.send(JSON.stringify({ type: 'presence.update', location: { kind: 'dt' } }));
            a.ws.send(JSON.stringify({ type: 'session.close' }));
            for (let i = 1; i <= 10; i++) a.ws.send(JSON.stringify({ type: 'presence.update', location, cursor: { x: i, y: i } }));
            await Bun.sleep(300);
            const updates = b.received.filter((m) => m.type === 'presence.update') as unknown as {
                presence: { cursor: { x: number }; participant: { name: string } };
            }[];
            expect(updates.length).toBeGreaterThanOrEqual(1);
            expect(updates.length).toBeLessThanOrEqual(3);
            expect(updates.at(-1)!.presence.cursor.x).toBe(10);
            expect(updates[0].presence.participant).toEqual(expect.objectContaining({ name: 'Ada', role: 'facilitator' }));
            expect(JSON.stringify(updates)).not.toContain('email');
            expect(a.received.filter((m) => m.type === 'presence.update')).toEqual([]);
            a.ws.send(JSON.stringify({ type: 'presence.leave' }));
            expect((await b.next('presence.leave')).type).toBe('presence.leave');
            expect(a.ws.readyState).toBe(WebSocket.OPEN);
        } finally {
            a.ws.close();
            b.ws.close();
        }
    });

    test('a WebSocket message larger than the limit closes that page only', async () => {
        const s = await socket(server, bob);
        s.ws.send(JSON.stringify({ type: 'presence.update', location: { kind: 'dt', viewKey: 'x'.repeat(20_000), layoutKey: 'y' } }));
        // 1009 (message too big), seen as 1006 by a client whose connection is cut without the close handshake
        expect([1006, 1009]).toContain(await s.closed);
    });

    test('signing out revokes the cookie and closes that participant’s pages', async () => {
        const carol = await join(server, 'Carol');
        const s = await socket(server, carol);
        const res = await api(server, carol, 'leave', {});
        expect(res.status).toBe(200);
        expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
        expect(await s.closed).toBe(WS_REVOKED);
        expect((await fetch(`${server.url}api/state`, { headers: { cookie: carol } })).status).toBe(401);
    });
});

describe('the agent API', () => {
    let root: string;
    let server: SessionServer;
    let ada: string;
    let bob: string;
    let cred: { url: string; token: string };

    beforeAll(async () => {
        root = await workspace();
        server = await start(root);
        await server.ready;
        ada = await join(server, 'Ada');
        bob = await join(server, 'Bob');
        await claim(server, ada);
        cred = await agentCredential(root);
    });
    afterAll(() => server?.stop());

    test('agent.json is the credential, private to the user; the listener is on 127.0.0.1 only', async () => {
        const file = path.join(root, '.domaintrail', 'session', 'agent.json');
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect(new URL(cred.url).hostname).toBe('127.0.0.1');
        expect(cred.url).toBe(server.agentUrl);
        expect(new URL(cred.url).port).not.toBe(new URL(server.url).port);
    });

    test('refuses a missing or wrong credential, a browser (Origin), and another Host', async () => {
        expect((await fetch(`${cred.url}agent/session`)).status).toBe(401);
        expect((await agent({ ...cred, token: 'x'.repeat(43) }, 'session')).status).toBe(401);
        expect((await agent({ ...cred, token: '' }, 'session')).status).toBe(401);
        expect((await fetch(`${cred.url}agent/session`, { headers: { cookie: bob } })).status).toBe(401);
        expect((await agent(cred, 'session', undefined, { Origin: server.url.slice(0, -1) })).status).toBe(403);
        expect((await agent(cred, 'session', undefined, { Host: 'attacker.example' })).status).toBe(403);
        const ok = await agent(cred, 'session');
        expect(ok.status).toBe(200);
        expect(await ok.json()).toEqual({ session: server.session, state: 'Open', allowedTools: [...DEFAULT_AGENT_TOOLS], leaseMs: 60_000 });
    });

    test('is not reachable through the public port, with or without an identity', async () => {
        for (const cookie of ['', bob, ada]) {
            for (const p of ['agent/session', 'agent/events', 'api/session/agent/session']) {
                const res = await fetch(server.url + p, { headers: { authorization: `Bearer ${cred.token}`, ...(cookie && { cookie }) } });
                expect([p, res.status]).toEqual([p, cookie ? 404 : 401]);
            }
        }
    });

    test('claim, start, heartbeat and finish over HTTP; a repeated finish is a replay; SSE resumes with Last-Event-ID', async () => {
        const state = (await (await api(server, bob, 'state')).json()) as SessionStateBody;
        const target = { target: { kind: 'DtElement', element: 'Shop.Order' }, sourceRevision: state.revisions[0].id };
        const request = ((await (await api(server, bob, 'requests', { target, body: 'Add cancel.' })).json()) as { request: { id: string } }).request;
        const queued = await api(server, ada, 'runs', { requests: [request.id], note: 'Go.' });
        expect(queued.status).toBe(201);
        const run = ((await queued.json()) as { run: { id: string; state: string } }).run;
        expect(run.state).toBe('Queued');

        const claimed = await agent(cred, 'runs/claim', { owner: 'test-agent' });
        expect(claimed.status).toBe(200);
        const { lease } = (await claimed.json()) as { lease: { token: string; expiresAt: string } };
        const second = await agent(cred, 'runs/claim', { owner: 'test-agent' });
        expect([second.status, ((await second.json()) as { error: { type: string } }).error.type]).toEqual([409, 'RunInProgress']);
        expect((await agent(cred, `runs/${run.id}/start`, { token: 'wrong' })).status).toBe(409);
        expect((await agent(cred, `runs/${run.id}/start`, { token: lease.token })).status).toBe(200);
        const beat = await agent(cred, `runs/${run.id}/heartbeat`, { token: lease.token });
        expect(beat.status).toBe(200);
        // the agent reports its facts only; anything more is refused
        expect((await agent(cred, `runs/${run.id}/finish`, { token: lease.token, exitCode: 0, formatted: true, checked: true, newDtErrors: 0 })).status).toBe(
            400,
        );
        const finished = await agent(cred, `runs/${run.id}/finish`, { token: lease.token, exitCode: 0, formatted: true, checked: true });
        expect(finished.status).toBe(200);
        const body = (await finished.json()) as { run: { state: string; changed: boolean }; replayed: boolean };
        expect(body).toMatchObject({ run: { state: 'Completed', changed: false }, replayed: false });
        const replay = await agent(cred, `runs/${run.id}/finish`, { token: lease.token, exitCode: 0, formatted: true, checked: true });
        expect(await replay.json()).toMatchObject({ run: body.run, replayed: true });
        const nothing = await agent(cred, 'runs/claim', { owner: 'test-agent' });
        expect([nothing.status, ((await nothing.json()) as { error: { type: string } }).error.type]).toEqual([409, 'NothingQueued']);

        // the stream from the start: the run's events with their outbox positions
        const all = await sse(cred, undefined, ['run.completed']);
        expect(all.map((e) => e.event)).toEqual(['run.queued', 'run.started', 'run.completed']);
        const [queuedEvent] = all;
        expect(JSON.parse(queuedEvent.data)).toMatchObject({ type: 'run.queued', seq: Number(queuedEvent.id), event: { runId: run.id } });
        // resumed after the first: the others only
        const resumed = await sse(cred, queuedEvent.id, ['run.completed']);
        expect(resumed.map((e) => [e.id, e.event])).toEqual(all.slice(1).map((e) => [e.id, e.event]));
        expect((await agent(cred, 'events', undefined, { 'Last-Event-ID': 'x' })).status).toBe(400);
    });

    test('a cancel of a running run is told to the agent as run.cancel_requested', async () => {
        const state = (await (await api(server, bob, 'state')).json()) as SessionStateBody;
        const target = { target: { kind: 'Workspace' }, sourceRevision: state.revisions[0].id };
        const request = ((await (await api(server, bob, 'requests', { target, body: 'Again.' })).json()) as { request: { id: string } }).request;
        const run = ((await (await api(server, ada, 'runs', { requests: [request.id] })).json()) as { run: { id: string } }).run;
        const { lease } = (await (await agent(cred, 'runs/claim', { owner: 'test-agent' })).json()) as { lease: { token: string } };
        await agent(cred, `runs/${run.id}/start`, { token: lease.token });
        expect((await api(server, ada, `runs/${run.id}/cancel`, {})).status).toBe(200);
        const events = await sse(cred, undefined, ['run.cancel_requested']);
        expect(events.at(-1)).toMatchObject({ event: 'run.cancel_requested' });
        const ended = await agent(cred, `runs/${run.id}/finish`, { token: lease.token, exitCode: 0, formatted: true, checked: true });
        expect(ended.status).toBe(409);
    });
});

/** Reads the agent's SSE stream (from `lastEventId`) until an event of one of `until` arrives. */
async function sse(
    cred: { url: string; token: string },
    lastEventId: string | undefined,
    until: string[],
): Promise<{ id: string; event: string; data: string }[]> {
    const controller = new AbortController();
    const res = await fetch(`${cred.url}agent/events`, {
        headers: { authorization: `Bearer ${cred.token}`, ...(lastEventId && { 'Last-Event-ID': lastEventId }) },
        signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events: { id: string; event: string; data: string }[] = [];
    const deadline = Date.now() + 5000;
    try {
        while (!events.some((e) => until.includes(e.event)) && Date.now() < deadline) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
                const block = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const field = (name: string): string | undefined =>
                    block
                        .split('\n')
                        .find((l) => l.startsWith(`${name}: `))
                        ?.slice(name.length + 2);
                const id = field('id');
                if (id) events.push({ id, event: field('event') ?? '', data: field('data') ?? '' });
            }
        }
    } finally {
        controller.abort();
    }
    return events;
}

describe('the watcher hold (for a restore, S7)', () => {
    test('defers the refresh and the publish while held, and refreshes once when resumed', async () => {
        const root = await workspace();
        const server = await start(root);
        try {
            await server.ready;
            const cookie = await join(server, 'Ada');
            const s = await socket(server, cookie);
            await s.next('update');
            const before = server.view.state.version;
            const resume = server.watcherHold.hold();
            const nested = server.watcherHold.hold();
            expect(server.watcherHold.held).toBe(true);
            await writeFile(path.join(root, 'ordering.dtes'), DTES.replace('  event OrderOpened', '  event OrderOpened\n  event OrderPaid'));
            await Bun.sleep(600);
            expect(server.view.state.version).toBe(before);
            expect(s.received.filter((m) => m.type === 'update')).toHaveLength(1);
            await nested();
            await nested();
            expect(server.watcherHold.held).toBe(true);
            expect(server.view.state.version).toBe(before);
            await resume();
            expect(server.watcherHold.held).toBe(false);
            expect(server.view.state.version).toBeGreaterThan(before);
            const update = (await s.next('update')) as unknown as ViewPayload;
            expect(update.stormings[0].storming.elements.map((e) => e.id)).toContain('OrderPaid');
            s.ws.close();

            // around(): resumed whatever the outcome
            expect(await server.watcherHold.around(() => Promise.reject(new Error('boom'))).catch((e: unknown) => e)).toEqual(new Error('boom'));
            expect(server.watcherHold.held).toBe(false);
        } finally {
            await server.stop();
        }
    });

    test('aroundWrite refreshes once after a write (not after a refusal) and takes the same sources afterwards as its echo', async () => {
        const refreshed: { sources: boolean; git: boolean }[] = [];
        let print = 'a';
        let t = 0;
        const hold = createWatcherHold(async (missed) => void refreshed.push(missed), { fingerprint: async () => print, now: () => t });
        expect(
            await hold.aroundWrite(
                async () => 'refused',
                () => false,
            ),
        ).toBe('refused');
        expect([refreshed, await hold.echo?.()]).toEqual([[], false]);
        await hold.aroundWrite(
            async () => 'written',
            () => true,
        );
        expect(refreshed).toEqual([{ sources: true, git: false }]);
        expect(await hold.echo?.()).toBe(true);
        expect(await hold.echo?.()).toBe(true);
        print = 'b';
        expect(await hold.echo?.()).toBe(false);
        print = 'a';
        expect(await hold.echo?.()).toBe(false);
        await hold.aroundWrite(
            async () => 'written',
            () => true,
        );
        t += ECHO_MS + 1;
        expect(await hold.echo?.()).toBe(false);
        // a write that throws leaves the workspace unknown: refreshed all the same
        expect(
            await hold
                .aroundWrite(
                    () => Promise.reject(new Error('boom')),
                    () => false,
                )
                .catch((e: unknown) => e),
        ).toEqual(new Error('boom'));
        expect(refreshed).toHaveLength(3);
    });

    test('a restore over HTTP runs behind the hold and leaves the workspace as the revision was', async () => {
        const root = await workspace();
        const server = await start(root);
        try {
            await server.ready;
            const ada = await join(server, 'Ada');
            await claim(server, ada);
            const first = ((await (await api(server, ada, 'state')).json()) as SessionStateBody).revisions[0].id;
            await writeFile(path.join(root, 'shop.dt'), DT.replace('state Placed', 'state Placed\n    state Shipped'));
            await Bun.sleep(200);
            // external changes since the last revision: refused until a revision is taken
            const refusedRestore = await api(server, ada, `revisions/${first}/restore`, {});
            expect([refusedRestore.status, ((await refusedRestore.json()) as { error: { type: string } }).error.type]).toEqual([
                409,
                'ExternalChangesSinceSnapshot',
            ]);
            expect((await api(server, ada, 'revisions', {})).status).toBe(201);
            const restored = await api(server, ada, `revisions/${first}/restore`, {});
            expect(restored.status).toBe(200);
            expect(await readFile(path.join(root, 'shop.dt'), 'utf8')).toBe(DT);
            expect(server.watcherHold.held).toBe(false);
        } finally {
            await server.stop();
        }
    });
});

describe('revisions: comparison and restore (S7)', () => {
    const errorOf = async (res: Response): Promise<{ type: string; [k: string]: unknown }> => ((await res.json()) as { error: { type: string } }).error;
    const updates = (s: Socket): ViewPayload[] => s.received.filter((m) => m.type === 'update') as unknown as ViewPayload[];
    const revisions = async (server: SessionServer, cookie: string): Promise<SessionStateBody['revisions']> =>
        ((await (await api(server, cookie, 'state')).json()) as SessionStateBody).revisions;
    const SHIPPED = DT.replace('state Placed', 'state Placed\n    state Shipped');

    test('any participant compares two revisions: each file by DSL with a line diff, both validations; only the facilitator takes, confirms and restores', async () => {
        const root = await workspace();
        const server = await start(root);
        try {
            await server.ready;
            const ada = await join(server, 'Ada');
            const bob = await join(server, 'Bob');
            await claim(server, ada);
            const [first] = await revisions(server, bob);
            await writeFile(path.join(root, 'shop.dt'), SHIPPED);
            await writeFile(path.join(root, 'more.dtes'), 'storming More {\n  event Happened\n}\n');
            for (const p of ['revisions', `revisions/${first.id}/confirm`, `revisions/${first.id}/restore`]) {
                const res = await api(server, bob, p, {});
                expect([p, res.status, (await errorOf(res)).type]).toEqual([p, 403, 'FacilitatorOnly']);
            }
            expect((await api(server, ada, 'revisions', {})).status).toBe(201);
            expect((await api(server, ada, `revisions/${first.id}/confirm`, {})).status).toBe(200);
            const second = (await revisions(server, bob)).at(-1);
            if (!second) throw new Error('no revision');

            const res = await api(server, bob, `revisions/${first.id}/compare/${second.id}`);
            expect(res.status).toBe(200);
            const c = (await res.json()) as ComparisonBody;
            expect([c.before.id, c.before.state, c.after.id]).toEqual([first.id, 'Confirmed', second.id]);
            expect(c.files.map((f) => [f.path, f.language, f.status])).toEqual([
                ['more.dtes', 'Dtes', 'added'],
                ['ordering.dtes', 'Dtes', 'unchanged'],
                ['shop.dt', 'Dt', 'changed'],
            ]);
            expect(c.files[2].diff).toMatchObject({ kind: 'diff', added: 1, removed: 0 });
            expect(c.files[2].diff?.kind === 'diff' && c.files[2].diff.unified).toContain('+    state Shipped');
            expect(c.files[1].diff).toBeUndefined();
            expect([c.before.validation, c.after.validation].map((v) => v.dtErrors)).toEqual([0, 0]);

            const unknown = await api(server, bob, `revisions/${first.id}/compare/00000000-0000-4000-8000-000000000000`);
            expect([unknown.status, (await errorOf(unknown)).type]).toEqual([404, 'NotFound']);
            const bad = await api(server, bob, `revisions/x/compare/${first.id}`);
            expect([bad.status, (await errorOf(bad)).type]).toEqual([400, 'InvalidInput']);
            const anonymous = await fetch(`${server.url}api/session/revisions/${first.id}/compare/${second.id}`);
            expect(anonymous.status).toBe(401);
        } finally {
            await server.stop();
        }
    });

    test('a restore reaches every page in one publish of the view; an external edit needs the two-step, and is kept as a revision', async () => {
        const root = await workspace();
        const server = await start(root);
        try {
            await server.ready;
            const ada = await join(server, 'Ada');
            const bob = await join(server, 'Bob');
            await claim(server, ada);
            const pages = [await socket(server, ada), await socket(server, bob)];
            for (const page of pages) await page.next('session.state');
            const [first] = await revisions(server, ada);
            await writeFile(path.join(root, 'shop.dt'), SHIPPED);
            for (const page of pages) await page.next('update');
            expect((await api(server, ada, 'revisions', {})).status).toBe(201);
            await Bun.sleep(300);

            const seen = pages.map((p) => updates(p).length);
            const restored = await api(server, ada, `revisions/${first.id}/restore`, {});
            expect(restored.status).toBe(200);
            const body = (await restored.json()) as RestoredBody;
            expect(body.restored.origin).toEqual({ kind: 'Restored', restoredFrom: first.id, preRestore: body.preRestore.id });
            expect(body.manual).toBeUndefined();
            // the watcher's own events of the write come later: they are absorbed, the pages get one update
            await Bun.sleep(800);
            for (const [i, page] of pages.entries()) {
                const after = updates(page).slice(seen[i]);
                expect(after).toHaveLength(1);
                expect(JSON.stringify(after[0].model)).not.toContain('Shipped');
                await page.next('revision.restored');
            }
            expect(server.watcherHold.held).toBe(false);

            // an edit by hand afterwards: refused, nothing written; the two-step records it, then restores
            const byHand = `${SHIPPED}\n// by hand\n`;
            await writeFile(path.join(root, 'shop.dt'), byHand);
            await Bun.sleep(200);
            const refused = await api(server, ada, `revisions/${first.id}/restore`, {});
            expect([refused.status, await errorOf(refused)]).toEqual([409, { type: 'ExternalChangesSinceSnapshot', paths: ['shop.dt'] }]);
            expect(await readFile(path.join(root, 'shop.dt'), 'utf8')).toBe(byHand);
            const invalid = await api(server, ada, `revisions/${first.id}/restore`, { recordExternalChanges: 'yes' });
            expect([invalid.status, (await errorOf(invalid)).type]).toEqual([400, 'InvalidInput']);
            const twoStep = await api(server, ada, `revisions/${first.id}/restore`, { recordExternalChanges: true });
            expect(twoStep.status).toBe(200);
            const kept = (await twoStep.json()) as RestoredBody;
            expect(kept.manual?.origin).toEqual({ kind: 'Manual', takenBy: 'local:facilitator' });
            expect(await readFile(path.join(root, 'shop.dt'), 'utf8')).toBe(DT);
            const diff = ((await (await api(server, bob, `revisions/${first.id}/compare/${kept.manual?.id}`)).json()) as ComparisonBody).files.find(
                (f) => f.path === 'shop.dt',
            )?.diff;
            expect(diff?.kind === 'diff' && diff.unified).toContain('+// by hand');

            const ops = await server.collaboration.restoreOperations({ session: server.session });
            expect(ops.map((o) => [o.result, o.reason, o.by, o.identity?.provider])).toEqual([
                ['Restored', undefined, 'local:facilitator', 'dev'],
                ['Refused', 'ExternalChangesSinceSnapshot', 'local:facilitator', 'dev'],
                ['Restored', undefined, 'local:facilitator', 'dev'],
            ]);
            for (const page of pages) page.ws.close();
        } finally {
            await server.stop();
        }
    });

    test('saves while a run is in progress make no revision; a restore is refused until the run ends or is cancelled', async () => {
        const root = await workspace();
        const server = await start(root);
        try {
            await server.ready;
            const ada = await join(server, 'Ada');
            await claim(server, ada);
            const cred = await agentCredential(root);
            const [first] = await revisions(server, ada);
            const target = { target: { kind: 'Workspace' }, sourceRevision: first.id };
            const request = ((await (await api(server, ada, 'requests', { target, body: 'Ship it.' })).json()) as { request: { id: string } }).request;
            const run = ((await (await api(server, ada, 'runs', { requests: [request.id] })).json()) as { run: { id: string } }).run;
            const { lease } = (await (await agent(cred, 'runs/claim', { owner: 'test-agent' })).json()) as { lease: { token: string } };
            const claimedOnly = await api(server, ada, `revisions/${first.id}/restore`, {});
            expect([claimedOnly.status, await errorOf(claimedOnly)]).toEqual([409, { type: 'RunInProgress', run: run.id }]);
            expect((await agent(cred, `runs/${run.id}/start`, { token: lease.token })).status).toBe(200);
            const atStart = (await revisions(server, ada)).length;
            for (const n of [1, 2, 3]) {
                await writeFile(path.join(root, 'shop.dt'), DT.replace('state Placed', `state Placed\n    state Step${n}`));
                await Bun.sleep(150);
            }
            expect((await revisions(server, ada)).length).toBe(atStart);
            const running = await api(server, ada, `revisions/${first.id}/restore`, { recordExternalChanges: true });
            expect([running.status, await errorOf(running)]).toEqual([409, { type: 'RunInProgress', run: run.id }]);
            expect(await readFile(path.join(root, 'shop.dt'), 'utf8')).toContain('Step3');

            // cancelled: the lease ends; the agent's edits are external to the run's base, so the two-step keeps them
            expect((await api(server, ada, `runs/${run.id}/cancel`, {})).status).toBe(200);
            const external = await api(server, ada, `revisions/${first.id}/restore`, {});
            expect([external.status, (await errorOf(external)).type]).toEqual([409, 'ExternalChangesSinceSnapshot']);
            expect((await api(server, ada, `revisions/${first.id}/restore`, { recordExternalChanges: true })).status).toBe(200);
            expect(await readFile(path.join(root, 'shop.dt'), 'utf8')).toBe(DT);
            expect((await revisions(server, ada)).map((r) => r.origin.kind)).toEqual(['SessionStart', 'RunBase', 'Manual', 'PreRestore', 'Restored']);
        } finally {
            await server.stop();
        }
    });
});

describe('closing and resuming', () => {
    test('one open session per workspace: a restart resumes it with its sign-ins; closing revokes them and closes the pages', async () => {
        const root = await workspace();
        const first = await start(root);
        const ada = await join(first, 'Ada');
        await claim(first, ada);
        const id = first.session;
        expect(first.resumed).toBe(false);
        await first.stop();
        expect(await readFile(path.join(root, '.domaintrail', 'session', 'agent.json'), 'utf8').catch(() => 'gone')).toBe('gone');

        const second = await start(root);
        try {
            expect(second.resumed).toBe(true);
            expect(second.session).toBe(id);
            expect(((await (await api(second, ada, 'me')).json()) as Me).participant.role).toBe('facilitator');
            const another = await issueFacilitatorLink(root);
            expect(another.link.startsWith(`${second.url}session/facilitator?code=`)).toBe(true);
            const bob = await join(second, 'Bob');
            const s = await socket(second, bob);
            const cred = await agentCredential(root);
            const stream = sse(cred, undefined, ['session.closed']);
            const closed = await api(second, ada, 'close', {});
            expect(closed.status).toBe(200);
            await second.closed;
            expect(await s.closed).toBe(WS_SESSION_CLOSED);
            expect((await stream).at(-1)?.event).toBe('session.closed');
            expect((await fetch(`${second.url}api/state`, { headers: { cookie: bob } })).status).toBe(401);
        } finally {
            await second.stop();
        }
        expect(
            await issueFacilitatorLink(root).then(
                () => undefined,
                (e: unknown) => e,
            ),
        ).toBeInstanceOf(SessionError);
        const third = await start(root);
        expect(third.resumed).toBe(false);
        expect(third.session).not.toBe(id);
        await third.stop();
    });

    test('a closed session identifies no one, while the process is still up: Access tokens and the facilitator get 401', async () => {
        const root = await workspace();
        const now = Math.floor(Date.now() / 1000);
        const claims = (sub: string): AccessClaims => ({
            iss: 'https://team.cloudflareaccess.com',
            aud: 'aud-tag',
            sub,
            exp: now + 600,
            email: `${sub}@example.com`,
        });
        const verifier = createMockAccessVerifier(
            new Map([
                ['ada', claims('ada')],
                ['bob', claims('bob')],
            ]),
        );
        const server = await start(root, {
            session: sessionConfig({ identity: 'access', access: accessConfig() }),
            accessVerifier: verifier,
            accessAdapter: { identityUrl: false },
        });
        try {
            const ada = { 'Cf-Access-Jwt-Assertion': 'ada' };
            const bob = { 'Cf-Access-Jwt-Assertion': 'bob' };
            expect((await fetch(server.facilitatorLink, { headers: ada, redirect: 'manual' })).status).toBe(303);
            expect((await fetch(`${server.url}api/state`, { headers: bob })).status).toBe(200);
            const s = await socket(server, bob);
            const closed = await fetch(`${server.url}api/session/close`, { method: 'POST', headers: { ...ada, ...json }, body: '{}' });
            expect(closed.status).toBe(200);
            await server.closed;
            expect(await s.closed).toBe(WS_SESSION_CLOSED);
            for (const who of [ada, bob]) {
                for (const p of ['api/state', 'api/session/me']) expect([p, (await fetch(server.url + p, { headers: who })).status]).toEqual([p, 401]);
                expect(await refused(server, who)).toBe(true);
            }
        } finally {
            await server.stop();
        }
    });
});

describe('identity modes', () => {
    test('dev refuses to start on a non-loopback bind', async () => {
        const root = await workspace();
        expect(
            await start(root, { session: sessionConfig({ host: '0.0.0.0' }) }).then(
                () => undefined,
                (e: unknown) => e,
            ),
        ).toBeInstanceOf(SessionError);
    });

    test('access: a verified token of the audience is an identity (joined on first sight); nothing else is; hosts are explicit', async () => {
        const root = await workspace();
        const now = Math.floor(Date.now() / 1000);
        const claims = (over: Partial<AccessClaims>): AccessClaims => ({
            iss: 'https://team.cloudflareaccess.com',
            aud: ['aud-tag'],
            sub: 'user-1',
            exp: now + 600,
            email: 'ada@example.com',
            name: 'Ada Lovelace',
            ...over,
        });
        const verifier = createMockAccessVerifier(
            new Map([
                ['good', claims({})],
                ['other-audience', claims({ aud: 'another' })],
                ['other-issuer', claims({ iss: 'https://evil.cloudflareaccess.com' })],
                ['expired', claims({ exp: now - 60 })],
            ]),
        );
        const access = accessConfig({ allowedHosts: ['session.example.com'], allowedOrigins: ['https://session.example.com'], acceptCookie: true });
        const server = await start(root, {
            session: sessionConfig({ identity: 'access', access }),
            accessVerifier: verifier,
            accessAdapter: { identityUrl: false },
        });
        try {
            const page = await fetch(server.url);
            expect(page.status).toBe(401);
            expect(await page.text()).not.toContain('action="/session/join"');
            expect((await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: '{"name":"x"}' })).status).toBe(404);
            for (const token of ['other-audience', 'other-issuer', 'expired', 'unknown']) {
                expect([token, (await fetch(`${server.url}api/state`, { headers: { 'Cf-Access-Jwt-Assertion': token } })).status]).toEqual([token, 401]);
            }
            const me = await fetch(`${server.url}api/session/me`, { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
            expect(me.status).toBe(200);
            const body = (await me.json()) as Me;
            expect({ ...body.participant }).toEqual({ id: 'access:user-1', name: 'Ada Lovelace', role: 'participant' } as typeof body.participant);
            expect(JSON.stringify(body)).not.toContain('ada@example.com');
            expect((await fetch(`${server.url}api/state`, { headers: { cookie: 'CF_Authorization=good' } })).status).toBe(200);
            // the public host through the tunnel, and its origin; anything else is refused
            const tunnel = { 'Cf-Access-Jwt-Assertion': 'good', Host: 'session.example.com' };
            expect((await fetch(`${server.url}api/state`, { headers: tunnel })).status).toBe(200);
            expect((await fetch(`${server.url}api/state`, { headers: { ...tunnel, Origin: 'https://session.example.com' } })).status).toBe(200);
            expect((await fetch(`${server.url}api/state`, { headers: { ...tunnel, Origin: 'https://evil.example' } })).status).toBe(403);
            expect((await fetch(`${server.url}api/state`, { headers: { ...tunnel, Host: 'other.example.com' } })).status).toBe(403);
            const state = (await (
                await fetch(`${server.url}api/session/state`, { headers: { 'Cf-Access-Jwt-Assertion': 'good' } })
            ).json()) as SessionStateBody;
            expect(state.session.participants.map((p) => p.id)).toEqual(['local:facilitator', 'access:user-1']);
        } finally {
            await server.stop();
        }
    });

    test('the participants a session admits are limited', async () => {
        const root = await workspace();
        const server = await start(root, { session: sessionConfig({ maxParticipants: 2 }) });
        try {
            await join(server, 'Ada');
            const full = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Bob' }) });
            expect([full.status, ((await full.json()) as { error: { type: string } }).error.type]).toEqual([409, 'SessionFull']);
        } finally {
            await server.stop();
        }
    });
});

describe('the join form (dev)', () => {
    test('a name posted from the form signs in and goes back to the facilitator link it came from', async () => {
        const root = await workspace();
        const server = await start(root);
        try {
            const link = new URL(server.facilitatorLink);
            const page = await fetch(link, { redirect: 'manual' });
            expect(page.status).toBe(401);
            expect(await page.text()).toContain(`value="${link.pathname}${link.search}"`);
            const posted = await fetch(`${server.url}session/join`, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: server.url.slice(0, -1) },
                body: new URLSearchParams({ name: 'Ada', next: `${link.pathname}${link.search}` }).toString(),
                redirect: 'manual',
            });
            expect(posted.status).toBe(303);
            expect(posted.headers.get('location')).toBe(`${link.pathname}${link.search}`);
            const cookie = (posted.headers.get('set-cookie') ?? '').split(';')[0];
            const claimed = await fetch(link, { headers: { cookie }, redirect: 'manual' });
            expect([claimed.status, claimed.headers.get('location')]).toEqual([303, '/']);
            expect(((await (await api(server, cookie, 'me')).json()) as Me).participant.role).toBe('facilitator');
            // only paths of this server are followed
            const away = await fetch(`${server.url}session/join`, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ name: 'Bob', next: '//evil.example/' }).toString(),
                redirect: 'manual',
            });
            expect(away.headers.get('location')).toBe('/');
            const blank = await fetch(`${server.url}session/join`, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: 'name=%20',
                redirect: 'manual',
            });
            expect(blank.status).toBe(400);
        } finally {
            await server.stop();
        }
    });
});

describe('the facilitator’s holder', () => {
    test('the state names the participant holding the role, and every page still connected is sent it when the role changes hands', async () => {
        const root = await workspace();
        const server = await start(root);
        try {
            const ada = await join(server, 'Ada');
            const bob = await join(server, 'Bob');
            const carol = await join(server, 'Carol');
            const before = (await (await api(server, bob, 'state')).json()) as SessionStateBody;
            expect(before.facilitatorHolder).toBeUndefined();
            const adaId = before.session.participants.find((p) => p.name === 'Ada')!.id;
            const bobId = before.session.participants.find((p) => p.name === 'Bob')!.id;
            expect(adaId).toMatch(/^dev:/);
            expect(listedParticipants(before).map((p) => [p.name, p.role])).toEqual([
                ['Facilitator', 'facilitator'],
                ['Ada', 'participant'],
                ['Bob', 'participant'],
                ['Carol', 'participant'],
            ]);

            // Carol's page stays connected through both claims: it is sent the state again each time
            const page = await socket(server, carol);
            await page.next('session.state');
            await claim(server, ada);
            const afterAda = ((await page.next('session.state')) as unknown as { state: SessionStateBody }).state;
            expect(afterAda.facilitatorHolder).toBe(adaId);
            expect(((await (await api(server, bob, 'state')).json()) as SessionStateBody).facilitatorHolder).toBe(adaId);
            // Ada is listed once, as the facilitator, under her name
            expect(listedParticipants(afterAda).map((p) => [p.name, p.role])).toEqual([
                ['Ada', 'facilitator'],
                ['Bob', 'participant'],
                ['Carol', 'participant'],
            ]);

            // the role moves to Bob: Ada is a participant again
            const link = await server.issueFacilitatorLink();
            expect((await fetch(link, { headers: { cookie: bob }, redirect: 'manual' })).status).toBe(303);
            const afterBob = ((await page.next('session.state')) as unknown as { state: SessionStateBody }).state;
            expect(afterBob.facilitatorHolder).toBe(bobId);
            expect(listedParticipants(afterBob).map((p) => [p.name, p.role])).toEqual([
                ['Bob', 'facilitator'],
                ['Ada', 'participant'],
                ['Carol', 'participant'],
            ]);
            page.ws.close();
        } finally {
            await server.stop();
        }
    });
});

describe('the CLI', () => {
    const run = async (...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> => {
        const out: string[] = [];
        const err: string[] = [];
        const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, cliDeps());
        return { code, out, err };
    };

    test('dt session start refuses a non-loopback bind in dev mode; dt session link needs a running server', async () => {
        const root = await workspace();
        const started = await run('-r', root, 'session', 'start', '--host', '0.0.0.0', '--port', '0');
        expect(started.code).toBe(1);
        expect(started.err.join('\n')).toContain('loopback');
        const link = await run('-r', root, 'session', 'link');
        expect(link.code).toBe(1);
        expect(link.err.join('\n')).toContain('No session server is running');
    });
});
