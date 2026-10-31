import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { watch, type FSWatcher } from 'chokidar';
import { WebSocket, WebSocketServer } from 'ws';
import { DEFAULT_SOURCES, IGNORED_DIRS } from '../core/config.js';
import { SourceScope } from '../core/files.js';
import { STRUCTURE_LEVELS, type StructureLevel } from '../graph/ir.js';
import { ElkLayoutEngine } from '../layout/elk.js';
import type { LayoutEngine } from '../layout/engine.js';
import { gitDirs, listRefs, resolveCommit, UnknownRevisionError } from './git.js';
import type { BaselineSpec } from './protocol.js';
import { ViewSession } from './session.js';

export interface ViewServerOptions {
    root: string;
    /** Globs of DSL files relative to `root` (default `DEFAULT_SOURCES`). */
    sources?: readonly string[];
    /** Whether files ignored by `.gitignore` are skipped (default true). */
    respectGitignore?: boolean;
    port?: number;
    host?: string;
    /** Debounce for bursts of file events (e.g. an AI saving several files). */
    debounceMs?: number;
    engine?: LayoutEngine;
    /** A git revision to compare the model with from the start (default: the previously shown model). */
    base?: string;
    /** Built Live View page (default: see `defaultWebDir`). */
    webDir?: string;
    log?: (line: string) => void;
}

export interface ViewServer {
    url: string;
    session: ViewSession;
    /** Resolves once the watcher is ready to report changes. */
    ready: Promise<void>;
    stop(): Promise<void>;
}

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html;charset=utf-8',
    '.js': 'text/javascript;charset=utf-8',
    '.css': 'text/css;charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

/** The page built by `bun run build`: next to the bundled CLI when installed, `dist/web` when running from source. */
function defaultWebDir(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const bundled = path.join(here, 'web');
    return existsSync(path.join(bundled, 'index.html')) ? bundled : path.resolve(here, '../../dist/web');
}

interface Asset {
    type: string;
    body: Buffer;
}

/** Loads the whole page up front; only these files are ever served, so no request path reaches the file system. */
async function loadAssets(dir: string): Promise<Map<string, Asset>> {
    if (!existsSync(path.join(dir, 'index.html'))) throw new Error(`Live View page not found in ${dir} (run \`bun run build\`)`);
    const assets = new Map<string, Asset>();
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const file = path.join(entry.parentPath, entry.name);
        const urlPath = '/' + path.relative(dir, file).split(path.sep).join('/');
        assets.set(urlPath, { type: CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream', body: await readFile(file) });
    }
    assets.set('/', assets.get('/index.html')!);
    return assets;
}

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
function isTrusted(headers: IncomingHttpHeaders, allowedHost: (hostname: string) => boolean): boolean {
    const host = headers.host;
    if (!host) return false;
    try {
        if (!allowedHost(new URL(`http://${host}`).hostname)) return false;
    } catch {
        return false;
    }
    const origin = headers.origin;
    if (!origin) return true;
    try {
        return new URL(origin).host === host;
    } catch {
        return false;
    }
}

const isStructureLevel = (s: string | null): s is StructureLevel => (STRUCTURE_LEVELS as readonly (string | null)[]).includes(s);

/** The Structure View level asked for: `level=…`, or `overview=1` as asked before there were three levels. */
function structureLevel(params: URLSearchParams): StructureLevel {
    const level = params.get('level');
    if (isStructureLevel(level)) return level;
    return params.get('overview') === '1' ? 'overview' : 'detail';
}

/** Largest request body accepted (a baseline is a few bytes). */
const MAX_BODY = 4096;

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
            body += chunk;
            if (body.length > MAX_BODY) reject(new Error('Request body too large'));
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

/** `{"kind":"previous"}` or `{"kind":"git","ref":"main"}`; undefined when it is neither. */
function parseBaseline(body: string): BaselineSpec | undefined {
    try {
        const v: unknown = JSON.parse(body);
        if (typeof v !== 'object' || v === null || !('kind' in v)) return undefined;
        if (v.kind === 'previous') return { kind: 'previous' };
        if (v.kind === 'git' && 'ref' in v && typeof v.ref === 'string' && v.ref.trim()) return { kind: 'git', ref: v.ref.trim() };
    } catch {
        // not JSON
    }
    return undefined;
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
    res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff' });
    res.end(body);
}

export async function startViewServer(options: ViewServerOptions): Promise<ViewServer> {
    const log = options.log ?? (() => {});
    const engine = options.engine ?? new ElkLayoutEngine();
    const sources = options.sources ?? DEFAULT_SOURCES;
    const respectGitignore = options.respectGitignore ?? true;
    // an unknown revision stops the server from starting, rather than showing nothing as changed
    if (options.base) await resolveCommit(options.root, options.base);
    const session = new ViewSession(options.root, engine, sources, respectGitignore, options.base);
    await session.refresh();

    const assets = await loadAssets(options.webDir ?? defaultWebDir());
    const host = options.host ?? '127.0.0.1';
    const allowedHost = hostAllowList(host);
    const http = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/api/state') {
            if (!isTrusted(req.headers, allowedHost)) return send(res, 403, 'text/plain', 'Forbidden');
            return send(res, 200, 'application/json', JSON.stringify(session.state));
        }
        // `?contexts=A,B&level=overview&hide=C`: Structure View of those bounded contexts with their dependencies as stubs,
        // except those on and from C (`overview=1` is still accepted for `level=overview`)
        if (url.pathname === '/api/focus') {
            if (!isTrusted(req.headers, allowedHost)) return send(res, 403, 'text/plain', 'Forbidden');
            const contexts = (url.searchParams.get('contexts') ?? '').split(',').filter(Boolean);
            try {
                const hidden = (url.searchParams.get('hide') ?? '').split(',').filter(Boolean);
                const graph = await session.focusGraph(contexts, structureLevel(url.searchParams), hidden);
                return graph ? send(res, 200, 'application/json', JSON.stringify(graph)) : send(res, 404, 'text/plain', 'No such contexts');
            } catch {
                return send(res, 500, 'text/plain', 'Layout failed');
            }
        }
        // the revisions the page offers as baselines
        if (url.pathname === '/api/git/refs') {
            if (!isTrusted(req.headers, allowedHost)) return send(res, 403, 'text/plain', 'Forbidden');
            return send(res, 200, 'application/json', JSON.stringify(await listRefs(options.root)));
        }
        // POST `{"kind":"git","ref":"main"}` or `{"kind":"previous"}`: what the model is compared with, for every page
        if (url.pathname === '/api/baseline') {
            if (!isTrusted(req.headers, allowedHost)) return send(res, 403, 'text/plain', 'Forbidden');
            if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method not allowed');
            const spec = parseBaseline(await readBody(req).catch(() => ''));
            if (!spec) return send(res, 400, 'text/plain', 'Expected {"kind":"previous"} or {"kind":"git","ref":"<revision>"}');
            try {
                const payload = await session.setBaseline(spec);
                publish(JSON.stringify(payload));
                log(`baseline: ${spec.kind === 'git' ? spec.ref : 'previous'}`);
                return send(res, 200, 'application/json', JSON.stringify(payload.baseline));
            } catch (e) {
                if (e instanceof UnknownRevisionError) return send(res, 400, 'text/plain', e.message);
                return send(res, 500, 'text/plain', 'Comparison failed');
            }
        }
        const asset = req.method === 'GET' || req.method === 'HEAD' ? assets.get(url.pathname) : undefined;
        if (!asset) return send(res, 404, 'text/plain', 'Not found');
        send(res, 200, asset.type, asset.body);
    });
    const wss = new WebSocketServer({ noServer: true });
    http.on('upgrade', (req, socket, head) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (pathname !== '/ws' || !isTrusted(req.headers, allowedHost)) {
            socket.end(`HTTP/1.1 ${pathname === '/ws' ? '403 Forbidden' : '404 Not Found'}\r\nConnection: close\r\n\r\n`);
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify(session.state)));
    });
    const publish = (message: string): void => {
        for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(message);
    };
    await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(options.port ?? 4321, host, () => resolve());
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- listening on TCP, so the address is an AddressInfo
    const { port } = http.address() as AddressInfo;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = (event: string, file: string): void => {
        log(`${event} ${path.relative(options.root, file)}`);
        clearTimeout(timer);
        timer = setTimeout(async () => {
            const payload = await session.refresh();
            publish(JSON.stringify(payload));
            const errors = payload.diagnostics.filter((d) => d.severity === 'error').length;
            const d = payload.diff;
            log(`v${payload.version} ${payload.status}: ${errors} error(s); +${d.added.length} ~${d.changed.length} -${d.removed.length}`);
        }, options.debounceMs ?? 80);
    };

    const scope = new SourceScope(options.root, sources, respectGitignore);
    const watcher: FSWatcher = watch(options.root, {
        ignoreInitial: true,
        ignored: (p, stats) => {
            if (stats?.isDirectory()) return p !== scope.root && !scope.includesDirectory(p);
            return IGNORED_DIRS.has(path.basename(p)) || (!!stats?.isFile() && scope.sourcePath(p) === undefined);
        },
    });
    for (const event of ['add', 'change', 'unlink'] as const) {
        watcher.on(event, (file: string) => onChange(event, file));
    }
    const ready = new Promise<void>((resolve) => watcher.once('ready', () => resolve()));

    // a git baseline moves with its branch (a commit, a checkout): watch the refs, not the objects
    let gitWatcher: FSWatcher | undefined;
    const dirs = await gitDirs(options.root);
    if (dirs) {
        gitWatcher = watch(
            dirs.flatMap((d) => ['HEAD', 'refs', 'packed-refs'].map((f) => path.join(d, f))),
            { ignoreInitial: true },
        );
        let gitTimer: ReturnType<typeof setTimeout> | undefined;
        gitWatcher.on('all', () => {
            if (session.state.baseline.kind !== 'git') return;
            clearTimeout(gitTimer);
            gitTimer = setTimeout(async () => {
                const before = session.state.baseline;
                const payload = await session.refresh();
                const after = payload.baseline;
                if (after.kind === 'git' && before.kind === 'git' && after.commit?.hash === before.commit?.hash) return;
                publish(JSON.stringify(payload));
                if (after.kind === 'git') log(`baseline ${after.ref} is now ${after.commit?.hash.slice(0, 7) ?? '(unknown)'}`);
            }, 200);
        });
    }

    return {
        url: `http://${host.includes(':') ? `[${host}]` : host}:${port}/`,
        session,
        ready,
        async stop() {
            clearTimeout(timer);
            await watcher.close();
            await gitWatcher?.close();
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            http.closeAllConnections();
            await new Promise<void>((resolve) => http.close(() => resolve()));
            if ('dispose' in engine && typeof engine.dispose === 'function') engine.dispose();
        },
    };
}
