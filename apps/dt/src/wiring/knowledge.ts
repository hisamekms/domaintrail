// The one place that turns the workspace's `knowledge` section into a `KnowledgeStore` (ADR 0031, section 5): `dt mcp`,
// the extraction of a session and the Live View all open the store here, so that they read and write the same one. Below
// it, the session's extractions wired to the session server (ADR 0031, section 3): its talk read from the collaboration
// (each person's message judged surely nothing or not by the triage's stage 1), its checkpoint and its switch in the
// session database, its extractor and light model reached through the agent API, its timing on the server's timers.
//
// - `files`: the items in `<root>/knowledge`, the deleted items and the extractions applied in the workspace's state
//   directory (outside it, `<state>/knowledge`).
// - `cloudflare`: the Worker at `knowledge.url`, reached with the Access service token of the environment
//   (`knowledgeCredentials`). Without one, the result says which variables to set (a Worker on a loopback host —
//   `wrangler dev` — is reached without one).
//
// The token goes where `knowledge.url` says, and that comes from the workspace's config, which a commit can change. So
// the `cloudflare` store is built only with the proof that the workspace's security-relevant settings — `knowledge.url`
// and `knowledge.project` among them — were approved as they are now (`SettingsApproval`, made only by
// `approveSettings` and `checkApproved` of cli/trust.ts, checked by `approvedFor`): no caller can skip the check, and a
// proof made before the URL changed proves nothing.
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type Collaboration, type CollaborationUseCases, isAi, mechanicalVerdict, plainBody } from '@domaintrail/collaboration';
import {
    cloudflareKnowledgeStore,
    createFilesKnowledgeStore,
    err,
    knowledgeCredentials,
    missingCredentialsMessage,
    Knowledge,
    KNOWLEDGE_DIR,
    ok,
    type KnowledgeStore,
    type ResolvedKnowledgeConfig,
    type Result,
    createExtractionScheduler,
    createSessionExtraction,
    createSqliteCheckpoints,
    createSqliteExtractionSwitches,
    type ExtractionScheduler,
    loadExtractionSwitch,
    type SessionMessage,
    type SessionTalk,
} from '@domaintrail/knowledge';
import type { ExtractionDispatcher } from '../server/session/extractions.js';
import { approvedFor, type SettingsApproval } from '../cli/trust.js';
import type { ResolvedConfig } from '../config/config.js';
import { workspaceState } from './state.js';

/** The store of a workspace, opened, and the project every call names. */
export interface OpenedKnowledgeStore {
    readonly kind: ResolvedKnowledgeConfig['store'];
    readonly store: KnowledgeStore;
    readonly project: Knowledge.ProjectName;
    /**
     * Completes the deletions past the undo window while nothing is written (the `files` store's sweep; a writer calls
     * it on a timer). Absent where the store sweeps by itself.
     */
    readonly sweep?: () => Promise<void>;
}

/** Why the workspace's store cannot be opened, as one line. */
export interface KnowledgeStoreUnavailable {
    readonly type: 'KnowledgeStoreUnavailable';
    readonly store: ResolvedKnowledgeConfig['store'];
    readonly message: string;
}

export interface KnowledgeStoreOptions {
    /** The workspace's state directory (default: opened as every command does, `workspaceState`); rejects with `StateError`. */
    readonly stateDir?: (root: string) => Promise<string>;
    /** The clock (tests). */
    readonly now?: () => Date;
    /** Where the `cloudflare` store's service token is read (default: `process.env`). */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** The `cloudflare` store's `fetch` (tests). */
    readonly fetch?: typeof fetch;
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** Why the `cloudflare` store is not opened without the approval of the settings. */
export const NOT_APPROVED =
    "the knowledge store 'cloudflare' sends its service token to knowledge.url, and this workspace's settings (knowledge.url and knowledge.project among them) are not approved as they are now: run `dt open` (or `dt collab`, `dt agent`) in a terminal once to approve them";

/**
 * Opens the knowledge store `cfg` names in its `knowledge` section, for the workspace at `cfg.root`. The `cloudflare`
 * store needs `approval`, the proof that `cfg`'s security-relevant settings were approved as they are now (see the
 * module's comment); the `files` store sends nothing anywhere and needs none. Rejects with `StateError` when the state
 * directory cannot be used; the store itself is opened lazily (nothing is read or written until a call).
 */
export async function openKnowledgeStore(
    cfg: ResolvedConfig,
    approval: SettingsApproval | undefined,
    options: KnowledgeStoreOptions = {},
): Promise<Result<OpenedKnowledgeStore, KnowledgeStoreUnavailable>> {
    const { knowledge, root } = cfg;
    switch (knowledge.store) {
        case 'files': {
            const state = options.stateDir ? await options.stateDir(root) : (await workspaceState(root, (line) => console.error(line))).state;
            const store = createFilesKnowledgeStore({
                dir: path.join(root, KNOWLEDGE_DIR),
                project: knowledge.project,
                stateDir: path.join(state, KNOWLEDGE_DIR),
                ...(options.now && { now: options.now }),
            });
            return ok({ kind: 'files', store, project: knowledge.project, sweep: () => store.sweep() });
        }
        case 'cloudflare': {
            if (!approvedFor(approval, cfg)) return err({ type: 'KnowledgeStoreUnavailable', store: 'cloudflare', message: NOT_APPROVED });
            const credentials = knowledgeCredentials(options.env ?? process.env);
            const loopback = LOOPBACK.includes(new URL(knowledge.url).hostname);
            if (!credentials.ok && !loopback)
                return err({ type: 'KnowledgeStoreUnavailable', store: 'cloudflare', message: missingCredentialsMessage(credentials.error) });
            const store = cloudflareKnowledgeStore({
                url: knowledge.url,
                ...(credentials.ok && { serviceToken: credentials.value }),
                ...(options.fetch && { fetch: options.fetch }),
            });
            return ok({ kind: 'cloudflare', store, project: knowledge.project });
        }
    }
}

/** Longest delay `setTimeout` keeps (about 24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The session's talk as the extraction reads it: every message in order but the reverts and dt's own notices, each
 * person named `P1`, `P2`, … in the order they first wrote (never by name), the AI `AI`; the stickies a message points
 * at (`<Storming>.<LocalId>`, with the label it had); an answer is the AI's reply to a message. A person's message is
 * surely nothing when the triage's stage 1 says so (empty, emoji only, a fixed acknowledgement: ADR 0030's list).
 */
export function sessionTalk(collaboration: CollaborationUseCases, session: Collaboration.SessionId): SessionTalk {
    return {
        async messages() {
            const state = await collaboration.sessionState({ session });
            if (!state.ok) return [];
            const aliases = new Map<string, string>();
            const alias = (participant: string): string => {
                const known = aliases.get(participant);
                if (known) return known;
                const made = `P${aliases.size + 1}`;
                aliases.set(participant, made);
                return made;
            };
            return state.value.requests
                .filter((r) => r.reverts === undefined && r.journeyNote === undefined)
                .map((r): SessionMessage => {
                    const ai = isAi(r.author);
                    return {
                        id: r.id,
                        at: r.sentAt,
                        from: ai ? 'ai' : 'person',
                        author: ai ? 'AI' : alias(r.author),
                        text: plainBody(r.body, { targets: r.targets.length, people: r.mentions.length }),
                        stickies: r.targets.flatMap((t) =>
                            t.target.kind === 'DtesElement' ? [{ ref: `${t.target.storming}.${t.target.local}`, ...(t.label && { label: t.label }) }] : [],
                        ),
                        answer: ai && r.replyTo?.kind === 'Message',
                        ...(!ai && mechanicalVerdict(r.body).verdict === 'NotForAi' && { nothing: true }),
                    };
                });
        },
    };
}

export interface SessionKnowledgeDeps {
    readonly store: KnowledgeStore;
    readonly config: ResolvedKnowledgeConfig;
    readonly session: Collaboration.SessionId;
    readonly collaboration: CollaborationUseCases;
    /** The session database: the extraction's checkpoint and cost records are kept beside the collaboration's tables. */
    readonly db: DatabaseSync;
    readonly extractor: ExtractionDispatcher;
    readonly now: () => Date;
    readonly log: (line: string) => void;
    /** The facilitator switched the extraction (after it was kept): tell the pages. */
    readonly switched?: (enabled: boolean) => void;
}

export interface SessionKnowledge {
    /** Whether the session extracts now (the config's default, else as the facilitator last switched it). */
    enabled(): boolean;
    /** The facilitator switches the extraction for the session: kept in the session database, the pages told. */
    setEnabled(enabled: boolean): Promise<void>;
    /** Events of the session: a message (a person's, or the AI's answer) makes the extraction decide again. */
    observe(events: readonly { readonly event: { readonly type: string } }[]): void;
    /** An extractor connected, or the server started: decide again. */
    kick(): void;
    /** The session ended: the last extraction, waited for at most `timeoutMs`. */
    end(timeoutMs: number): Promise<void>;
    stop(): void;
}

export async function startSessionKnowledge(deps: SessionKnowledgeDeps): Promise<SessionKnowledge> {
    const { config, log } = deps;
    const switched = await loadExtractionSwitch({
        session: deps.session,
        switches: createSqliteExtractionSwitches(deps.db),
        byDefault: config.extraction.enabled,
        now: deps.now,
    });
    log(`knowledge: extraction ${switched.enabled() ? 'on' : 'off'} (the facilitator can switch it)`);
    const extraction = createSessionExtraction({
        project: config.project,
        session: deps.session,
        store: deps.store,
        checkpoints: createSqliteCheckpoints(deps.db),
        talk: sessionTalk(deps.collaboration, deps.session),
        extractor: deps.extractor,
        config: config.extraction,
        now: deps.now,
        log,
    });
    const scheduler: ExtractionScheduler = createExtractionScheduler({
        extraction,
        timing: { quietMs: config.extraction.quietSeconds * 1000, minIntervalMs: config.extraction.minIntervalSeconds * 1000 },
        now: deps.now,
        timers: {
            set(ms, run) {
                const timer = setTimeout(run, Math.min(ms, MAX_TIMER_MS));
                timer.unref();
                return () => clearTimeout(timer);
            },
        },
        log,
        enabled: switched.enabled(),
    });
    // what a restart left: held operations to settle, an extraction to send again, messages not yet extracted
    scheduler.kick();
    return {
        enabled: () => switched.enabled(),
        async setEnabled(enabled) {
            if (!(await switched.set(enabled))) return;
            log(`knowledge: extraction switched ${enabled ? 'on' : 'off'} by the facilitator`);
            scheduler.setEnabled(enabled);
            deps.switched?.(enabled);
        },
        observe(events) {
            if (events.some((e) => e.event.type === 'RequestSent')) scheduler.kick();
        },
        kick: () => scheduler.kick(),
        async end(timeoutMs) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const late = new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                    log('knowledge: the last extraction did not end in time; the session closes without it');
                    resolve();
                }, timeoutMs);
                timer.unref();
            });
            await Promise.race([scheduler.end(), late]);
            clearTimeout(timer);
        },
        stop: () => scheduler.stop(),
    };
}
