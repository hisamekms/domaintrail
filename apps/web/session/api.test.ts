import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SessionApiError, sessionApi } from './api';

/** A browser's answer to a `fetch` with `redirect: 'manual'` that met a redirect: `type` opaqueredirect, status 0. */
const opaqueRedirect = (): Response => {
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'type', { value: 'opaqueredirect' });
    Object.defineProperty(res, 'status', { value: 0 });
    return res;
};

const g = globalThis as unknown as Record<string, unknown>;
const saved = { fetch: g.fetch, sessionStorage: g.sessionStorage, location: g.location };
let reloads = 0;
let seen: RequestInit[] = [];

const answering = (answer: () => Response | Promise<Response>): void => {
    g.fetch = (_: unknown, init?: RequestInit) => {
        if (init) seen.push(init);
        return Promise.resolve().then(answer);
    };
};

beforeEach(() => {
    reloads = 0;
    seen = [];
    const storage = new Map<string, string>();
    g.sessionStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) };
    g.location = { reload: () => void reloads++ };
});
afterEach(() => {
    for (const [k, v] of Object.entries(saved)) g[k] = v;
});

const failure = (p: Promise<unknown>): Promise<SessionApiError> =>
    p.then(
        () => {
            throw new Error('expected a failure');
        },
        (e: unknown) => {
            if (!(e instanceof SessionApiError)) throw e;
            return e;
        },
    );

describe('sessionApi, behind Cloudflare Access', () => {
    test('does not follow redirects', async () => {
        answering(() => new Response('{}'));
        await sessionApi.me();
        await sessionApi.queueRun({ requests: [] });
        expect(seen.map((i) => i.redirect)).toEqual(['manual', 'manual']);
    });

    test('Access’s redirect to its sign-in (the session ran out) is SignInRequired and reloads the page, once', async () => {
        answering(opaqueRedirect);
        const e = await failure(sessionApi.me());
        expect([e.type, e.status]).toEqual(['SignInRequired', 0]);
        expect(reloads).toBe(1);
        // a POST alike; the reload just made is not made again (no loop when a sign-in does not hold)
        expect((await failure(sessionApi.queueRun({ requests: [] }))).type).toBe('SignInRequired');
        expect(reloads).toBe(1);
    });

    test('a 302 as a non-browser fetch sees it is SignInRequired too', async () => {
        answering(() => new Response(null, { status: 302, headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/x' } }));
        expect((await failure(sessionApi.state())).type).toBe('SignInRequired');
    });

    test('a network failure (the server down) is Network, and does not reload', async () => {
        answering(() => Promise.reject(new TypeError('Failed to fetch')));
        const e = await failure(sessionApi.me());
        expect([e.type, e.status]).toEqual(['Network', 0]);
        expect(reloads).toBe(0);
    });

    test('the server’s 401 stays the server’s error (the caller decides), and does not reload here', async () => {
        answering(() => Response.json({ error: { type: 'Unauthenticated', message: 'Sign in to the session first.' } }, { status: 401 }));
        const e = await failure(sessionApi.me());
        expect([e.type, e.status]).toEqual(['Unauthenticated', 401]);
        expect(reloads).toBe(0);
    });
});

describe('sessionApi over HTTP, against a stand-in for Access in front of the server', () => {
    const TEAM_LOGIN = 'https://team.cloudflareaccess.com/cdn-cgi/access/login/session.example.com';
    let signedIn = true;
    let originRequests = 0;
    // the edge and the origin in one: the origin's answers while the Access session lasts, Access's 302 after
    const edge = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: (req) => {
            if (!signedIn)
                return new Response(null, {
                    status: 302,
                    headers: { location: `${TEAM_LOGIN}?redirect_url=${encodeURIComponent(new URL(req.url).pathname)}` },
                });
            originRequests++;
            return Response.json({ participant: { id: 'access:ada', name: 'ada', role: 'participant' } });
        },
    });
    const viaEdge = (): void => {
        // the page's relative URLs, on the edge
        g.fetch = (input: string, init?: RequestInit) => (saved.fetch as typeof fetch)(new URL(input, edge.url), init);
    };

    test('signed in, the call reaches the server; expired, it is SignInRequired and reloads, without asking the server', async () => {
        viaEdge();
        signedIn = true;
        expect((await sessionApi.me()).participant.name).toBe('ada');
        signedIn = false;
        const before = originRequests;
        const e = await failure(sessionApi.queueRun({ requests: [] }));
        expect([e.type, e.status]).toEqual(['SignInRequired', 0]);
        expect(reloads).toBe(1);
        expect(originRequests).toBe(before);
    });

    test('the edge gone is Network, and does not reload', async () => {
        viaEdge();
        await edge.stop(true);
        expect((await failure(sessionApi.me())).type).toBe('Network');
        expect(reloads).toBe(0);
    });
});
