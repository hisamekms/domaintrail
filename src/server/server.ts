import * as path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import index from '../../web/index.html';
import { DEFAULT_SOURCES, IGNORED_DIRS, sourceMatcher } from '../core/config.js';
import { ElkLayoutEngine } from '../layout/elk.js';
import type { LayoutEngine } from '../layout/engine.js';
import { ViewSession } from './session.js';

export interface ViewServerOptions {
    root: string;
    /** Globs of DSL files relative to `root` (default `**\/*.dt`). */
    sources?: readonly string[];
    port?: number;
    host?: string;
    /** Debounce for bursts of file events (e.g. an AI saving several files). */
    debounceMs?: number;
    engine?: LayoutEngine;
    log?: (line: string) => void;
}

export interface ViewServer {
    url: string;
    session: ViewSession;
    /** Resolves once the watcher is ready to report changes. */
    ready: Promise<void>;
    stop(): Promise<void>;
}

const TOPIC = 'model';
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

/**
 * Host names the server answers to; anything else (e.g. a DNS-rebinding domain) is rejected.
 * Binding to a wildcard address is an explicit opt-in to network access, so any Host is accepted then.
 */
function hostAllowList(bind: string): (hostname: string) => boolean {
    if (bind === '0.0.0.0' || bind === '::') return () => true;
    return (hostname) => LOOPBACK.includes(hostname) || hostname === bind;
}

/**
 * The model may be confidential: reject requests whose Host is unexpected (DNS rebinding) and cross-origin
 * browser requests (browsers do not apply the same-origin policy to WebSockets). Non-browser clients send no Origin.
 */
function isTrusted(req: Request, allowedHost: (hostname: string) => boolean): boolean {
    const host = req.headers.get('host');
    if (!host || !allowedHost(new URL(`http://${host}`).hostname)) return false;
    const origin = req.headers.get('origin');
    if (!origin) return true;
    try {
        return new URL(origin).host === host;
    } catch {
        return false;
    }
}

const forbidden = (): Response => new Response('Forbidden', { status: 403 });

export async function startViewServer(options: ViewServerOptions): Promise<ViewServer> {
    const log = options.log ?? (() => {});
    const engine = options.engine ?? new ElkLayoutEngine();
    const sources = options.sources ?? DEFAULT_SOURCES;
    const isSource = sourceMatcher(sources);
    const session = new ViewSession(options.root, engine, sources);
    await session.refresh();

    const allowedHost = hostAllowList(options.host ?? '127.0.0.1');
    const server = Bun.serve({
        port: options.port ?? 4321,
        hostname: options.host ?? '127.0.0.1',
        development: false,
        routes: {
            '/': index,
            '/api/state': (req) => (isTrusted(req, allowedHost) ? Response.json(session.state) : forbidden()),
        },
        fetch(req, srv) {
            if (new URL(req.url).pathname !== '/ws') return new Response('Not found', { status: 404 });
            if (!isTrusted(req, allowedHost)) return forbidden();
            if (srv.upgrade(req, { data: undefined })) return undefined;
            return new Response('Upgrade failed', { status: 400 });
        },
        websocket: {
            open(ws) {
                ws.subscribe(TOPIC);
                ws.send(JSON.stringify(session.state));
            },
            message() {},
        },
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = (event: string, file: string): void => {
        log(`${event} ${path.relative(options.root, file)}`);
        clearTimeout(timer);
        timer = setTimeout(async () => {
            const payload = await session.refresh();
            server.publish(TOPIC, JSON.stringify(payload));
            const errors = payload.diagnostics.filter((d) => d.severity === 'error').length;
            const d = payload.diff;
            log(`v${payload.version} ${payload.status}: ${errors} error(s); +${d.added.length} ~${d.changed.length} -${d.removed.length}`);
        }, options.debounceMs ?? 80);
    };

    const watcher: FSWatcher = watch(options.root, {
        ignoreInitial: true,
        ignored: (p, stats) => IGNORED_DIRS.has(path.basename(p)) || (!!stats?.isFile() && !isSource(path.relative(options.root, p))),
    });
    for (const event of ['add', 'change', 'unlink'] as const) {
        watcher.on(event, (file: string) => onChange(event, file));
    }
    const ready = new Promise<void>((resolve) => watcher.once('ready', () => resolve()));

    return {
        url: server.url.toString(),
        session,
        ready,
        async stop() {
            clearTimeout(timer);
            await watcher.close();
            await server.stop(true);
            (engine as { dispose?: () => void }).dispose?.();
        },
    };
}
