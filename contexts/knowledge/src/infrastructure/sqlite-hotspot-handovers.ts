// The presses of ホットスポットにする still waiting for their message's run (ADR 0031, section 4), in the session
// database (`node:sqlite`, beside the extraction's checkpoint and switch): one row per message sent, removed once its
// run ended (handed over, or the conflict given its buttons back), so that a page reloaded or a server started again
// still shows the conflict as being made into a hotspot.
import type { DatabaseSync } from 'node:sqlite';
import { Knowledge } from '../generated/index.js';
import type { PendingHandOver, PendingHandOvers } from '../application/hotspot-handovers.js';

export const HOTSPOT_HANDOVERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_hotspot_handovers (
    session_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    item_a TEXT NOT NULL,
    item_b TEXT NOT NULL,
    pressed_by TEXT NOT NULL,
    pressed_at TEXT NOT NULL,
    PRIMARY KEY (session_id, request_id)
) STRICT;
`;

const known = <T>(r: { ok: true; value: T } | { ok: false }, what: string): T => {
    if (!r.ok) throw new Error(`The session database holds an invalid ${what}`);
    return r.value;
};

/** The waiting presses of the session database `db` (its table made when missing). */
export function createSqliteHotspotHandOvers(db: DatabaseSync): PendingHandOvers {
    db.exec(HOTSPOT_HANDOVERS_SCHEMA);
    const list = db.prepare(
        'SELECT request_id, item_a, item_b, pressed_by, pressed_at FROM knowledge_hotspot_handovers WHERE session_id = :session ORDER BY pressed_at, request_id',
    );
    const add = db.prepare(`
        INSERT INTO knowledge_hotspot_handovers (session_id, request_id, item_a, item_b, pressed_by, pressed_at)
        VALUES (:session, :request, :a, :b, :by, :at)
        ON CONFLICT (session_id, request_id) DO UPDATE SET
          item_a = excluded.item_a, item_b = excluded.item_b, pressed_by = excluded.pressed_by, pressed_at = excluded.pressed_at
    `);
    const remove = db.prepare('DELETE FROM knowledge_hotspot_handovers WHERE session_id = :session AND request_id = :request');
    return {
        async list(session) {
            return list.all({ session }).map((row): PendingHandOver => ({
                request: String(row.request_id),
                items: [
                    known(Knowledge.makeKnowledgeItemId(String(row.item_a)), 'knowledge item ID'),
                    known(Knowledge.makeKnowledgeItemId(String(row.item_b)), 'knowledge item ID'),
                ],
                by: known(Knowledge.makeUserName(String(row.pressed_by)), 'user name'),
                at: new Date(String(row.pressed_at)),
            }));
        },
        async add(session, p) {
            add.run({ session, request: p.request, a: p.items[0], b: p.items[1], by: p.by, at: p.at.toISOString() });
        },
        async remove(session, request) {
            remove.run({ session, request });
        },
    };
}
