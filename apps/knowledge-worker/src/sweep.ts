// The store's own sweep (ADR 0031, section 7), run by the Cron Trigger every few minutes whether or not the page that
// deleted an item is still open. For each item deleted longer ago than the undo window allows:
//
// - the images only it refers to (in any of its versions) are deleted from R2;
// - every version, its search text, its stickies and the item itself are deleted;
// - the reasons of its audit records are dropped (`withoutReason`: a reason may quote someone), the records kept;
// - its `redactionOf` is appended to the redaction log, which every dt of the project reads on from its cursor.
//
// One item at a time, in one batch, guarded like any write (store.ts): an item restored meanwhile is left alone. It
// also removes the images nothing has referred to for a day (uploaded and never attached), and the idempotency records
// of the extractions older than a week.
import { redactionOf, type Knowledge } from '@domaintrail/knowledge';
import type { D1Database, R2Bucket } from './env.js';
import { guard, imageKey, itemOf, type ItemRow } from './store.js';

export interface SweepSettings {
    /** How long a deleted item is kept for 元に戻す, in ms. */
    readonly afterMs: number;
    /** The most items removed in one run (D1 limits the queries of one invocation); the next run goes on. */
    readonly maxItems?: number;
}

export interface SweepReport {
    readonly items: number;
    readonly images: number;
    /** The items that failed (restored meanwhile, or an error): tried again by the next run. */
    readonly failed: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function sweep(db: D1Database, bucket: R2Bucket, now: Date, settings: SweepSettings): Promise<SweepReport> {
    const before = new Date(now.getTime() - settings.afterMs).toISOString();
    const { results } = await db
        .prepare("SELECT * FROM items WHERE state = 'Deleted' AND deleted_at <= ?1 ORDER BY deleted_at LIMIT ?2")
        .bind(before, settings.maxItems ?? 50)
        .all<ItemRow>();
    let items = 0;
    let images = 0;
    let failed = 0;
    for (const row of results) {
        try {
            images += await sweepItem(db, bucket, row, now);
            items++;
        } catch (e) {
            failed++;
            console.error(`knowledge-worker: sweeping an item of ${row.project} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    images += await sweepOrphanImages(db, bucket, now);
    await db
        .prepare('DELETE FROM extractions WHERE applied_at <= ?1')
        .bind(new Date(now.getTime() - 7 * DAY_MS).toISOString())
        .run();
    return { items, images, failed };
}

/** Removes one deleted item; the number of images removed with it. */
async function sweepItem(db: D1Database, bucket: R2Bucket, row: ItemRow, now: Date): Promise<number> {
    const item = itemOf(row);
    if (item.state !== 'Deleted') return 0;
    const { project, id } = row;
    const { results: refs } = await db
        .prepare(
            `SELECT r.image AS image FROM image_refs r WHERE r.project = ?1 AND r.item = ?2
             AND NOT EXISTS (SELECT 1 FROM image_refs o WHERE o.project = r.project AND o.image = r.image AND o.item != r.item)`,
        )
        .bind(project, id)
        .all<{ image: string }>();
    const only = refs.map((r) => r.image);
    // R2 first: if the batch then fails, the item stays and the next run deletes the (already missing) images again
    if (only.length > 0) await bucket.delete(only.map((image) => imageKey(project, image)));
    const redaction: Knowledge.Redaction = redactionOf(item);
    await db.batch([
        guard(db, project, [{ id, rev: row.rev }]),
        db.prepare('DELETE FROM item_search WHERE rowid = ?1').bind(row.seq),
        db.prepare('DELETE FROM item_about WHERE project = ?1 AND item = ?2').bind(project, id),
        db.prepare('DELETE FROM item_versions WHERE project = ?1 AND item = ?2').bind(project, id),
        db.prepare('DELETE FROM image_refs WHERE project = ?1 AND item = ?2').bind(project, id),
        db.prepare('DELETE FROM images WHERE project = ?1 AND id IN (SELECT value FROM json_each(?2))').bind(project, JSON.stringify(only)),
        // what `withoutReason` keeps of each record
        db.prepare('UPDATE audit SET reason = NULL WHERE project = ?1 AND item = ?2').bind(project, id),
        db
            .prepare('INSERT INTO redactions (project, item, messages, at) VALUES (?1, ?2, ?3, ?4)')
            .bind(project, id, JSON.stringify(redaction.messages), now.toISOString()),
        db.prepare('DELETE FROM items WHERE project = ?1 AND id = ?2').bind(project, id),
    ]);
    return only.length;
}

/** Removes the images uploaded more than a day ago that no item refers to; how many. */
async function sweepOrphanImages(db: D1Database, bucket: R2Bucket, now: Date): Promise<number> {
    const { results } = await db
        .prepare(
            `SELECT project, id FROM images i WHERE created_at <= ?1
             AND NOT EXISTS (SELECT 1 FROM image_refs r WHERE r.project = i.project AND r.image = i.id) LIMIT 100`,
        )
        .bind(new Date(now.getTime() - DAY_MS).toISOString())
        .all<{ project: string; id: string }>();
    if (results.length === 0) return 0;
    await bucket.delete(results.map((r) => imageKey(r.project, r.id)));
    await db.batch(results.map((r) => db.prepare('DELETE FROM images WHERE project = ?1 AND id = ?2').bind(r.project, r.id)));
    return results.length;
}
