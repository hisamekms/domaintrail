// The extraction's checkpoint and cost records in the session database (`node:sqlite`, the database the session's
// collaboration keeps; ADR 0031, section 3): two tables of their own, made when missing, beside the collaboration's
// (whose migrations number its own schema only).
//
// - `knowledge_extractions`: one row per session — the last extraction's number, the newest message extracted, when the
//   last extraction started, the held operations and the operations decided but not yet applied (JSON), the extractor's
//   failures in a row;
// - `knowledge_extraction_costs`: one row per extraction — what it cost (tokens, cache, dollars as Claude Code reports
//   them) and did (operations proposed, applied, held, dropped), JSON, for measuring the cost per extraction:
//   `SELECT data FROM knowledge_extraction_costs WHERE session_id = ? ORDER BY number`.
//
// The operations are written as JSON with their times as ISO strings, and read back with the times made dates again:
// the rows are this module's own writing, not input.
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { Knowledge } from '../generated/index.js';
import { EMPTY_CHECKPOINT, type ExtractionCheckpoint, type ExtractionCheckpoints, type ExtractionCost } from '../application/extraction.js';
import type { HeldOperation } from '../domain/guards.js';

export const CHECKPOINT_SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_extractions (
    session_id TEXT PRIMARY KEY,
    number INTEGER NOT NULL,
    last_message TEXT,
    last_message_at TEXT,
    last_extraction_at TEXT,
    held TEXT NOT NULL,
    pending TEXT,
    failures INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS knowledge_extraction_costs (
    session_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    at TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (session_id, number, at)
) STRICT;
`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const dateOr = (v: SQLOutputValue | undefined): Date | undefined => (typeof v === 'string' ? new Date(v) : undefined);

/** A source read back: its time made a date again. */
function reviveSource(source: unknown): unknown {
    return isObject(source) && typeof source.at === 'string' ? { ...source, at: new Date(source.at) } : source;
}

/** An operation read back: the times of its sources made dates again. */
function reviveOperation(operation: unknown): unknown {
    if (!isObject(operation)) return operation;
    return {
        ...operation,
        ...(Array.isArray(operation.sources) && { sources: operation.sources.map(reviveSource) }),
        ...(operation.source !== undefined && { source: reviveSource(operation.source) }),
    };
}

function readHeld(text: string): readonly HeldOperation[] {
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((h: unknown) =>
        isObject(h) && typeof h.heldIn === 'number' && typeof h.heldAt === 'string'
            ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- this module's own JSON of a held operation, its dates revived
              [{ operation: reviveOperation(h.operation) as HeldOperation['operation'], heldIn: h.heldIn, heldAt: new Date(h.heldAt) }]
            : [],
    );
}

function readPending(text: string | undefined): Knowledge.Extraction | undefined {
    if (text === undefined) return undefined;
    const raw: unknown = JSON.parse(text);
    if (!isObject(raw) || !Array.isArray(raw.operations)) return undefined;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- this module's own JSON of an extraction, its dates revived
    return { ...raw, operations: raw.operations.map(reviveOperation) } as unknown as Knowledge.Extraction;
}

/** The checkpoints of the session database `db` (its tables made when missing). */
export function createSqliteCheckpoints(db: DatabaseSync): ExtractionCheckpoints {
    db.exec(CHECKPOINT_SCHEMA);
    const load = db.prepare('SELECT * FROM knowledge_extractions WHERE session_id = :session');
    const save = db.prepare(`
        INSERT INTO knowledge_extractions (session_id, number, last_message, last_message_at, last_extraction_at, held, pending, failures)
        VALUES (:session, :number, :lastMessage, :lastMessageAt, :lastExtractionAt, :held, :pending, :failures)
        ON CONFLICT (session_id) DO UPDATE SET
            number = excluded.number, last_message = excluded.last_message, last_message_at = excluded.last_message_at,
            last_extraction_at = excluded.last_extraction_at, held = excluded.held, pending = excluded.pending, failures = excluded.failures
    `);
    const cost = db.prepare('INSERT OR REPLACE INTO knowledge_extraction_costs (session_id, number, at, data) VALUES (:session, :number, :at, :data)');
    return {
        async load(session) {
            const row = load.get({ session });
            if (!row) return EMPTY_CHECKPOINT;
            const lastMessageAt = dateOr(row.last_message_at);
            const lastExtractionAt = dateOr(row.last_extraction_at);
            const pending = readPending(typeof row.pending === 'string' ? row.pending : undefined);
            const checkpoint: ExtractionCheckpoint = {
                number: Number(row.number),
                ...(typeof row.last_message === 'string' && { lastMessage: row.last_message }),
                ...(lastMessageAt && { lastMessageAt }),
                ...(lastExtractionAt && { lastExtractionAt }),
                held: readHeld(String(row.held)),
                ...(pending && { pending }),
                failures: Number(row.failures),
            };
            return checkpoint;
        },
        async save(session, checkpoint) {
            save.run({
                session,
                number: checkpoint.number,
                lastMessage: checkpoint.lastMessage ?? null,
                lastMessageAt: checkpoint.lastMessageAt?.toISOString() ?? null,
                lastExtractionAt: checkpoint.lastExtractionAt?.toISOString() ?? null,
                held: JSON.stringify(checkpoint.held),
                pending: checkpoint.pending ? JSON.stringify(checkpoint.pending) : null,
                failures: checkpoint.failures,
            });
        },
        async recordCost(record: ExtractionCost) {
            cost.run({ session: record.session, number: record.number, at: record.at.toISOString(), data: JSON.stringify(record) });
        },
    };
}

/** The cost records of a session, in the order of the extractions (for the maintainer, and the tests). */
export function extractionCosts(db: DatabaseSync, session: string): readonly Record<string, unknown>[] {
    db.exec(CHECKPOINT_SCHEMA);
    return db
        .prepare('SELECT data FROM knowledge_extraction_costs WHERE session_id = :session ORDER BY number, at')
        .all({ session })
        .flatMap((r) => {
            const data: unknown = JSON.parse(String(r.data));
            return isObject(data) ? [data] : [];
        });
}
