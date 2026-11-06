// Whether a session extracts its knowledge, as its facilitator last switched it (ADR 0031, section 3), in the session
// database (`node:sqlite`, beside the extraction's checkpoint): one row per session, written only when the facilitator
// switches; no row means the config's default (`knowledge.extraction.enabled`), so that a server started again keeps
// what the facilitator chose and a session never switched follows the config.
import type { DatabaseSync } from 'node:sqlite';
import type { ExtractionSwitches } from '../application/extraction-switch.js';

export const EXTRACTION_SWITCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_extraction_switch (
    session_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    changed_at TEXT NOT NULL
) STRICT;
`;

/** The switches of the session database `db` (its table made when missing). */
export function createSqliteExtractionSwitches(db: DatabaseSync): ExtractionSwitches {
    db.exec(EXTRACTION_SWITCH_SCHEMA);
    const load = db.prepare('SELECT enabled FROM knowledge_extraction_switch WHERE session_id = :session');
    const save = db.prepare(`
        INSERT INTO knowledge_extraction_switch (session_id, enabled, changed_at) VALUES (:session, :enabled, :at)
        ON CONFLICT (session_id) DO UPDATE SET enabled = excluded.enabled, changed_at = excluded.changed_at
    `);
    return {
        async load(session) {
            const row = load.get({ session });
            return row ? Number(row.enabled) === 1 : undefined;
        },
        async save(session, enabled, at) {
            save.run({ session, enabled: enabled ? 1 : 0, at: at.toISOString() });
        },
    };
}
