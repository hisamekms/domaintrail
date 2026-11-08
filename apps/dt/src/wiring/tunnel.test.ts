// `dt collab --tunnel`'s quick tunnel with cloudflared stood in for: its URL read from sample output (never the API's
// host), waited for until a connection is up, the errors (missing, exited, no URL in time), and cloudflared stopped by
// `stop` and by this process's exit.
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { TunnelError } from '../cli/ports.js';
import { quickTunnelUrl, startQuickTunnel, tunnelArgs, type Spawn } from './tunnel.js';

/** cloudflared 2024.x's output of a quick tunnel, as it prints it on stderr. */
const SAMPLE = `2026-11-03T08:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use (https://www.cloudflare.com/website-terms/), and Cloudflare reserves the right to investigate your use of Tunnels for violations of such terms. If you intend to use Tunnels in production you should use a pre-created named tunnel by following: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks
2026-11-03T08:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-11-03T08:00:01Z INF +--------------------------------------------------------------------------------------------+
2026-11-03T08:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-11-03T08:00:01Z INF |  https://quiet-river-moon-1234.trycloudflare.com                                           |
2026-11-03T08:00:01Z INF +--------------------------------------------------------------------------------------------+
2026-11-03T08:00:01Z INF Version 2024.8.2
2026-11-03T08:00:02Z INF Registered tunnel connection connIndex=0 connection=1b2c event=0 ip=198.41.192.7 location=nrt01 protocol=quic
`;

class FakeChild extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly signals: string[] = [];
    /** Whether it exits when signalled (a hung cloudflared does not on SIGTERM). */
    constructor(private readonly exitsOn: readonly string[] = ['SIGTERM', 'SIGKILL']) {
        super();
    }
    kill(signal: string): boolean {
        this.signals.push(signal);
        if (this.exitsOn.includes(signal)) queueMicrotask(() => this.emit('exit', null, signal));
        return true;
    }
}

function setup(child: FakeChild = new FakeChild()): {
    child: FakeChild;
    spawn: Spawn;
    calls: { command: string; args: readonly string[] }[];
    exitHooks: { listeners: (() => void)[]; on(e: 'exit', l: () => void): void; off(e: 'exit', l: () => void): void };
} {
    const calls: { command: string; args: readonly string[] }[] = [];
    const spawn: Spawn = (command, args) => {
        calls.push({ command, args });
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stand-in with what the tunnel uses of a child
        return child as unknown as ChildProcess;
    };
    const listeners: (() => void)[] = [];
    const exitHooks = {
        listeners,
        on: (_e: 'exit', l: () => void): void => void listeners.push(l),
        off: (_e: 'exit', l: () => void): void => void listeners.splice(listeners.indexOf(l), 1),
    };
    return { child, spawn, calls, exitHooks };
}

const failure = (p: Promise<unknown>): Promise<unknown> =>
    p.then(
        () => undefined,
        (e: unknown) => e,
    );

describe('the quick tunnel URL', () => {
    test('is read from the box cloudflared prints, never the API it asks', () => {
        const urls = SAMPLE.split('\n').map(quickTunnelUrl).filter(Boolean);
        expect(urls).toEqual(['https://quiet-river-moon-1234.trycloudflare.com']);
        expect(quickTunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF')).toBeUndefined();
        expect(quickTunnelUrl('see https://evil.example/https://x.trycloudflare.com.evil.example')).toBe('https://x.trycloudflare.com');
        expect(quickTunnelUrl('nothing here')).toBeUndefined();
    });

    test('cloudflared is asked for a quick tunnel to loopback only, without updating itself', () => {
        expect(tunnelArgs(4530)).toEqual(['tunnel', '--url', 'http://127.0.0.1:4530', '--no-autoupdate']);
    });
});

describe('starting the quick tunnel', () => {
    test('resolves with the URL once a connection is registered; stop ends cloudflared and its exit hook', async () => {
        const { child, spawn, calls, exitHooks } = setup();
        const lines: string[] = [];
        const started = startQuickTunnel({ port: 4530, log: (l) => lines.push(l), spawn, onExit: exitHooks });
        expect(calls).toEqual([{ command: 'cloudflared', args: tunnelArgs(4530) }]);
        expect(exitHooks.listeners).toHaveLength(1);
        child.stderr.write(SAMPLE);
        const tunnel = await started;
        expect(tunnel.url).toBe('https://quiet-river-moon-1234.trycloudflare.com');
        await tunnel.stop();
        expect(child.signals).toEqual(['SIGTERM']);
        await tunnel.exited;
        expect(exitHooks.listeners).toHaveLength(0);
    });

    test('goes on without the connection line after a while, the URL known', async () => {
        const { child, spawn, exitHooks } = setup();
        const started = startQuickTunnel({ port: 1, log: () => undefined, spawn, onExit: exitHooks, connectedTimeoutMs: 20 });
        child.stderr.write(SAMPLE.split('\n').slice(0, 6).join('\n'));
        expect((await started).url).toBe('https://quiet-river-moon-1234.trycloudflare.com');
    });

    test('this process exiting kills cloudflared (no orphan)', async () => {
        const { child, spawn, exitHooks } = setup();
        const started = startQuickTunnel({ port: 1, log: () => undefined, spawn, onExit: exitHooks });
        child.stderr.write(SAMPLE);
        await started;
        for (const l of exitHooks.listeners) l();
        expect(child.signals).toEqual(['SIGKILL']);
    });

    test('a cloudflared that ignores SIGTERM is killed', async () => {
        const { child, spawn, exitHooks } = setup(new FakeChild(['SIGKILL']));
        const started = startQuickTunnel({ port: 1, log: () => undefined, spawn, onExit: exitHooks });
        child.stderr.write(SAMPLE);
        const tunnel = await started;
        await tunnel.stop();
        expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    }, 10_000);

    test('cloudflared missing: a clear error', async () => {
        const { child, spawn, exitHooks } = setup();
        const started = startQuickTunnel({ port: 1, log: () => undefined, spawn, onExit: exitHooks });
        child.emit('error', Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' }));
        const e = await failure(started);
        expect(e).toBeInstanceOf(TunnelError);
        expect((e as Error).message).toContain('cloudflared not found: install cloudflared');
    });

    test('cloudflared exiting before its URL: an error with its last lines', async () => {
        const { child, spawn, exitHooks } = setup();
        const started = startQuickTunnel({ port: 1, log: () => undefined, spawn, onExit: exitHooks });
        child.stderr.write('ERR failed to request quick Tunnel: 429 Too Many Requests\n');
        await Bun.sleep(5);
        child.emit('exit', 1, null);
        const e = await failure(started);
        expect(e).toBeInstanceOf(TunnelError);
        expect((e as Error).message).toContain('exited (code 1) before the tunnel was up');
        expect((e as Error).message).toContain('429 Too Many Requests');
    });

    test('no URL in time: cloudflared is stopped and the start fails', async () => {
        const { child, spawn, exitHooks } = setup();
        const e = await failure(startQuickTunnel({ port: 1, log: () => undefined, spawn, onExit: exitHooks, timeoutMs: 30 }));
        expect(e).toBeInstanceOf(TunnelError);
        expect((e as Error).message).toContain('gave no tunnel URL within');
        expect(child.signals).toEqual(['SIGTERM']);
        expect(exitHooks.listeners).toHaveLength(0);
    });
});
