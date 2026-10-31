import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { DEFAULT_SOURCES } from '@domaintrail/modeling/core/config';
import { createApiRoutes } from '@domaintrail/presentation/http/routes';
import { defaultWebDir, loadAssets, type Assets } from '@domaintrail/presentation/http/assets';
import { createViewHttpServer } from '@domaintrail/presentation/http/server';
import { createWebSocketHub } from '@domaintrail/presentation/websocket/hub';
import type { LayoutEngine } from '@domaintrail/visualization/application/layout-engine';
import type { GitRevisions } from '@domaintrail/visualization/application/ports';
import { createViewService, type ViewService } from '@domaintrail/visualization/application/view-service';
import { ElkLayoutEngine } from '@domaintrail/visualization/infrastructure/elk';
import { createFileLayoutStore } from '@domaintrail/visualization/infrastructure/file-layout-store';
import { createGitRevisions } from '@domaintrail/visualization/infrastructure/git';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import { createWorkspaceReader } from '@domaintrail/workspace/infrastructure/files';
import { createGitRefWatcher, createWorkspaceWatcher } from '@domaintrail/workspace/infrastructure/watchers';
import type { WatcherGate } from './watcher-hold.js';

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

/** The Live View's parts before anything listens or watches: shared by `dt view` and `dt session start`. */
export interface LiveView {
    readonly view: ViewService;
    readonly git: GitRevisions;
    readonly engine: LayoutEngine;
    readonly assets: Assets;
}

/**
 * Wires the adapters (layout engine, git, layout file, workspace reader) into the view service, computes the first
 * view and loads the page. An unknown `base` rejects with `UnknownRevisionError`.
 */
export async function prepareLiveView(options: ViewServerOptions): Promise<LiveView> {
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
    return { view, git, engine, assets };
}

/** The watchers of a Live View, subscribed. */
export interface LiveViewWatch {
    /** Resolves once the watcher is ready to report changes. */
    readonly ready: Promise<void>;
    /** Refreshes the view from the sources and publishes it (what a settled burst of file events does). */
    refreshSources(): Promise<void>;
    /** Refreshes the view for a moved git baseline and publishes it when its commit changed. */
    refreshGitBaseline(): Promise<void>;
    stop(): Promise<void>;
}

/**
 * Subscribes the workspace's watchers: a settled burst of source changes refreshes the view and publishes it; a moved
 * git ref refreshes it when the baseline is a git revision. While `gate` is held, refreshes are deferred to it.
 */
export async function watchLiveView(
    options: ViewServerOptions,
    { view, git }: LiveView,
    publish: (payload: ViewPayload) => void,
    gate?: WatcherGate,
): Promise<LiveViewWatch> {
    const log = options.log ?? (() => {});
    const sources = options.sources ?? DEFAULT_SOURCES;
    const respectGitignore = options.respectGitignore ?? true;

    const refreshSources = async (): Promise<void> => {
        if (gate?.held) return gate.defer('sources');
        const payload = await view.refresh();
        publish(payload);
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
        if (gate?.held) return gate.defer('git');
        const before = view.state.baseline;
        const payload = await view.refresh();
        const after = payload.baseline;
        if (after.kind === 'git' && before.kind === 'git' && after.commit?.hash === before.commit?.hash) return;
        publish(payload);
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
        ready,
        refreshSources,
        refreshGitBaseline,
        async stop() {
            for (const unsubscribe of await Promise.all([sourcesWatch, gitRefsWatch])) await unsubscribe?.();
        },
    };
}

/** The URL of a server listening on `host`. */
export const serverUrl = (host: string, port: number): string => `http://${host.includes(':') ? `[${host}]` : host}:${port}/`;

/**
 * Starts the Live View of a workspace: wires the adapters (layout engine, git, layout file, workspace reader and
 * watchers) into the view service, serves it over HTTP and WebSocket, and pushes a view on every change.
 */
export async function startViewServer(options: ViewServerOptions): Promise<ViewServer> {
    const log = options.log ?? (() => {});
    const live = await prepareLiveView(options);
    const { view, git, engine } = live;

    const host = options.host ?? '127.0.0.1';
    const hub = createWebSocketHub(() => view.state);
    const http = createViewHttpServer({
        host,
        api: createApiRoutes({ view, git, publish: (payload) => hub.publish(payload), log }),
        assets: live.assets,
        upgrade: (req, socket, head) => hub.handleUpgrade(req, socket, head, undefined),
    });
    await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(options.port ?? 4321, host, () => resolve());
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- listening on TCP, so the address is an AddressInfo
    const { port } = http.address() as AddressInfo;

    const watch = await watchLiveView(options, live, (payload) => hub.publish(payload));

    return {
        url: serverUrl(host, port),
        view,
        ready: watch.ready,
        async stop() {
            await watch.stop();
            hub.close();
            http.closeAllConnections();
            await new Promise<void>((resolve) => http.close(() => resolve()));
            if ('dispose' in engine && typeof engine.dispose === 'function') engine.dispose();
        },
    };
}
