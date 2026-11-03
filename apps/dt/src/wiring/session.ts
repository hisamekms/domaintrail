// `dt open` and `dt collab` (ADR 0026, S4; ADR 0030): the Live View, plus a collaboration session in the same HTTP
// process (its REST API, its WebSocket messages, its identities), and the agent API on a listener of its own bound to
// 127.0.0.1. One open session per workspace, opened in the mode asked for (`openSession`, decision 13): a session of
// that mode is resumed; `dt collab` continues a Solo session as a Collab one; `dt open` refuses an open Collab session.
// In the Solo mode the one person is the facilitator without signing in (./solo.ts) and no facilitator link is made.
// The server runs the triage's stage 2 (Clef, `classifier`) on the messages addressed to the AI, hands the answerer
// role its jobs (the agent API's answers entry point) and tells the pages which agents are connected.
import {
    type AccessAdapterOptions,
    type AccessTokenVerifier,
    type Clock,
    type Collaboration,
    type CollaborationUseCases,
    createClefClassifier,
    createCloudflareAccess,
    createCollaboration,
    createRunActivities,
    createSessionAccess,
    createUnitOfWork,
    FACILITATOR_NAME,
    FACILITATOR_PARTICIPANT,
    type IdentityKey,
    type IdentityProvider,
    type MessageClassifier,
    openSessionBlobs,
    openSessionDatabase,
    randomIds,
    randomSecrets,
    readServerAddress,
    removeLegacyAgentFile,
    removeSessionFiles,
    RUN_ENDING_EVENTS,
    sameIdentity,
    type SessionAccess,
    systemClock,
    writeServerAddress,
} from '@domaintrail/collaboration';
import type { AgentPresence, EventMessage } from '@domaintrail/collaboration/protocol';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { DEFAULT_SOURCES, sourceSelection } from '@domaintrail/analysis';
import { type Connection, createWebSocketHub } from '../server/websocket/hub.js';
import { createAgentApi } from '../server/session/agent.js';
import { createApiRoutes } from '../server/http/routes.js';
import { createEventRelay, lastSeq } from '../server/session/relay.js';
import { createPresenceRelay, type SessionConnection } from '../server/session/presence.js';
import { createRevertQueue } from '../server/session/reverts.js';
import { createSessionHttp, meOf, stateBody } from '../server/session/routes.js';
import { createSessionIdentities } from '../server/session/identities.js';
import { createTriageStage } from '../server/session/triage.js';
import { eventFor } from '../server/session/views.js';
import { createViewHttpServer } from '../server/http/server.js';
import { isLoopbackBind, sessionHostPolicy } from '../server/http/access.js';
import { SessionError, type SessionSettings } from '../cli/ports.js';
import type { ViewService } from '@domaintrail/visualization';
import { createWorkspaceSnapshot } from '@domaintrail/workspace';
import { processAlive } from './process.js';
import { createModelValidator, createSourceFormatter } from './validator.js';
import { prepareLiveView, serverUrl, watchLiveView, type ViewServerOptions } from './view.js';
import { createWatcherHold, type WatcherHold } from './watcher-hold.js';
import { createSoloSignIn, soloIdentities, soloName, soloSurface } from './solo.js';
import * as path from 'node:path';

/** How long a lease of the agent holds without a heartbeat. */
export const AGENT_LEASE_MS = 60_000;
/** How often expired leases are applied (the recovery policy of S3). */
const EXPIRE_EVERY_MS = 5_000;
/** How long a facilitator link works. */
export const FACILITATOR_LINK_TTL_MS = 10 * 60_000;
/** How long an agent pairing code (`dt collab agent-link`) works. */
export const AGENT_CODE_TTL_MS = 10 * 60_000;
/** Largest WebSocket message from a page. */
export const MAX_WS_PAYLOAD = 16 * 1024;
/** Most agent SSE streams at once. */
const MAX_AGENT_STREAMS = 8;
/** The WebSocket close codes of a session: the session closed; the page's identity was signed out or changed role. */
export const WS_SESSION_CLOSED = 4000;
export const WS_REVOKED = 4001;
/** The WebSocket close code of a page whose Access token expired: it reconnects with the token Access gives it now. */
export const WS_EXPIRED = 4002;
/** How long the classifier of a message may take. */
const CLASSIFY_TIMEOUT_MS = 8_000;
/** The most an answer job may take, unless given (`agent.answer.timeout`, default 120 s). */
export const ANSWER_TIMEOUT_MS = 120_000;
/** Where the server's one line per triage goes when no `debug` log is given: printed when this variable is set. */
export const DEBUG_ENV = 'DOMAINTRAIL_DEBUG';
/** Where the Clef classifier is asked instead of Cloudflare's API (a local mock, for tests and demos). */
export const CLASSIFIER_URL_ENV = 'DOMAINTRAIL_CLASSIFIER_URL';
/** Longest delay `setTimeout` keeps (about 24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface SessionServerOptions extends ViewServerOptions {
    /** What the session server reads of the configuration (`collab`, `agent.port`, `agent.run`'s tools, `classifier`). */
    session: SessionSettings;
    /** `access` mode: a stand-in for the JWKS check of the tokens' signature (tests); default: the team's JWKS. */
    accessVerifier?: AccessTokenVerifier;
    /** `access` mode: where the JWKS and the Identity API are and their timings (tests point them at a local mock). */
    accessAdapter?: AccessAdapterOptions;
    clock?: Clock;
    /** How long a claim or a heartbeat holds the agent's lease (default `AGENT_LEASE_MS`). */
    leaseMs?: number;
    /** How often expired leases are applied (default 5 s). */
    expireEveryMs?: number;
    /** A classifier instead of the configured one (tests). */
    classifier?: MessageClassifier;
    /** The most an answer job may take (default `ANSWER_TIMEOUT_MS`). */
    answerTimeoutMs?: number;
    /** The debug log: one line per triage decided, without the message's text (default: the log when `DOMAINTRAIL_DEBUG` is set). */
    debug?: (line: string) => void;
    /** `Solo` (`dt open`: one person, loopback, the facilitator without signing in) or `Collab` (`dt collab`). Default: `Collab`. */
    mode?: Collaboration.SessionMode;
    /** The name a session started now gives its facilitator. Default: in `Solo`, git's `user.name` or the OS user's; else `Facilitator`. */
    facilitatorName?: Collaboration.DisplayName;
}

export interface SessionServer {
    /** The page and the session's API. */
    url: string;
    /** The agent API, on 127.0.0.1 (also in `.domaintrail/session/server.json`, without its credential). */
    agentUrl: string;
    /** The agent API's bearer token, in memory only: for the agent in process (a standalone one pairs with a code). */
    agentToken: string;
    session: Collaboration.SessionId;
    /** The session's mode as served. */
    mode: Collaboration.SessionMode;
    /** Whether an open session was resumed (or continued from Solo) rather than started. */
    resumed: boolean;
    /** How the session was opened: `started`, `resumed`, or `collaborated` (a Solo session continued as Collab). */
    opened: 'started' | 'resumed' | 'collaborated';
    /** A one-time link: opened by a signed-in browser, it makes that identity the facilitator; in `Solo`, it signs the browser that opens it in as the one person. */
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
    /**
     * Sends what the use cases appended to the outbox to the pages and the agents, and lets the server's stages take it
     * (after a use case called on `collaboration` directly: the tests, a solo sign-in).
     */
    pump(): Promise<void>;
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

/** The workspaces (resolved roots) a session server of this process serves. */
const served = new Set<string>();

/** The name of the facilitator a session was started with (the one person of a Solo session). */
const soloPersonName = (session: Collaboration.OpenSession): Collaboration.DisplayName =>
    session.participants.find((p) => p.id === FACILITATOR_PARTICIPANT)?.name ?? FACILITATOR_NAME;

const linkOf = (url: string, code: string): string => `${url}session/facilitator?code=${code}`;

/**
 * The identity provider of the configured mode (none for `dev`). `access` needs the team domain and the audience; a
 * `publicUrl` must be https with its host in `allowedHosts` and its origin in `allowedOrigins` (it allows nothing by
 * itself, and the tunnel's requests would all be refused otherwise). The team's keys are fetched ahead of the first
 * token; a failure is told, not fatal (they are fetched again on the first token).
 */
function identityProvider(options: SessionServerOptions, clock: Clock, log: (line: string) => void): IdentityProvider | undefined {
    const config = options.session;
    if (options.mode === 'Solo' && !isLoopbackBind(config.host))
        throw new SessionError(`dt open serves the chat on loopback only; ${config.host} is not a loopback address.`);
    if (config.identity === 'dev' || options.mode === 'Solo') {
        if (!isLoopbackBind(config.host)) {
            throw new SessionError(`The dev identity mode serves loopback only; ${config.host} is not a loopback address (use identity "access").`);
        }
        return undefined;
    }
    const access = config.access;
    if (!access?.teamDomain.trim() || !access.audience.trim()) throw new SessionError('The access identity mode needs collab.access (teamDomain, audience).');
    if (access.publicUrl !== undefined) {
        const url = URL.canParse(access.publicUrl) ? new URL(access.publicUrl) : undefined;
        if (url?.protocol !== 'https:')
            throw new SessionError(`collab.access.publicUrl must be an https URL (Cloudflare Access serves https): ${access.publicUrl}`);
        if (!access.allowedHosts.some((h) => h.toLowerCase() === url.hostname))
            throw new SessionError(`collab.access.allowedHosts must include the host of publicUrl (${url.hostname}), or the tunnel's requests are refused.`);
        if (!access.allowedOrigins.includes(url.origin))
            throw new SessionError(`collab.access.allowedOrigins must include the origin of publicUrl (${url.origin}), or the pages' requests are refused.`);
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
 * Stage 2 of the triage: Clef, when `classifier` is enabled and its token is in the environment; otherwise none (the
 * stage is recorded as not configured, and the light model of the answerer role decides).
 */
function messageClassifier(options: SessionServerOptions, log: (line: string) => void): MessageClassifier | undefined {
    if (options.classifier) return options.classifier;
    const c = options.session.classifier;
    if (!c.enabled || !c.accountId) return undefined;
    const token = process.env[c.apiTokenEnv];
    if (!token) {
        log(`classifier is enabled but ${c.apiTokenEnv} is not set: the triage goes without Clef.`);
        return undefined;
    }
    const baseUrl = process.env[CLASSIFIER_URL_ENV];
    log(`Triaging the messages addressed to the AI with Cloudflare Workers AI (${c.model}) first: their text is sent to Cloudflare.`);
    return createClefClassifier({ accountId: c.accountId, model: c.model, token, ...(baseUrl && { baseUrl }) });
}

/**
 * Starts the session server of a workspace: resumes its open session or starts one (with a revision of every source),
 * serves the Live View and the session on `session.host:session.port`, the agent API on 127.0.0.1, writes
 * `server.json` (no secret) and makes a facilitator link.
 */
export async function startSessionServer(options: SessionServerOptions): Promise<SessionServer> {
    const log = options.log ?? (() => {});
    const config = options.session;
    const clock = options.clock ?? systemClock;
    const provider = identityProvider(options, clock, log);
    // one live server per workspace: a second one would open (or change the mode of) the session under the first
    const root = path.resolve(options.root);
    const running = await readServerAddress(root).catch(() => undefined);
    if (served.has(root) || (running && running.pid !== process.pid && processAlive(running.pid)))
        throw new SessionError(
            `A session server is already running for this workspace${running ? ` (pid ${running.pid}, ${running.url})` : ''}: stop it before starting another.`,
        );
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
    served.add(root);
    try {
        const uow = createUnitOfWork(db);
        const snapshot = createWorkspaceSnapshot(options.root, sourceSelection(sources, respectGitignore));
        const collaboration = createCollaboration({
            uow,
            workspace: snapshot,
            blobs: await openSessionBlobs(options.root),
            validator: createModelValidator(),
            formatter: createSourceFormatter(),
            clock,
            ids: randomIds,
        });
        const access: SessionAccess = createSessionAccess({ uow, clock, secrets: randomSecrets });

        // the recovery policy at startup, then one open session per workspace, in the mode asked for
        await collaboration.expireLeases();
        const mode = options.mode ?? 'Collab';
        const openedSession = await collaboration.openSession({
            mode,
            facilitator: FACILITATOR_PARTICIPANT,
            name: options.facilitatorName ?? (mode === 'Solo' ? await soloName(options.root) : FACILITATOR_NAME),
        });
        if (!openedSession.ok) {
            if (openedSession.error.type === 'CollabSessionOpen')
                throw new SessionError(
                    'This workspace has an open collab session: resume it with `dt collab`, or end it from its collab menu before `dt open`.',
                );
            throw new SessionError(`A source is outside the workspace: ${openedSession.error.path}`);
        }
        const { value: sessionOpened } = openedSession;
        const session: Collaboration.SessionId = sessionOpened.session.id;

        const shared = createSessionIdentities({
            session,
            mode: mode === 'Solo' ? 'dev' : config.identity,
            provider,
            acceptAccessCookie: config.access?.acceptCookie ?? false,
            access,
            collaboration,
            maxParticipants: config.maxParticipants,
        });
        const soloPerson = soloPersonName(sessionOpened.session);
        // `dt open`'s sign-in: in this server's memory only, revoked when it stops
        const soloSignIn = createSoloSignIn();
        // a Solo session's person, bound to the cookie of the link `dt open` prints; nobody once it is no longer Solo
        const identities =
            mode === 'Solo'
                ? soloIdentities({
                      signIn: soloSignIn,
                      base: shared,
                      name: soloPerson,
                      isOpenSolo: async () => {
                          const current = await collaboration.currentSession();
                          return current?.id === session && current.mode === 'Solo';
                      },
                  })
                : shared;

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
        /** Sends a page the session's state as of now (with who holds the facilitator's role), as its role sees it. */
        const sendState = async (connection: Connection<SessionConnection>): Promise<void> => {
            const seq = cursor();
            const [state, holder, agentNow] = await Promise.all([
                collaboration.sessionState({ session }),
                identities.facilitatorParticipant(),
                agentPresence(),
            ]);
            if (state.ok)
                connection.send({
                    type: 'session.state',
                    state: stateBody(state.value, seq, config.quickReactions, holder, connection.data.role, agentNow),
                    me: meOf(session, connection.data),
                });
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
                void sendState(connection).then(() => {
                    // what the running runs are doing now (a page that reloads gets the latest)
                    connection.send({ type: 'session.activities', activities: activities.all() });
                    presence.connected(connection);
                }, stateFailed);
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

        // stage 2 of the triage of the messages addressed to the AI: Clef when configured (ADR 0030)
        const classifier = messageClassifier(options, log);
        const debug = options.debug ?? (process.env[DEBUG_ENV] ? log : undefined);

        /** Sends a session's event to every page as its role sees it (a participant: the triages' outcomes only). */
        const publishEvent = (message: EventMessage): void => {
            hub.publishWhere((c) => c.data.role === 'facilitator', message);
            const shown = eventFor('participant', message);
            if (shown) hub.publishWhere((c) => c.data.role !== 'facilitator', shown);
        };

        // the agents connected per role and the work waiting for one: on connect (with the state), then on each change
        let presenceShown = '';
        const agentPresence = async (): Promise<AgentPresence> => {
            const [state, answersWaiting] = await Promise.all([collaboration.sessionState({ session }), agent.answers.waiting()]);
            const queued = state.ok ? state.value.runs.filter((r) => r.state === 'Queued').length : 0;
            return { connected: agent.connected(), waiting: answersWaiting + queued };
        };
        let presenceTail: Promise<void> = Promise.resolve();
        const presenceChanged = (): void => {
            presenceTail = presenceTail
                .then(async () => {
                    const now = await agentPresence();
                    const key = JSON.stringify(now);
                    if (key === presenceShown) return;
                    presenceShown = key;
                    hub.publish({ type: 'agent.presence', agent: now });
                })
                .catch((e: unknown) => log(`agent presence failed: ${e instanceof Error ? e.message : String(e)}`));
        };

        // what the running runs are doing (ADR 0026, amendment): in memory, never stored; dropped once a run ends
        const activities = createRunActivities();
        const ending: ReadonlySet<string> = new Set(RUN_ENDING_EVENTS);

        const agentToken = randomSecrets.newSecret();
        const relay = createEventRelay({
            collaboration,
            session,
            from: await lastSeq(collaboration, session),
            publish: publishEvent,
            after: (entries) => {
                agent.wake();
                // the queue may have moved: a revert at its head is the server's to try
                void reverts.kick();
                // messages addressed to the AI: stage 2 on the server, then the answerer role's jobs
                if (entries.some((e) => e.event.type === 'TriageOpened' || e.event.type === 'TriageReaddressed')) stage.kick();
                agent.answers.kick();
                if (entries.some((e) => e.event.type === 'RevisionRestored')) agent.answers.restored();
                for (const e of entries) {
                    // one line per triage decided (and per override), without the message's text
                    if (e.event.type === 'TriageDecided') debug?.(`triage ${e.event.triageId}: ${e.event.kind} (decided by ${e.event.decidedBy})`);
                    if (e.event.type === 'TriageOverridden') debug?.(`triage ${e.event.triageId}: ${e.event.kind} (overridden by ${e.event.step.stage})`);
                }
                for (const e of entries) if (ending.has(e.event.type) && 'runId' in e.event) activities.end(e.event.runId);
                presenceChanged();
                if (entries.some((e) => e.event.type === 'SessionClosed')) {
                    agent.answers.close(true);
                    void onClosed();
                }
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
            maxPreviousRunDiff: config.agent.maxPreviousRunDiff,
            maxStreams: MAX_AGENT_STREAMS,
            pump,
            activity: (run, activity) => {
                if (activities.set(run, activity)) hub.publish({ type: 'run.activity', run, activity });
            },
            reverts: () => void reverts.kick(),
            answerTimeoutMs: options.answerTimeoutMs ?? ANSWER_TIMEOUT_MS,
            onPresence: () => presenceChanged(),
            log,
            pair: (code) => access.redeemAgentCode({ session, code }),
        });
        const stage = createTriageStage({
            session,
            collaboration,
            ...(classifier && { classifier }),
            threshold: config.classifier.threshold,
            timeoutMs: CLASSIFY_TIMEOUT_MS,
            pump,
            log,
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

        // the reverts at the head of the queue, tried by the server itself (no agent needed), behind the watcher hold
        const reverts = createRevertQueue({
            session,
            collaboration,
            leaseMs,
            holdWatcher: (work, wrote) => watcherHold.aroundWrite(work, wrote),
            pump,
            log,
        });

        // `dt open` answers loopback only: `collab.access` (a tunnel's hosts and origins) is never its
        const accessConfig = mode === 'Solo' ? undefined : config.access;
        const sessionSurface = createSessionHttp({
            session,
            collaboration,
            identities,
            hostPolicy: sessionHostPolicy(accessConfig?.allowedHosts ?? [], accessConfig?.allowedOrigins ?? []),
            pump,
            cursor,
            holdWatcher: (work, wrote) => watcherHold.aroundWrite(work, wrote),
            reverts: () => reverts.kick(),
            disconnect,
            facilitatorChanged,
            closed: onClosed,
            issueFacilitatorLink: async () => {
                const link = await access.issueFacilitatorLink({ session, ttlMs: FACILITATOR_LINK_TTL_MS });
                if (!link.ok) throw new Error('The session is not open');
                return { link: linkOf(url, link.value.code), expiresAt: link.value.expiresAt.toISOString() };
            },
            secureCookie: accessConfig?.publicUrl?.startsWith('https://') ?? false,
            quickReactions: config.quickReactions,
            triaged: () => stage.kick(),
            agentPresence,
            log,
        });
        const http = createViewHttpServer({
            host: config.host,
            api: createApiRoutes({ view, git, publish: (payload) => hub.publish(payload), log }),
            assets: live.assets,
            upgrade: (req, socket, head, auth) => {
                if (auth.kind !== 'participant') return void socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                hub.handleUpgrade(req, socket, head, { participant: auth.participant, role: auth.role, actor: auth.actor });
            },
            session: mode === 'Solo' ? soloSurface(sessionSurface, soloSignIn) : sessionSurface,
        });
        opened.http = http;
        const port = await listen(http, config.port, config.host);
        const url = serverUrl(config.host, port);
        opened.agent = agent.server;
        const agentPort = await listen(agent.server, config.agent.port, '127.0.0.1');
        const agentUrl = serverUrl('127.0.0.1', agentPort);

        watch = await watchLiveView(options, live, (payload) => hub.publish(payload), watcherHold);
        // the credential is never on disk: an older version's agent.json goes
        if (await removeLegacyAgentFile(options.root)) log('Removed .domaintrail/session/agent.json (an agent credential an older version wrote).');
        await writeServerAddress(options.root, { url, agentUrl, session, pid: process.pid });

        const issueFacilitatorLink = async (): Promise<string> => {
            const link = await access.issueFacilitatorLink({ session, ttlMs: FACILITATOR_LINK_TTL_MS });
            if (!link.ok) throw new Error('The session is not open');
            return linkOf(url, link.value.code);
        };
        // the one person of a Solo session is the facilitator already
        // in Solo, the one-time link that signs the launching user's browser in as the facilitator
        const facilitatorLink = mode === 'Solo' ? soloSignIn.link(url) : await issueFacilitatorLink();

        const expiring = setInterval(() => {
            collaboration
                .expireLeases()
                .then(
                    (expired) => (expired.failed.length ? pump() : undefined),
                    (e: unknown) => log(`expiring leases failed: ${e instanceof Error ? e.message : String(e)}`),
                )
                // a revert whose try was refused (or whose server lease expired) is tried again
                .then(
                    () => reverts.kick(),
                    () => undefined,
                );
        }, options.expireEveryMs ?? EXPIRE_EVERY_MS);
        expiring.unref();
        // a revert left at the head of the queue when the server last stopped; triages left waiting for stage 2
        void reverts.kick();
        stage.kick();

        let stopped: Promise<void> | undefined;
        return {
            url,
            agentUrl,
            agentToken,
            session,
            mode,
            resumed: sessionOpened.opened !== 'started',
            opened: sessionOpened.opened,
            facilitatorLink,
            view,
            collaboration,
            ready: watch.ready,
            watcherHold,
            closed,
            issueFacilitatorLink,
            pump,
            stop() {
                stopped ??= (async () => {
                    soloSignIn.revoke();
                    clearInterval(expiring);
                    // the links and pairing codes not used yet die with the server
                    await access.revokeLinks(session).catch(() => undefined);
                    await reverts.stop();
                    for (const timer of expiries.values()) clearTimeout(timer);
                    expiries.clear();
                    presence.dispose();
                    agent.close();
                    await stage.settled();
                    await watch?.stop();
                    hub.close();
                    await Promise.all([close(http), close(agent.server)]);
                    // the transactions in flight end before the database closes
                    await pump().catch(() => undefined);
                    await uow.transaction(() => undefined);
                    db.close();
                    await removeSessionFiles(options.root, process.pid);
                    disposeEngine();
                    served.delete(root);
                })();
                return stopped;
            },
        };
    } catch (e) {
        await Promise.all([opened.http, opened.agent].map((s) => (s?.listening ? close(s) : Promise.resolve())));
        db.close();
        disposeEngine();
        served.delete(root);
        throw e;
    }
}

/**
 * Another facilitator link for the session server running on the workspace at `root` (`dt collab link`): written to
 * the session's database, so the running server accepts it. Rejects with `SessionError` when none runs, or when it
 * serves a Solo session (`dt open`: its one person is the facilitator already).
 */
export async function issueFacilitatorLink(root: string): Promise<{ link: string; expiresAt: Date }> {
    const address = await readServerAddress(root);
    if (!address || !processAlive(address.pid)) throw new SessionError('No session server is running for this workspace (start one with `dt collab`).');
    const db = await openSessionDatabase(root);
    try {
        const access = createSessionAccess({ uow: createUnitOfWork(db), clock: systemClock, secrets: randomSecrets });
        const open = await openSessionOf(db);
        const collaboration = open?.id;
        if (collaboration !== address.session) throw new SessionError('The running session server serves a session that is no longer open.');
        if (open?.mode === 'Solo')
            throw new SessionError('The running server is `dt open`: one person, the facilitator already. Stop it and run `dt collab` to invite others.');
        const link = await access.issueFacilitatorLink({ session: collaboration, ttlMs: FACILITATOR_LINK_TTL_MS });
        if (!link.ok) throw new SessionError('The session is not open.');
        return { link: linkOf(address.url, link.value.code), expiresAt: link.value.expiresAt };
    } finally {
        db.close();
    }
}

/**
 * A one-time agent pairing code for the session server running on the workspace at `root` (`dt collab agent-link`,
 * `dt open agent-link`): `dt agent --code` exchanges it for the agent API's credential. Written (as a hash) to the
 * session's database, so the running server accepts it; never a facilitator link. Rejects with `SessionError` when no
 * server runs.
 */
export async function issueAgentLink(root: string): Promise<{ code: string; agentUrl: string; expiresAt: Date }> {
    const address = await readServerAddress(root);
    if (!address || !processAlive(address.pid))
        throw new SessionError('No session server is running for this workspace (start one with `dt open` or `dt collab`).');
    if (!address.agentUrl) throw new SessionError('The running session server is of an older version: restart it.');
    const db = await openSessionDatabase(root);
    try {
        const access = createSessionAccess({ uow: createUnitOfWork(db), clock: systemClock, secrets: randomSecrets });
        const open = await openSessionOf(db);
        if (open?.id !== address.session) throw new SessionError('The running session server serves a session that is no longer open.');
        const code = await access.issueAgentCode({ session: open.id, ttlMs: AGENT_CODE_TTL_MS });
        if (!code.ok) throw new SessionError('The session is not open.');
        return { code: code.value.code, agentUrl: address.agentUrl, expiresAt: code.value.expiresAt };
    } finally {
        db.close();
    }
}

/** The open session of a database, if any. */
async function openSessionOf(db: Awaited<ReturnType<typeof openSessionDatabase>>): Promise<Collaboration.OpenSession | undefined> {
    const uow = createUnitOfWork(db);
    return uow.transaction((stores) => stores.sessions.listOpen()[0]);
}
