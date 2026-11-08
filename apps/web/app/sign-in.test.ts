import { afterEach, describe, expect, test } from 'bun:test';
import { fetchServer, isSignInRedirect, reloadForSignIn, SIGN_IN_RELOAD_INTERVAL_MS, SignInRequiredError, signInRequired, type ReloadDeps } from './sign-in';

/** A storage in memory, and the reloads asked of it. */
function deps(now: { t: number }, storage: Map<string, string> | null = new Map()): ReloadDeps & { reloads: number } {
    const d = {
        reloads: 0,
        storage: storage ? { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) } : undefined,
        now: () => now.t,
        reload: () => void d.reloads++,
    };
    return d;
}

/** A browser's answer to a `fetch` with `redirect: 'manual'` that met a redirect: `type` opaqueredirect, status 0. */
const opaqueRedirect = (): Response => {
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'type', { value: 'opaqueredirect' });
    Object.defineProperty(res, 'status', { value: 0 });
    return res;
};

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

const answering = (answer: () => Response | Promise<Response>, seen: RequestInit[] = []): void => {
    globalThis.fetch = ((_: unknown, init?: RequestInit) => {
        if (init) seen.push(init);
        return Promise.resolve().then(answer);
    }) as typeof fetch;
};

describe('isSignInRedirect', () => {
    test('a redirect not followed is the edge in front wanting a sign-in: the browser’s opaqueredirect, or a 3xx', () => {
        expect(isSignInRedirect(opaqueRedirect())).toBe(true);
        expect(isSignInRedirect(new Response(null, { status: 302, headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/x' } }))).toBe(
            true,
        );
    });

    test('an answer of the server is not, a 401 included', () => {
        for (const status of [200, 401, 403, 404, 500]) expect(isSignInRedirect(new Response(null, { status }))).toBe(false);
    });
});

describe('reloadForSignIn', () => {
    test('reloads once, then not again within the interval, then again after it', () => {
        const now = { t: 1_000_000 };
        const d = deps(now);
        expect(reloadForSignIn(d)).toBe(true);
        now.t += SIGN_IN_RELOAD_INTERVAL_MS - 1;
        expect(reloadForSignIn(d)).toBe(false);
        now.t += 1;
        expect(reloadForSignIn(d)).toBe(true);
        expect(d.reloads).toBe(2);
    });

    test('a reload remembered from the future (a clock set back) does not hold it back', () => {
        const now = { t: 1_000_000 };
        const storage = new Map([['domaintrail.signInReload', String(now.t + 60_000)]]);
        const d = deps(now, storage);
        expect(reloadForSignIn(d)).toBe(true);
    });

    test('without a storage, or one that throws, it does not reload: a loop could not be stopped', () => {
        const now = { t: 1 };
        const none = deps(now, null);
        expect(reloadForSignIn(none)).toBe(false);
        const throwing: ReloadDeps & { reloads: number } = {
            ...deps(now),
            storage: {
                getItem: () => {
                    throw new Error('SecurityError');
                },
                setItem: () => undefined,
            },
        };
        expect(reloadForSignIn(throwing)).toBe(false);
        expect(none.reloads + throwing.reloads).toBe(0);
    });
});

describe('the page’s calls to its server', () => {
    test('do not follow redirects, and keep the cookies of the origin', async () => {
        const seen: RequestInit[] = [];
        answering(() => new Response('{}'), seen);
        await fetchServer('/api/git/refs');
        await fetchServer('/api/baseline', { method: 'POST', body: '{}' });
        expect(seen.map((i) => [i.redirect, i.credentials, i.method])).toEqual([
            ['manual', 'same-origin', undefined],
            ['manual', 'same-origin', 'POST'],
        ]);
    });

    test('a redirect rejects with SignInRequiredError; a network failure rejects as fetch does', async () => {
        answering(opaqueRedirect);
        expect(await fetchServer('/api/focus').catch((e: unknown) => e)).toBeInstanceOf(SignInRequiredError);
        answering(() => Promise.reject(new TypeError('Failed to fetch')));
        const e = await fetchServer('/api/focus').catch((x: unknown) => x);
        expect(e).toBeInstanceOf(TypeError);
    });

    test('signInRequired: a redirect is; the server’s 401 or 404 and a network failure are not', async () => {
        answering(opaqueRedirect);
        expect(await signInRequired()).toBe(true);
        answering(() => new Response(null, { status: 401 }));
        expect(await signInRequired()).toBe(false);
        answering(() => new Response(null, { status: 404 }));
        expect(await signInRequired()).toBe(false);
        answering(() => Promise.reject(new TypeError('Failed to fetch')));
        expect(await signInRequired()).toBe(false);
    });
});
