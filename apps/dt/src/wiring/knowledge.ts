// The knowledge of a session (ADR 0031): the workspace's knowledge store, and the session's extractions wired to the
// session server — its talk read from the collaboration, its checkpoint in the session database, its extractor reached
// through the agent API's extraction entry point, its timing on the server's timers.
import {
    createExtractionScheduler,
    createSessionExtraction,
    createSqliteCheckpoints,
    type ExtractionScheduler,
    type KnowledgeStore,
    type ResolvedKnowledgeConfig,
    type SessionMessage,
    type SessionTalk,
} from '@domaintrail/knowledge';
import { type Collaboration, type CollaborationUseCases, isAi, plainBody } from '@domaintrail/collaboration';
import type { DatabaseSync } from 'node:sqlite';
import type { ExtractionDispatcher } from '../server/session/extractions.js';

/** Longest delay `setTimeout` keeps (about 24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The knowledge store of the workspace, by `knowledge.store`: where the store's adapters are made — the `files` one
 * (`knowledge/*.md` in `root`) and the `cloudflare` one (the Worker at `knowledge.url`, its service token from the
 * environment). None is made here yet, so a session extracts nothing: with no store, the agent API's extraction entry
 * point answers 404 and the extractor stays idle.
 */
export function knowledgeStore(_config: ResolvedKnowledgeConfig, _root: string): KnowledgeStore | undefined {
    return undefined;
}

/**
 * The session's talk as the extraction reads it: every message in order but the reverts and dt's own notices, each
 * person named `P1`, `P2`, … in the order they first wrote (never by name), the AI `AI`; the stickies a message points
 * at (`<Storming>.<LocalId>`, with the label it had); an answer is the AI's reply to a message.
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
}

export interface SessionKnowledge {
    /** Events of the session: a message (a person's, or the AI's answer) makes the extraction decide again. */
    observe(events: readonly { readonly event: { readonly type: string } }[]): void;
    /** An extractor connected, or the server started: decide again. */
    kick(): void;
    /** The session ended: the last extraction, waited for at most `timeoutMs`. */
    end(timeoutMs: number): Promise<void>;
    stop(): void;
}

export function startSessionKnowledge(deps: SessionKnowledgeDeps): SessionKnowledge {
    const { config, log } = deps;
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
    });
    // what a restart left: held operations to settle, an extraction to send again, messages not yet extracted
    scheduler.kick();
    return {
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
