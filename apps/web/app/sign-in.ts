// The edge in front of the server (Cloudflare Access) asking for a sign-in. Once a participant's Access session has
// run out, Access answers every request of the page itself, with a redirect to the team's login page: the origin's 401
// is never seen. A `fetch` that followed it would fail on CORS like a network failure, so the page's same-origin calls
// do not follow redirects (the server's API never redirects) and take a redirect as "sign in again": a reload, a
// top-level navigation Access can sign in and bring back.

/** sessionStorage key of the last reload for a sign-in (ms since the epoch). */
const RELOAD_KEY = 'domaintrail.signInReload';
/** At most one reload for a sign-in this often: a sign-in that does not hold must not reload the page in a loop. */
export const SIGN_IN_RELOAD_INTERVAL_MS = 30_000;

/** The `fetch` options of the page's calls to its own server: a redirect comes back as an answer, not followed. */
export const SAME_ORIGIN: RequestInit = { credentials: 'same-origin', redirect: 'manual' };

/**
 * An answer that is a redirect: in a browser an `opaqueredirect` (status 0), elsewhere (tests) the 3xx itself. The
 * server's API never redirects, so this is the edge in front wanting a sign-in.
 */
export const isSignInRedirect = (res: Response): boolean => res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);

export interface ReloadDeps {
    readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined;
    readonly now: () => number;
    readonly reload: () => void;
}

const pageStorage = (): ReloadDeps['storage'] => {
    try {
        return sessionStorage;
    } catch {
        // none here, or blocked by the browser
        return undefined;
    }
};

const browser = (): ReloadDeps => ({ storage: pageStorage(), now: Date.now, reload: () => location.reload() });

/**
 * Reloads the page so that the edge in front signs it in again, unless it did so less than
 * `SIGN_IN_RELOAD_INTERVAL_MS` ago (then the caller shows its error). True when it reloads.
 */
export function reloadForSignIn(deps: ReloadDeps = browser()): boolean {
    const now = deps.now();
    // without the storage there is no guard to keep, so no reload either: a loop could not be stopped
    if (!deps.storage) return false;
    try {
        const last = Number(deps.storage.getItem(RELOAD_KEY));
        if (last > 0 && now - last >= 0 && now - last < SIGN_IN_RELOAD_INTERVAL_MS) return false;
        deps.storage.setItem(RELOAD_KEY, String(now));
    } catch {
        return false;
    }
    deps.reload();
    return true;
}

/**
 * Whether the edge in front wants a sign-in now, asked of the server without following a redirect: for the socket,
 * whose failed handshake cannot tell why it failed. Any answer of the server itself (a 401, or a 404 under `dt view`)
 * is not that; neither is a network failure.
 */
export async function signInRequired(): Promise<boolean> {
    try {
        return isSignInRedirect(await fetch('/api/session/me', { ...SAME_ORIGIN, cache: 'no-store' }));
    } catch {
        return false;
    }
}

/** A call of the page that the edge in front answered with its sign-in (the page reloads, unless it just did). */
export class SignInRequiredError extends Error {
    constructor() {
        super('Sign in again.');
        this.name = 'SignInRequiredError';
    }
}

/**
 * `fetch` of the page's own server (the view's API): a redirect, the edge in front wanting a sign-in, reloads the page
 * and rejects with `SignInRequiredError`. A network failure rejects as `fetch` does.
 */
export async function fetchServer(input: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(input, { ...init, ...SAME_ORIGIN });
    if (!isSignInRedirect(res)) return res;
    reloadForSignIn();
    throw new SignInRequiredError();
}
