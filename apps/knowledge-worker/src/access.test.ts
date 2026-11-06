// Who calls: the Access token verified with the team's keys (a local stand-in of the JWKS), a person by its e-mail and a
// service token by its Client ID, and which service tokens may write.
import { beforeAll, describe, expect, test } from 'bun:test';
import { accessVerifier, identify, mayWrite, type AccessSettings } from './access.js';
import type { Env } from './env.js';

const settings: AccessSettings = { teamDomain: 'team.cloudflareaccess.com', audience: 'aud-1' };
const ISSUER = 'https://team.cloudflareaccess.com';
const now = Date.parse('2026-11-05T09:00:00Z');

let privateKey: CryptoKey;
let jwks: unknown;
let certFetches = 0;
const certs = (async (input: RequestInfo | URL): Promise<Response> => {
    expect(input instanceof Request ? input.url : input.toString()).toBe(`${ISSUER}/cdn-cgi/access/certs`);
    certFetches++;
    return Response.json(jwks);
}) as typeof fetch;

beforeAll(async () => {
    const pair = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
    );
    privateKey = pair.privateKey;
    jwks = { keys: [{ ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };
});

const b64url = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
const part = (v: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(v)));

async function token(claims: Record<string, unknown>, kid = 'k1'): Promise<string> {
    const signed = `${part({ alg: 'RS256', kid, typ: 'JWT' })}.${part({ iss: ISSUER, aud: ['aud-1'], exp: now / 1000 + 600, iat: now / 1000, ...claims })}`;
    const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(signed)));
    return `${signed}.${b64url(signature)}`;
}

describe('the Access token', () => {
    const verifier = accessVerifier(settings, { fetch: certs, now: () => now });

    test("verifies a person's and a service token's, and fetches the keys once", async () => {
        expect(await verifier.verify(await token({ email: 'a@example.com', sub: 'u1' }))).toEqual({ email: 'a@example.com', sub: 'u1' });
        expect(await verifier.verify(await token({ common_name: 'abc.access', sub: '' }))).toEqual({ common_name: 'abc.access', sub: '' });
        expect(certFetches).toBe(1);
    });

    test('refuses another audience, another issuer, an expired token, an unknown key and a tampered payload', async () => {
        expect(await verifier.verify(await token({ email: 'a@example.com', aud: ['other'] }))).toBeUndefined();
        expect(await verifier.verify(await token({ email: 'a@example.com', iss: 'https://evil.cloudflareaccess.com' }))).toBeUndefined();
        expect(await verifier.verify(await token({ email: 'a@example.com', exp: now / 1000 - 120 }))).toBeUndefined();
        expect(await verifier.verify(await token({ email: 'a@example.com' }, 'k2'))).toBeUndefined();
        const [h, , s] = (await token({ email: 'a@example.com' })).split('.');
        expect(await verifier.verify(`${h}.${part({ iss: ISSUER, aud: 'aud-1', exp: now / 1000 + 600, email: 'b@example.com' })}.${s}`)).toBeUndefined();
        expect(await verifier.verify('not a token')).toBeUndefined();
    });
});

describe('the caller', () => {
    const env = (vars: Partial<Env>): Env => ({ DB: undefined as never, IMAGES: undefined as never, ...vars });
    const request = (headers: Record<string, string>): Request => new Request('https://knowledge.example.com/v1/health', { headers });
    const verifier = (): ReturnType<typeof accessVerifier> => accessVerifier(settings, { fetch: certs, now: () => now });
    const configured = env({ ACCESS_TEAM_DOMAIN: settings.teamDomain, ACCESS_AUD: settings.audience });

    test('comes from the verified token when Access is configured, never from the plain headers', async () => {
        const person = await token({ email: 'a@example.com' });
        expect(await identify(request({ 'Cf-Access-Jwt-Assertion': person }), configured, verifier)).toEqual({ kind: 'person', email: 'a@example.com' });
        const service = await token({ common_name: 'abc.access' });
        expect(await identify(request({ 'Cf-Access-Jwt-Assertion': service }), configured, verifier)).toEqual({ kind: 'service', clientId: 'abc.access' });
        expect(await identify(request({ 'Cf-Access-Authenticated-User-Email': 'a@example.com' }), configured, verifier)).toMatchObject({ status: 401 });
        expect(await identify(request({ 'Cf-Access-Jwt-Assertion': `${person}x` }), configured, verifier)).toMatchObject({ status: 401 });
    });

    test('comes from the headers only when the check is explicitly skipped, and nowhere without settings', async () => {
        const skipped = env({ INSECURE_SKIP_ACCESS_CHECK: 'true' });
        expect(await identify(request({ 'CF-Access-Client-Id': 'abc.access' }), skipped)).toEqual({ kind: 'service', clientId: 'abc.access' });
        expect(await identify(request({ 'CF-Access-Client-Id': 'abc.access' }), env({}))).toMatchObject({ status: 500 });
    });

    test('a person may write, a service token only when listed', () => {
        const writers = env({ WRITER_TOKENS: ' abc.access ,def.access' });
        expect(mayWrite({ kind: 'person', email: 'a@example.com' }, writers)).toBe(true);
        expect(mayWrite({ kind: 'service', clientId: 'abc.access' }, writers)).toBe(true);
        expect(mayWrite({ kind: 'service', clientId: 'xyz.access' }, writers)).toBe(false);
        expect(mayWrite({ kind: 'service', clientId: 'abc.access' }, env({}))).toBe(false);
    });
});
