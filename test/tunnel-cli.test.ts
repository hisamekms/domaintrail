/**
 * `dt collab --tunnel` with the tunnel and the servers faked: the tunnel starts once the server holds the port (asked
 * for the public URL with the port bound), its URL is the link session's, the invite link is printed, cloudflared stops
 * with the session (and when the server fails after it started), and the refusals (identity access, cloudflared
 * failing). The approval of `--tunnel`: apps/dt/src/cli/trust.test.ts;
 * the tunnel itself: apps/dt/src/wiring/tunnel.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { type CliDeps, cliDeps, fileTrustStore, runCli, TunnelError } from '@domaintrail/dt';
import { tempCopyOfExamples } from './helpers.js';

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const URL_ = 'https://quiet-river-1234.trycloudflare.com';

async function setup(config?: string): Promise<{ root: string; trust: string }> {
    const root = await tempCopyOfExamples();
    const trust = await mkdtemp(path.join(tmpdir(), 'domaintrail-trust-'));
    dirs.push(root, trust);
    if (config) await writeFile(path.join(root, 'domaintrail.jsonc'), config);
    return { root, trust: path.join(trust, 'trust.json') };
}

interface Calls {
    tunnels: { port: number }[];
    sessions: Parameters<CliDeps['startSessionServer']>[0][];
    tunnelStops: number;
    serverStops: number;
}

function fakeDeps(trust: string, over: { tunnelFails?: boolean; serverFails?: 'before' | 'after' } = {}): { deps: CliDeps; calls: Calls } {
    const calls: Calls = { tunnels: [], sessions: [], tunnelStops: 0, serverStops: 0 };
    const deps: CliDeps = {
        ...cliDeps(),
        trust: fileTrustStore(trust),
        startTunnel: async ({ port }) => {
            calls.tunnels.push({ port });
            if (over.tunnelFails) throw new TunnelError('cloudflared not found: install cloudflared');
            return { url: URL_, exited: new Promise<void>(() => undefined), stop: async () => void calls.tunnelStops++ };
        },
        startSessionServer: async (options) => {
            calls.sessions.push(options);
            if (over.serverFails === 'before') throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' });
            // the server binds (port 4530 here), then asks for the public URL
            const publicUrl = await options.publicUrlAfterListen?.(4530);
            expect(publicUrl).toBe(URL_);
            if (over.serverFails === 'after') throw Object.assign(new Error('agent port in use'), { code: 'EADDRINUSE' });
            return {
                url: 'http://127.0.0.1:4530/',
                agentUrl: 'http://127.0.0.1:2/',
                agentToken: 't',
                session: 's1',
                opened: 'started',
                facilitatorLink: `${URL_}/session/facilitator?code=x`,
                publicUrl: URL_,
                issueInvite: async () => ({ link: `${URL_}/session/invite?code=y`, expiresAt: '2026-11-03T10:00:00.000Z' }),
                closed: Promise.resolve(),
                stop: async () => void calls.serverStops++,
            };
        },
    };
    return { deps, calls };
}

async function run(deps: CliDeps, ...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, deps);
    return { code, out, err };
}

describe('dt collab --tunnel', () => {
    test('serves the link identity at the tunnel URL, prints the links, and stops cloudflared with the session', async () => {
        const { root, trust } = await setup();
        const { deps, calls } = fakeDeps(trust);
        const r = await run(deps, '-r', root, 'collab', '--tunnel', '--port', '4530', '--no-agent', '--yes');
        expect(r.err).toEqual([]);
        expect(r.code).toBe(0);
        expect(calls.tunnels).toEqual([{ port: 4530 }]);
        expect(calls.sessions[0].session).toMatchObject({ identity: 'link', port: 4530, host: '127.0.0.1' });
        expect(calls.sessions[0].quickTunnel).toBe(true);
        expect(r.out).toContain(`Tunnel: ${URL_} (a Cloudflare quick tunnel: public, temporary, gone when the session ends)`);
        expect(r.out.some((l) => l.startsWith(`Live View: ${URL_}/`))).toBe(true);
        expect(r.out.some((l) => l.includes(`${URL_}/session/facilitator?code=x`))).toBe(true);
        expect(r.out.some((l) => l.startsWith('Invite link') && l.endsWith(`${URL_}/session/invite?code=y`))).toBe(true);
        // the approval listed the tunnel
        expect(r.out.some((l) => l.includes('collab --tunnel'))).toBe(true);
        expect(calls.serverStops).toBe(1);
        expect(calls.tunnelStops).toBe(1);
    });

    test('needs approval: refused without a terminal or --yes, before any tunnel starts', async () => {
        const { root, trust } = await setup();
        const { deps, calls } = fakeDeps(trust);
        const r = await run({ ...deps, confirm: undefined }, '-r', root, 'collab', '--tunnel', '--port', '4530', '--no-agent');
        expect(r.code).toBe(1);
        expect(r.err.join('\n')).toContain('Not started');
        expect(calls.tunnels).toEqual([]);
    });

    test('refused with identity access; any port, 0 included, since the tunnel follows the port bound', async () => {
        const access = await setup('{ "collab": { "identity": "access", "access": { "teamDomain": "t.cloudflareaccess.com", "audience": "a" } } }');
        const a = await run(fakeDeps(access.trust).deps, '-r', access.root, 'collab', '--tunnel', '--yes', '--no-agent');
        expect(a.err.join('\n')).toContain('--tunnel starts a quick tunnel for the link identity mode');
        const zero = await setup();
        const z = fakeDeps(zero.trust);
        const r = await run(z.deps, '-r', zero.root, 'collab', '--tunnel', '--port', '0', '--yes', '--no-agent');
        expect(r.err).toEqual([]);
        expect(z.calls.tunnels).toEqual([{ port: 4530 }]);
    });

    test('cloudflared failing: one line; the port taken: no tunnel at all; the server failing after: cloudflared stopped', async () => {
        const one = await setup();
        const failing = fakeDeps(one.trust, { tunnelFails: true });
        const r = await run(failing.deps, '-r', one.root, 'collab', '--tunnel', '--port', '4530', '--yes', '--no-agent');
        expect(r.err).toEqual(['cloudflared not found: install cloudflared']);
        const two = await setup();
        const busy = fakeDeps(two.trust, { serverFails: 'before' });
        const b = await run(busy.deps, '-r', two.root, 'collab', '--tunnel', '--port', '4530', '--yes', '--no-agent');
        expect(b.err.join('\n')).toContain('already in use');
        expect(busy.calls.tunnels).toEqual([]);
        const three = await setup();
        const late = fakeDeps(three.trust, { serverFails: 'after' });
        const c = await run(late.deps, '-r', three.root, 'collab', '--tunnel', '--port', '4530', '--yes', '--no-agent');
        expect(c.err.join('\n')).toContain('already in use');
        expect(late.calls.tunnelStops).toBe(1);
    });
});
