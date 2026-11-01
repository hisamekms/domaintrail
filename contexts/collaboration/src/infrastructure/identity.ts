// The `access` identity mode (ADR 0026): a Cloudflare Access token (the `Cf-Access-Jwt-Assertion` header, or the
// `CF_Authorization` cookie when configured) proves an identity. The token is an RS256 JWT signed by the team's keys,
// published as a JWKS at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`; its `iss` is the team domain's
// URL and its `aud` the application's AUD tag. The display name and the picture come from the Identity API
// (`/cdn-cgi/access/get-identity`), asked server-side with the token. Only `node:crypto` and `fetch`: no JWT library.
// Nothing here logs a token or an e-mail.
//
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/application-token/
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import type { Identity, IdentityProvider } from '../application/identity.js';
import type { Clock } from '../application/ports.js';

/** The claims of an Access token whose signature holds (the ones this adapter reads). */
export interface AccessClaims {
    readonly iss: string;
    readonly aud: string | readonly string[];
    /** The user's ID, unique to an e-mail address per account. */
    readonly sub: string;
    /** Seconds since the epoch. */
    readonly exp: number;
    readonly nbf?: number;
    readonly iat?: number;
    readonly email?: string;
    /** Not in Cloudflare's tokens; a name a test (or a custom claim) gives. The Identity API's `name` comes first. */
    readonly name?: string;
}

/** Checks a token's signature with the team's keys; its claims, or `undefined` when it is not a token signed by them. */
export interface AccessTokenVerifier {
    verify(token: string): Promise<AccessClaims | undefined>;
}

export interface AccessSettings {
    /** `<team>.cloudflareaccess.com` (or with `https://`): the issuer of the tokens. */
    readonly teamDomain: string;
    /** The application's audience tag (AUD). */
    readonly audience: string;
    /** Hosts an avatar URL may point to (`https` only). Default: none, the page shows initials. */
    readonly avatarHosts?: readonly string[];
}

/** Where the adapter reaches Cloudflare, and its timings: the team domain's endpoints unless a test points elsewhere. */
export interface AccessAdapterOptions {
    /** The JWKS. Default: `https://<teamDomain>/cdn-cgi/access/certs`. */
    readonly certsUrl?: string;
    /** The Identity API, or `false` for none (the name is then the e-mail's local part). Default: `https://<teamDomain>/cdn-cgi/access/get-identity`. */
    readonly identityUrl?: string | false;
    /** The clock skew allowed on `exp`, `nbf` and `iat`, in seconds. Default: `CLOCK_SKEW_S`. */
    readonly clockSkewS?: number;
    /** The shortest time between two fetches of the JWKS (an unknown `kid` asks again). Default: 30 s. */
    readonly minRefetchMs?: number;
    /** How long fetched keys are used before they are fetched again. Default: 1 h. */
    readonly maxKeyAgeMs?: number;
    /** How long the JWKS and the Identity API may take. Default: 5 s. */
    readonly timeoutMs?: number;
    /** How long a profile from the Identity API is kept, per subject. Default: 5 min (a failure: at most 1 min). */
    readonly profileTtlMs?: number;
    readonly fetch?: typeof fetch;
    /** Where failures of the JWKS and the Identity API are told (never with a token or an e-mail). */
    readonly log?: (line: string) => void;
}

/** The clock skew allowed by default on the token's times, in seconds. */
export const CLOCK_SKEW_S = 30;
/** Largest token accepted (a JWT of Access is about 1 kB). */
const MAX_TOKEN = 8192;
/** Largest JWKS or identity read. */
const MAX_RESPONSE = 256 * 1024;
/** Smallest RSA modulus accepted. */
const MIN_MODULUS_BITS = 2048;
/** Most profiles kept at once (the oldest go first). */
const MAX_PROFILES = 1000;
/** Longest display name made from an identity (the join form allows 60 characters). */
const MAX_NAME = 60;

/** The issuer of the team's tokens: `https://<teamDomain>` without a trailing slash. */
export const accessIssuer = (teamDomain: string): string => (teamDomain.startsWith('https://') ? teamDomain : `https://${teamDomain}`).replace(/\/+$/, '');
/** The team's signing keys (JWKS). */
export const accessCertsUrl = (teamDomain: string): string => `${accessIssuer(teamDomain)}/cdn-cgi/access/certs`;
/** The team's Identity API. */
export const accessIdentityUrl = (teamDomain: string): string => `${accessIssuer(teamDomain)}/cdn-cgi/access/get-identity`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((a) => typeof a === 'string');

/**
 * The claims of a token's payload when they hold at `nowMs`: `iss` is the team's, `aud` (a string or a list) names the
 * application, `exp` is after now and `nbf` and `iat` not after it (each within `skewS`), `sub` and `email` are there.
 */
export function checkAccessClaims(payload: unknown, settings: AccessSettings, nowMs: number, skewS: number = CLOCK_SKEW_S): AccessClaims | undefined {
    if (!isObject(payload)) return undefined;
    const { iss, aud, sub, exp, nbf, iat, email, name } = payload;
    if (typeof iss !== 'string' || iss !== accessIssuer(settings.teamDomain)) return undefined;
    const audiences = typeof aud === 'string' ? [aud] : isStrings(aud) ? aud : [];
    if (!audiences.includes(settings.audience)) return undefined;
    const now = nowMs / 1000;
    if (!isTime(exp) || !(now < exp + skewS)) return undefined;
    if (nbf !== undefined && (!isTime(nbf) || now < nbf - skewS)) return undefined;
    if (iat !== undefined && (!isTime(iat) || iat > now + skewS)) return undefined;
    if (!nonEmpty(sub) || !nonEmpty(email)) return undefined;
    return {
        iss,
        aud: audiences,
        sub,
        exp,
        email,
        ...(nbf !== undefined && { nbf }),
        ...(iat !== undefined && { iat }),
        ...(nonEmpty(name) && { name }),
    };
}

/** The JSON of a base64url segment, or `undefined` when it is not JSON. */
function segment(part: string): unknown {
    try {
        return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    } catch {
        return undefined;
    }
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Reads a response's body (up to `MAX_RESPONSE` bytes) as JSON. */
async function readJson(res: Response): Promise<unknown> {
    const text = await res.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE) throw new Error(`response larger than ${MAX_RESPONSE} bytes`);
    return JSON.parse(text);
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The public keys of a JWKS by `kid`: RSA signing keys of at least 2048 bits, for RS256; anything else is skipped. */
export function jwksKeys(jwks: unknown): Map<string, KeyObject> {
    const keys = new Map<string, KeyObject>();
    if (!isObject(jwks) || !Array.isArray(jwks.keys)) return keys;
    for (const jwk of jwks.keys) {
        if (!isObject(jwk) || jwk.kty !== 'RSA' || !nonEmpty(jwk.kid) || !nonEmpty(jwk.n) || !nonEmpty(jwk.e)) continue;
        if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
        if (jwk.use !== undefined && jwk.use !== 'sig') continue;
        const key = publicKey(jwk.n, jwk.e);
        if (key && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= MIN_MODULUS_BITS) keys.set(jwk.kid, key);
    }
    return keys;
}

/** The RSA public key of a JWK's modulus and exponent; `undefined` when they are not one (the key is then skipped). */
function publicKey(n: string, e: string): KeyObject | undefined {
    try {
        return createPublicKey({ key: { kty: 'RSA', n, e }, format: 'jwk' });
    } catch {
        return undefined;
    }
}

/** The JWKS verifier, with a way to fetch the keys ahead of the first token (at startup). */
export interface JwksAccessVerifier extends AccessTokenVerifier {
    /** Fetches the keys now; false (and told to `log`) when they could not be. */
    refresh(): Promise<boolean>;
}

/**
 * Verifies Access tokens with the team's JWKS: the header is `{"alg":"RS256","kid":…}` (`none`, `HS256` and any other
 * algorithm are refused, as is a `crit` header; `jku`/`x5u` are never followed), the claims hold
 * (`checkAccessClaims`), the key is the JWKS's key of that `kid`, and the RS256 signature holds. The keys are cached:
 * fetched on first use, again after `maxKeyAgeMs`, and again for an unknown `kid` (key rotation) at most every
 * `minRefetchMs`; a failed fetch keeps the keys known.
 */
export function createJwksAccessVerifier(settings: AccessSettings, clock: Clock, options: AccessAdapterOptions = {}): JwksAccessVerifier {
    const url = options.certsUrl ?? accessCertsUrl(settings.teamDomain);
    const doFetch = options.fetch ?? fetch;
    const timeoutMs = options.timeoutMs ?? 5000;
    const minRefetchMs = options.minRefetchMs ?? 30_000;
    const maxKeyAgeMs = options.maxKeyAgeMs ?? 60 * 60_000;
    const skewS = options.clockSkewS ?? CLOCK_SKEW_S;
    const log = options.log ?? (() => {});

    let keys = new Map<string, KeyObject>();
    let fetchedAt = -Infinity;
    let attemptedAt = -Infinity;
    let inflight: Promise<boolean> | undefined;

    const fetchKeys = async (): Promise<boolean> => {
        attemptedAt = clock.now().getTime();
        try {
            const res = await doFetch(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const fresh = jwksKeys(await readJson(res));
            if (!fresh.size) throw new Error('no RS256 key in the JWKS');
            keys = fresh;
            fetchedAt = clock.now().getTime();
            return true;
        } catch (e) {
            log(`Cloudflare Access keys could not be fetched (${message(e)}); ${keys.size ? 'keeping the keys known' : 'no token can be verified yet'}`);
            return false;
        }
    };
    const load = (): Promise<boolean> => (inflight ??= fetchKeys().finally(() => (inflight = undefined)));

    const keyFor = async (kid: string): Promise<KeyObject | undefined> => {
        const now = clock.now().getTime();
        if (inflight) await inflight;
        else if ((now - fetchedAt >= maxKeyAgeMs || !keys.has(kid)) && now - attemptedAt >= minRefetchMs) await load();
        return keys.get(kid);
    };

    return {
        refresh: load,
        async verify(token) {
            if (!token || token.length > MAX_TOKEN) return undefined;
            const parts = token.split('.');
            if (parts.length !== 3 || !parts.every((p) => BASE64URL.test(p))) return undefined;
            const [h, p, s] = parts;
            const header = segment(h);
            if (!isObject(header) || header.alg !== 'RS256' || !nonEmpty(header.kid) || header.crit !== undefined) return undefined;
            // the claims first: a token of another team or application never makes the keys be fetched again
            const claims = checkAccessClaims(segment(p), settings, clock.now().getTime(), skewS);
            if (!claims) return undefined;
            const key = await keyFor(header.kid);
            if (!key) return undefined;
            return verifySignature('sha256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url')) ? claims : undefined;
        },
    };
}

/** What the Identity API tells of a person, as far as a session uses it. */
export interface AccessProfile {
    readonly name?: string;
    readonly picture?: string;
}

/** The Identity API (`get-identity`), asked with the person's token. */
export interface AccessIdentityApi {
    /** The profile of `subject` (cached per subject); `undefined` when the API did not answer. */
    profile(token: string, subject: string): Promise<AccessProfile | undefined>;
}

/** The name and the picture of a `get-identity` answer: `name`; `picture`, else the OIDC claim `oidc_fields.picture`. */
export function profileOf(identity: unknown): AccessProfile {
    if (!isObject(identity)) return {};
    const oidc = isObject(identity.oidc_fields) ? identity.oidc_fields : {};
    const picture = [identity.picture, oidc.picture].find(nonEmpty);
    return { ...(nonEmpty(identity.name) && { name: identity.name.trim() }), ...(picture !== undefined && { picture }) };
}

/**
 * The Identity API at `url`, asked with the token as the `CF_Authorization` cookie, as Cloudflare documents. A profile
 * is kept per subject for `profileTtlMs`; a failure (timeout, an answer other than 200, not JSON) for at most a
 * minute, so a person is not asked for on every request while the API is down.
 */
export function createAccessIdentityApi(url: string, clock: Clock, options: AccessAdapterOptions = {}): AccessIdentityApi {
    const doFetch = options.fetch ?? fetch;
    const timeoutMs = options.timeoutMs ?? 5000;
    const ttlMs = options.profileTtlMs ?? 5 * 60_000;
    const failureTtlMs = Math.min(ttlMs, 60_000);
    const log = options.log ?? (() => {});
    const cache = new Map<string, { readonly profile: AccessProfile | undefined; readonly until: number }>();
    const inflight = new Map<string, Promise<AccessProfile | undefined>>();

    const ask = async (token: string): Promise<AccessProfile | undefined> => {
        try {
            const res = await doFetch(url, {
                headers: { cookie: `CF_Authorization=${token}`, accept: 'application/json' },
                // Access answers an unknown token with a redirect to its login page
                redirect: 'manual',
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
            return profileOf(await readJson(res));
        } catch (e) {
            log(`the Cloudflare Access identity could not be read (${message(e)}); the name falls back to the e-mail's local part`);
            return undefined;
        }
    };

    const remember = (subject: string, profile: AccessProfile | undefined): AccessProfile | undefined => {
        inflight.delete(subject);
        cache.delete(subject);
        cache.set(subject, { profile, until: clock.now().getTime() + (profile ? ttlMs : failureTtlMs) });
        for (const oldest of cache.keys()) {
            if (cache.size <= MAX_PROFILES) break;
            cache.delete(oldest);
        }
        return profile;
    };

    return {
        async profile(token, subject) {
            const cached = cache.get(subject);
            if (cached && cached.until > clock.now().getTime()) return cached.profile;
            const pending = inflight.get(subject);
            if (pending) return pending;
            const asked = ask(token).then((profile) => remember(subject, profile));
            inflight.set(subject, asked);
            return asked;
        },
    };
}

/** An avatar URL the page may show: `https`, no credentials, the default port, a host of `hosts`; else `undefined`. */
export function allowedAvatarUrl(raw: string | undefined, hosts: readonly string[]): string | undefined {
    if (!raw || raw.length > 2048 || !hosts.length || !URL.canParse(raw)) return undefined;
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    return hosts.some((h) => h.toLowerCase() === url.hostname) ? url.href : undefined;
}

/** The display name of an identity: the Identity API's name, a `name` claim, else the e-mail's local part. */
function displayNameOf(profile: AccessProfile | undefined, claims: AccessClaims): string {
    const local = claims.email?.split('@')[0]?.trim();
    const name = profile?.name || claims.name?.trim() || local || 'Participant';
    return name.slice(0, MAX_NAME);
}

/**
 * The `access` identity provider: the verifier's claims (checked here again, so a stand-in verifier is held to them
 * too), then the profile of the Identity API for the name and the avatar. The identity holds until `exp` plus the skew.
 */
export function createAccessIdentityProvider(
    settings: AccessSettings,
    verifier: AccessTokenVerifier,
    clock: Clock,
    options: { readonly identityApi?: AccessIdentityApi; readonly clockSkewS?: number } = {},
): IdentityProvider {
    const skewS = options.clockSkewS ?? CLOCK_SKEW_S;
    return {
        mode: 'access',
        async verify(token) {
            if (!token || token.length > MAX_TOKEN) return undefined;
            const claims = checkAccessClaims(await verifier.verify(token), settings, clock.now().getTime(), skewS);
            if (!claims) return undefined;
            const profile = await options.identityApi?.profile(token, claims.sub);
            const avatarUrl = allowedAvatarUrl(profile?.picture, settings.avatarHosts ?? []);
            const identity: Identity = {
                provider: 'access',
                subject: claims.sub,
                displayName: displayNameOf(profile, claims),
                ...(claims.email && { email: claims.email }),
                ...(avatarUrl && { avatarUrl }),
                expiresAt: new Date((claims.exp + skewS) * 1000),
            };
            return identity;
        },
    };
}

/** The `access` mode against Cloudflare: its identity provider, and whether the team's keys could be fetched at start. */
export interface CloudflareAccess {
    readonly provider: IdentityProvider;
    readonly ready: Promise<boolean>;
}

/** The JWKS verifier (unless a stand-in `verifier` is given, for tests) and the Identity API, as a provider. */
export function createCloudflareAccess(
    settings: AccessSettings,
    clock: Clock,
    options: AccessAdapterOptions & { readonly verifier?: AccessTokenVerifier } = {},
): CloudflareAccess {
    const identityUrl = options.identityUrl ?? accessIdentityUrl(settings.teamDomain);
    const identityApi = identityUrl === false ? undefined : createAccessIdentityApi(identityUrl, clock, options);
    const providerOf = (verifier: AccessTokenVerifier): IdentityProvider =>
        createAccessIdentityProvider(settings, verifier, clock, {
            ...(identityApi && { identityApi }),
            ...(options.clockSkewS !== undefined && { clockSkewS: options.clockSkewS }),
        });
    if (options.verifier) return { provider: providerOf(options.verifier), ready: Promise.resolve(true) };
    const jwks = createJwksAccessVerifier(settings, clock, options);
    return { provider: providerOf(jwks), ready: jwks.refresh() };
}

/** A verifier that knows a fixed set of tokens and their claims: a stand-in for the JWKS check, for tests. */
export function createMockAccessVerifier(tokens: ReadonlyMap<string, AccessClaims>): AccessTokenVerifier {
    return { verify: async (token) => tokens.get(token) };
}
