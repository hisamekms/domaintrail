// `dt collab --tunnel` (docs/session-link.md): a Cloudflare quick tunnel, `cloudflared tunnel --url
// http://127.0.0.1:<port>`, which needs no account and gives a random public `https://<words>.trycloudflare.com` URL
// for as long as it runs. The URL is read from cloudflared's output (it prints it in a box on stderr), then the first
// connection to Cloudflare's edge is waited for, so that the links printed work at once. cloudflared is a child of
// this process: stopped when the session ends, on Ctrl+C (the CLI's interrupt), and when this process exits for any
// reason it can see (an `exit` handler kills it): never left running alone.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { TunnelError } from '../cli/ports.js';

/** How long cloudflared may take to give its URL. */
export const TUNNEL_START_TIMEOUT_MS = 30_000;
/** How long to wait, once the URL is known, for the first connection to the edge before going on anyway. */
const CONNECTED_TIMEOUT_MS = 10_000;
/** How many of cloudflared's last lines an error quotes. */
const ERROR_LINES = 5;

/** A quick tunnel's URL in a line of cloudflared's output (never the API it asks, `api.trycloudflare.com`). */
export function quickTunnelUrl(line: string): string | undefined {
    for (const match of line.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com\b/gi)) if (match[1].toLowerCase() !== 'api') return match[0].toLowerCase();
    return undefined;
}

/** Whether a line of cloudflared's output says a connection to the edge is up. */
const connected = (line: string): boolean => /Registered tunnel connection/i.test(line);

/** What starts cloudflared: `node:child_process`'s `spawn` (tests give a stand-in). */
export type Spawn = (command: string, args: readonly string[], options: { stdio: ['ignore', 'pipe', 'pipe'] }) => ChildProcess;

export interface TunnelOptions {
    /** The local port the tunnel forwards to (on 127.0.0.1). */
    readonly port: number;
    readonly log: (line: string) => void;
    /** Default: `cloudflared` on the PATH. */
    readonly command?: string;
    readonly spawn?: Spawn;
    readonly timeoutMs?: number;
    readonly connectedTimeoutMs?: number;
    /** Where the `exit` handler is registered (tests give a stand-in). Default: `process`. */
    readonly onExit?: { on(event: 'exit', listener: () => void): unknown; off(event: 'exit', listener: () => void): unknown };
}

export interface QuickTunnel {
    /** `https://<words>.trycloudflare.com`. */
    readonly url: string;
    /** Resolves when cloudflared exits (by `stop` or by itself). */
    readonly exited: Promise<void>;
    /** Stops cloudflared (SIGTERM, then SIGKILL after a few seconds); resolves once it exited. */
    stop(): Promise<void>;
}

/** The arguments of a quick tunnel to `port`. */
export const tunnelArgs = (port: number): string[] => ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'];

/** Starts a quick tunnel to `127.0.0.1:<port>`: resolves with its URL once it can be used; rejects with `TunnelError`. */
export function startQuickTunnel(options: TunnelOptions): Promise<QuickTunnel> {
    const spawn = options.spawn ?? (nodeSpawn as Spawn);
    const exitHooks = options.onExit ?? process;
    const command = options.command ?? 'cloudflared';
    const child = spawn(command, tunnelArgs(options.port), { stdio: ['ignore', 'pipe', 'pipe'] });
    const last: string[] = [];
    let exited = false;
    const done = new Promise<void>((resolve) => {
        child.once('exit', () => {
            exited = true;
            resolve();
        });
        // a child that never started (ENOENT) emits `error` and maybe no `exit`
        child.once('error', () => {
            exited = true;
            resolve();
        });
    });
    // whatever ends this process, cloudflared ends with it
    const killOnExit = (): void => {
        if (!exited) child.kill('SIGKILL');
    };
    exitHooks.on('exit', killOnExit);
    void done.then(() => exitHooks.off('exit', killOnExit));

    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> =>
        (stopping ??= (async () => {
            if (!exited) child.kill('SIGTERM');
            const timer = setTimeout(() => {
                if (!exited) child.kill('SIGKILL');
            }, 3_000);
            await done;
            clearTimeout(timer);
        })());

    return new Promise<QuickTunnel>((resolve, reject) => {
        let url: string | undefined;
        let settled = false;
        const timers: ReturnType<typeof setTimeout>[] = [];
        const settle = (outcome: () => void): void => {
            if (settled) return;
            settled = true;
            for (const t of timers) clearTimeout(t);
            outcome();
        };
        const ready = (): void => settle(() => url && resolve({ url, exited: done, stop }));
        const fail = (message: string): void =>
            settle(() => {
                const tail = last.length ? `\n${last.join('\n')}` : '';
                void stop().then(() => reject(new TunnelError(`${message}${tail}`)));
            });
        const read = (chunk: Buffer): void => {
            for (const line of chunk.toString('utf8').split(/\r?\n/)) {
                const text = line.trim();
                if (!text) continue;
                last.push(text);
                if (last.length > ERROR_LINES) last.shift();
                const found = url ? undefined : quickTunnelUrl(text);
                if (found) {
                    url = found;
                    // the link works once a connection is up: wait for it a little, then go on anyway
                    timers.push(setTimeout(ready, options.connectedTimeoutMs ?? CONNECTED_TIMEOUT_MS));
                }
                if (url && connected(text)) ready();
            }
        };
        child.stdout?.on('data', read);
        child.stderr?.on('data', read);
        child.once('error', (e: NodeJS.ErrnoException) =>
            fail(
                e.code === 'ENOENT'
                    ? `${command} not found: install cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/, e.g. brew install cloudflared), or run without --tunnel.`
                    : `${command} could not start: ${e.message}`,
            ),
        );
        child.once('exit', (code, signal) => fail(`${command} exited (${signal ?? `code ${code}`}) before the tunnel was up.`));
        timers.push(
            setTimeout(
                () => fail(`${command} gave no tunnel URL within ${Math.round((options.timeoutMs ?? TUNNEL_START_TIMEOUT_MS) / 1000)} s.`),
                options.timeoutMs ?? TUNNEL_START_TIMEOUT_MS,
            ),
        );
        options.log(`Starting a Cloudflare quick tunnel to 127.0.0.1:${options.port} (${command} ${tunnelArgs(options.port).join(' ')})…`);
    });
}
