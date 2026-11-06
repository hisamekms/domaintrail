// Where this dt read the project's redaction log up to (`application/redaction-sync.ts`), in the session database whose
// messages it redacts: a table of its own, made when missing, beside the collaboration's.
import type { DatabaseSync } from 'node:sqlite';
import type { RedactionCursors } from '../application/redaction-sync.js';

export const REDACTION_CURSOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_redaction_cursors (
    project TEXT PRIMARY KEY,
    cursor TEXT NOT NULL
) STRICT;
`;

/** The cursors of the session database `db` (its table made when missing). */
export function createSqliteRedactionCursors(db: DatabaseSync): RedactionCursors {
    db.exec(REDACTION_CURSOR_SCHEMA);
    const get = db.prepare('SELECT cursor FROM knowledge_redaction_cursors WHERE project = :project');
    const set = db.prepare(
        'INSERT INTO knowledge_redaction_cursors (project, cursor) VALUES (:project, :cursor) ON CONFLICT (project) DO UPDATE SET cursor = excluded.cursor',
    );
    return {
        async get(project) {
            const row = get.get({ project });
            return typeof row?.cursor === 'string' ? row.cursor : undefined;
        },
        async set(project, cursor) {
            set.run({ project, cursor });
        },
    };
}
