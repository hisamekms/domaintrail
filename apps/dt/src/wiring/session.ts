// `dt open` and `dt collab` (ADR 0026, S4; ADR 0030): the Live View, plus a collaboration session in the same HTTP
// process (its REST API, its WebSocket messages, its identities), and the agent API on a listener of its own bound to
// 127.0.0.1. One open session per workspace, opened in the mode asked for (`openSession`, decision 13): a session of
// that mode is resumed; `dt collab` continues a Solo session as a Collab one; `dt open` refuses an open Collab session.
// In the Solo mode the one person is the facilitator without signing in (./solo.ts) and no facilitator link is made.
// The server runs the triage's stage 2 (Clef, `classifier`) on the messages addressed to the AI, hands the answerer
// role its jobs (the agent API's answers entry point) and tells the pages which agents are connected. In the `link`
// identity mode (docs/session-link.md) it answers its public URL's host and origin only besides loopback, requires an
// Origin on every request that changes something, and lets people in through the invite link and the facilitator's
// approval (../server/session/link-join.ts). When the workspace's knowledge store opens (ADR 0031: `openKnowledgeStore`,
// ./knowledge.ts, with the proof that its settings were approved), the server extracts knowledge from the talk through the extractor role (the agent API's extraction
// entry point), the last time when the session closes.
import {
    type AccessAdapterOptions,
    type AccessTokenVerifier,
    type Clock,
    type Collaboration,
    type CollaborationUseCases,
    createClefClassifier,
    createCloudflareAccess,
    createCollaboration,
    createJoinRequests,
    createRunActivities,
    createSessionAccess,
    createUnitOfWork,
    FACILITATOR_NAME,
    agentJourneys,
    type GuideWorkspace,
    JOURNEY_FILE,
    journeyWhere,
    FACILITATOR_PARTICIPANT,
    type IdentityKey,
    type IdentityProvider,
    type MessageClassifier,
    openSessionBlobs,
    openSessionDatabase,
    randomIds,
    randomSecrets,
    readServerAddress,
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
import { createExtractionDispatcher } from '../server/session/extractions.js';
import { journeyStormings, openKnowledgeStore, type SessionKnowledge, startSessionKnowledge, stickyFocus } from './knowledge.js';
import { type LiveKnowledge, startLiveKnowledge } from './knowledge-live.js';
import { ownRequest, requestOutcomes } from './knowledge-hotspots.js';
import type { SettingsApproval } from '../cli/trust.js';
import type { ResolvedConfig } from '../config/config.js';
import { createApiRoutes } from '../server/http/routes.js';
import { createEventRelay, lastSeq } from '../server/session/relay.js';
import { createPresenceRelay, type SessionConnection } from '../server/session/presence.js';
import { createRevertQueue } from '../server/session/reverts.js';
import { createSessionHttp, meOf, stateBody } from '../server/session/routes.js';
import { createLinkJoin, INVITE_PATH, INVITE_TTL_MS, type LinkJoin } from '../server/session/link-join.js';
import { createSessionIdentities } from '../server/session/identities.js';
import { createTriageStage } from '../server/session/triage.js';
import { eventFor } from '../server/session/views.js';
import { guideWorkspace, knownViewNames } from '../server/session/viewed-at.js';
import { createSessionJourneys, rememberWrites } from '../server/session/journeys.js';
import { pageBoot } from '../server/http/boot.js';
import { createViewHttpServer } from '../server/http/server.js';
import { isLoopbackBind, sessionHostPolicy } from '../server/http/access.js';
import { SessionError, type SessionSettings } from '../cli/ports.js';
import type { ViewService } from '@domaintrail/visualization';
import type { KnowledgeStore } from '@domaintrail/knowledge';
import { createGuardedTextFile, createWorkspaceSnapshot, watchFile } from '@domaintrail/workspace';
import { processAlive } from './process.js';
import { createModelValidator, createSourceFormatter, createStickyEditor } from './validator.js';
import { prepareLiveView, serverUrl, watchLiveView, type ViewServerOptions } from './view.js';
import { createWatcherHold, type WatcherHold } from './watcher-hold.js';
import { workspaceState } from './state.js';
import { createSoloSignIn, SOLO_LINK_PATH, SOLO_LINK_TTL_MS, soloIdentities, soloName, soloSurface } from './solo.js';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

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
/** The most seconds an extraction of knowledge may take, unless given (`agent.extract.timeout`). */
const EXTRACT_TIMEOUT_S = 180;
/** Where the server's one line per triage goes when no `debug` log is given: printed when this variable is set. */
export const DEBUG_ENV = 'DOMAINTRAIL_DEBUG';
/** Where the Clef classifier is asked instead of Cloudflare's API (a local mock, for tests and demos). */
export const CLASSIFIER_URL_ENV = 'DOMAINTRAIL_CLASSIFIER_URL';
/** Longest delay `setTimeout` keeps (about 24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface SessionServerOptions extends ViewServerOptions {
    /** What the session server reads of the configuration (`collab`, `agent.port`, `agent.run`'s tools, `classifier`). */
    session: SessionSettings;
    /**
     * `dt collab --tunnel`: the server is reached through the quick tunnel this process started, so the visitor's
     * address in `CF-Connecting-IP` is that cloudflared's word (the join requests' rate limit). Default: false.
     */
    quickTunnel?: boolean;
    /**
     * `link`: the public URL is known only once the server listens (`dt collab --tunnel` starts its tunnel to the port
     * then, so that nothing else can take the port in between): called with the port bound; until it resolves the
     * server answers loopback only. A rejection stops the server and is the start's.
     */
    publicUrlAfterListen?: (port: number) => Promise<string>;
    /** `access` mode: a stand-in for the JWKS check of the tokens' signature (tests); default: the team's JWKS. */
    accessVerifier?: AccessTokenVerifier;
    /** `access` mode: where the JWKS and the Identity API are and their timings (tests point them at a local mock). */
    accessAdapter?: AccessAdapterOptions;
    clock?: Clock;
    /** How long a claim or a heartbeat holds the agent's lease (default `AGENT_LEASE_MS`). */
    leaseMs?: number;
    /** How long a person waits for the light model's name of their hotspot (ADR 0033; default 6 s). */
    hotspotNameTimeoutMs?: number;
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
    /**
     * The workspace's config and the proof that its security-relevant settings were approved as they are now
     * (`approve` of the CLI): the knowledge store is opened from them (`openKnowledgeStore`), never without the proof.
     * Absent: the session keeps no knowledge.
     */
    knowledge?: { readonly config: ResolvedConfig; readonly approval: SettingsApproval | undefined };
    /**
     * A knowledge store instead of the workspace's, with `session.knowledge` its settings, and its sweep where dt runs
     * it (the `files` store's): for the tests only.
     */
    knowledgeStore?: KnowledgeStore & { readonly sweep?: () => Promise<void> };
    /** How often the knowledge's redaction log is read (default `REDACTION_EVERY_MS`, 3 minutes): for the tests. */
    redactionEveryMs?: number;
    /** The name a session started now gives its facilitator. Default: in `Solo`, git's `user.name` or the OS user's; else `Facilitator`. */
    facilitatorName?: Collaboration.DisplayName;
}

export interface SessionServer {
    /** The page and the session's API. */
    url: string;
    /** The agent API, on 127.0.0.1 (also in `server.json` in the workspace's state directory, without its credential). */
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
    /** The public origin of a `link` session (the tunnel's), which the links are made with; absent in the other modes. */
    publicUrl?: string;
    /** `link`: a new invite link (the previous one stops working). */
    issueInvite?(): Promise<{ link: string; expiresAt: string }>;
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

/** The public origin of a `link` session: `collab.link.publicUrl` (the CLI puts a quick tunnel's there). */
const linkPublicUrl = (config: SessionSettings): string | undefined => config.link?.publicUrl;

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
    if (config.identity === 'link' && options.mode !== 'Solo') {
        if (!isLoopbackBind(config.host))
            throw new SessionError(`The link identity mode serves loopback only (its tunnel connects there); ${config.host} is not a loopback address.`);
        const publicUrl = linkPublicUrl(config);
        const url = publicUrl !== undefined && URL.canParse(publicUrl) ? new URL(publicUrl) : undefined;
        if (url?.protocol !== 'https:' && !options.publicUrlAfterListen)
            throw new SessionError(
                "The link identity mode needs an https public URL: run `dt collab --tunnel`, or set collab.link.publicUrl to your tunnel's.",
            );
        return undefined;
    }
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
    // the session's files are in the workspace's state directory, outside it (an older `.domaintrail/` moved there)
    const state = options.state ?? (await workspaceState(root, log));
    const running = await readServerAddress(state.state).catch(() => undefined);
    if (served.has(root) || (running && running.pid !== process.pid && processAlive(running.pid)))
        throw new SessionError(
            `A session server is already running for this workspace${running ? ` (pid ${running.pid}, ${running.url})` : ''}: stop it before starting another.`,
        );
    const leaseMs = options.leaseMs ?? AGENT_LEASE_MS;
    /** How long a person waits for the light model's name of their hotspot before dt names it (ADR 0033). */
    const HOTSPOT_NAME_TIMEOUT_MS = options.hotspotNameTimeoutMs ?? 6_000;
    const sources = options.sources ?? DEFAULT_SOURCES;
    const respectGitignore = options.respectGitignore ?? true;

    const live = await prepareLiveView({ ...options, state });
    const { view, git, engine } = live;
    const db = await openSessionDatabase(state.state);
    const disposeEngine = (): void => {
        if ('dispose' in engine && typeof engine.dispose === 'function') engine.dispose();
    };
    const opened: { http?: Server; agent?: Server } = {};
    served.add(root);
    try {
        const uow = createUnitOfWork(db);
        const snapshot = createWorkspaceSnapshot(options.root, sourceSelection(sources, respectGitignore));
        // the journey file at the workspace root: dt writes it itself (atomically, never over another's write)
        const journeyFile = createGuardedTextFile(path.join(options.root, JOURNEY_FILE));
        // what dt wrote is remembered: a change of the file that is none of it was made outside dt (recorded in the chat)
        const journeyWrites = rememberWrites(journeyFile);
        const collaboration = createCollaboration({
            uow,
            journeys: journeyWrites,
            workspace: snapshot,
            blobs: await openSessionBlobs(state.state),
            validator: createModelValidator(),
            formatter: createSourceFormatter(),
            stickies: createStickyEditor(),
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

        // `link`: the cookies' names are this server's (a restart signs everyone out), with the `__Host-` prefix (Secure,
        // no Domain, Path=/: the browser keeps them to this very host)
        const linkMode = mode === 'Collab' && config.identity === 'link';
        const publicUrl = linkMode ? linkPublicUrl(config) : undefined;
        const cookieSuffix = randomBytes(6).toString('hex');
        const shared = createSessionIdentities({
            session,
            mode: mode === 'Solo' ? 'dev' : config.identity,
            ...(linkMode && { cookieName: `__Host-dt_link_${cookieSuffix}` }),
            provider,
            acceptAccessCookie: config.access?.acceptCookie ?? false,
            access,
            collaboration,
            maxParticipants: config.maxParticipants,
            // `access`: a newcomer joins while identified; the pages learn of it now (the relay is made below, before
            // the server listens)
            joined: async (participant) => {
                await pump();
                log(`joined: ${participant}`);
            },
        });
        // `link`: the sign-ins of an earlier server (whatever mode it had) end now: everyone is approved again, the
        // facilitator signs in with this server's link
        if (linkMode) await access.signOutAll(session);
        const soloPerson = soloPersonName(sessionOpened.session);
        // `dt open`'s sign-in: in this server's memory, and the codes `dt open link` issued; revoked when it stops
        const soloSignIn = createSoloSignIn({ redeemIssued: (code) => access.redeemOpenCode({ session, code }) });
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
                    state: stateBody(state.value, seq, config.quickReactions, holder, connection.data.role, agentNow, config.templates),
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
                connection.send({ type: 'journey', journey: journeys.body() });
                // whether the session extracts its knowledge (ADR 0031): the facilitator's switch shows it
                if (knowledge) connection.send({ type: 'knowledge.extraction', enabled: knowledge.enabled() });
                if (linkJoin && connection.data.role === 'facilitator')
                    void linkJoin.snapshot().then((snapshot) => connection.send({ type: 'join.requests', ...snapshot }), stateFailed);
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
            // the last extraction of knowledge, before the extractor is told the session closed
            if (knowledge) {
                log('knowledge: the last extraction');
                await knowledge.end(extractTimeoutMs + 15_000).catch((e: unknown) => log(`knowledge: ${e instanceof Error ? e.message : String(e)}`));
            }
            extractions?.close(true);
            helpers.close(true);
            resolveClosed();
        };

        // stage 2 of the triage of the messages addressed to the AI: Clef when configured (ADR 0030)
        const classifier = messageClassifier(options, log);
        const debug = options.debug ?? (process.env[DEBUG_ENV] ? log : undefined);

        // the journey file: read now, sent to every page on each change (dt's writes, git, another tool)
        const journeys = createSessionJourneys({
            session,
            store: journeyWrites,
            // an ES journey is named by its storming's label, as the page names it
            labels: (key) => (key.startsWith('es:') ? guideWorkspace(view.state).stormings.find((s) => s.id === key.slice(3))?.label : undefined),
            collaboration,
            changed: (journey) => hub.publish({ type: 'journey', journey }),
            // the relay is made below; a record is written only on a change after the first read
            recorded: () => pump(),
            now: () => clock.now(),
            log,
        });
        await journeys.reload();
        await journeys.restore();

        /** Sends a session's event to every page as its role sees it (a participant: the triages' outcomes only). */
        const publishEvent = (message: EventMessage): void => {
            hub.publishWhere((c) => c.data.role === 'facilitator', message);
            const shown = eventFor('participant', message);
            if (shown) hub.publishWhere((c) => c.data.role !== 'facilitator', shown);
        };

        // the agents connected per role and the work waiting for one: on connect (with the state), then on each change
        let presenceShown = '';
        const agentPresence = async (): Promise<AgentPresence> => {
            const [state, answersWaiting, givenUp] = await Promise.all([
                collaboration.sessionState({ session }),
                agent.answers.waiting(),
                agent.answers.givenUp(),
            ]);
            const queued = state.ok ? state.value.runs.filter((r) => r.state === 'Queued').length : 0;
            return { connected: agent.connected(), waiting: answersWaiting + queued, ...(givenUp.length > 0 && { givenUp }) };
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
        // the knowledge of the session (ADR 0031): extracted only when the workspace's store opens; else said, and none
        const knowledgeConfig = options.knowledge?.config.knowledge ?? config.knowledge;
        const given = options.knowledgeStore;
        let sweep: (() => Promise<void>) | undefined = given?.sweep && (() => given.sweep?.() ?? Promise.resolve());
        let store: KnowledgeStore | undefined = given;
        if (!store && options.knowledge) {
            const opened = await openKnowledgeStore(options.knowledge.config, options.knowledge.approval).catch((e: unknown) => ({
                ok: false as const,
                error: { message: e instanceof Error ? e.message : String(e) },
            }));
            if (opened.ok) {
                store = opened.value.store;
                sweep = opened.value.sweep;
            } else log(`knowledge: not extracted in this session (${opened.error.message})`);
        }
        // the Live View's knowledge over the same store: its routes, the pages told of changes, the redaction log followed
        const liveKnowledge: LiveKnowledge | undefined =
            store && knowledgeConfig
                ? startLiveKnowledge({
                      store,
                      project: knowledgeConfig.project,
                      ...(sweep && { sweep }),
                      db,
                      uow,
                      clock,
                      session,
                      publish: (message) => hub.publish(message),
                      sessionRedacted: facilitatorChanged,
                      ...(options.redactionEveryMs !== undefined && { everyMs: options.redactionEveryMs }),
                      log,
                      // a conflict made a hotspot follows its message (ADR 0031, section 4)
                      requests: {
                          outcomeOf: requestOutcomes(collaboration, session),
                          isOwn: (request, participant) => ownRequest(collaboration, session, request, participant),
                      },
                  })
                : undefined;
        if (liveKnowledge) store = liveKnowledge.store;
        const extractTimeoutMs = (config.agent.extractTimeout ?? EXTRACT_TIMEOUT_S) * 1000;
        let knowledge: SessionKnowledge | undefined;
        const extractions = store
            ? createExtractionDispatcher({
                  timeoutMs: extractTimeoutMs,
                  maxStreams: MAX_AGENT_STREAMS,
                  token: agentToken,
                  onConnected: () => knowledge?.kick(),
                  log,
              })
            : undefined;
        // the light model's small jobs, whatever the knowledge config: a hotspot's name (ADR 0033), on a stream of their own
        const helpers = createExtractionDispatcher({ timeoutMs: HOTSPOT_NAME_TIMEOUT_MS, maxStreams: MAX_AGENT_STREAMS, token: agentToken, log });
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
                // a message, or the AI's answer: the extraction of knowledge decides when to run
                knowledge?.observe(entries);
                // a run ended, a proposal decided, a message triaged: the conflicts being made hotspots may be settled
                void liveKnowledge?.handOvers?.settle();
                presenceChanged();
                if (entries.some((e) => e.event.type === 'SessionClosed')) {
                    agent.answers.close(true);
                    void onClosed();
                }
            },
        });
        cursor = () => relay.cursor();
        const pump = (): Promise<void> => relay.pump();
        /** The guide's workspace now: the view's model, stormings and findings, the journey file's findings, the file. */
        const guideWorkspaceNow = (): GuideWorkspace => {
            const seen = guideWorkspace(view.state);
            const names = knownViewNames(view.state);
            const file = journeys.file();
            return {
                ...seen,
                diagnostics: [...seen.diagnostics, ...journeys.diagnostics({ contexts: names.contexts, stormings: names.stormings.keys() })],
                ...(file && { journey: file }),
            };
        };
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
            // the people's edits a run dropped are written again before the agent claims the next run (ADR 0033)
            afterRun: async (run) => {
                const r = await watcherHold.aroundWrite(
                    () => collaboration.reapplyEdits({ session, run }),
                    (done) => done.reapplied !== undefined,
                );
                if (r.reapplied) log(`re-applied people's edits after run ${run} (run ${r.reapplied.id})`);
                if (r.conflicts.length > 0) log(`run ${run} changed ${r.conflicts.length} edited label(s) otherwise: left to people`);
                await pump();
            },
            answerTimeoutMs: options.answerTimeoutMs ?? ANSWER_TIMEOUT_MS,
            onPresence: () => presenceChanged(),
            log,
            pair: (code) => access.redeemAgentCode({ session, code }),
            ...(extractions && { extractions }),
            helpers,
            journeys: async () => {
                const file = journeys.file();
                if (!file) return undefined;
                const state = await collaboration.sessionState({ session });
                const given = agentJourneys(file, state.ok ? state.value.session.currentJourney : undefined);
                // where the current journey stands, by the chip's rule (the guide's map of it, from the files now)
                const where = given.current === undefined ? undefined : journeyWhere(guideWorkspaceNow(), given.current);
                return { ...given, ...(where && { where }) };
            },
        });
        if (store && extractions && knowledgeConfig)
            knowledge = await startSessionKnowledge({
                store,
                config: knowledgeConfig,
                session,
                collaboration,
                db,
                extractor: extractions,
                now: () => clock.now(),
                log,
                switched: (enabled) => hub.publish({ type: 'knowledge.extraction', enabled }),
                // the workspace's stickies of each extraction: the stormings the view analysed, those the pages have open, the journey's
                workspace: async () => {
                    const file = journeys.file();
                    const state = file ? await collaboration.sessionState({ session }) : undefined;
                    const chosen = state?.ok ? state.value.session.currentJourney : undefined;
                    return stickyFocus(
                        view.state.stormings.map((s) => s.storming),
                        presence.presences(),
                        journeyStormings(file, chosen),
                    );
                },
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

        // `dt open` answers loopback only: `collab.access` (a tunnel's hosts and origins) is never its; `link` answers its
        // public URL's host and origin only
        const accessConfig = mode === 'Solo' || linkMode ? undefined : config.access;
        // `link`: the public origin, known now (configured) or once the server listens (a quick tunnel's)
        let publicOrigin = publicUrl === undefined || options.publicUrlAfterListen ? undefined : new URL(publicUrl);
        /** The Host and Origin rules as of now: a `link` session's public origin is added once it is known. */
        const hostRules = (): ReturnType<typeof sessionHostPolicy> =>
            publicOrigin
                ? sessionHostPolicy([publicOrigin.hostname], [publicOrigin.origin])
                : sessionHostPolicy(accessConfig?.allowedHosts ?? [], accessConfig?.allowedOrigins ?? []);
        /** The base the links are made with: the public origin of a `link` session, else the server's address. */
        const linkBase = (): string => (publicOrigin ? `${publicOrigin.origin}/` : url);
        // `link`: the invite link and the join requests, the facilitator's pages told of each change
        const linkJoin: LinkJoin | undefined = linkMode
            ? createLinkJoin({
                  session,
                  access,
                  identities,
                  requests: createJoinRequests({ clock, secrets: randomSecrets }),
                  publicUrl: () => linkBase().replace(/\/$/, ''),
                  // the participants who joined, and the names of the pages connected (the facilitator's own among them)
                  participantNames: async () => {
                      const state = await collaboration.sessionState({ session });
                      const joined = state.ok ? state.value.session.participants.map((p) => p.name) : [];
                      return [...new Set([...joined, ...[...pages.values()].map((c) => c.data.participant.identity.displayName)])];
                  },
                  waitCookie: `__Host-dt_wait_${cookieSuffix}`,
                  changed: () => {
                      void linkJoin
                          ?.snapshot()
                          .then((snapshot) => hub.publishWhere((c) => c.data.role === 'facilitator', { type: 'join.requests', ...snapshot }), stateFailed);
                  },
                  disconnect,
                  pump,
                  log,
                  trustForwarded: options.quickTunnel ?? false,
              })
            : undefined;
        const sessionSurface = createSessionHttp({
            session,
            collaboration,
            identities,
            hostPolicy: {
                allowedHost: (hostname) => hostRules().allowedHost(hostname),
                allowedOrigin: (origin, host) => hostRules().allowedOrigin?.(origin, host) ?? false,
                ...(linkMode && { requireOrigin: true }),
            },
            ...(linkJoin && { link: linkJoin }),
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
                return { link: linkOf(linkBase(), link.value.code), expiresAt: link.value.expiresAt.toISOString() };
            },
            secureCookie: linkMode || (accessConfig?.publicUrl?.startsWith('https://') ?? false),
            quickReactions: config.quickReactions,
            ...(config.templates && { templates: config.templates }),
            triaged: () => stage.kick(),
            agentPresence,
            retryAnswer: (request) => agent.answers.retry(request),
            // the light model names a hotspot a person writes (ADR 0033), through the extractor role; none: dt names it
            hotspotName: async (input: Parameters<typeof helpers.hotspotName>[0]): Promise<unknown> => {
                const answer = await helpers.hotspotName(input, HOTSPOT_NAME_TIMEOUT_MS);
                if (answer.kind !== 'done' || answer.result.error !== undefined) return undefined;
                const reply = answer.result.reply;
                return typeof reply === 'object' && reply !== null && 'name' in reply ? reply.name : undefined;
            },
            knownViewNames: () => knownViewNames(view.state),
            guideWorkspace: guideWorkspaceNow,
            journeys,
            ...(liveKnowledge && { knowledge: liveKnowledge.routes }),
            ...(knowledge && { extraction: knowledge }),
            log,
        });
        const http = createViewHttpServer({
            host: config.host,
            api: createApiRoutes({ view, git, sources: live.sources, publish: (payload) => hub.publish(payload), log }),
            assets: live.assets,
            upgrade: (req, socket, head, auth) => {
                if (auth.kind !== 'participant') return void socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                hub.handleUpgrade(req, socket, head, { participant: auth.participant, role: auth.role, actor: auth.actor });
            },
            session: mode === 'Solo' ? soloSurface(sessionSurface, soloSignIn) : sessionSurface,
            boot: pageBoot(options.root, mode),
        });
        opened.http = http;
        const port = await listen(http, config.port, config.host);
        const url = serverUrl(config.host, port);
        opened.agent = agent.server;
        const agentPort = await listen(agent.server, config.agent.port, '127.0.0.1');
        const agentUrl = serverUrl('127.0.0.1', agentPort);
        if (options.publicUrlAfterListen) {
            const given = await options.publicUrlAfterListen(port);
            const parsed = URL.canParse(given) ? new URL(given) : undefined;
            if (parsed?.protocol !== 'https:') throw new SessionError(`The public URL must be https: ${given}`);
            publicOrigin = new URL(parsed.origin);
        }

        watch = await watchLiveView(options, live, (payload) => hub.publish(payload), watcherHold);
        // the journey file is watched on its own (it is no source): a change from git or another tool reaches the pages
        const journeyWatch = await watchFile(journeyFile.path, () => void journeys.reload());
        await writeServerAddress(state.state, { url, agentUrl, ...(publicOrigin && { publicUrl: publicOrigin.origin }), session, pid: process.pid });

        const issueFacilitatorLink = async (): Promise<string> => {
            const link = await access.issueFacilitatorLink({ session, ttlMs: FACILITATOR_LINK_TTL_MS });
            if (!link.ok) throw new Error('The session is not open');
            return linkOf(linkBase(), link.value.code);
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
            // the join requests that expired, and an invite changed by `dt collab invite`
            void linkJoin?.sweep().catch((e: unknown) => log(`join requests failed: ${e instanceof Error ? e.message : String(e)}`));
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
            ...(publicOrigin && { publicUrl: publicOrigin.origin }),
            ...(linkJoin && {
                issueInvite: async (): Promise<{ link: string; expiresAt: string }> => {
                    const invite = await linkJoin.issueInvite();
                    if (!invite.ok) throw new Error('The session is not open');
                    return invite.value;
                },
            }),
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
                    // the `files` store's sweep runs with the redaction log's reading (./knowledge-live.ts)
                    liveKnowledge?.stop();
                    // the links and pairing codes not used yet die with the server; in `link`, every sign-in too
                    await access.revokeLinks(session).catch(() => undefined);
                    if (linkMode) await access.signOutAll(session).catch(() => undefined);
                    await reverts.stop();
                    await journeyWatch();
                    for (const timer of expiries.values()) clearTimeout(timer);
                    expiries.clear();
                    presence.dispose();
                    knowledge?.stop();
                    extractions?.close(false);
                    helpers.close(false);
                    agent.close();
                    await stage.settled();
                    await watch?.stop();
                    hub.close();
                    await Promise.all([close(http), close(agent.server)]);
                    // the transactions in flight end before the database closes
                    await pump().catch(() => undefined);
                    await uow.transaction(() => undefined);
                    db.close();
                    await removeSessionFiles(state.state, process.pid);
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
    const { state } = await workspaceState(root, (line) => console.error(line));
    const address = await readServerAddress(state);
    if (!address || !processAlive(address.pid)) throw new SessionError('No session server is running for this workspace (start one with `dt collab`).');
    const db = await openSessionDatabase(state);
    try {
        const access = createSessionAccess({ uow: createUnitOfWork(db), clock: systemClock, secrets: randomSecrets });
        const open = await openSessionOf(db);
        const collaboration = open?.id;
        if (collaboration !== address.session) throw new SessionError('The running session server serves a session that is no longer open.');
        if (open?.mode === 'Solo')
            throw new SessionError('The running server is `dt open`: one person, the facilitator already. Stop it and run `dt collab` to invite others.');
        const link = await access.issueFacilitatorLink({ session: collaboration, ttlMs: FACILITATOR_LINK_TTL_MS });
        if (!link.ok) throw new SessionError('The session is not open.');
        return { link: linkOf(address.publicUrl ? `${address.publicUrl}/` : address.url, link.value.code), expiresAt: link.value.expiresAt };
    } finally {
        db.close();
    }
}

/**
 * A new invite link for the `link` session running on the workspace at `root` (`dt collab invite`): written (as a
 * hash) to the session's database, revoking the previous one; the running server notices within seconds (the requests
 * made through the previous one expire). With `stop`, the invite is revoked and nothing is made. Rejects with
 * `SessionError` when no `link` session runs.
 */
export async function issueInvite(root: string, stop = false): Promise<{ link: string; expiresAt: Date } | { stopped: boolean }> {
    const { state } = await workspaceState(root, (line) => console.error(line));
    const address = await readServerAddress(state);
    if (!address || !processAlive(address.pid))
        throw new SessionError('No session server is running for this workspace (start one with `dt collab --tunnel`).');
    if (!address.publicUrl) throw new SessionError('The running session is not of the link identity mode: people join it without an invite link.');
    const db = await openSessionDatabase(state);
    try {
        const access = createSessionAccess({ uow: createUnitOfWork(db), clock: systemClock, secrets: randomSecrets });
        const open = await openSessionOf(db);
        if (open?.id !== address.session) throw new SessionError('The running session server serves a session that is no longer open.');
        if (stop) return { stopped: await access.revokeInvite(open.id) };
        const invite = await access.issueInvite({ session: open.id, ttlMs: INVITE_TTL_MS });
        if (!invite.ok) throw new SessionError('The session is not open.');
        return { link: `${address.publicUrl}${INVITE_PATH}?code=${invite.value.code}`, expiresAt: invite.value.expiresAt };
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
    const { state } = await workspaceState(root, (line) => console.error(line));
    const address = await readServerAddress(state);
    if (!address || !processAlive(address.pid))
        throw new SessionError('No session server is running for this workspace (start one with `dt open` or `dt collab`).');
    if (!address.agentUrl) throw new SessionError('The running session server is of an older version: restart it.');
    const db = await openSessionDatabase(state);
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

/**
 * Another one-time sign-in link for the `dt open` server running on the workspace at `root` (`dt open link`): single
 * use, for `SOLO_LINK_TTL_MS`, written (as a hash, in a domain of its own) to the session's database, where the running
 * server redeems it; revoked when it stops. Rejects with `SessionError` when no server runs, or when it is `dt collab`'s.
 */
export async function issueOpenLink(root: string): Promise<{ link: string; expiresAt: Date }> {
    const { state } = await workspaceState(root, (line) => console.error(line));
    const address = await readServerAddress(state);
    if (!address || !processAlive(address.pid)) throw new SessionError('No session server is running for this workspace (start one with `dt open`).');
    const db = await openSessionDatabase(state);
    try {
        const access = createSessionAccess({ uow: createUnitOfWork(db), clock: systemClock, secrets: randomSecrets });
        const open = await openSessionOf(db);
        if (open?.id !== address.session) throw new SessionError('The running session server serves a session that is no longer open.');
        if (open.mode !== 'Solo')
            throw new SessionError('The running server is `dt collab`: people join with its address, and `dt collab link` prints a facilitator link.');
        const code = await access.issueOpenCode({ session: open.id, ttlMs: SOLO_LINK_TTL_MS });
        if (!code.ok) throw new SessionError('The session is not open.');
        return { link: `${address.url}${SOLO_LINK_PATH.slice(1)}?code=${code.value.code}`, expiresAt: code.value.expiresAt };
    } finally {
        db.close();
    }
}

/** The open session of a database, if any. */
async function openSessionOf(db: Awaited<ReturnType<typeof openSessionDatabase>>): Promise<Collaboration.OpenSession | undefined> {
    const uow = createUnitOfWork(db);
    return uow.transaction((stores) => stores.sessions.listOpen()[0]);
}
