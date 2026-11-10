// The knowledge store on D1 and R2: the `KnowledgeStore` port (contexts/knowledge, application/ports.ts) as the Worker
// keeps it. What happens to an item is decided by the knowledge context's pure code — `applyExtraction` for an
// extraction, `knowledgeItemCommands` for a person's correction, deletion and restore, `auditOf` for the audit log —
// and this module only reads the items it needs and writes what was decided, in one D1 batch (one transaction).
//
// A write checks that the items are as it read them (their `rev`): a guard statement at the head of the batch fails
// it otherwise, which rolls the batch back, and the call is decided again over the items as they are now. So an
// extraction never overwrites a correction or a deletion made while it was being decided: its operation on that item
// is dropped when decided again (`StaleOperation`, `KnowledgeItemGone`), as the domain says.
//
// Retiring (廃止) writes the item's `retirement`; the AI's proposals are rows of `proposals`, decided by the context's
// `admitProposal`, `decideApproval` and `decideDismissal`. A decision on a proposal is guarded by its state as an item
// is by its `rev`: approving or dismissing one that another person decided meanwhile is decided again.
import {
    admitProposal,
    applyExtraction,
    candidateOf,
    proposalIdOf,
    auditOf,
    auditOfProposal,
    decideApproval,
    decideDismissal,
    openProposals,
    proposalsTouched,
    type ApprovalError,
    type ApprovedProposal,
    type ProposalRejection,
    type RetireError,
    type RetirementCandidate,
    type RetirementInput,
    idempotencyKey,
    imagesIn,
    itemsTouched,
    knowledgeItemCommands,
    pastVersionOf,
    sourceMessages,
    err,
    ok,
    type AppliedExtraction,
    type AuditQuery,
    type Deletion,
    type DroppedOperation,
    type ItemWithHistory,
    type Knowledge,
    type KnowledgeImage,
    type KnowledgeQuery,
    type KnowledgeStore,
    type Page,
    type PastVersion,
    type RedactionEntry,
    type Result,
    type StickyCount,
    withLiveConflicts,
} from '@domaintrail/knowledge';
import {
    DEFAULT_LIMIT,
    WireError,
    auditEntry,
    dropReason,
    imageId as imageIdOf,
    itemContent,
    itemId,
    itemVersion,
    knowledgeItem,
    retirementProposal,
    stickyRef,
    type Decoder,
} from '@domaintrail/knowledge/protocol';
import type { D1Database, D1PreparedStatement, R2Bucket } from './env.js';

/** An item's row in `items`. */
export interface ItemRow {
    readonly seq: number;
    readonly project: string;
    readonly id: string;
    readonly state: string;
    readonly version: number;
    readonly title: string;
    readonly text: string;
    readonly when_label: string;
    readonly kind: string;
    readonly origin: string;
    readonly perspective: string | null;
    readonly about: string;
    readonly sources: string;
    readonly conflicts_with: string;
    readonly created_in: string | null;
    readonly created_at: string;
    readonly updated_at: string;
    readonly deleted_by: string | null;
    readonly deleted_at: string | null;
    readonly retirement: string | null;
    readonly rev: number;
}

/** A proposal's row in `proposals`. */
interface ProposalRow {
    readonly id: string;
    readonly state: string;
    readonly body: string;
}

/** A row as the model's proposal; a row that is not one is a broken store, never input. */
const proposalOf = (row: ProposalRow): Knowledge.RetirementProposal => retirementProposal(JSON.parse(row.body), `proposals[${row.id}]`);

/** A row as the model's item; a row that is not one is a broken store, never input. */
export function itemOf(row: ItemRow): Knowledge.KnowledgeItem {
    return knowledgeItem(
        {
            state: row.state,
            id: row.id,
            content: {
                title: row.title,
                text: row.text,
                labels: { when: row.when_label, kind: row.kind, origin: row.origin, ...(row.perspective !== null && { perspective: row.perspective }) },
                about: JSON.parse(row.about),
            },
            sources: JSON.parse(row.sources),
            version: row.version,
            conflictsWith: JSON.parse(row.conflicts_with),
            ...(row.created_in !== null && { createdIn: row.created_in }),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            ...(row.deleted_by !== null && { deletedBy: row.deleted_by }),
            ...(row.deleted_at !== null && { deletedAt: row.deleted_at }),
            ...(row.retirement !== null && { retirement: JSON.parse(row.retirement) }),
        },
        `items[${row.id}]`,
    );
}

/** What full-text search reads of an item: its title, its text and its sources' quotes. */
const searchBody = (item: Knowledge.KnowledgeItem): string => [item.content.title, item.content.text, ...item.sources.map((s) => s.quote)].join('\n');

/** A decoder of a single value of the store's own rows (trusted: a failure is a broken store, never input). */
const one =
    <T>(d: Decoder<T>) =>
    (v: unknown): T =>
        d(v, 'row');

/** The R2 key of an image. */
export const imageKey = (project: string, id: string): string => `${project}/${id}`;

/**
 * The statement that fails the batch it heads unless the items have the `rev` they were read with (`null`: absent).
 * `json('stale')` is malformed JSON: SQLite raises an error, and D1 rolls the whole batch back.
 */
export function guard(db: D1Database, project: string, read: readonly { readonly id: string; readonly rev: number | null }[]): D1PreparedStatement {
    return db
        .prepare(
            `SELECT json(CASE WHEN (
               SELECT count(*) FROM json_each(?2) g LEFT JOIN items i ON i.project = ?1 AND i.id = g.value ->> 'id'
               WHERE i.rev IS NOT g.value ->> 'rev'
             ) = 0 THEN '1' ELSE 'stale' END)`,
        )
        .bind(project, JSON.stringify(read));
}

/** How often a write is decided again after its items changed meanwhile. */
const ATTEMPTS = 4;

/** The page cursor of a list newest first: where the last item stood. */
interface Cursor {
    readonly u: string;
    readonly i: string;
}
const cursorOf = (row: { updated_at: string; id: string }): string => btoa(JSON.stringify({ u: row.updated_at, i: row.id } satisfies Cursor));
function readCursor(cursor: string): Cursor {
    try {
        const c: unknown = JSON.parse(atob(cursor));
        if (typeof c === 'object' && c !== null && 'u' in c && 'i' in c && typeof c.u === 'string' && typeof c.i === 'string') return { u: c.u, i: c.i };
    } catch {
        // falls through
    }
    throw new WireError('cursor: not a cursor of this list');
}

/** `%` and `_` of a term taken literally by `LIKE … ESCAPE '\'`. */
const likeTerm = (term: string): string => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** What an extraction applied, as kept for a replay: IDs and reasons, never text (`extractions.outcome`). */
interface KeptOutcome {
    readonly items: readonly string[];
    readonly dropped: readonly { readonly index: number; readonly reason: unknown }[];
}

/** An extraction's `Idempotency-Key` sent again with other operations. */
export class IdempotencyKeyReused extends Error {
    override readonly name = 'IdempotencyKeyReused';
}

async function sha256(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const randomId = (prefix: string): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return prefix + [...bytes].map((b) => '0123456789abcdefghijklmnopqrstuvwxyz'[b % 36]).join('');
};

export interface D1StoreOptions {
    /** The caller of the request, as the audit log records it (`callerName`). */
    readonly caller: string;
    readonly now?: () => Date;
}

/**
 * The store of one request: its writes record `caller` in the audit log. Every method is the port's; the extra ones
 * (`redactionsPage`, `attachImage`) serve routes the port has no call for.
 */
export class D1KnowledgeStore implements KnowledgeStore {
    private readonly now: () => Date;
    private readonly caller: string;

    constructor(
        private readonly db: D1Database,
        private readonly bucket: R2Bucket,
        options: D1StoreOptions,
    ) {
        this.now = options.now ?? ((): Date => new Date());
        this.caller = options.caller;
    }

    // ---- reads ---------------------------------------------------------------------------------------------------

    private async rows(project: string, ids: readonly string[]): Promise<ItemRow[]> {
        if (ids.length === 0) return [];
        const { results } = await this.db
            .prepare('SELECT * FROM items WHERE project = ?1 AND id IN (SELECT value FROM json_each(?2))')
            .bind(project, JSON.stringify(ids))
            .all<ItemRow>();
        return results;
    }

    private async row(project: string, id: string): Promise<ItemRow | undefined> {
        return (await this.db.prepare('SELECT * FROM items WHERE project = ?1 AND id = ?2').bind(project, id).first<ItemRow>()) ?? undefined;
    }

    /** The items as they are read: each one's conflicts with live items only (`withLiveConflicts`). */
    private async shown(project: string, items: readonly Knowledge.LiveKnowledgeItem[]): Promise<Knowledge.LiveKnowledgeItem[]> {
        const linked = [...new Set(items.flatMap((i) => i.conflictsWith))];
        if (linked.length === 0) return [...items];
        const { results } = await this.db
            .prepare("SELECT id FROM items WHERE project = ?1 AND state = 'Live' AND id IN (SELECT value FROM json_each(?2))")
            .bind(project, JSON.stringify(linked))
            .all<{ id: string }>();
        const live = new Set(results.map((r) => r.id));
        return items.map((i) => withLiveConflicts(i, (id) => live.has(id)));
    }

    async about(project: Knowledge.ProjectName, stickies: readonly Knowledge.StickyRef[]): Promise<readonly Knowledge.LiveKnowledgeItem[]> {
        const items: Knowledge.LiveKnowledgeItem[] = [];
        let cursor: string | undefined;
        do {
            const p = await this.search(project, { about: stickies, limit: 200, ...(cursor !== undefined && { cursor }) });
            items.push(...p.items);
            cursor = p.next;
        } while (cursor !== undefined);
        return items;
    }

    async search(project: Knowledge.ProjectName, query: KnowledgeQuery): Promise<Page<Knowledge.LiveKnowledgeItem>> {
        const where = ['i.project = ?1', "i.state = 'Live'"];
        const binds: unknown[] = [project];
        const bind = (v: unknown): string => {
            binds.push(v);
            return `?${binds.length}`;
        };
        if (query.about?.length)
            where.push(
                `EXISTS (SELECT 1 FROM item_about a WHERE a.project = i.project AND a.item = i.id AND a.sticky IN (SELECT value FROM json_each(${bind(JSON.stringify(query.about))})))`,
            );
        if (query.when?.length) where.push(`i.when_label IN (SELECT value FROM json_each(${bind(JSON.stringify(query.when))}))`);
        if (query.kind?.length) where.push(`i.kind IN (SELECT value FROM json_each(${bind(JSON.stringify(query.kind))}))`);
        if (query.origin?.length) where.push(`i.origin IN (SELECT value FROM json_each(${bind(JSON.stringify(query.origin))}))`);
        if (query.perspective !== undefined) where.push(`i.perspective = ${bind(query.perspective)}`);
        if (query.session !== undefined) where.push(`i.created_in = ${bind(query.session)}`);
        if (query.retired === undefined) where.push('i.retirement IS NULL');
        else if (query.retired === 'only') where.push('i.retirement IS NOT NULL');
        const terms = (query.q ?? '').split(/\s+/).filter(Boolean).slice(0, 10);
        if (terms.length > 0)
            where.push(`i.seq IN (SELECT rowid FROM item_search WHERE ${terms.map((t) => `body LIKE ${bind(likeTerm(t))} ESCAPE '\\'`).join(' AND ')})`);
        if (query.cursor !== undefined) {
            const c = readCursor(query.cursor);
            const u = bind(c.u);
            where.push(`(i.updated_at < ${u} OR (i.updated_at = ${u} AND i.id < ${bind(c.i)}))`);
        }
        const limit = query.limit ?? DEFAULT_LIMIT;
        const sql = `SELECT i.* FROM items i WHERE ${where.join(' AND ')} ORDER BY i.updated_at DESC, i.id DESC LIMIT ${bind(limit + 1)}`;
        const { results } = await this.db
            .prepare(sql)
            .bind(...binds)
            .all<ItemRow>();
        const shown = results.slice(0, limit);
        const items = await this.shown(
            project,
            shown.map(itemOf).filter((i): i is Knowledge.LiveKnowledgeItem => i.state === 'Live'),
        );
        return results.length > limit ? { items, next: cursorOf(shown[shown.length - 1]) } : { items };
    }

    async counts(project: Knowledge.ProjectName, storming: string): Promise<readonly StickyCount[]> {
        const prefix = `${storming}.`;
        const { results } = await this.db
            .prepare(
                `SELECT a.sticky AS sticky,
                        MAX(EXISTS (SELECT 1 FROM json_each(i.conflicts_with) c
                                    JOIN items o ON o.project = i.project AND o.id = c.value AND o.state = 'Live' AND o.retirement IS NULL)) AS conflict
                 FROM item_about a JOIN items i ON i.project = a.project AND i.id = a.item
                 WHERE a.project = ?1 AND i.state = 'Live' AND i.retirement IS NULL AND substr(a.sticky, 1, length(?2)) = ?2
                 GROUP BY a.sticky ORDER BY a.sticky`,
            )
            .bind(project, prefix)
            .all<{ sticky: string; conflict: number }>();
        return results.map((r) => ({ sticky: one(stickyRef)(r.sticky), hasItems: true, hasConflict: r.conflict === 1 }));
    }

    async get(project: Knowledge.ProjectName, id: Knowledge.KnowledgeItemId, options?: { readonly history?: boolean }): Promise<ItemWithHistory | undefined> {
        const row = await this.row(project, id);
        if (!row) return undefined;
        const found = itemOf(row);
        if (found.state !== 'Live') return undefined;
        const [item] = await this.shown(project, [found]);
        if (!options?.history) return { item };
        const { results } = await this.db
            .prepare('SELECT version, content, replaced_at FROM item_versions WHERE project = ?1 AND item = ?2 ORDER BY version DESC')
            .bind(project, id)
            .all<{ version: number; content: string; replaced_at: string }>();
        const history = results.map((r, i): PastVersion => ({
            version: one(itemVersion)(r.version),
            content: itemContent(JSON.parse(r.content), `item_versions[${i}].content`),
            replacedAt: new Date(r.replaced_at),
        }));
        return { item, history };
    }

    async redactions(project: Knowledge.ProjectName, after?: string): Promise<readonly RedactionEntry[]> {
        const all: RedactionEntry[] = [];
        let cursor = after;
        for (;;) {
            const got = await this.redactionsPage(project, cursor, 1000);
            all.push(...got);
            if (got.length < 1000) return all;
            cursor = got[got.length - 1].cursor;
        }
    }

    /** A page of the redaction log after a cursor, oldest first. */
    async redactionsPage(project: Knowledge.ProjectName, after: string | undefined, limit: number): Promise<RedactionEntry[]> {
        const from = after === undefined ? 0 : /^\d+$/.test(after) ? Number(after) : undefined;
        if (from === undefined) throw new WireError('after: not a cursor of the redaction log');
        const { results } = await this.db
            .prepare('SELECT seq, item, messages FROM redactions WHERE project = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3')
            .bind(project, from, limit)
            .all<{ seq: number; item: string; messages: string }>();
        return results.map((r) => ({
            redaction: { item: one(itemId)(r.item), messages: JSON.parse(r.messages) },
            cursor: String(r.seq),
        }));
    }

    async audit(project: Knowledge.ProjectName, query: AuditQuery): Promise<Page<Knowledge.AuditEntry>> {
        const page = await this.auditPage(project, query);
        return { items: page.items.map((r) => r.entry), ...(page.next !== undefined && { next: page.next }) };
    }

    /** A page of the audit log, newest first, with the caller of each record. */
    async auditPage(project: Knowledge.ProjectName, query: AuditQuery): Promise<Page<{ entry: Knowledge.AuditEntry; caller: string }>> {
        const limit = query.limit ?? DEFAULT_LIMIT;
        const before = query.cursor === undefined ? Number.MAX_SAFE_INTEGER : /^\d+$/.test(query.cursor) ? Number(query.cursor) : undefined;
        if (before === undefined) throw new WireError('cursor: not a cursor of the audit log');
        const { results } = await this.db
            .prepare('SELECT * FROM audit WHERE project = ?1 AND (?2 IS NULL OR item = ?2) AND seq < ?3 ORDER BY seq DESC LIMIT ?4')
            .bind(project, query.item ?? null, before, limit + 1)
            .all<{ seq: number; item: string; version: number; operation: string; actor: string; caller: string; reason: string | null; at: string }>();
        const shown = results.slice(0, limit);
        const items = shown.map((r) => ({
            entry: auditEntry(
                {
                    item: r.item,
                    version: r.version,
                    operation: r.operation,
                    actor: JSON.parse(r.actor),
                    ...(r.reason !== null && { reason: r.reason }),
                    at: r.at,
                },
                `audit[${r.seq}]`,
            ),
            caller: r.caller,
        }));
        return results.length > limit ? { items, next: String(shown[shown.length - 1].seq) } : { items };
    }

    async getImage(project: Knowledge.ProjectName, id: Knowledge.ImageId): Promise<KnowledgeImage | undefined> {
        const object = await this.bucket.get(imageKey(project, id));
        if (!object) return undefined;
        return { mediaType: object.httpMetadata?.contentType ?? 'application/octet-stream', bytes: new Uint8Array(await object.arrayBuffer()) };
    }

    // ---- writes --------------------------------------------------------------------------------------------------

    /**
     * The statements that write items as decided: the items themselves (their `rev` one more), the stickies they are
     * about, their search text, the images their text refers to, the versions they replaced and the audit records.
     */
    private writes(
        project: string,
        items: readonly Knowledge.KnowledgeItem[],
        past: readonly { item: Knowledge.KnowledgeItemId; past: PastVersion }[],
        audit: readonly Knowledge.AuditEntry[],
    ): D1PreparedStatement[] {
        const at = this.now().toISOString();
        const rows = JSON.stringify(
            items.map((i) => ({
                id: i.id,
                state: i.state,
                version: i.version,
                title: i.content.title,
                text: i.content.text,
                when: i.content.labels.when,
                kind: i.content.labels.kind,
                origin: i.content.labels.origin,
                perspective: i.content.labels.perspective ?? null,
                about: i.content.about,
                sources: i.sources,
                conflictsWith: i.conflictsWith,
                createdIn: i.createdIn ?? null,
                createdAt: i.createdAt,
                updatedAt: i.updatedAt,
                deletedBy: i.state === 'Deleted' ? i.deletedBy : null,
                deletedAt: i.state === 'Deleted' ? i.deletedAt : null,
                retirement: i.retirement ?? null,
                body: searchBody(i),
                images: imagesIn(i.content.text),
            })),
        );
        const statements = [
            this.db.prepare("INSERT INTO projects (name, visibility, created_at) VALUES (?1, 'open', ?2) ON CONFLICT DO NOTHING").bind(project, at),
            this.db
                .prepare(
                    `INSERT INTO items (project, id, state, version, title, text, when_label, kind, origin, perspective, about, sources, conflicts_with,
                                        created_in, created_at, updated_at, deleted_by, deleted_at, retirement, rev)
                     SELECT ?1, j.value ->> 'id', j.value ->> 'state', j.value ->> 'version', j.value ->> 'title', j.value ->> 'text', j.value ->> 'when',
                            j.value ->> 'kind', j.value ->> 'origin', j.value ->> 'perspective', j.value -> 'about', j.value -> 'sources',
                            j.value -> 'conflictsWith', j.value ->> 'createdIn', j.value ->> 'createdAt', j.value ->> 'updatedAt',
                            j.value ->> 'deletedBy', j.value ->> 'deletedAt', j.value ->> 'retirement', 1
                     FROM json_each(?2) j WHERE true
                     ON CONFLICT (project, id) DO UPDATE SET
                       state = excluded.state, version = excluded.version, title = excluded.title, text = excluded.text, when_label = excluded.when_label,
                       kind = excluded.kind, origin = excluded.origin, perspective = excluded.perspective, about = excluded.about,
                       sources = excluded.sources, conflicts_with = excluded.conflicts_with, updated_at = excluded.updated_at,
                       deleted_by = excluded.deleted_by, deleted_at = excluded.deleted_at, retirement = excluded.retirement, rev = items.rev + 1`,
                )
                .bind(project, rows),
            this.db.prepare("DELETE FROM item_about WHERE project = ?1 AND item IN (SELECT j.value ->> 'id' FROM json_each(?2) j)").bind(project, rows),
            this.db
                .prepare(
                    "INSERT OR IGNORE INTO item_about (project, sticky, item) SELECT ?1, a.value, j.value ->> 'id' FROM json_each(?2) j, json_each(j.value -> 'about') a",
                )
                .bind(project, rows),
            this.db
                .prepare(
                    "DELETE FROM item_search WHERE rowid IN (SELECT seq FROM items WHERE project = ?1 AND id IN (SELECT j.value ->> 'id' FROM json_each(?2) j))",
                )
                .bind(project, rows),
            this.db
                .prepare(
                    "INSERT INTO item_search (rowid, body) SELECT i.seq, j.value ->> 'body' FROM json_each(?2) j JOIN items i ON i.project = ?1 AND i.id = j.value ->> 'id'",
                )
                .bind(project, rows),
            this.db
                .prepare(
                    "INSERT OR IGNORE INTO image_refs (project, image, item) SELECT ?1, m.value, j.value ->> 'id' FROM json_each(?2) j, json_each(j.value -> 'images') m",
                )
                .bind(project, rows),
        ];
        if (past.length > 0)
            statements.push(
                this.db
                    .prepare(
                        `INSERT OR IGNORE INTO item_versions (project, item, version, content, replaced_at)
                         SELECT ?1, j.value ->> 'item', j.value ->> 'version', j.value -> 'content', j.value ->> 'replacedAt' FROM json_each(?2) j`,
                    )
                    .bind(project, JSON.stringify(past.map((p) => ({ item: p.item, ...p.past })))),
            );
        if (audit.length > 0)
            statements.push(
                this.db
                    .prepare(
                        `INSERT INTO audit (project, item, version, operation, actor, caller, reason, at)
                         SELECT ?1, j.value ->> 'item', j.value ->> 'version', j.value ->> 'operation', j.value -> 'actor', ?3, j.value ->> 'reason', j.value ->> 'at'
                         FROM json_each(?2) j ORDER BY j.key`,
                    )
                    .bind(project, JSON.stringify(audit), this.caller),
            );
        return statements;
    }

    /**
     * Decides a write over the items as they are and writes it, again over the items as they are then when they changed
     * meanwhile. `decide` returns the statements after the guard and the value to return.
     */
    private async decideAndWrite<T>(
        project: string,
        ids: readonly string[],
        decide: (items: Map<string, ItemRow>) => Promise<{ statements: D1PreparedStatement[]; value: T }>,
    ): Promise<T> {
        for (let attempt = 1; ; attempt++) {
            const rows = new Map((await this.rows(project, ids)).map((r) => [r.id, r]));
            const { statements, value } = await decide(rows);
            if (statements.length === 0) return value;
            const read = ids.map((id) => ({ id, rev: rows.get(id)?.rev ?? null }));
            try {
                await this.db.batch([guard(this.db, project, read), ...statements]);
                return value;
            } catch (e) {
                if (attempt >= ATTEMPTS) throw e;
            }
        }
    }

    async applyExtraction(project: Knowledge.ProjectName, extraction: Knowledge.Extraction): Promise<AppliedExtraction> {
        const key = idempotencyKey(extraction.by);
        const hash = await sha256(JSON.stringify(extraction));
        for (let attempt = 1; ; attempt++) {
            const kept = await this.keptExtraction(project, key, hash, extraction);
            if (kept) return kept;
            const ids = itemsTouched(extraction);
            const rows = new Map((await this.rows(project, ids)).map((r) => [r.id, r]));
            const items = new Map([...rows].map(([id, r]) => [id, itemOf(r)]));
            // about the items, and those of the candidates' IDs wherever they are (a retry, or a collision)
            const proposals = await this.proposalsFor(
                project,
                proposalsTouched(extraction),
                extraction.operations.flatMap((o) =>
                    o.kind === 'ProposeRetire' || o.kind === 'ProposeUnretire' ? [proposalIdOf(candidateOf(o, extraction.by))] : [],
                ),
            );
            const outcome = applyExtraction(
                extraction,
                (id) => items.get(id),
                this.now(),
                () => proposals,
            );
            const changes = outcome.applied.flatMap((a) => a.changes);
            const past = changes.flatMap((c) => (c.replaced ? [{ item: c.item.id, past: pastVersionOf(c.replaced, c.item) }] : []));
            const keep: KeptOutcome = {
                items: outcome.items.map((i) => i.id),
                dropped: outcome.dropped.map((d) => ({ index: extraction.operations.indexOf(d.operation), reason: d.reason })),
            };
            const read = ids.map((id) => ({ id, rev: rows.get(id)?.rev ?? null }));
            try {
                await this.db.batch([
                    guard(this.db, project, read),
                    ...(outcome.items.length > 0
                        ? this.writes(
                              project,
                              outcome.items,
                              past,
                              changes.map((c) => auditOf(c.event)),
                          )
                        : []),
                    ...this.proposalInserts(
                        project,
                        outcome.proposals,
                        outcome.applied.flatMap((a) => (a.proposal ? [auditOfProposal(a.proposal.event, a.proposal.version)] : [])),
                    ),
                    this.db
                        .prepare('INSERT INTO extractions (project, key, body_hash, outcome, applied_at) VALUES (?1, ?2, ?3, ?4, ?5)')
                        .bind(project, key, hash, JSON.stringify(keep), this.now().toISOString()),
                ]);
            } catch (e) {
                // the items changed meanwhile, or the same extraction was applied by a retry running alongside: decide again
                if (attempt >= ATTEMPTS) throw e;
                continue;
            }
            return {
                items: outcome.items.filter((i): i is Knowledge.LiveKnowledgeItem => i.state === 'Live'),
                dropped: outcome.dropped,
                replayed: false,
                ...(outcome.proposals.length > 0 && { proposals: outcome.proposals }),
            };
        }
    }

    /** The first result of an extraction applied before, with the items as they are now (the deleted ones left out). */
    private async keptExtraction(project: string, key: string, hash: string, extraction: Knowledge.Extraction): Promise<AppliedExtraction | undefined> {
        const row = await this.db
            .prepare('SELECT body_hash, outcome FROM extractions WHERE project = ?1 AND key = ?2')
            .bind(project, key)
            .first<{ body_hash: string; outcome: string }>();
        if (!row) return undefined;
        if (row.body_hash !== hash) throw new IdempotencyKeyReused(`extraction ${key} was applied before with other operations`);
        const kept: KeptOutcome = JSON.parse(row.outcome);
        const items = (await this.rows(project, kept.items))
            .map(itemOf)
            .filter((i): i is Knowledge.LiveKnowledgeItem => i.state === 'Live')
            .sort((a, b) => kept.items.indexOf(a.id) - kept.items.indexOf(b.id));
        const dropped = kept.dropped.flatMap((d): DroppedOperation[] => {
            const operation = extraction.operations[d.index];
            return operation ? [{ operation, reason: dropReason(d.reason, `extractions[${key}].dropped`) }] : [];
        });
        return { items, dropped, replayed: true };
    }

    // Implemented with the bookmark route and D1 migration in the dependent Worker PR.
    async setBookmark(): Promise<never> {
        throw new Error('Bookmark support requires the Worker bookmark migration.');
    }

    async correct(
        project: Knowledge.ProjectName,
        id: Knowledge.KnowledgeItemId,
        corrected: Knowledge.ItemContent,
        by: Knowledge.UserName,
    ): Promise<Result<Knowledge.LiveKnowledgeItem, Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone>> {
        return this.decideAndWrite<Result<Knowledge.LiveKnowledgeItem, Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone>>(
            project,
            [id],
            async (rows) => {
                const row = rows.get(id);
                if (!row) return { statements: [], value: err({ type: 'KnowledgeItemNotFound' as const, itemId: id }) };
                const item = itemOf(row);
                if (item.state !== 'Live') return { statements: [], value: err({ type: 'KnowledgeItemGone' as const, itemId: id }) };
                const r = knowledgeItemCommands.correct(item, { corrected, by, at: this.now() });
                if (!r.ok) throw new Error('correct refused a live item');
                const next = r.value.Live.aggregate;
                const statements = this.writes(
                    project,
                    [next],
                    [{ item: id, past: pastVersionOf(item, next) }],
                    [auditOf(r.value.Live.events.KnowledgeItemCorrected)],
                );
                return { statements, value: ok(next) };
            },
        );
    }

    async unlinkConflict(
        project: Knowledge.ProjectName,
        id: Knowledge.KnowledgeItemId,
        other: Knowledge.KnowledgeItemId,
        by: Knowledge.UserName,
    ): Promise<Result<readonly Knowledge.LiveKnowledgeItem[], Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone>> {
        type Answer = Result<readonly Knowledge.LiveKnowledgeItem[], Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone>;
        return this.decideAndWrite<Answer>(project, other === id ? [id] : [id, other], async (rows) => {
            const row = rows.get(id);
            if (!row) return { statements: [], value: err({ type: 'KnowledgeItemNotFound' as const, itemId: id }) };
            const item = itemOf(row);
            if (item.state !== 'Live') return { statements: [], value: err({ type: 'KnowledgeItemGone' as const, itemId: id }) };
            if (other === id) return { statements: [], value: ok([item]) };
            const otherRow = rows.get(other);
            const otherItem = otherRow ? itemOf(otherRow) : undefined;
            const at = this.now();
            // the other side too, while it is live (a deleted one's links go with it)
            const sides = [item, ...(otherItem?.state === 'Live' ? [otherItem] : [])].map((side) => {
                const r = knowledgeItemCommands.unlinkConflict(side, { other: side.id === id ? other : id, by, at });
                if (!r.ok) throw new Error('unlinkConflict refused two distinct items');
                return r.value.Live;
            });
            const statements = this.writes(
                project,
                sides.map((s) => s.aggregate),
                [],
                sides.map((s) => auditOf(s.events.KnowledgeConflictUnlinked)),
            );
            return { statements, value: ok(sides.map((s) => s.aggregate)) };
        });
    }

    async handOverToHotspot(
        project: Knowledge.ProjectName,
        id: Knowledge.KnowledgeItemId,
        other: Knowledge.KnowledgeItemId,
        hotspot: Knowledge.StickyRef,
        by: Knowledge.UserName,
    ): Promise<Result<readonly Knowledge.LiveKnowledgeItem[], Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone>> {
        type Answer = Result<readonly Knowledge.LiveKnowledgeItem[], Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone>;
        return this.decideAndWrite<Answer>(project, other === id ? [id] : [id, other], async (rows) => {
            const row = rows.get(id);
            if (!row) return { statements: [], value: err({ type: 'KnowledgeItemNotFound' as const, itemId: id }) };
            const item = itemOf(row);
            if (item.state !== 'Live') return { statements: [], value: err({ type: 'KnowledgeItemGone' as const, itemId: id }) };
            if (other === id) return { statements: [], value: ok([item]) };
            const otherRow = rows.get(other);
            const otherItem = otherRow ? itemOf(otherRow) : undefined;
            const at = this.now();
            // the other side too, while it is live (a deleted one's links go with it)
            const sides = [item, ...(otherItem?.state === 'Live' ? [otherItem] : [])].map((side) => {
                const r = knowledgeItemCommands.handOverToHotspot(side, { hotspot, other: side.id === id ? other : id, by, at });
                if (!r.ok) throw new Error('handOverToHotspot refused two distinct items');
                return r.value.Live;
            });
            const statements = this.writes(
                project,
                sides.map((s) => s.aggregate),
                [],
                sides.map((s) => auditOf(s.events.KnowledgeHandedOverToHotspot)),
            );
            return { statements, value: ok(sides.map((s) => s.aggregate)) };
        });
    }

    async delete(
        project: Knowledge.ProjectName,
        id: Knowledge.KnowledgeItemId,
        by: Knowledge.UserName,
    ): Promise<Result<Deletion, Knowledge.KnowledgeItemNotFound>> {
        return this.decideAndWrite<Result<Deletion, Knowledge.KnowledgeItemNotFound>>(project, [id], async (rows) => {
            const row = rows.get(id);
            if (!row) return { statements: [], value: err({ type: 'KnowledgeItemNotFound' as const, itemId: id }) };
            const item = itemOf(row);
            const deletion = { items: [id], messages: sourceMessages(item) };
            // deleting again (a retry) answers as the first time did
            if (item.state !== 'Live') return { statements: [], value: ok(deletion) };
            const r = knowledgeItemCommands.delete(item, { by, at: this.now() });
            if (!r.ok) throw new Error('delete refused a live item');
            return {
                statements: this.writes(project, [r.value.Deleted.aggregate], [], [auditOf(r.value.Deleted.events.KnowledgeItemDeleted)]),
                value: ok(deletion),
            };
        });
    }

    async deleteSession(project: Knowledge.ProjectName, session: Knowledge.SessionRef, by: Knowledge.UserName): Promise<Deletion> {
        const { results } = await this.db
            .prepare("SELECT id FROM items WHERE project = ?1 AND created_in = ?2 AND state = 'Live'")
            .bind(project, session)
            .all<{ id: string }>();
        const ids = results.map((r) => r.id);
        return this.decideAndWrite(project, ids, async (rows) => {
            const deleted: Knowledge.KnowledgeItem[] = [];
            const audit: Knowledge.AuditEntry[] = [];
            const messages: Knowledge.MessageKey[] = [];
            for (const row of rows.values()) {
                const item = itemOf(row);
                if (item.state !== 'Live') continue;
                const r = knowledgeItemCommands.delete(item, { by, at: this.now() });
                if (!r.ok) throw new Error('delete refused a live item');
                deleted.push(r.value.Deleted.aggregate);
                audit.push(auditOf(r.value.Deleted.events.KnowledgeItemDeleted));
                messages.push(...sourceMessages(item));
            }
            return {
                statements: deleted.length > 0 ? this.writes(project, deleted, [], audit) : [],
                value: { items: deleted.map((i) => i.id), messages },
            };
        });
    }

    async restore(
        project: Knowledge.ProjectName,
        id: Knowledge.KnowledgeItemId,
        by: Knowledge.UserName,
    ): Promise<Result<Knowledge.LiveKnowledgeItem, Knowledge.KnowledgeItemNotFound>> {
        return this.decideAndWrite<Result<Knowledge.LiveKnowledgeItem, Knowledge.KnowledgeItemNotFound>>(project, [id], async (rows) => {
            const row = rows.get(id);
            if (!row) return { statements: [], value: err({ type: 'KnowledgeItemNotFound' as const, itemId: id }) };
            const item = itemOf(row);
            if (item.state === 'Live') return { statements: [], value: ok(item) };
            const r = knowledgeItemCommands.restore(item, { by, at: this.now() });
            if (!r.ok) throw new Error('restore refused a deleted item');
            const restored = r.value.Live.aggregate;
            return { statements: this.writes(project, [restored], [], [auditOf(r.value.Live.events.KnowledgeItemRestored)]), value: ok(restored) };
        });
    }

    // ---- retiring ------------------------------------------------------------------------------------------------

    /** The proposals about these items, and those of these IDs wherever they are. */
    private async proposalsFor(project: string, items: readonly string[], ids: readonly string[]): Promise<Knowledge.RetirementProposal[]> {
        if (items.length === 0 && ids.length === 0) return [];
        const { results } = await this.db
            .prepare(
                'SELECT id, state, body FROM proposals WHERE project = ?1 AND (item IN (SELECT value FROM json_each(?2)) OR id IN (SELECT value FROM json_each(?3)))',
            )
            .bind(project, JSON.stringify(items), JSON.stringify(ids))
            .all<ProposalRow>();
        return results.map(proposalOf);
    }

    private async proposalRow(project: string, id: string): Promise<ProposalRow | undefined> {
        return (
            (await this.db.prepare('SELECT id, state, body FROM proposals WHERE project = ?1 AND id = ?2').bind(project, id).first<ProposalRow>()) ?? undefined
        );
    }

    /**
     * The statements that add new proposals, and the audit records of them. A row of the same ID is never overwritten
     * (`DO NOTHING`): `admitProposal` found it already, as the same proposal sent again or as a collision.
     */
    private proposalInserts(
        project: string,
        proposals: readonly Knowledge.RetirementProposal[],
        audit: readonly Knowledge.AuditEntry[],
    ): D1PreparedStatement[] {
        const statements: D1PreparedStatement[] = [];
        if (proposals.length > 0)
            statements.push(
                this.db
                    .prepare(
                        `INSERT INTO proposals (project, id, item, state, body, proposed_at)
                         SELECT ?1, j.value ->> 'id', j.value ->> 'item', j.value ->> 'state', j.value -> 'body', j.value ->> 'proposedAt' FROM json_each(?2) j
                         WHERE true ON CONFLICT (project, id) DO NOTHING`,
                    )
                    .bind(project, JSON.stringify(proposals.map((p) => ({ id: p.id, item: p.item, state: p.state, body: p, proposedAt: p.proposedAt })))),
            );
        statements.push(...this.auditWrites(project, audit));
        return statements;
    }

    /** The statement that writes a decided proposal over its open row (`openGuard` heads its batch), and the audit records. */
    private proposalDecided(project: string, proposal: Knowledge.RetirementProposal, audit: readonly Knowledge.AuditEntry[]): D1PreparedStatement[] {
        return [
            this.db
                .prepare("UPDATE proposals SET state = ?3, body = ?4 WHERE project = ?1 AND id = ?2 AND state = 'Open'")
                .bind(project, proposal.id, proposal.state, JSON.stringify(proposal)),
            ...this.auditWrites(project, audit),
        ];
    }

    private auditWrites(project: string, audit: readonly Knowledge.AuditEntry[]): D1PreparedStatement[] {
        if (audit.length === 0) return [];
        return [
            this.db
                .prepare(
                    `INSERT INTO audit (project, item, version, operation, actor, caller, reason, at)
                     SELECT ?1, j.value ->> 'item', j.value ->> 'version', j.value ->> 'operation', j.value -> 'actor', ?3, j.value ->> 'reason', j.value ->> 'at'
                     FROM json_each(?2) j ORDER BY j.key`,
                )
                .bind(project, JSON.stringify(audit), this.caller),
        ];
    }

    /** The statement that fails the batch it heads unless the proposal is still open. */
    private openGuard(project: string, id: string): D1PreparedStatement {
        return this.db
            .prepare("SELECT json(CASE WHEN (SELECT state FROM proposals WHERE project = ?1 AND id = ?2) = 'Open' THEN '1' ELSE 'stale' END)")
            .bind(project, id);
    }

    async retire(
        project: Knowledge.ProjectName,
        id: Knowledge.KnowledgeItemId,
        retirement: RetirementInput,
        by: Knowledge.UserName,
    ): Promise<Result<Knowledge.LiveKnowledgeItem, RetireError>> {
        const ids = retirement.replacedBy !== undefined && retirement.replacedBy !== id ? [id, retirement.replacedBy] : [id];
        return this.decideAndWrite<Result<Knowledge.LiveKnowledgeItem, RetireError>>(project, ids, async (rows) => {
            const row = rows.get(id);
            if (!row) return { statements: [], value: err({ type: 'KnowledgeItemNotFound' as const, itemId: id }) };
            const item = itemOf(row);
            if (item.state !== 'Live') return { statements: [], value: err({ type: 'KnowledgeItemGone' as const, itemId: id }) };
            if (ids.length > 1) {
                const other = rows.get(ids[1]);
                const replacement = other ? itemOf(other) : undefined;
                if (!replacement || replacement.state !== 'Live' || replacement.retirement !== undefined)
                    return { statements: [], value: err({ type: 'ProposalRefused' as const, reason: 'replacementUnavailable' as const }) };
            }
            const r = knowledgeItemCommands.retire(item, { ...retirement, by, at: this.now() });
            if (!r.ok) return { statements: [], value: r };
            const next = r.value.Live.aggregate;
            return { statements: this.writes(project, [next], [], [auditOf(r.value.Live.events.KnowledgeItemRetired)]), value: ok(next) };
        });
    }

    async unretire(
        project: Knowledge.ProjectName,
        id: Knowledge.KnowledgeItemId,
        by: Knowledge.UserName,
    ): Promise<Result<Knowledge.LiveKnowledgeItem, Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone | Knowledge.NotRetired>> {
        type Answer = Result<Knowledge.LiveKnowledgeItem, Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone | Knowledge.NotRetired>;
        return this.decideAndWrite<Answer>(project, [id], async (rows) => {
            const row = rows.get(id);
            if (!row) return { statements: [], value: err({ type: 'KnowledgeItemNotFound' as const, itemId: id }) };
            const item = itemOf(row);
            if (item.state !== 'Live') return { statements: [], value: err({ type: 'KnowledgeItemGone' as const, itemId: id }) };
            const r = knowledgeItemCommands.unretire(item, { by, at: this.now() });
            if (!r.ok) return { statements: [], value: r };
            const next = r.value.Live.aggregate;
            return { statements: this.writes(project, [next], [], [auditOf(r.value.Live.events.KnowledgeItemUnretired)]), value: ok(next) };
        });
    }

    async propose(project: Knowledge.ProjectName, candidate: RetirementCandidate): Promise<Result<Knowledge.RetirementProposal, ProposalRejection>> {
        const ids = [
            ...new Set([
                candidate.item,
                ...(candidate.replacedBy ? [candidate.replacedBy] : []),
                ...candidate.evidence.flatMap((e) => (e.kind === 'Decision' ? [e.item] : [])),
            ]),
        ];
        return this.decideAndWrite<Result<Knowledge.RetirementProposal, ProposalRejection>>(project, ids, async (rows) => {
            const items = new Map([...rows].map(([id, r]) => [id, itemOf(r)]));
            // about the item, and the one of the candidate's ID wherever it is (a retry, or a collision)
            const proposals = await this.proposalsFor(project, [candidate.item], [proposalIdOf(candidate)]);
            const r = admitProposal(candidate, { lookup: (id) => items.get(id), proposals }, this.now());
            if (!r.ok) return { statements: [], value: r };
            const { proposal, event } = r.value;
            const item = items.get(candidate.item);
            if (!event || !item) return { statements: [], value: ok(proposal) };
            return { statements: this.proposalInserts(project, [proposal], [auditOfProposal(event, item.version)]), value: ok(proposal) };
        });
    }

    async proposals(project: Knowledge.ProjectName): Promise<readonly Knowledge.OpenRetirementProposal[]> {
        const { results } = await this.db
            .prepare("SELECT id, state, body FROM proposals WHERE project = ?1 AND state = 'Open' ORDER BY proposed_at DESC, id DESC LIMIT 500")
            .bind(project)
            .all<ProposalRow>();
        const proposals = results.map(proposalOf);
        const items = new Map((await this.rows(project, [...new Set(proposals.map((p) => p.item))])).map((r) => [r.id, itemOf(r)]));
        return openProposals(proposals, (id) => items.get(id));
    }

    async approveProposal(
        project: Knowledge.ProjectName,
        id: Knowledge.RetirementProposalId,
        by: Knowledge.UserName,
    ): Promise<Result<ApprovedProposal, ApprovalError>> {
        for (let attempt = 1; ; attempt++) {
            const row = await this.proposalRow(project, id);
            const proposal = row ? proposalOf(row) : undefined;
            const ids = proposal ? [proposal.item, ...(proposal.replacedBy ? [proposal.replacedBy] : [])] : [];
            const rows = new Map((await this.rows(project, ids)).map((r) => [r.id, r]));
            const items = new Map([...rows].map(([i, r]) => [i, itemOf(r)]));
            const r = decideApproval(id, proposal, (i) => items.get(i), by, this.now());
            if (!r.ok) return r;
            const read = ids.map((i) => ({ id: i, rev: rows.get(i)?.rev ?? null }));
            try {
                await this.db.batch([
                    guard(this.db, project, read),
                    this.openGuard(project, id),
                    ...this.writes(project, [r.value.item], [], [auditOf(r.value.itemEvent)]),
                    ...this.proposalDecided(project, r.value.proposal, []),
                ]);
            } catch (e) {
                if (attempt >= ATTEMPTS) throw e;
                continue;
            }
            return ok({ proposal: r.value.proposal, item: r.value.item });
        }
    }

    async dismissProposal(
        project: Knowledge.ProjectName,
        id: Knowledge.RetirementProposalId,
        by: Knowledge.UserName,
    ): Promise<Result<Knowledge.DismissedRetirementProposal, Knowledge.ProposalNotFound | Knowledge.ProposalDecided>> {
        for (let attempt = 1; ; attempt++) {
            const row = await this.proposalRow(project, id);
            const proposal = row ? proposalOf(row) : undefined;
            const r = decideDismissal(id, proposal, by, this.now());
            if (!r.ok) return r;
            const item = proposal ? await this.row(project, proposal.item) : undefined;
            try {
                await this.db.batch([
                    this.openGuard(project, id),
                    ...this.proposalDecided(project, r.value.proposal, item ? [auditOfProposal(r.value.event, itemOf(item).version)] : []),
                ]);
            } catch (e) {
                if (attempt >= ATTEMPTS) throw e;
                continue;
            }
            return ok(r.value.proposal);
        }
    }

    async putImage(project: Knowledge.ProjectName, image: KnowledgeImage): Promise<Knowledge.ImageId> {
        const id = one(imageIdOf)(randomId('img_'));
        await this.bucket.put(imageKey(project, id), image.bytes, { httpMetadata: { contentType: image.mediaType } });
        const at = this.now().toISOString();
        await this.db.batch([
            this.db.prepare("INSERT INTO projects (name, visibility, created_at) VALUES (?1, 'open', ?2) ON CONFLICT DO NOTHING").bind(project, at),
            this.db
                .prepare('INSERT INTO images (project, id, media_type, size, created_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
                .bind(project, id, image.mediaType, image.bytes.byteLength, at, this.caller),
        ]);
        return id;
    }

    /** `POST /knowledge/:id/images`: stores an image and appends it to the item's text, as a person's correction. */
    async attachImage(
        project: Knowledge.ProjectName,
        id: Knowledge.KnowledgeItemId,
        image: KnowledgeImage,
        by: Knowledge.UserName,
    ): Promise<Result<Knowledge.LiveKnowledgeItem, Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone>> {
        const current = await this.get(project, id);
        if (!current) {
            const row = await this.row(project, id);
            return err(row ? { type: 'KnowledgeItemGone', itemId: id } : { type: 'KnowledgeItemNotFound', itemId: id });
        }
        const imageId = await this.putImage(project, image);
        const text = `${current.item.content.text}\n\n![](image:${imageId})`;
        const content = itemContent({ ...current.item.content, text }, 'text');
        return this.correct(project, id, content, by);
    }
}
