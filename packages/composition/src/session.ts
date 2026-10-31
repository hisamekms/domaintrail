// `dt session start` (ADR 0026, S4): the Live View exactly as `dt view` serves it, plus a collaboration session in the
// same HTTP process (its REST API, its WebSocket messages, its identities), and the agent API on a listener of its
// own bound to 127.0.0.1. One open session per workspace: an open session is resumed, else one is started.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createSessionAccess, type SessionAccess } from '@domaintrail/collaboration/application/access';
import {
    FACILITATOR_NAME,
    FACILITATOR_PARTICIPANT,
    sameIdentity,
    type IdentityKey,
    type IdentityProvider,
} from '@domaintrail/collaboration/application/identity';
import type { Clock } from '@domaintrail/collaboration/application/ports';
import { createCollaboration, type CollaborationUseCases } from '@domaintrail/collaboration/application/use-cases';
import type { Collaboration } from '@domaintrail/collaboration/generated/index';
import { openSessionBlobs } from '@domaintrail/collaboration/infrastructure/blobs';
import { createCloudflareAccess, type AccessAdapterOptions, type AccessTokenVerifier } from '@domaintrail/collaboration/infrastructure/identity';
import { readServerAddress, removeSessionFiles, writeAgentCredential, writeServerAddress } from '@domaintrail/collaboration/infrastructure/session-files';
import { createUnitOfWork, openSessionDatabase } from '@domaintrail/collaboration/infrastructure/sqlite';
import { randomIds, randomSecrets, systemClock } from '@domaintrail/collaboration/infrastructure/system';
import { createModelValidator } from '@domaintrail/collaboration/infrastructure/validator';
import { DEFAULT_SOURCES, type ResolvedSessionConfig } from '@domaintrail/modeling/core/config';
import { SessionError } from '@domaintrail/presentation/cli/ports';
import { isLoopbackBind, sessionHostPolicy } from '@domaintrail/presentation/http/access';
import { createApiRoutes } from '@domaintrail/presentation/http/routes';
import { createViewHttpServer } from '@domaintrail/presentation/http/server';
import { createAgentApi } from '@domaintrail/presentation/session/agent';
import { createSessionIdentities } from '@domaintrail/presentation/session/identities';
import { createPresenceRelay, type SessionConnection } from '@domaintrail/presentation/session/presence';
import { createEventRelay, lastSeq } from '@domaintrail/presentation/session/relay';
import { createSessionHttp, meOf, stateBody } from '@domaintrail/presentation/session/routes';
import { createWebSocketHub, type Connection } from '@domaintrail/presentation/websocket/hub';
import type { ViewService } from '@domaintrail/visualization/application/view-service';
import { createWorkspaceSnapshot } from '@domaintrail/workspace/infrastructure/snapshot';
import { processAlive } from './process.js';
import { prepareLiveView, serverUrl, watchLiveView, type ViewServerOptions } from './view.js';
import { createWatcherHold, type WatcherHold } from './watcher-hold.js';

/** How long a lease of the agent holds without a heartbeat. */
export const AGENT_LEASE_MS = 60_000;
/** How often expired leases are applied (the recovery policy of S3). */
const EXPIRE_EVERY_MS = 5_000;
/** How long a facilitator link works. */
export const FACILITATOR_LINK_TTL_MS = 10 * 60_000;
/** Largest WebSocket message from a page. */
export const MAX_WS_PAYLOAD = 16 * 1024;
/** Most agent SSE streams at once. */
const MAX_AGENT_STREAMS = 8;
/** The WebSocket close codes of a session: the session closed; the page's identity was signed out or changed role. */
export const WS_SESSION_CLOSED = 4000;
export const WS_REVOKED = 4001;
/** The WebSocket close code of a page whose Access token expired: it reconnects with the token Access gives it now. */
export const WS_EXPIRED = 4002;
/** Longest delay `setTimeout` keeps (about 24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface SessionServerOptions extends ViewServerOptions {
    /** The `session` section of the configuration, resolved. */
    session: ResolvedSessionConfig;
    /** `access` mode: a stand-in for the JWKS check of the tokens' signature (tests); default: the team's JWKS. */
    accessVerifier?: AccessTokenVerifier;
    /** `access` mode: where the JWKS and the Identity API are and their timings (tests point them at a local mock). */
    accessAdapter?: AccessAdapterOptions;
    clock?: Clock;
    /** How long a claim or a heartbeat holds the agent's lease (default `AGENT_LEASE_MS`). */
    leaseMs?: number;
    /** How often expired leases are applied (default 5 s). */
    expireEveryMs?: number;
}

export interface SessionServer {
    /** The page and the session's API. */
    url: string;
    /** The agent API, on 127.0.0.1 (also in `.domaintrail/session/agent.json` with its credential). */
    agentUrl: string;
    session: Collaboration.SessionId;
    /** Whether an open session was resumed rather than started. */
    resumed: boolean;
    /** A one-time link: opened by a signed-in browser, it makes that identity the facilitator. */
    facilitatorLink: string;
    view: ViewService;
    /** The use cases of the session, for the tests and S7. */
    collaboration: CollaborationUseCases;
    /** Resolves once the watcher is ready to report changes. */
    ready: Promise<void>;
    /** Holds the workspace watcher's refresh and publish around a write of the sources (restore; S7). */
    watcherHold: WatcherHold;
    /** Resolves when the facilitator closes the session. */
    closed: Promise<void>;
    /** Another one-time facilitator link. */
    issueFacilitatorLink(): Promise<string>;
    stop(): Promise<void>;
}

const listen = (server: Server, port: number, host: string): Promise<number> =>
    new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.off('error', reject);
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- listening on TCP, so the address is an AddressInfo
            resolve((server.address() as AddressInfo).port);
        });
    });

const close = (server: Server): Promise<void> =>
    new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
    });

const linkOf = (url: string, code: string): string => `${url}session/facilitator?code=${code}`;

/**
 * The identity provider of the configured mode (none for `dev`). `access` needs the team domain and the audience; a
 * `publicUrl` must be https with its host in `allowedHosts` and its origin in `allowedOrigins` (it allows nothing by
 * itself, and the tunnel's requests would all be refused otherwise). The team's keys are fetched ahead of the first
 * token; a failure is told, not fatal (they are fetched again on the first token).
 */
function identityProvider(options: SessionServerOptions, clock: Clock, log: (line: string) => void): IdentityProvider | undefined {
    const config = options.session;
    if (config.identity === 'dev') {
        if (!isLoopbackBind(config.host)) {
            throw new SessionError(`The dev identity mode serves loopback only; ${config.host} is not a loopback address (use identity "access").`);
        }
        return undefined;
    }
    const access = config.access;
    if (!access?.teamDomain.trim() || !access.audience.trim()) throw new SessionError('The access identity mode needs session.access (teamDomain, audience).');
    if (access.publicUrl !== undefined) {
        const url = URL.canParse(access.publicUrl) ? new URL(access.publicUrl) : undefined;
        if (url?.protocol !== 'https:')
            throw new SessionError(`session.access.publicUrl must be an https URL (Cloudflare Access serves https): ${access.publicUrl}`);
        if (!access.allowedHosts.some((h) => h.toLowerCase() === url.hostname))
            throw new SessionError(`session.access.allowedHosts must include the host of publicUrl (${url.hostname}), or the tunnel's requests are refused.`);
        if (!access.allowedOrigins.includes(url.origin))
            throw new SessionError(`session.access.allowedOrigins must include the origin of publicUrl (${url.origin}), or the pages' requests are refused.`);
    }
    if (!isLoopbackBind(config.host))
        log(`Bound to ${config.host}: reachable without the tunnel (an Access token is still required). Bind to 127.0.0.1 behind cloudflared.`);
    const cloudflare = createCloudflareAccess(access, clock, {
        ...options.accessAdapter,
        log: options.accessAdapter?.log ?? log,
        ...(options.accessVerifier && { verifier: options.accessVerifier }),
    });
    void cloudflare.ready.then((fetched) => {
        if (!fetched) log('Cloudflare Access keys are not fetched yet: no participant can sign in until they are.');
    });
    return cloudflare.provider;
}

/**
 * Starts the session server of a workspace: resumes its open session or starts one (with a revision of every source),
 * serves the Live View and the session on `session.host:session.port`, the agent API on 127.0.0.1, writes
 * `agent.json` and `server.json` and makes a facilitator link.
 */
export async function startSessionServer(options: SessionServerOptions): Promise<SessionServer> {
    const log = options.log ?? (() => {});
    const config = options.session;
    const clock = options.clock ?? systemClock;
    const provider = identityProvider(options, clock, log);
    const leaseMs = options.leaseMs ?? AGENT_LEASE_MS;
    const sources = options.sources ?? DEFAULT_SOURCES;
    const respectGitignore = options.respectGitignore ?? true;

    const live = await prepareLiveView(options);
    const { view, git, engine } = live;
    const db = await openSessionDatabase(options.root);
    const disposeEngine = (): void => {
        if ('dispose' in engine && typeof engine.dispose === 'function') engine.dispose();
    };
    const opened: { http?: Server; agent?: Server } = {};
    try {
        const uow = createUnitOfWork(db);
        const snapshot = createWorkspaceSnapshot(options.root, sources, respectGitignore);
        const collaboration = createCollaboration({
            uow,
            workspace: snapshot,
            blobs: await openSessionBlobs(options.root),
            validator: createModelValidator(),
            clock,
            ids: randomIds,
        });
        const access: SessionAccess = createSessionAccess({ uow, clock, secrets: randomSecrets });

        // the recovery policy at startup, then one open session per workspace
        await collaboration.expireLeases();
        const current = await collaboration.currentSession();
        let session: Collaboration.SessionId;
        if (current) {
            session = current.id;
        } else {
            const started = await collaboration.startSession({ facilitator: FACILITATOR_PARTICIPANT, name: FACILITATOR_NAME });
            if (!started.ok) throw new SessionError(`A source is outside the workspace: ${started.error.path}`);
            session = started.value.session.id;
        }

        const identities = createSessionIdentities({
            session,
            mode: config.identity,
            provider,
            acceptAccessCookie: config.access?.acceptCookie ?? false,
            access,
            collaboration,
            maxParticipants: config.maxParticipants,
        });

        let resolveClosed: () => void = () => {};
        const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
        let isClosed = false;

        // the pages: the view, then the session's state and the others' presence
        const presence = createPresenceRelay({ publishWhere: (matches, message) => hub.publishWhere(matches, message) });
        let cursor = (): number => 0;
        // a page of an identity that expires (an Access token) is closed then; it reconnects with a fresh token
        const expiries = new Map<string, ReturnType<typeof setTimeout>>();
        /** The pages connected, by connection: each is sent the state again when the facilitator's role changes hands. */
        const pages = new Map<string, Connection<SessionConnection>>();
        /** Sends a page the session's state as of now (with who holds the facilitator's role). */
        const sendState = async (connection: Connection<SessionConnection>): Promise<void> => {
            const seq = cursor();
            const [state, holder] = await Promise.all([collaboration.sessionState({ session }), identities.facilitatorParticipant()]);
            if (state.ok) connection.send({ type: 'session.state', state: stateBody(state.value, seq, holder), me: meOf(session, connection.data) });
        };
        const stateFailed = (e: unknown): void => log(`session state failed: ${e instanceof Error ? e.message : String(e)}`);
        const hub = createWebSocketHub<SessionConnection>(() => view.state, {
            maxPayload: MAX_WS_PAYLOAD,
            onConnect(connection) {
                const expiresAt = connection.data.participant.identity.expiresAt;
                if (expiresAt) {
                    const ms = Math.min(Math.max(expiresAt.getTime() - clock.now().getTime(), 0), MAX_TIMER_MS);
                    const timer = setTimeout(() => hub.closeWhere((c) => c.id === connection.id, WS_EXPIRED, 'token expired'), ms);
                    timer.unref();
                    expiries.set(connection.id, timer);
                }
                pages.set(connection.id, connection);
                void sendState(connection).then(() => presence.connected(connection), stateFailed);
            },
            onMessage: (connection, message) => presence.received(connection, message),
            onClose: (connection) => {
                clearTimeout(expiries.get(connection.id));
                expiries.delete(connection.id);
                pages.delete(connection.id);
                presence.left(connection);
            },
        });
        // the claiming and the previous holder's pages are disconnected (they reconnect in their new role); the others
        // learn who holds the role from a new state
        const facilitatorChanged = (): void => {
            for (const connection of pages.values()) void sendState(connection).catch(stateFailed);
        };
        const disconnect = (identity: IdentityKey, reason: string): void =>
            hub.closeWhere((c) => sameIdentity(c.data.participant.identity, identity), WS_REVOKED, reason);

        const onClosed = async (): Promise<void> => {
            if (isClosed) return;
            isClosed = true;
            await identities.closeAll();
            hub.closeWhere(() => true, WS_SESSION_CLOSED, 'session closed');
            log('session closed');
            resolveClosed();
        };

        const agentToken = randomSecrets.newSecret();
        const relay = createEventRelay({
            collaboration,
            session,
            from: await lastSeq(collaboration, session),
            publish: (message) => hub.publish(message),
            after: (entries) => {
                agent.wake();
                if (entries.some((e) => e.event.type === 'SessionClosed')) void onClosed();
            },
        });
        cursor = () => relay.cursor();
        const pump = (): Promise<void> => relay.pump();
        const agent = createAgentApi({
            session,
            collaboration,
            token: agentToken,
            allowedTools: config.agent.allowedTools,
            leaseMs,
            maxStreams: MAX_AGENT_STREAMS,
            pump,
        });

        // a restore writes the sources: the watcher holds, then refreshes once
        // subscribed once the server listens
        let watch: Awaited<ReturnType<typeof watchLiveView>> | undefined;
        const watcherHold = createWatcherHold(
            async (missed) => {
                if (missed.sources) await watch?.refreshSources();
                else if (missed.git) await watch?.refreshGitBaseline();
            },
            {
                // what a write left on disk: the watcher's late events of the same sources are its echo
                fingerprint: async () => (await snapshot.read()).files.map((f) => `${f.path}\u0000${f.hash}`).join('\n'),
                log,
            },
        );

        const accessConfig = config.access;
        const surface = createSessionHttp({
            session,
            collaboration,
            identities,
            hostPolicy: sessionHostPolicy(accessConfig?.allowedHosts ?? [], accessConfig?.allowedOrigins ?? []),
            pump,
            cursor,
            holdWatcher: (work, wrote) => watcherHold.aroundWrite(work, wrote),
            disconnect,
            facilitatorChanged,
            closed: onClosed,
            secureCookie: accessConfig?.publicUrl?.startsWith('https://') ?? false,
            log,
        });
        const http = createViewHttpServer({
            host: config.host,
            api: createApiRoutes({ view, git, publish: (payload) => hub.publish(payload), log }),
            assets: live.assets,
            upgrade: (req, socket, head, auth) => {
                if (auth.kind !== 'participant') return void socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                hub.handleUpgrade(req, socket, head, { participant: auth.participant, role: auth.role });
            },
            session: surface,
        });
        opened.http = http;
        const port = await listen(http, config.port, config.host);
        const url = serverUrl(config.host, port);
        opened.agent = agent.server;
        const agentPort = await listen(agent.server, config.agent.port, '127.0.0.1');
        const agentUrl = serverUrl('127.0.0.1', agentPort);

        watch = await watchLiveView(options, live, (payload) => hub.publish(payload), watcherHold);
        await writeAgentCredential(options.root, { url: agentUrl, token: agentToken, session, pid: process.pid });
        await writeServerAddress(options.root, { url, session, pid: process.pid });

        const issueFacilitatorLink = async (): Promise<string> => {
            const link = await access.issueFacilitatorLink({ session, ttlMs: FACILITATOR_LINK_TTL_MS });
            if (!link.ok) throw new Error('The session is not open');
            return linkOf(url, link.value.code);
        };
        const facilitatorLink = await issueFacilitatorLink();

        const expiring = setInterval(() => {
            collaboration.expireLeases().then(
                (expired) => (expired.failed.length ? pump() : undefined),
                (e: unknown) => log(`expiring leases failed: ${e instanceof Error ? e.message : String(e)}`),
            );
        }, options.expireEveryMs ?? EXPIRE_EVERY_MS);
        expiring.unref();

        let stopped: Promise<void> | undefined;
        return {
            url,
            agentUrl,
            session,
            resumed: current !== undefined,
            facilitatorLink,
            view,
            collaboration,
            ready: watch.ready,
            watcherHold,
            closed,
            issueFacilitatorLink,
            stop() {
                stopped ??= (async () => {
                    clearInterval(expiring);
                    for (const timer of expiries.values()) clearTimeout(timer);
                    expiries.clear();
                    presence.dispose();
                    agent.close();
                    await watch?.stop();
                    hub.close();
                    await Promise.all([close(http), close(agent.server)]);
                    // the transactions in flight end before the database closes
                    await pump().catch(() => undefined);
                    await uow.transaction(() => undefined);
                    db.close();
                    await removeSessionFiles(options.root, process.pid);
                    disposeEngine();
                })();
                return stopped;
            },
        };
    } catch (e) {
        await Promise.all([opened.http, opened.agent].map((s) => (s?.listening ? close(s) : Promise.resolve())));
        db.close();
        disposeEngine();
        throw e;
    }
}

/**
 * Another facilitator link for the session server running on the workspace at `root` (`dt session link`): written to
 * the session's database, so the running server accepts it. Rejects with `SessionError` when none runs.
 */
export async function issueFacilitatorLink(root: string): Promise<{ link: string; expiresAt: Date }> {
    const address = await readServerAddress(root);
    if (!address || !processAlive(address.pid)) throw new SessionError('No session server is running for this workspace (start one with `dt session start`).');
    const db = await openSessionDatabase(root);
    try {
        const access = createSessionAccess({ uow: createUnitOfWork(db), clock: systemClock, secrets: randomSecrets });
        const collaboration = await openSessionId(db);
        if (collaboration !== address.session) throw new SessionError('The running session server serves a session that is no longer open.');
        const link = await access.issueFacilitatorLink({ session: collaboration, ttlMs: FACILITATOR_LINK_TTL_MS });
        if (!link.ok) throw new SessionError('The session is not open.');
        return { link: linkOf(address.url, link.value.code), expiresAt: link.value.expiresAt };
    } finally {
        db.close();
    }
}

/** The open session of a database, if any. */
async function openSessionId(db: Awaited<ReturnType<typeof openSessionDatabase>>): Promise<Collaboration.SessionId | undefined> {
    const uow = createUnitOfWork(db);
    return uow.transaction((stores) => stores.sessions.listOpen()[0]?.id);
}
