import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { DEFAULT_SOURCES } from '../core/config.js';
import { createApiRoutes } from '../presentation/http/routes.js';
import { defaultWebDir, loadAssets } from '../presentation/http/assets.js';
import { createViewHttpServer } from '../presentation/http/server.js';
import { createWebSocketHub } from '../presentation/websocket/hub.js';
import type { LayoutEngine } from '../visualization/application/layout-engine.js';
import { createViewService, type ViewService } from '../visualization/application/view-service.js';
import { ElkLayoutEngine } from '../visualization/infrastructure/elk.js';
import { createFileLayoutStore } from '../visualization/infrastructure/file-layout-store.js';
import { createGitRevisions } from '../visualization/infrastructure/git.js';
import { createWorkspaceReader } from '../workspace/infrastructure/files.js';
import { createGitRefWatcher, createWorkspaceWatcher } from '../workspace/infrastructure/watchers.js';

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
    view: ViewService;
    /** Resolves once the watcher is ready to report changes. */
    ready: Promise<void>;
    stop(): Promise<void>;
}

/**
 * Starts the Live View of a workspace: wires the adapters (layout engine, git, layout file, workspace reader and
 * watchers) into the view service, serves it over HTTP and WebSocket, and pushes a view on every change.
 */
export async function startViewServer(options: ViewServerOptions): Promise<ViewServer> {
    const log = options.log ?? (() => {});
    const engine = options.engine ?? new ElkLayoutEngine();
    const sources = options.sources ?? DEFAULT_SOURCES;
    const respectGitignore = options.respectGitignore ?? true;
    // an unknown revision stops the server from starting, rather than showing nothing as changed
    const git = createGitRevisions(options.root);
    if (options.base) await git.resolveCommit(options.base);
    const view = createViewService({
        root: options.root,
        engine,
        workspace: createWorkspaceReader(options.root, sources, respectGitignore),
        layoutStore: createFileLayoutStore(options.root),
        git,
        sources,
        baseRef: options.base,
    });
    await view.refresh();

    const assets = await loadAssets(options.webDir ?? defaultWebDir());
    const host = options.host ?? '127.0.0.1';
    const hub = createWebSocketHub(() => view.state);
    const http = createViewHttpServer({
        host,
        api: createApiRoutes({ view, git, publish: (payload) => hub.publish(payload), log }),
        assets,
        upgrade: (req, socket, head) => hub.handleUpgrade(req, socket, head),
    });
    await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(options.port ?? 4321, host, () => resolve());
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- listening on TCP, so the address is an AddressInfo
    const { port } = http.address() as AddressInfo;

    const refreshSources = async (): Promise<void> => {
        const payload = await view.refresh();
        hub.publish(payload);
        const errors = payload.diagnostics.filter((d) => d.severity === 'error').length;
        const d = payload.diff;
        log(`v${payload.version} ${payload.status}: ${errors} error(s); +${d.added.length} ~${d.changed.length} -${d.removed.length}`);
    };
    const sourcesWatch = createWorkspaceWatcher(options.root, { sources, respectGitignore, debounceMs: options.debounceMs }).subscribe((event) => {
        if (event.kind === 'settled') void refreshSources();
        else log(`${event.kind} ${path.relative(options.root, event.file)}`);
    });
    const ready = sourcesWatch.then(() => undefined);

    // a git baseline moves with its branch (a commit, a checkout): watch the refs, not the objects
    const refreshGitBaseline = async (): Promise<void> => {
        const before = view.state.baseline;
        const payload = await view.refresh();
        const after = payload.baseline;
        if (after.kind === 'git' && before.kind === 'git' && after.commit?.hash === before.commit?.hash) return;
        hub.publish(payload);
        if (after.kind === 'git') log(`baseline ${after.ref} is now ${after.commit?.hash.slice(0, 7) ?? '(unknown)'}`);
    };
    const dirs = await git.gitDirs();
    const gitRefsWatch = dirs
        ? createGitRefWatcher(dirs).subscribe(
              () => void refreshGitBaseline(),
              () => view.state.baseline.kind === 'git',
          )
        : undefined;

    return {
        url: `http://${host.includes(':') ? `[${host}]` : host}:${port}/`,
        view,
        ready,
        async stop() {
            for (const unsubscribe of await Promise.all([sourcesWatch, gitRefsWatch])) await unsubscribe?.();
            hub.close();
            http.closeAllConnections();
            await new Promise<void>((resolve) => http.close(() => resolve()));
            if ('dispose' in engine && typeof engine.dispose === 'function') engine.dispose();
        },
    };
}
