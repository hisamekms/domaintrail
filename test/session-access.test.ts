/**
 * The `access` identity mode (ADR 0026, S8) against a local stand-in for Cloudflare: RSA keys made with `node:crypto`,
 * a JWKS and `get-identity` served from a local HTTP server, tokens signed here. The verifier (signature, `alg`, `kid`,
 * issuer, audience, times, required claims, key rotation, timeouts), the Identity API (name, fallback, cache, avatar
 * rules), and the session server in access mode (no identity, no answer; roles; Host and Origin; e-mail never sent;
 * pages closed at the token's expiry and on leaving).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { Clock } from '@domaintrail/collaboration/application/ports';
import {
    allowedAvatarUrl,
    createCloudflareAccess,
    createJwksAccessVerifier,
    type AccessAdapterOptions,
    type AccessSettings,
} from '@domaintrail/collaboration/infrastructure/identity';
import type { Me } from '@domaintrail/collaboration/protocol';
import { cliDeps } from '@domaintrail/composition/cli';
import { startSessionServer, WS_EXPIRED, WS_REVOKED, type SessionServer, type SessionServerOptions } from '@domaintrail/composition/session';
import { DEFAULT_AGENT_TOOLS, type ResolvedSessionConfig } from '@domaintrail/modeling/core/config';
import { runCli } from '@domaintrail/presentation/cli/main';
import { SessionError } from '@domaintrail/presentation/cli/ports';

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

// --- the session server in access mode -------------------------------------------------------------------------------

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
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-session-access-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'shop.dt'), DT);
    await writeFile(path.join(dir, 'ordering.dtes'), 'storming Ordering {\n  event OrderOpened\n}\n');
    return dir;
}

type AccessConfig = NonNullable<ResolvedSessionConfig['access']>;

const accessConfig = (over: Partial<AccessConfig> = {}): AccessConfig => ({
    teamDomain: TEAM,
    audience: AUD,
    publicUrl: 'https://session.example.com',
    allowedHosts: ['session.example.com'],
    allowedOrigins: ['https://session.example.com'],
    acceptCookie: false,
    avatarHosts: ['avatars.example.com'],
    ...over,
});

const sessionConfig = (access: AccessConfig): ResolvedSessionConfig => ({
    port: 0,
    host: '127.0.0.1',
    identity: 'access',
    access,
    agent: { port: 0, allowedTools: [...DEFAULT_AGENT_TOOLS] },
    maxParticipants: 50,
});

const failure = (p: Promise<unknown>): Promise<unknown> =>
    p.then(
        () => undefined,
        (e: unknown) => e,
    );

interface Socket {
    received: { type: string; [k: string]: unknown }[];
    ws: WebSocket;
    closed: Promise<number>;
}

async function socket(server: SessionServer, headers: Record<string, string>): Promise<Socket> {
    const ws = new WebSocket(server.url.replace('http', 'ws') + 'ws', { headers } as never);
    const received: Socket['received'] = [];
    ws.onmessage = (ev) => received.push(JSON.parse(ev.data as string));
    const closed = new Promise<number>((resolve) => (ws.onclose = (ev) => resolve(ev.code)));
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });
    return { ws, received, closed };
}

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

const until = async (check: () => boolean, timeoutMs = 3000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out');
        await Bun.sleep(10);
    }
};

describe('a session in access mode (against a mock of Cloudflare)', () => {
    const k1 = newKey('k1');
    let mock: MockCloudflare;
    let root: string;
    let server: SessionServer;
    const lines: string[] = [];
    const header = (who: string, over: Record<string, unknown> = {}): Record<string, string> => ({ 'Cf-Access-Jwt-Assertion': token(claims(who, over), k1) });
    const start = (over: Partial<SessionServerOptions> = {}): Promise<SessionServer> =>
        startSessionServer({
            root,
            debounceMs: 30,
            session: sessionConfig(accessConfig()),
            accessAdapter: adapter(mock, { clockSkewS: 0 }),
            log: (l) => lines.push(l),
            ...over,
        });

    beforeAll(async () => {
        mock = await mockCloudflare([k1]);
        mock.identities.set('ada-0000-uuid', { name: 'Ada Lovelace', email: 'ada@example.com', picture: 'https://avatars.example.com/ada.png' });
        mock.identities.set('bob-0000-uuid', 503);
        root = await workspace();
        server = await start();
        await server.ready;
    });
    afterAll(async () => {
        await server?.stop();
        await mock.close();
    });

    test('dt session start runs the access mode now, and refuses a publicUrl the hosts and origins do not allow', async () => {
        expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);
        for (const access of [
            accessConfig({ publicUrl: 'http://session.example.com' }),
            accessConfig({ allowedHosts: [] }),
            accessConfig({ allowedOrigins: ['https://other.example.com'] }),
            accessConfig({ audience: ' ' }),
        ]) {
            expect(await failure(startSessionServer({ root, session: sessionConfig(access), accessAdapter: adapter(mock) }))).toBeInstanceOf(SessionError);
        }
        const dir = await workspace();
        await writeFile(
            path.join(dir, 'domaintrail.json'),
            JSON.stringify({ session: { identity: 'access', access: { teamDomain: TEAM, audience: AUD, publicUrl: 'https://session.example.com' } } }),
        );
        const out: string[] = [];
        const err: string[] = [];
        const code = await runCli(['-r', dir, 'session', 'start', '--port', '0'], { out: (l) => out.push(l), err: (l) => err.push(l) }, cliDeps());
        expect(code).toBe(1);
        expect(err.join('\n')).toContain('allowedHosts must include the host of publicUrl');
    });

    test('without a valid token nothing is served: page, assets, view API, session API, WebSocket', async () => {
        const bad: Record<string, string>[] = [
            {},
            { 'Cf-Access-Jwt-Assertion': 'garbage' },
            header('ada', { exp: nowS() - 1 }),
            header('ada', { aud: ['another'] }),
            header('ada', { iss: 'https://evil.cloudflareaccess.com' }),
            { 'Cf-Access-Jwt-Assertion': token(claims('ada'), newKey('k1')) },
            // the cookie is not accepted unless configured
            { cookie: `CF_Authorization=${token(claims('ada'), k1)}` },
        ];
        for (const headers of bad) {
            for (const p of [
                '',
                'index.js',
                'api/state',
                'api/git/refs',
                'api/session/me',
                'api/session/state',
                'api/session/requests',
                'session/facilitator?code=' + 'x'.repeat(43),
            ]) {
                const res = await fetch(server.url + p, { headers });
                expect([p, res.status]).toEqual([p, 401]);
                expect(await res.text()).not.toContain('OrderOpened');
            }
            expect(await refused(server, headers)).toBe(true);
        }
    });

    test('a valid token is a participant: the name and avatar from the Identity API, else the e-mail’s local part; e-mail never sent', async () => {
        const me = await fetch(`${server.url}api/session/me`, { headers: header('ada') });
        expect(me.status).toBe(200);
        const body = (await me.json()) as Me;
        expect(body.participant).toEqual({
            id: 'access:ada-0000-uuid',
            name: 'Ada Lovelace',
            role: 'participant',
            avatarUrl: 'https://avatars.example.com/ada.png',
        } as Me['participant']);
        const bob = (await (await fetch(`${server.url}api/session/me`, { headers: header('bob') })).json()) as Me;
        expect([bob.participant.name, bob.participant.avatarUrl]).toEqual(['bob', undefined]);
        const state = await (await fetch(`${server.url}api/session/state`, { headers: header('ada') })).text();
        expect(state).toContain('Ada Lovelace');
        expect(state).not.toContain('@example.com');
        expect(JSON.stringify(body)).not.toContain('@example.com');
        expect(lines.join('\n')).not.toContain('@example.com');
        expect(lines.join('\n')).not.toContain('eyJ');
    });

    test('presence carries the participant ID, name and avatar only', async () => {
        const a = await socket(server, header('ada'));
        const b = await socket(server, header('bob'));
        try {
            await until(() => b.received.some((m) => m.type === 'presence.snapshot'));
            await until(() => a.received.some((m) => m.type === 'session.state'));
            a.ws.send(JSON.stringify({ type: 'presence.update', location: { kind: 'dt', viewKey: 'contextMap', layoutKey: 'g#1' }, cursor: { x: 1, y: 2 } }));
            await until(() => b.received.some((m) => m.type === 'presence.update'));
            const update = b.received.find((m) => m.type === 'presence.update');
            expect(JSON.stringify(update)).not.toContain('@');
            expect(update?.presence).toEqual(
                expect.objectContaining({
                    participant: { id: 'access:ada-0000-uuid', name: 'Ada Lovelace', role: 'participant', avatarUrl: 'https://avatars.example.com/ada.png' },
                }),
            );
            expect(JSON.stringify(a.received)).not.toContain('@example.com');
        } finally {
            a.ws.close();
            b.ws.close();
        }
    });

    test('Access lets the user in, not into the facilitator’s role: only the local link gives it', async () => {
        const ada = header('ada');
        const post = (p: string, headers: Record<string, string>, body: unknown = {}): Promise<Response> =>
            fetch(server.url + p, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        for (const [p, body] of [
            ['api/session/runs', { requests: [] }],
            ['api/session/revisions', {}],
            ['api/session/close', {}],
            ['api/baseline', { kind: 'previous' }],
        ] as const) {
            const res = await post(p, ada, body);
            expect([p, res.status, ((await res.json()) as { error: { type: string } }).error.type]).toEqual([p, 403, 'FacilitatorOnly']);
        }
        // the join form and a name do not exist in access mode
        expect((await post('api/session/join', ada, { name: 'Mallory' })).status).toBe(404);
        const carol = header('carol');
        expect((await fetch(server.facilitatorLink, { headers: carol, redirect: 'manual' })).status).toBe(303);
        expect(((await (await fetch(`${server.url}api/session/me`, { headers: carol })).json()) as Me).participant.role).toBe('facilitator');
        expect((await post('api/session/revisions', carol)).status).toBe(201);
        expect((await post('api/session/revisions', ada)).status).toBe(403);
    });

    test('the public host and origin pass; any other Host or Origin is refused, token or not', async () => {
        const ada = header('ada');
        const tunnel = { ...ada, Host: 'session.example.com' };
        expect((await fetch(`${server.url}api/state`, { headers: tunnel })).status).toBe(200);
        expect((await fetch(`${server.url}api/state`, { headers: { ...tunnel, Origin: 'https://session.example.com' } })).status).toBe(200);
        expect((await fetch(`${server.url}api/state`, { headers: { ...tunnel, Origin: 'https://evil.example' } })).status).toBe(403);
        expect((await fetch(`${server.url}api/state`, { headers: { ...ada, Host: 'evil.example' } })).status).toBe(403);
        expect(await refused(server, { ...ada, Origin: 'https://evil.example' })).toBe(true);
        expect(await refused(server, { ...ada, Host: 'evil.example' })).toBe(true);
    });

    test('a page is closed when its token expires, and when its participant leaves (then to Access’s logout)', async () => {
        const short = await socket(server, header('dan', { exp: nowS() + 2 }));
        const started = Date.now();
        expect(await short.closed).toBe(WS_EXPIRED);
        expect(Date.now() - started).toBeLessThan(4000);
        // an expired token cannot connect again
        expect(await refused(server, header('dan', { exp: nowS() - 1 }))).toBe(true);

        const s = await socket(server, header('dan'));
        const left = await fetch(`${server.url}api/session/leave`, {
            method: 'POST',
            headers: { ...header('dan'), 'content-type': 'application/json' },
            body: '{}',
        });
        expect(left.status).toBe(200);
        expect(await left.json()).toEqual({ left: true, logout: '/cdn-cgi/access/logout' });
        expect(await s.closed).toBe(WS_REVOKED);
    });

    test('the cookie is accepted when configured; the header comes first', async () => {
        const other = await start({ session: sessionConfig(accessConfig({ acceptCookie: true })) });
        try {
            const cookie = `CF_Authorization=${token(claims('ada'), k1)}`;
            expect((await fetch(`${other.url}api/state`, { headers: { cookie } })).status).toBe(200);
            const both = { cookie, 'Cf-Access-Jwt-Assertion': 'garbage' };
            expect((await fetch(`${other.url}api/state`, { headers: both })).status).toBe(401);
        } finally {
            await other.stop();
        }
    });

    test('a session closed with a page of an Access user open: the user is identified no more', async () => {
        const dir = await workspace();
        const other = await startSessionServer({
            root: dir,
            debounceMs: 30,
            session: sessionConfig(accessConfig()),
            accessAdapter: adapter(mock),
        });
        try {
            const ada = header('ada');
            expect((await fetch(other.facilitatorLink, { headers: ada, redirect: 'manual' })).status).toBe(303);
            const closed = await fetch(`${other.url}api/session/close`, {
                method: 'POST',
                headers: { ...ada, 'content-type': 'application/json' },
                body: '{}',
            });
            expect(closed.status).toBe(200);
            await other.closed;
            expect((await fetch(`${other.url}api/session/state`, { headers: ada })).status).toBe(401);
            expect((await fetch(`${other.url}api/state`, { headers: header('bob') })).status).toBe(401);
            expect(await refused(other, ada)).toBe(true);
        } finally {
            await other.stop();
        }
    });
});
