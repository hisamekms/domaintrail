/**
 * The `link` identity mode (docs/session-link.md): a session behind a tunnel whose participants join through a shared
 * invite link and the facilitator's approval. The session server is started with a public URL (as `dt collab --tunnel`
 * does with its quick tunnel's) and asked as the tunnel would ask it: the public Host, the page's Origin. Covered: the
 * start's refusals, Host and Origin on every request and the WebSocket, the facilitator's sign-in with their link, the
 * invite (made, used many times, replaced, stopped; facilitator only), join requests (pending, approved, denied,
 * limited per client), the cookies' flags, names escaped, removing a participant, and `dt collab invite`.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DEFAULT_AGENT_TOOLS } from '@domaintrail/agent';
import type { Me } from '@domaintrail/collaboration/protocol';
import { createSessionAccess, createUnitOfWork, FACILITATOR_NAME, openSessionDatabase, randomSecrets, systemClock } from '@domaintrail/collaboration';
import { issueInvite, SessionError, type SessionServer, type SessionSettings, startSessionServer, WS_REVOKED } from '@domaintrail/dt';

const PUBLIC = 'https://quiet-river-1234.trycloudflare.com';
const HOST = 'quiet-river-1234.trycloudflare.com';

const DT = `context Shop {
  id OrderId: UUID

  aggregate Order {
    id: OrderId

    state Open

    create command start(id: OrderId) -> Open
  }
}
`;

const dirs: string[] = [];
afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-session-link-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'shop.dt'), DT);
    return dir;
}

const settings = (over: Partial<SessionSettings> = {}): SessionSettings => ({
    port: 0,
    host: '127.0.0.1',
    identity: 'link',
    link: { publicUrl: PUBLIC },
    agent: { port: 0, allowedTools: [...DEFAULT_AGENT_TOOLS], maxPreviousRunDiff: 20 * 1024 },
    maxParticipants: 50,
    quickReactions: ['👍'],
    classifier: { enabled: false, provider: 'cloudflare-clef', model: 'clef-flash', apiTokenEnv: 'CLOUDFLARE_API_TOKEN', threshold: 0.5 },
    ...over,
});

/** The headers a page of the public URL sends through the tunnel. */
const page = (cookie?: string, extra: Record<string, string> = {}): Record<string, string> => ({
    host: HOST,
    origin: PUBLIC,
    ...(cookie && { cookie }),
    ...extra,
});

/** `name=value` of a `Set-Cookie` whose name starts with `prefix`, and the whole line. */
function setCookie(res: Response, prefix: string): { pair: string; line: string } {
    const line = res.headers.getSetCookie().find((c) => c.startsWith(prefix));
    if (!line) throw new Error(`no cookie ${prefix} in ${JSON.stringify(res.headers.getSetCookie())}`);
    return { pair: line.split(';')[0], line };
}

const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_BODY = { 'content-type': 'application/json' };

interface Socket {
    received: { type: string; [k: string]: unknown }[];
    closed: Promise<number>;
    ws: WebSocket;
}

async function socket(server: SessionServer, headers: Record<string, string>): Promise<Socket> {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}ws`, { headers } as never);
    const received: Socket['received'] = [];
    ws.onmessage = (ev) => received.push(JSON.parse(String(ev.data)));
    const closed = new Promise<number>((resolve) => (ws.onclose = (ev) => resolve(ev.code)));
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });
    return { ws, received, closed };
}

async function refused(server: SessionServer, headers: Record<string, string>): Promise<boolean> {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}ws`, { headers } as never);
    const result = await new Promise<boolean>((resolve) => {
        ws.onopen = () => resolve(false);
        ws.onerror = () => resolve(true);
        ws.onclose = () => resolve(true);
    });
    ws.close();
    return result;
}

const until = async (check: () => boolean, timeoutMs = 3000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out');
        await Bun.sleep(10);
    }
};

const servers: SessionServer[] = [];
afterEach(async () => {
    for (const s of servers.splice(0)) await s.stop();
});

async function start(
    over: Partial<SessionSettings> = {},
    options: { quickTunnel?: boolean; root?: string } = {},
): Promise<{ server: SessionServer; root: string; lines: string[] }> {
    const root = options.root ?? (await workspace());
    const lines: string[] = [];
    const server = await startSessionServer({
        root,
        debounceMs: 30,
        session: settings(over),
        log: (l) => lines.push(l),
        expireEveryMs: 50,
        ...(options.quickTunnel && { quickTunnel: true }),
    });
    servers.push(server);
    return { server, root, lines };
}

/** Signs the facilitator in with the link the server printed: the cookie's `name=value`. */
async function facilitator(server: SessionServer, name = 'Fiona'): Promise<string> {
    const link = new URL(server.facilitatorLink);
    expect(link.origin).toBe(PUBLIC);
    const next = `${link.pathname}${link.search}`;
    // without a cookie the link asks for a name
    const asked = await fetch(`${server.url}${next.slice(1)}`, { headers: page(), redirect: 'manual' });
    expect(asked.status).toBe(401);
    expect(await asked.text()).toContain('action="/session/join"');
    const res = await fetch(`${server.url}session/join`, { method: 'POST', headers: { ...page(), ...FORM }, body: form({ name, next }), redirect: 'manual' });
    expect(res.status).toBe(303);
    return setCookie(res, '__Host-dt_link_').pair;
}

async function me(server: SessionServer, cookie: string): Promise<Me | number> {
    const res = await fetch(`${server.url}api/session/me`, { headers: page(cookie) });
    return res.ok ? ((await res.json()) as Me) : res.status;
}

const post = (server: SessionServer, apiPath: string, cookie: string, headers: Record<string, string> = page(cookie)): Promise<Response> =>
    fetch(`${server.url}api/session/${apiPath}`, { method: 'POST', headers: { ...headers, ...JSON_BODY }, body: '{}' });

/** Opens the invite link and asks to join as `name` (from `ip`, as cloudflared forwards it): the waiting cookie. */
async function ask(server: SessionServer, invite: string, name: string, ip = '203.0.113.7'): Promise<{ res: Response; wait?: string }> {
    const link = new URL(invite);
    const code = link.searchParams.get('code') ?? '';
    const opened = await fetch(`${server.url}${link.pathname.slice(1)}${link.search}`, { headers: page() });
    expect(opened.status).toBe(200);
    const res = await fetch(`${server.url}session/invite`, {
        method: 'POST',
        headers: { ...page(undefined, { 'cf-connecting-ip': ip }), ...FORM },
        body: form({ code, name }),
        redirect: 'manual',
    });
    return res.status === 303 ? { res, wait: setCookie(res, '__Host-dt_wait_').pair } : { res };
}

const waiting = (server: SessionServer, wait: string): Promise<Response> => fetch(`${server.url}session/wait`, { headers: page(wait), redirect: 'manual' });

describe('starting a session in the link identity mode', () => {
    test('needs an https public URL and a loopback address', async () => {
        const root = await workspace();
        const failed = (over: Partial<SessionSettings>): Promise<unknown> =>
            startSessionServer({ root, session: settings(over), log: () => undefined }).then(
                (s) => s.stop().then(() => undefined),
                (e: unknown) => e,
            );
        expect(await failed({ link: {} })).toBeInstanceOf(SessionError);
        expect(await failed({ link: { publicUrl: 'http://example.com' } })).toBeInstanceOf(SessionError);
        expect(await failed({ host: '0.0.0.0' })).toBeInstanceOf(SessionError);
    });

    test('makes its links with the public URL and records it for the other commands', async () => {
        const { server } = await start();
        expect(server.publicUrl).toBe(PUBLIC);
        expect(server.facilitatorLink.startsWith(`${PUBLIC}/session/facilitator?code=`)).toBe(true);
    });
});

describe('a session in the link identity mode', () => {
    test('answers the public host and loopback only, and wants an Origin on what changes something (HTTP and WebSocket)', async () => {
        const { server } = await start();
        const cookie = await facilitator(server);
        expect(await me(server, cookie)).toMatchObject({ participant: { role: 'facilitator' }, identity: { provider: 'link' } });
        // another host: refused, with or without a cookie
        expect((await fetch(`${server.url}api/session/me`, { headers: { ...page(cookie), host: 'evil.example' } })).status).toBe(403);
        // another origin, or none on a POST: refused
        expect((await post(server, 'invite', cookie, page(cookie, { origin: 'https://evil.example' }))).status).toBe(403);
        expect((await post(server, 'invite', cookie, { host: HOST, cookie })).status).toBe(403);
        expect((await post(server, 'invite', cookie)).status).toBe(201);
        // a read without an Origin is fine (a navigation)
        expect((await fetch(`${server.url}api/session/me`, { headers: { host: HOST, cookie } })).status).toBe(200);
        // the WebSocket: an Origin of the public URL only
        expect(await refused(server, { host: HOST, cookie })).toBe(true);
        expect(await refused(server, page(cookie, { origin: 'https://evil.example' }))).toBe(true);
        expect(await refused(server, { ...page(cookie), host: 'evil.example' })).toBe(true);
        const ws = await socket(server, page(cookie));
        ws.ws.close();
    });

    test('anyone without a cookie is told to use the invite; joining by name without one is refused', async () => {
        const { server } = await start();
        const res = await fetch(server.url, { headers: page() });
        expect(res.status).toBe(401);
        expect(await res.text()).toContain('invite link');
        const join = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: { ...page(), ...JSON_BODY }, body: '{"name":"Eve"}' });
        expect(join.status).toBe(404);
        // the facilitator's form with a made-up code signs nobody in
        const forged = await fetch(`${server.url}session/join`, {
            method: 'POST',
            headers: { ...page(), ...FORM },
            body: form({ name: 'Eve', next: `/session/facilitator?code=${'x'.repeat(43)}` }),
            redirect: 'manual',
        });
        expect(forged.status).toBe(409);
        expect(forged.headers.getSetCookie()).toEqual([]);
    });

    test('the cookies are HttpOnly, Secure, SameSite=Strict, of this host only, and the session cookie ends with the browser session', async () => {
        const { server } = await start();
        const link = new URL(server.facilitatorLink);
        const res = await fetch(`${server.url}session/join`, {
            method: 'POST',
            headers: { ...page(), ...FORM },
            body: form({ name: 'Fiona', next: `${link.pathname}${link.search}` }),
            redirect: 'manual',
        });
        const { line } = setCookie(res, '__Host-dt_link_');
        expect(line).toMatch(/^__Host-dt_link_[0-9a-f]{12}=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
        const invite = (await (await post(server, 'invite', setCookie(res, '__Host-dt_link_').pair)).json()) as { link: string };
        const asked = await ask(server, invite.link, 'Ada');
        expect(setCookie(asked.res, '__Host-dt_wait_').line).toMatch(
            /^__Host-dt_wait_[0-9a-f]{12}=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/,
        );
    });

    test('a join request waits, the facilitator approves it from their page, and the visitor comes in as a participant', async () => {
        const { server, lines } = await start();
        const cookie = await facilitator(server);
        const fws = await socket(server, page(cookie));
        await until(() => fws.received.some((m) => m.type === 'join.requests'));
        expect(fws.received.find((m) => m.type === 'join.requests')).toMatchObject({ requests: [], invite: null });
        const invite = (await (await post(server, 'invite', cookie)).json()) as { link: string; expiresAt: string };
        expect(invite.link.startsWith(`${PUBLIC}/session/invite?code=`)).toBe(true);
        await until(() => fws.received.some((m) => m.type === 'join.requests' && m.invite !== null));

        const { wait } = await ask(server, invite.link, 'Ada');
        if (!wait) throw new Error('not asked');
        const pending = await waiting(server, wait);
        expect(pending.status).toBe(200);
        const html = await pending.text();
        expect(html).toContain('<meta http-equiv="refresh"');
        expect(html).toContain('Waiting to be let in');
        await until(() => fws.received.some((m) => m.type === 'join.requests' && (m.requests as unknown[]).length === 1));
        const listed = (await (await fetch(`${server.url}api/session/join-requests`, { headers: page(cookie) })).json()) as {
            requests: { id: string; name: string }[];
        };
        expect(listed.requests.map((r) => r.name)).toEqual(['Ada']);

        expect((await post(server, `join-requests/${listed.requests[0].id}/approve`, cookie)).status).toBe(200);
        const admitted = await waiting(server, wait);
        expect(admitted.status).toBe(303);
        expect(admitted.headers.get('location')).toBe('/');
        const ada = setCookie(admitted, '__Host-dt_link_').pair;
        expect(await me(server, ada)).toMatchObject({ participant: { name: 'Ada', role: 'participant' }, identity: { provider: 'link' } });
        // the waiting cookie is done: once admitted, never again
        expect((await waiting(server, wait)).status).toBe(410);
        // a participant does not decide, nor make invites
        expect((await post(server, 'invite', ada)).status).toBe(403);
        expect((await post(server, `join-requests/${listed.requests[0].id}/deny`, ada)).status).toBe(403);
        expect((await fetch(`${server.url}api/session/join-requests`, { headers: page(ada) })).status).toBe(403);
        // the invite's code is never in the log
        const code = new URL(invite.link).searchParams.get('code') ?? '';
        expect(lines.some((l) => l.includes(code))).toBe(false);
        fws.ws.close();
    });

    test('the invite works many times; a denied visitor is told so; names are escaped', async () => {
        const { server } = await start();
        const cookie = await facilitator(server);
        const { link } = (await (await post(server, 'invite', cookie)).json()) as { link: string };
        const bob = await ask(server, link, '<b>Bob</b>');
        const carol = await ask(server, link, 'Carol', '198.51.100.2');
        if (!bob.wait || !carol.wait) throw new Error('not asked');
        const html = await (await waiting(server, bob.wait)).text();
        expect(html).toContain('&lt;b&gt;Bob&lt;/b&gt;');
        expect(html).not.toContain('<b>Bob</b>');
        const { requests } = (await (await fetch(`${server.url}api/session/join-requests`, { headers: page(cookie) })).json()) as {
            requests: { id: string; name: string }[];
        };
        expect(requests.map((r) => r.name)).toEqual(['<b>Bob</b>', 'Carol']);
        expect((await post(server, `join-requests/${requests[0].id}/deny`, cookie)).status).toBe(200);
        const denied = await waiting(server, bob.wait);
        expect(denied.status).toBe(403);
        expect(denied.headers.getSetCookie().some((c) => c.startsWith('__Host-dt_wait_') && c.includes('Max-Age=0'))).toBe(true);
        // deciding again, or an unknown request
        expect((await post(server, `join-requests/${requests[0].id}/approve`, cookie)).status).toBe(404);
        expect((await waiting(server, carol.wait)).status).toBe(200);
    });

    test('a new invite stops the previous one and its pending requests; stopping it stops it', async () => {
        const { server } = await start();
        const cookie = await facilitator(server);
        const first = (await (await post(server, 'invite', cookie)).json()) as { link: string };
        const { wait } = await ask(server, first.link, 'Ada');
        if (!wait) throw new Error('not asked');
        const second = (await (await post(server, 'invite', cookie)).json()) as { link: string };
        expect((await waiting(server, wait)).status).toBe(410);
        const old = new URL(first.link);
        expect((await fetch(`${server.url}${old.pathname.slice(1)}${old.search}`, { headers: page() })).status).toBe(410);
        const posted = await fetch(`${server.url}session/invite`, {
            method: 'POST',
            headers: { ...page(), ...FORM },
            body: form({ code: old.searchParams.get('code') ?? '', name: 'Ada' }),
            redirect: 'manual',
        });
        expect(posted.status).toBe(410);
        expect((await ask(server, second.link, 'Bob')).wait).toBeDefined();
        expect(await (await post(server, 'invite/revoke', cookie)).json()).toEqual({ revoked: true });
        const now = new URL(second.link);
        expect((await fetch(`${server.url}${now.pathname.slice(1)}${now.search}`, { headers: page() })).status).toBe(410);
    });

    test('requests are limited per client (CF-Connecting-IP from the quick tunnel this process started), and the pending ones in all', async () => {
        const { server } = await start({}, { quickTunnel: true });
        const cookie = await facilitator(server);
        const { link } = (await (await post(server, 'invite', cookie)).json()) as { link: string };
        for (let i = 0; i < 5; i++) expect((await ask(server, link, `A${i}`, '203.0.113.9')).wait).toBeDefined();
        const limited = await ask(server, link, 'A5', '203.0.113.9');
        expect(limited.res.status).toBe(429);
        expect(await limited.res.text()).toContain('Too many requests');
        expect((await ask(server, link, 'B', '203.0.113.10')).wait).toBeDefined();
    });

    test('without its own quick tunnel the server never reads CF-Connecting-IP: a spoofed address does not dodge the limit', async () => {
        const { server } = await start();
        const cookie = await facilitator(server);
        const { link } = (await (await post(server, 'invite', cookie)).json()) as { link: string };
        for (let i = 0; i < 5; i++) expect((await ask(server, link, `A${i}`, `203.0.113.${i}`)).wait).toBeDefined();
        expect((await ask(server, link, 'A5', '203.0.113.99')).res.status).toBe(429);
    });

    test('a restart signs everyone out (the cookie of the earlier server is no one), and a sign-in of another mode is never accepted', async () => {
        const { server, root } = await start();
        const cookie = await facilitator(server);
        const value = cookie.split('=')[1];
        await server.stop();
        servers.splice(servers.indexOf(server), 1);
        const again = (await start({}, { root })).server;
        // the same secret under this server's cookie name: revoked
        const renamed = `${(await facilitator(again)).split('=')[0]}=${value}`;
        expect(await me(again, renamed)).toBe(401);
        // a dev sign-in of this session, its secret under the link cookie's name: not a link identity
        const db = await openSessionDatabase(root);
        const access = createSessionAccess({ uow: createUnitOfWork(db), clock: systemClock, secrets: randomSecrets });
        const devSecret = await access.signIn({
            session: again.session as never,
            identity: { provider: 'dev', subject: crypto.randomUUID(), displayName: FACILITATOR_NAME },
        });
        db.close();
        expect(await me(again, `${renamed.split('=')[0]}=${devSecret}`)).toBe(401);
    });

    test('a removed participant is signed out and their pages close; the facilitator cannot be removed', async () => {
        const { server } = await start();
        const cookie = await facilitator(server);
        const { link } = (await (await post(server, 'invite', cookie)).json()) as { link: string };
        const { wait } = await ask(server, link, 'Ada');
        if (!wait) throw new Error('not asked');
        const { requests } = (await (await fetch(`${server.url}api/session/join-requests`, { headers: page(cookie) })).json()) as {
            requests: { id: string }[];
        };
        await post(server, `join-requests/${requests[0].id}/approve`, cookie);
        const ada = setCookie(await waiting(server, wait), '__Host-dt_link_').pair;
        const who = await me(server, ada);
        if (typeof who === 'number') throw new Error(`me: ${who}`);
        const ws = await socket(server, page(ada));
        expect((await post(server, `participants/${encodeURIComponent(who.participant.id)}/remove`, ada)).status).toBe(403);
        const self = await me(server, cookie);
        if (typeof self === 'number') throw new Error(`me: ${self}`);
        expect((await post(server, `participants/${encodeURIComponent(self.participant.id)}/remove`, cookie)).status).toBe(409);
        expect((await post(server, `participants/${encodeURIComponent(who.participant.id)}/remove`, cookie)).status).toBe(200);
        expect(await ws.closed).toBe(WS_REVOKED);
        expect(await me(server, ada)).toBe(401);
    });

    test('dt collab invite makes a new invite for the running server, which then expires the requests of the previous one', async () => {
        const { server, root } = await start();
        const cookie = await facilitator(server);
        const first = (await (await post(server, 'invite', cookie)).json()) as { link: string };
        const { wait } = await ask(server, first.link, 'Ada');
        if (!wait) throw new Error('not asked');
        const made = await issueInvite(root);
        if (!('link' in made)) throw new Error('no link');
        expect(made.link.startsWith(`${PUBLIC}/session/invite?code=`)).toBe(true);
        expect((await ask(server, made.link, 'Bob', '198.51.100.3')).wait).toBeDefined();
        await until(() => false, 300).catch(() => undefined);
        expect((await waiting(server, wait)).status).toBe(410);
        expect(await issueInvite(root, true)).toEqual({ stopped: true });
    });
});
