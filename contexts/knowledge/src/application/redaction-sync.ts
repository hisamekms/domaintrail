// Following the project's redaction log (ADR 0031, section 7): the store's sweep appends the source messages of each
// deleted item it removes for good, and every dt of the project reads the log on from where it left off — when it
// starts and now and then during a session — and redacts the messages its own session database holds. Where it left
// off (the cursor) is kept beside that database, so that a restart reads on, and a dt that was not running when an
// item was deleted (from the Worker's page, from another clone) catches up the next time it runs.
import type { Knowledge } from '../generated/index.js';
import type { KnowledgeStore } from './ports.js';

/** Where the log was read up to, per project (kept beside the session database). */
export interface RedactionCursors {
    get(project: Knowledge.ProjectName): Promise<string | undefined>;
    set(project: Knowledge.ProjectName, cursor: string): Promise<void>;
}

export interface RedactionSyncDeps {
    readonly store: KnowledgeStore;
    readonly project: Knowledge.ProjectName;
    readonly cursors: RedactionCursors;
    /** Redacts the messages the session database holds (the others are not its own: left as they are). */
    readonly redact: (messages: readonly Knowledge.MessageKey[]) => Promise<void>;
    /** The store's sweep, where dt runs it (the `files` store): run first, so that the deletions past their undo window reach the log. */
    readonly sweep?: () => Promise<void>;
    readonly log: (line: string) => void;
}

export interface RedactionSync {
    /**
     * Sweeps (where dt does), reads the log after the cursor, redacts, then moves the cursor: how many entries were
     * read. A run asked for while one runs waits for it and runs after (one at a time). A failure is logged and leaves
     * the cursor where it was: the next run reads the same entries again (redacting twice is harmless).
     */
    run(): Promise<number>;
}

export function createRedactionSync(deps: RedactionSyncDeps): RedactionSync {
    const { store, project, cursors, log } = deps;
    let tail: Promise<unknown> = Promise.resolve();
    const once = async (): Promise<number> => {
        try {
            await deps.sweep?.();
            const after = await cursors.get(project);
            const entries = await store.redactions(project, after);
            const last = entries[entries.length - 1];
            if (last === undefined) return 0;
            const messages = entries.flatMap((e) => e.redaction.messages);
            if (messages.length > 0) await deps.redact(messages);
            await cursors.set(project, last.cursor);
            return entries.length;
        } catch (e) {
            log(`knowledge: the redaction log could not be followed (${e instanceof Error ? e.message : String(e)}); tried again later`);
            return 0;
        }
    };
    return {
        run() {
            const next = tail.then(once);
            tail = next.catch(() => undefined);
            return next;
        },
    };
}
