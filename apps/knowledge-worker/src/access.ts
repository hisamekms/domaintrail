// Who calls (ADR 0031, sections 6 and 8). Cloudflare Access stands in front of the Worker and lets through only a person
// its policy allows or a service token it knows; it then adds its signed token, `Cf-Access-Jwt-Assertion`. The Worker
// verifies that token again (defence in depth: a route that bypasses Access, such as the `*.workers.dev` URL left on,
// reaches nothing) with the team's keys and the application's AUD, and takes the caller from it:
//
// - a person: the token's `email`;
// - a service token: its `common_name`, the token's Client ID (Access puts no e-mail in a service token's JWT).
//
// Only WebCrypto and `fetch`: no JWT library in the Worker.
//
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
import type { Env } from './env.js';

/** Who calls: a person Access signed in, or a service token (dt). */
export type Caller = { readonly kind: 'person'; readonly email: string } | { readonly kind: 'service'; readonly clientId: string };

/** The caller as the audit log records it: the e-mail, or `service:<Client ID>`. */
export const callerName = (caller: Caller): string => (caller.kind === 'person' ? caller.email : `service:${caller.clientId}`);

/** Whether a caller may write: a person may (`authorize` decides on the project); a service token only when listed. */
export function mayWrite(caller: Caller, env: Env): boolean {
    if (caller.kind === 'person') return true;
    const writers = (env.WRITER_TOKENS ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    return writers.includes(caller.clientId);
}

/** Why a request has no caller: the status and the message of the answer. */
export interface Refusal {
    readonly status: 401 | 500;
    readonly type: 'Unauthenticated' | 'Internal';
    readonly message: string;
}

/** The request's caller, or why it has none. */
export async function identify(
    request: Request,
    env: Env,
    verifier: (settings: AccessSettings) => AccessTokenVerifier = cachedVerifier,
): Promise<Caller | Refusal> {
    const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
    const audience = env.ACCESS_AUD?.trim();
    if (teamDomain && audience) {
        const token = request.headers.get('Cf-Access-Jwt-Assertion');
        if (!token) return unauthenticated('no Access token (Cf-Access-Jwt-Assertion): is the Worker reached through Access?');
        const claims = await verifier({ teamDomain, audience }).verify(token);
        if (!claims) return unauthenticated('the Access token does not verify');
        if (typeof claims.email === 'string' && claims.email) return { kind: 'person', email: claims.email };
        if (typeof claims.common_name === 'string' && claims.common_name) return { kind: 'service', clientId: claims.common_name };
        return unauthenticated('the Access token names neither a person nor a service token');
    }
    if (env.INSECURE_SKIP_ACCESS_CHECK === 'true') {
        // local development and the tests: the headers Access would have set, taken as they are
        const email = request.headers.get('Cf-Access-Authenticated-User-Email');
        if (email) return { kind: 'person', email };
        const clientId = request.headers.get('CF-Access-Client-Id');
        if (clientId) return { kind: 'service', clientId };
        return unauthenticated('no identity header (INSECURE_SKIP_ACCESS_CHECK is on)');
    }
    return {
        status: 500,
        type: 'Internal',
        message: 'Access is not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD (or INSECURE_SKIP_ACCESS_CHECK for local development)',
    };
}

const unauthenticated = (message: string): Refusal => ({ status: 401, type: 'Unauthenticated', message });

// ---- the token -------------------------------------------------------------------------------------------------

export interface AccessSettings {
    /** `<team>.cloudflareaccess.com` (or with `https://`). */
    readonly teamDomain: string;
    /** The application's AUD tag. */
    readonly audience: string;
}

/** The claims of a verified token that the Worker reads. */
export interface AccessClaims {
    readonly email?: string;
    readonly common_name?: string;
    readonly sub?: string;
}

export interface AccessTokenVerifier {
    verify(token: string): Promise<AccessClaims | undefined>;
}

export interface VerifierOptions {
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
    /** The JWKS URL; default `https://<team>/cdn-cgi/access/certs`. */
    readonly certsUrl?: string;
}

/** The allowed clock skew on `exp` and `nbf`, in seconds. */
const SKEW_S = 30;
/** How long fetched keys are kept; an unknown `kid` fetches them again (at most every 30 s). */
const KEYS_TTL_MS = 60 * 60 * 1000;
const MIN_REFETCH_MS = 30 * 1000;

export const accessIssuer = (teamDomain: string): string => (teamDomain.startsWith('https://') ? teamDomain : `https://${teamDomain}`).replace(/\/+$/, '');

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function base64url(part: string): Uint8Array<ArrayBuffer> | undefined {
    if (!/^[A-Za-z0-9_-]*$/.test(part)) return undefined;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4);
    try {
        return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    } catch {
        return undefined;
    }
}

function jsonOf(part: string): unknown {
    const bytes = base64url(part);
    if (!bytes) return undefined;
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return undefined;
    }
}

/** A verifier of the team's RS256 tokens for one application. */
export function accessVerifier(settings: AccessSettings, options: VerifierOptions = {}): AccessTokenVerifier {
    const issuer = accessIssuer(settings.teamDomain);
    const certsUrl = options.certsUrl ?? `${issuer}/cdn-cgi/access/certs`;
    const doFetch = options.fetch ?? fetch;
    const now = options.now ?? Date.now;
    let keys = new Map<string, CryptoKey>();
    let fetchedAt = -Infinity;

    const refresh = async (): Promise<void> => {
        fetchedAt = now();
        const res = await doFetch(certsUrl, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`the Access certs answered ${res.status}`);
        const jwks: unknown = await res.json();
        const next = new Map<string, CryptoKey>();
        if (isObject(jwks) && Array.isArray(jwks.keys)) {
            for (const jwk of jwks.keys) {
                if (!isObject(jwk) || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
                if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
                try {
                    const key = await crypto.subtle.importKey(
                        'jwk',
                        { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
                        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
                        false,
                        ['verify'],
                    );
                    next.set(jwk.kid, key);
                } catch {
                    // not a usable RSA key: skipped
                }
            }
        }
        keys = next;
    };

    const keyOf = async (kid: string): Promise<CryptoKey | undefined> => {
        const stale = now() - fetchedAt > KEYS_TTL_MS;
        if (stale || (!keys.has(kid) && now() - fetchedAt > MIN_REFETCH_MS)) {
            try {
                await refresh();
            } catch (e) {
                console.error(`knowledge-worker: fetching the Access keys failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        return keys.get(kid);
    };

    return {
        async verify(token) {
            if (token.length > 8192) return undefined;
            const parts = token.split('.');
            if (parts.length !== 3) return undefined;
            const [h, p, s] = parts;
            const header = jsonOf(h);
            const payload = jsonOf(p);
            const signature = base64url(s);
            if (!isObject(header) || !isObject(payload) || !signature) return undefined;
            if (header.alg !== 'RS256' || typeof header.kid !== 'string') return undefined;
            const key = await keyOf(header.kid);
            if (!key) return undefined;
            const signed = new TextEncoder().encode(`${h}.${p}`);
            if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed))) return undefined;
            if (payload.iss !== issuer) return undefined;
            const audiences = typeof payload.aud === 'string' ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud : [];
            if (!audiences.includes(settings.audience)) return undefined;
            const t = now() / 1000;
            if (typeof payload.exp !== 'number' || !(t < payload.exp + SKEW_S)) return undefined;
            if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || t < payload.nbf - SKEW_S)) return undefined;
            return {
                ...(typeof payload.email === 'string' && { email: payload.email }),
                ...(typeof payload.common_name === 'string' && { common_name: payload.common_name }),
                ...(typeof payload.sub === 'string' && { sub: payload.sub }),
            };
        },
    };
}

/** One verifier per isolate and settings, so that the keys are fetched once, not per request. */
const verifiers = new Map<string, AccessTokenVerifier>();
function cachedVerifier(settings: AccessSettings): AccessTokenVerifier {
    const key = `${settings.teamDomain}\n${settings.audience}`;
    let v = verifiers.get(key);
    if (!v) {
        v = accessVerifier(settings);
        verifiers.set(key, v);
    }
    return v;
}
