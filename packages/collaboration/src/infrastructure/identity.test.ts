// The access identity adapter (ADR 0026, S8) against a local stand-in for Cloudflare: RSA keys made with `node:crypto`,
// a JWKS and `get-identity` served from a local HTTP server, tokens signed here. The verifier (signature, `alg`, `kid`,
// issuer, audience, times, required claims, key rotation, timeouts) and the Identity API (name, fallback, cache, avatar
// rules). The session server in access mode: test/session-access.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Clock } from '../application/ports.js';
import { type AccessAdapterOptions, type AccessSettings, allowedAvatarUrl, createCloudflareAccess, createJwksAccessVerifier } from './identity.js';

const TEAM = 'team.cloudflareaccess.com';
const ISSUER = `https://${TEAM}`;
const AUD = 'a'.repeat(64);
const settings: AccessSettings = { teamDomain: TEAM, audience: AUD, avatarHosts: ['avatars.example.com'] };

interface Key {
    readonly kid: string;
    readonly privateKey: KeyObject;
    readonly publicKey: KeyObject;
}

const newKey = (kid: string): Key => ({ kid, ...generateKeyPairSync('rsa', { modulusLength: 2048 }) });

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A JWT signed with `key` (RS256), or with the header and signature a test chooses. */
function token(payload: Record<string, unknown>, key: Key, header: Record<string, unknown> = { alg: 'RS256', kid: key.kid, typ: 'JWT' }): string {
    const data = `${b64(header)}.${b64(payload)}`;
    return `${data}.${sign('sha256', Buffer.from(data), key.privateKey).toString('base64url')}`;
}

const nowS = (): number => Math.floor(Date.now() / 1000);

/** The claims of a valid application token of `sub`. */
const claims = (sub: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    aud: [AUD],
    email: `${sub}@example.com`,
    exp: nowS() + 600,
    iat: nowS() - 5,
    nbf: nowS() - 5,
    iss: ISSUER,
    type: 'app',
    identity_nonce: 'nonce',
    sub: `${sub}-0000-uuid`,
    country: 'JP',
    ...over,
});

/** A stand-in for the team domain: the JWKS and `get-identity`, with what they answer and how often they were asked. */
interface MockCloudflare {
    readonly url: string;
    keys: Key[];
    /** What `get-identity` answers by `sub`: an identity, a status, or `hang`. */
    identities: Map<string, Record<string, unknown> | number | 'hang'>;
    certsStatus: number | 'hang';
    certsFetches: number;
    identityFetches: number;
    close(): Promise<void>;
}

async function mockCloudflare(keys: Key[]): Promise<MockCloudflare> {
    const hanging: ServerResponse[] = [];
    const mock: Omit<MockCloudflare, 'url' | 'close'> = { keys, identities: new Map(), certsStatus: 200, certsFetches: 0, identityFetches: 0 };
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname;
        if (pathname === '/cdn-cgi/access/certs') {
            mock.certsFetches++;
            if (mock.certsStatus === 'hang') return void hanging.push(res);
            if (mock.certsStatus !== 200) return void res.writeHead(mock.certsStatus).end();
            const jwks = mock.keys.map((k) => ({ ...k.publicKey.export({ format: 'jwk' }), kid: k.kid, alg: 'RS256', use: 'sig' }));
            return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: jwks }));
        }
        if (pathname === '/cdn-cgi/access/get-identity') {
            mock.identityFetches++;
            // the token is the cookie, as Cloudflare documents; its payload names the person (the signature is the verifier's)
            const cookie = /CF_Authorization=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
            const payload: unknown = JSON.parse(Buffer.from(cookie.split('.')[1] ?? '', 'base64url').toString() || '{}');
            const sub = typeof payload === 'object' && payload !== null && 'sub' in payload ? String(payload.sub) : '';
            const answer = mock.identities.get(sub) ?? 404;
            if (answer === 'hang') return void hanging.push(res);
            if (typeof answer === 'number') return void res.writeHead(answer).end();
            return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
        }
        res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- listening on TCP
    const port = (server.address() as AddressInfo).port;
    return Object.assign(mock, {
        url: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise<void>((resolve) => {
                for (const res of hanging) res.destroy();
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    });
}

/** A clock a test moves. */
const testClock = (): Clock & { advance(ms: number): void } => {
    let offset = 0;
    return { now: () => new Date(Date.now() + offset), advance: (ms) => void (offset += ms) };
};

const adapter = (mock: MockCloudflare, over: AccessAdapterOptions = {}): AccessAdapterOptions => ({
    certsUrl: `${mock.url}/cdn-cgi/access/certs`,
    identityUrl: `${mock.url}/cdn-cgi/access/get-identity`,
    timeoutMs: 300,
    ...over,
});

describe('the JWKS verifier', () => {
    const k1 = newKey('k1');
    const k2 = newKey('k2');
    const intruder = newKey('k1');
    let mock: MockCloudflare;
    beforeAll(async () => {
        mock = await mockCloudflare([k1]);
    });
    afterAll(() => mock.close());

    const verifier = (over: AccessAdapterOptions = {}, clock: Clock = testClock()): ReturnType<typeof createJwksAccessVerifier> =>
        createJwksAccessVerifier(settings, clock, adapter(mock, over));

    test('accepts a token of the team and the application, with `aud` a list or a string; the claims are returned', async () => {
        const v = verifier();
        expect(await v.verify(token(claims('ada'), k1))).toEqual(expect.objectContaining({ sub: 'ada-0000-uuid', email: 'ada@example.com', iss: ISSUER }));
        expect(await v.verify(token(claims('ada', { aud: AUD }), k1))).toEqual(expect.objectContaining({ sub: 'ada-0000-uuid' }));
        expect(await v.verify(token(claims('ada', { aud: ['other', AUD] }), k1))).toBeDefined();
    });

    test('refuses expired and not-yet-valid tokens, with a small clock skew', async () => {
        const v = verifier();
        expect(await v.verify(token(claims('ada', { exp: nowS() - 60 }), k1))).toBeUndefined();
        expect(await v.verify(token(claims('ada', { exp: nowS() - 5 }), k1))).toBeDefined();
        expect(await v.verify(token(claims('ada', { nbf: nowS() + 120 }), k1))).toBeUndefined();
        expect(await v.verify(token(claims('ada', { nbf: nowS() + 5 }), k1))).toBeDefined();
        expect(await v.verify(token(claims('ada', { iat: nowS() + 120 }), k1))).toBeUndefined();
        expect(await v.verify(token(claims('ada', { exp: undefined }), k1))).toBeUndefined();
        expect(await v.verify(token(claims('ada', { exp: String(nowS() + 600) }), k1))).toBeUndefined();
        // the clock is the server's
        const late = testClock();
        late.advance(3600_000);
        expect(await verifier({}, late).verify(token(claims('ada'), k1))).toBeUndefined();
    });

    test('refuses another audience, another issuer, and tokens without `sub` or `email`', async () => {
        const v = verifier();
        for (const over of [
            { aud: ['another'] },
            { aud: 'another' },
            { aud: [] },
            { aud: [1] },
            { iss: 'https://evil.cloudflareaccess.com' },
            { iss: `${ISSUER}/` },
            { iss: `http://${TEAM}` },
            { sub: undefined },
            { sub: '' },
            { email: undefined },
        ]) {
            expect([over, await v.verify(token(claims('ada', over), k1))]).toEqual([over, undefined]);
        }
    });

    test('refuses a wrong signature, a changed payload, and anything but a three-part token', async () => {
        const v = verifier();
        expect(await v.verify(token(claims('ada'), intruder))).toBeUndefined();
        const [h, , s] = token(claims('ada'), k1).split('.');
        expect(await v.verify(`${h}.${b64(claims('eve'))}.${s}`)).toBeUndefined();
        expect(await v.verify(`${h}.${b64(claims('ada'))}.`)).toBeUndefined();
        for (const t of ['', 'abc', 'a.b', 'a.b.c.d', `${token(claims('ada'), k1)}x!`, 'x'.repeat(9000)]) expect(await v.verify(t)).toBeUndefined();
    });

    test('refuses `alg` confusion: none, HS256 keyed with the public key, RS512, a missing `kid`, a `crit` header', async () => {
        const v = verifier();
        const payload = b64(claims('ada'));
        expect(await v.verify(`${b64({ alg: 'none', kid: 'k1' })}.${payload}.`)).toBeUndefined();
        expect(await v.verify(`${b64({ alg: 'none', kid: 'k1' })}.${payload}.AAAA`)).toBeUndefined();
        const pem = k1.publicKey.export({ format: 'pem', type: 'spki' });
        const hsData = `${b64({ alg: 'HS256', kid: 'k1' })}.${payload}`;
        expect(await v.verify(`${hsData}.${createHmac('sha256', pem).update(hsData).digest('base64url')}`)).toBeUndefined();
        expect(await v.verify(token(claims('ada'), k1, { alg: 'RS512', kid: 'k1' }))).toBeUndefined();
        expect(await v.verify(token(claims('ada'), k1, { alg: 'RS256' }))).toBeUndefined();
        expect(await v.verify(token(claims('ada'), k1, { alg: 'RS256', kid: 'k1', crit: ['exp'] }))).toBeUndefined();
        // the header's key URLs are never followed
        expect(await v.verify(token(claims('ada'), intruder, { alg: 'RS256', kid: 'k1', jku: `${mock.url}/evil` }))).toBeUndefined();
    });

    test('an unknown `kid` fetches the keys again, at most once per interval; rotation keeps working', async () => {
        mock.keys = [k1];
        const clock = testClock();
        const v = verifier({ minRefetchMs: 10_000 }, clock);
        const before = mock.certsFetches;
        expect(await v.verify(token(claims('ada'), k1))).toBeDefined();
        expect(mock.certsFetches - before).toBe(1);
        // a token of a key not published (yet): one fetch, then none within the interval
        expect(await v.verify(token(claims('ada'), k2))).toBeUndefined();
        clock.advance(10_000);
        expect(await v.verify(token(claims('ada'), k2))).toBeUndefined();
        expect(await v.verify(token(claims('ada'), k2))).toBeUndefined();
        expect(mock.certsFetches - before).toBe(2);
        // Cloudflare rotates: k2 is published beside k1; after the interval the unknown kid is fetched again
        mock.keys = [k2, k1];
        expect(await v.verify(token(claims('ada'), k2))).toBeUndefined();
        clock.advance(10_000);
        expect(await v.verify(token(claims('ada'), k2))).toBeDefined();
        expect(await v.verify(token(claims('ada'), k1))).toBeDefined();
        expect(mock.certsFetches - before).toBe(3);
        // k1 is withdrawn: once the keys are old, they are fetched again and k1 no longer verifies
        mock.keys = [k2];
        clock.advance(60 * 60_000);
        const later = { exp: nowS() + 7200 };
        expect(await v.verify(token(claims('ada', later), k1))).toBeUndefined();
        expect(await v.verify(token(claims('ada', later), k2))).toBeDefined();
        mock.keys = [k1];
    });

    test('concurrent tokens share one fetch; a failed or slow JWKS is told without the token and keeps the keys known', async () => {
        const lines: string[] = [];
        const clock = testClock();
        const v = verifier({ minRefetchMs: 0, maxKeyAgeMs: 1000, log: (l) => lines.push(l) }, clock);
        const before = mock.certsFetches;
        const t = token(claims('ada'), k1);
        expect((await Promise.all([v.verify(t), v.verify(t), v.verify(t)])).every(Boolean)).toBe(true);
        expect(mock.certsFetches - before).toBe(1);
        clock.advance(2000);
        mock.certsStatus = 500;
        expect(await v.verify(t)).toBeDefined();
        mock.certsStatus = 'hang';
        clock.advance(2000);
        const started = Date.now();
        expect(await v.verify(t)).toBeDefined();
        expect(Date.now() - started).toBeLessThan(2000);
        mock.certsStatus = 200;
        expect(lines.length).toBe(2);
        expect(lines.join('\n')).toContain('keeping the keys known');
        expect(lines.join('\n')).not.toContain(t.split('.')[1]);
        expect(lines.join('\n')).not.toContain('@');

        mock.certsStatus = 500;
        const cold = verifier({ log: (l) => lines.push(l) });
        expect(await cold.refresh()).toBe(false);
        expect(await cold.verify(t)).toBeUndefined();
        mock.certsStatus = 200;
    });

    test('skips keys that are not RSA signing keys of 2048 bits or more', async () => {
        const small = { kid: 'small', ...generateKeyPairSync('rsa', { modulusLength: 1024 }) };
        const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const server = createServer((_req, res) => {
            const keys = [
                { ...small.publicKey.export({ format: 'jwk' }), kid: 'small' },
                { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec' },
                { ...k1.publicKey.export({ format: 'jwk' }), kid: 'enc', use: 'enc' },
                { ...k1.publicKey.export({ format: 'jwk' }), kid: 'ps', alg: 'PS256' },
                { kty: 'RSA', kid: 'broken', n: 'AQAB', e: 'AQAB' },
            ];
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys }));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- listening on TCP
            const certsUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
            const v = createJwksAccessVerifier(settings, testClock(), { certsUrl, log: () => {} });
            expect(await v.refresh()).toBe(false);
            expect(await v.verify(token(claims('ada'), small))).toBeUndefined();
            for (const kid of ['enc', 'ps']) expect(await v.verify(token(claims('ada'), k1, { alg: 'RS256', kid }))).toBeUndefined();
        } finally {
            server.closeAllConnections();
            server.close();
        }
    });
});

describe('the Identity API and the identity', () => {
    const k1 = newKey('k1');
    let mock: MockCloudflare;
    beforeAll(async () => {
        mock = await mockCloudflare([k1]);
    });
    afterAll(() => mock.close());

    test('the name and the avatar come from get-identity, asked once per subject while cached', async () => {
        mock.identities.set('ada-0000-uuid', {
            name: ' Ada Lovelace ',
            email: 'ada@example.com',
            picture: 'https://avatars.example.com/ada.png',
            idp: { type: 'google' },
        });
        const { provider } = createCloudflareAccess(settings, testClock(), adapter(mock));
        const before = mock.identityFetches;
        const t = token(claims('ada'), k1);
        const [a, b] = await Promise.all([provider.verify(t), provider.verify(t)]);
        expect(a).toEqual({
            provider: 'access',
            subject: 'ada-0000-uuid',
            displayName: 'Ada Lovelace',
            email: 'ada@example.com',
            avatarUrl: 'https://avatars.example.com/ada.png',
            expiresAt: expect.any(Date),
        });
        expect(b).toEqual(a);
        expect(await provider.verify(t)).toEqual(a);
        expect(mock.identityFetches - before).toBe(1);
    });

    test('a failing, slow or redirecting Identity API falls back to the e-mail’s local part, told without the token or e-mail', async () => {
        const lines: string[] = [];
        const { provider } = createCloudflareAccess(settings, testClock(), adapter(mock, { log: (l) => lines.push(l) }));
        mock.identities.set('bob-0000-uuid', 500);
        mock.identities.set('cy-0000-uuid', 'hang');
        mock.identities.set('di-0000-uuid', 302);
        for (const [who, name] of [
            ['bob', 'bob'],
            ['cy', 'cy'],
            ['di', 'di'],
            ['eve', 'eve'],
        ]) {
            const identity = await provider.verify(token(claims(who), k1));
            expect([who, identity?.displayName, identity?.avatarUrl]).toEqual([who, name, undefined]);
        }
        expect(lines.length).toBe(4);
        expect(lines.join('\n')).not.toContain('@');
        expect(lines.join('\n')).not.toContain('eyJ');
    });

    test('an avatar only when https, without credentials or port, on an allowed host; else initials (none)', () => {
        const hosts = ['avatars.example.com'];
        expect(allowedAvatarUrl('https://avatars.example.com/a.png?s=64', hosts)).toBe('https://avatars.example.com/a.png?s=64');
        expect(allowedAvatarUrl('https://AVATARS.example.com/a.png', hosts)).toBe('https://avatars.example.com/a.png');
        for (const raw of [
            'http://avatars.example.com/a.png',
            'https://evil.example.com/a.png',
            'https://avatars.example.com.evil.example/a.png',
            'https://user:pw@avatars.example.com/a.png',
            'https://avatars.example.com:8443/a.png',
            'data:image/png;base64,AAAA',
            'javascript:alert(1)',
            '/relative.png',
            `https://avatars.example.com/${'a'.repeat(2100)}`,
        ]) {
            expect([raw, allowedAvatarUrl(raw, hosts)]).toEqual([raw, undefined]);
        }
        expect(allowedAvatarUrl('https://avatars.example.com/a.png', [])).toBeUndefined();
    });

    test('the OIDC picture claim is used too; a picture of another host is dropped', async () => {
        mock.identities.set('fay-0000-uuid', { name: 'Fay', oidc_fields: { picture: 'https://avatars.example.com/fay.png' } });
        mock.identities.set('gus-0000-uuid', { name: 'Gus', picture: 'https://tracker.example.net/gus.png' });
        const { provider } = createCloudflareAccess(settings, testClock(), adapter(mock));
        expect((await provider.verify(token(claims('fay'), k1)))?.avatarUrl).toBe('https://avatars.example.com/fay.png');
        const gus = await provider.verify(token(claims('gus'), k1));
        expect([gus?.displayName, gus?.avatarUrl]).toEqual(['Gus', undefined]);
    });
});
