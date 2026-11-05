// The knowledge of a running session as the Live View sees it (ADR 0031, sections 7 and 10), over the store the session
// server opened (`openKnowledgeStore`, one per server): the page's routes (../server/session/knowledge.ts), the pages
// told when the knowledge changed — a person's change through those routes, and every extraction the store applied —
// and the redaction log followed, from where this dt left off: when the server starts, then every few minutes, each
// time after the `files` store's sweep (which appends the deletions past their undo window to the log).
//
// Redacting a message forgets, in the one session database: the extraction's held operations quoting it
// (`forgetHeldQuotes`), then the message and its copies (`createRedaction`), whose transaction is followed by a WAL
// checkpoint. A page of this session is sent the session's state again when one of its messages was redacted.
//
// The conflicts made hotspots (ADR 0031, section 4) are kept here too: the presses of ホットスポットにする in the session
// database, settled when the server starts and whenever the session moved (`handOvers.settle`, called by the session
// server), the pages told (`knowledge.changed`) when one is kept or settled.
import type { DatabaseSync } from 'node:sqlite';
import { type Clock, createRedaction } from '@domaintrail/collaboration';

type UnitOfWork = Parameters<typeof createRedaction>[0]['uow'];
import {
    createHotspotHandOvers,
    createRedactionSync,
    createSqliteHotspotHandOvers,
    createSqliteRedactionCursors,
    type HotspotHandOvers,
    type RequestOutcome,
    forgetHeldQuotes,
    type Knowledge,
    type KnowledgeStore,
    type RedactionSync,
} from '@domaintrail/knowledge';
import { KNOWLEDGE_CHANGED, type KnowledgeChangedMessage } from '@domaintrail/knowledge/protocol';
import { createKnowledgeRoutes, type KnowledgeRoutes } from '../server/session/knowledge.js';

/** How often the redaction log is read (and the `files` store swept first). */
export const REDACTION_EVERY_MS = 3 * 60_000;

export interface LiveKnowledgeDeps {
    readonly store: KnowledgeStore;
    readonly project: Knowledge.ProjectName;
    /** The `files` store's sweep (absent where the store sweeps by itself). */
    readonly sweep?: () => Promise<void>;
    /** The session database, its unit of work and clock: where the messages are redacted. */
    readonly db: DatabaseSync;
    readonly uow: UnitOfWork;
    readonly clock: Clock;
    /** The session this server runs. */
    readonly session: string;
    /** Sends a message to every page. */
    readonly publish: (message: KnowledgeChangedMessage) => void;
    /** Messages of this session were redacted: every page gets the session's state again. */
    readonly sessionRedacted: () => void;
    readonly everyMs?: number;
    readonly log: (line: string) => void;
    /**
     * What became of a message sent to the AI, and whether a message is a participant's own: the hand-overs of conflicts
     * made hotspots follow them (ADR 0031, section 4). Absent: no hand-overs.
     */
    readonly requests?: {
        readonly outcomeOf: (request: string) => Promise<RequestOutcome>;
        readonly isOwn: (request: string, participant: string) => Promise<boolean>;
    };
}

export interface LiveKnowledge {
    /** The store that tells the pages when an extraction applied something: the one the extraction is given. */
    readonly store: KnowledgeStore;
    readonly routes: KnowledgeRoutes;
    readonly redactions: RedactionSync;
    /** The conflicts being made hotspots: settled whenever the session moved (absent without `requests`). */
    readonly handOvers?: HotspotHandOvers;
    stop(): void;
}

/** A store that calls `changed` after each extraction it applied (a replay applies nothing new: not told). */
export function tellingExtractions(store: KnowledgeStore, changed: () => void): KnowledgeStore {
    return {
        ...store,
        async applyExtraction(project, extraction) {
            const applied = await store.applyExtraction(project, extraction);
            if (!applied.replayed && applied.items.length > 0) changed();
            return applied;
        },
    };
}

export function startLiveKnowledge(deps: LiveKnowledgeDeps): LiveKnowledge {
    const { log } = deps;
    const changed = (): void => deps.publish(KNOWLEDGE_CHANGED);
    const redaction = createRedaction({ uow: deps.uow, clock: deps.clock });
    const redactions = createRedactionSync({
        store: deps.store,
        project: deps.project,
        cursors: createSqliteRedactionCursors(deps.db),
        ...(deps.sweep && { sweep: deps.sweep }),
        redact: async (messages) => {
            const forgotten = forgetHeldQuotes(deps.db, messages);
            const done = await redaction.redactMessages(messages);
            if (done.requests.length > 0 || forgotten > 0) log(`knowledge: ${done.requests.length} message(s) redacted`);
            if (done.sessions.some((s) => s === deps.session)) deps.sessionRedacted();
        },
        log,
    });
    const requests = deps.requests;
    const handOvers = requests
        ? createHotspotHandOvers({
              session: deps.session,
              project: deps.project,
              store: deps.store,
              pending: createSqliteHotspotHandOvers(deps.db),
              outcomeOf: requests.outcomeOf,
              now: () => deps.clock.now(),
              changed,
              log,
          })
        : undefined;
    // what a restart left: presses whose run ended meanwhile
    void handOvers?.settle();
    void redactions.run();
    const timer = setInterval(() => void redactions.run(), deps.everyMs ?? REDACTION_EVERY_MS);
    timer.unref();
    return {
        store: tellingExtractions(deps.store, changed),
        routes: createKnowledgeRoutes({
            store: deps.store,
            project: deps.project,
            changed,
            log,
            ...(handOvers &&
                requests && {
                    handOvers: {
                        list: () => handOvers.list(),
                        async press({ request, items, by, participant }) {
                            if (!(await requests.isOwn(request, participant))) return false;
                            await handOvers.press({ request, items, by });
                            return true;
                        },
                    },
                }),
        }),
        redactions,
        ...(handOvers && { handOvers }),
        stop: () => clearInterval(timer),
    };
}
