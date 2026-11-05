// The published stormings (ADR 0031, section 11): `dt publish`, run by CI when `main` changes, sends each storming's
// published form, which the `published` table keeps whole (one row per project and storming, the latest only), and
// with `--prune` removes those no longer in the workspace; the read-only page reads the list, a storming's form, and
// the items about stickies no published storming has.
import type { Knowledge, MissingStickies, PublishedEntry, PublishedStorming, PublishResult } from '@domaintrail/knowledge';
import { publishedEntries, stickyRef } from '@domaintrail/knowledge/protocol';
import type { D1Database } from './env.js';
import type { D1KnowledgeStore } from './store.js';

interface EntryRow {
    storming: string;
    version: string;
    published_at: string;
    label: string | null;
    drawing: string;
}

/** The columns of a row as the list says it: the drawing's label and date read out of the body by SQLite. */
const ENTRY_COLUMNS = "storming, version, published_at, json_extract(body, '$.label') AS label, json_extract(body, '$.drawing') AS drawing";

/** The store's own row as an entry (decoded with the API's decoder: a failure is a broken row, never input). */
function entryOf(row: EntryRow): PublishedEntry {
    const [entry] = publishedEntries(
        {
            stormings: [
                {
                    storming: row.storming,
                    ...(row.label !== null && { label: row.label }),
                    version: row.version,
                    drawing: JSON.parse(row.drawing) as unknown,
                    publishedAt: row.published_at,
                },
            ],
        },
        'row',
    );
    return entry;
}

/** Replaces the published form of a storming; `changed` when its drawing differs from the one kept. */
export async function putPublished(db: D1Database, project: Knowledge.ProjectName, form: PublishedStorming, by: string, now: Date): Promise<PublishResult> {
    const at = now.toISOString();
    const before = await db
        .prepare('SELECT version FROM published WHERE project = ?1 AND storming = ?2')
        .bind(project, form.storming)
        .first<{ version: string }>();
    await db.batch([
        db.prepare("INSERT INTO projects (name, visibility, created_at) VALUES (?1, 'open', ?2) ON CONFLICT DO NOTHING").bind(project, at),
        db
            .prepare(
                `INSERT INTO published (project, storming, version, body, published_at, published_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (project, storming) DO UPDATE SET version = excluded.version, body = excluded.body,
                   published_at = excluded.published_at, published_by = excluded.published_by`,
            )
            .bind(project, form.storming, form.version, JSON.stringify(form), at, by),
    ]);
    const row = await db.prepare(`SELECT ${ENTRY_COLUMNS} FROM published WHERE project = ?1 AND storming = ?2`).bind(project, form.storming).first<EntryRow>();
    if (!row) throw new Error(`the published ${form.storming} was not kept`);
    return { entry: entryOf(row), changed: before?.version !== form.version };
}

/**
 * Removes the published form of a storming (`dt publish --prune`, for a storming no longer in the workspace); whether
 * there was one. Its knowledge stays: the items about its stickies are then listed apart, as about missing stickies.
 */
export async function deletePublished(db: D1Database, project: Knowledge.ProjectName, storming: string): Promise<boolean> {
    const row = await db
        .prepare('DELETE FROM published WHERE project = ?1 AND storming = ?2 RETURNING storming')
        .bind(project, storming)
        .first<{ storming: string }>();
    return row !== null;
}

/** The published stormings of a project, by ID. */
export async function listPublished(db: D1Database, project: Knowledge.ProjectName): Promise<PublishedEntry[]> {
    const { results } = await db.prepare(`SELECT ${ENTRY_COLUMNS} FROM published WHERE project = ?1 ORDER BY storming`).bind(project).all<EntryRow>();
    return results.map(entryOf);
}

/** A storming's published form as it was sent (its JSON), or undefined when it was never published. */
export async function publishedBody(db: D1Database, project: Knowledge.ProjectName, storming: string): Promise<string | undefined> {
    const row = await db.prepare('SELECT body FROM published WHERE project = ?1 AND storming = ?2').bind(project, storming).first<{ body: string }>();
    return row?.body;
}

/**
 * The stickies that live items name and no published storming has (a sticky renamed or removed, a storming not
 * published), with the items about them. None while nothing is published: there is no drawing to miss from.
 */
export async function missingStickies(db: D1Database, store: D1KnowledgeStore, project: Knowledge.ProjectName): Promise<MissingStickies> {
    const { results } = await db
        .prepare(
            `SELECT DISTINCT a.sticky AS sticky
             FROM item_about a JOIN items i ON i.project = a.project AND i.id = a.item
             WHERE a.project = ?1 AND i.state = 'Live'
               AND EXISTS (SELECT 1 FROM published WHERE project = ?1)
               AND a.sticky NOT IN (SELECT s.value ->> 'ref' FROM published p, json_each(p.body, '$.stickies') s WHERE p.project = ?1)
             ORDER BY a.sticky`,
        )
        .bind(project)
        .all<{ sticky: string }>();
    const stickies = results.map((r) => stickyRef(r.sticky, 'row'));
    return { stickies, items: stickies.length ? await store.about(project, stickies) : [] };
}

/** The projects that have knowledge or a published storming, by name: what the page offers to open. */
export async function projectList(db: D1Database): Promise<string[]> {
    const { results } = await db.prepare('SELECT name FROM projects UNION SELECT project FROM published ORDER BY 1').all<{ name: string }>();
    return results.map((r) => r.name);
}
