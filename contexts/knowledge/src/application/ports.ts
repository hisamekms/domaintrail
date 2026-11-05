// The knowledge store (ADR 0031, sections 5 to 8): the one port dt talks to for knowledge, and that the Live View and
// Claude Code reach through dt. Two adapters implement it: `files` (one Markdown file per item in the workspace's
// `knowledge/`, versions and audit left to git) and `cloudflare` (a Worker with D1 and R2, behind Access). Nothing here
// says how they keep things; what follows is what they must offer.
//
// Every call names the project (`knowledge.project` of the workspace, ADR 0031 section 6): every clone and worktree of a
// repository reads and writes the same knowledge. The calls are asynchronous (the `cloudflare` adapter is HTTP); a
// rejected promise means the store could not be reached or failed, never a domain answer, which is in the `Result`.
//
// What every call returns is live: a deleted item is hidden from every read at once (`delete`), until `restore` brings
// it back or the store's sweep removes it for good.
import type { Knowledge, Result } from '../generated/index.js';
import type { DroppedOperation } from '../domain/extraction.js';
import type { PastVersion } from '../domain/records.js';

type Project = Knowledge.ProjectName;
type ItemId = Knowledge.KnowledgeItemId;

/** A page of a list, newest first, and the cursor of the next page (absent on the last). */
export interface Page<T> {
    readonly items: readonly T[];
    readonly next?: string;
}

/** A search of the items: every given filter holds (a list filter: any of its values); none given lists them all. */
export interface KnowledgeQuery {
    /** Items about any of these stickies. */
    readonly about?: readonly Knowledge.StickyRef[];
    readonly when?: readonly Knowledge.When[];
    readonly kind?: readonly Knowledge.KnowledgeKind[];
    readonly origin?: readonly Knowledge.Origin[];
    readonly perspective?: Knowledge.Perspective;
    /** Full text, over the text (and the quotes, where the store can). */
    readonly q?: string;
    /** Items made in this session. */
    readonly session?: Knowledge.SessionRef;
    /** At most this many per page (the store's own default and maximum otherwise). */
    readonly limit?: number;
    /** Where the previous page ended (`Page.next`). */
    readonly cursor?: string;
}

/** An item with the versions it replaced, newest first (`get` with `history`). */
export interface ItemWithHistory {
    readonly item: Knowledge.LiveKnowledgeItem;
    /** Present only when asked for; the `files` adapter may keep none (git keeps them). */
    readonly history?: readonly PastVersion[];
}

/** Per sticky of a storming: whether it has items, and whether any of them is in a conflict (a dot and a mark). */
export interface StickyCount {
    readonly sticky: Knowledge.StickyRef;
    readonly hasItems: boolean;
    readonly hasConflict: boolean;
}

/** What an extraction did, as the store applied it (`applyExtraction`). */
export interface AppliedExtraction {
    /** The items the extraction added or changed, as they are now. */
    readonly items: readonly Knowledge.LiveKnowledgeItem[];
    /** The operations dropped, with why (the item deleted, corrected meanwhile, …): logged, never retried. */
    readonly dropped: readonly DroppedOperation[];
    /** True when the extraction had been applied before: this is that first result, and nothing was applied again. */
    readonly replayed: boolean;
}

/** What a deletion leaves to do in the session database: the messages the deleted items came from. */
export interface Deletion {
    readonly items: readonly ItemId[];
    readonly messages: readonly Knowledge.MessageKey[];
}

/** One entry of the redaction log with its place in it. */
export interface RedactionEntry {
    readonly redaction: Knowledge.Redaction;
    /** Where the log stands after this entry: the cursor to read on from. */
    readonly cursor: string;
}

/** An image: its bytes and its media type (`image/png`, …). */
export interface KnowledgeImage {
    readonly mediaType: string;
    readonly bytes: Uint8Array;
}

/** A filter of the audit log. */
export interface AuditQuery {
    readonly item?: ItemId;
    readonly limit?: number;
    readonly cursor?: string;
}

export interface KnowledgeStore {
    /** The live items about any of these stickies, newest first: the panel of a sticky, the extractor's context. */
    about(project: Project, stickies: readonly Knowledge.StickyRef[]): Promise<readonly Knowledge.LiveKnowledgeItem[]>;

    /** The live items that match, newest first, a page at a time. */
    search(project: Project, query: KnowledgeQuery): Promise<Page<Knowledge.LiveKnowledgeItem>>;

    /** Per sticky of a storming that has items: whether it has a conflict. Stickies without items are left out. */
    counts(project: Project, storming: string): Promise<readonly StickyCount[]>;

    /** The live item, with its past versions when `history` is asked for; `undefined` when it is missing or deleted. */
    get(project: Project, id: ItemId, options?: { readonly history?: boolean }): Promise<ItemWithHistory | undefined>;

    /**
     * Applies an extraction's operations atomically, with the semantics of `applyExtraction` (`domain/extraction.ts`):
     * the operations on items deleted or changed since the extraction saw them are dropped. The extraction's `by`
     * (session and number, `idempotencyKey`) is the idempotency key: sent again — a retry after a timeout — it applies
     * nothing and returns the first result with `replayed`. Each change and its operation's reason go to the audit log
     * (`auditOf`), and a change that made a new version keeps the version it replaced.
     */
    applyExtraction(project: Project, extraction: Knowledge.Extraction): Promise<AppliedExtraction>;

    /** A person's edit of the text, labels or `about`: always a new version, the replaced one kept. */
    correct(
        project: Project,
        id: ItemId,
        corrected: Knowledge.ItemContent,
        by: Knowledge.UserName,
    ): Promise<Result<Knowledge.LiveKnowledgeItem, Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone>>;

    /**
     * A person decides that two items linked as a conflict do not conflict (食い違いではない): the link goes from both
     * sides (the other's only while it is live), recorded in the audit log; the contents and versions stay. Returns the
     * items as they are now (the item first). Unlinking what is not linked answers the items as they are.
     */
    unlinkConflict(
        project: Project,
        id: ItemId,
        other: ItemId,
        by: Knowledge.UserName,
    ): Promise<Result<readonly Knowledge.LiveKnowledgeItem[], Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone>>;

    /**
     * A person deletes an item: hidden from every read at once, and recorded in the audit log. It can be restored until
     * the store's own sweep — every few minutes, after the page's undo window (ADR 0031 section 7), whether or not the
     * page that deleted it is still open — removes every version of it and the images only it refers to, drops the
     * reasons of its audit records (`withoutReason`), and appends its `redactionOf` to the redaction log. Returns the
     * messages the item came from.
     */
    delete(project: Project, id: ItemId, by: Knowledge.UserName): Promise<Result<Deletion, Knowledge.KnowledgeItemNotFound>>;

    /** A person deletes every item made in a session, as `delete` does each (`DELETE /knowledge?session=`). */
    deleteSession(project: Project, session: Knowledge.SessionRef, by: Knowledge.UserName): Promise<Deletion>;

    /** A person undoes a deletion the sweep has not yet removed. */
    restore(project: Project, id: ItemId, by: Knowledge.UserName): Promise<Result<Knowledge.LiveKnowledgeItem, Knowledge.KnowledgeItemNotFound>>;

    /**
     * The redaction log after a cursor (from its start without one), oldest first. It holds IDs only and is kept for
     * good, so that every dt of the project, reading on from where it left off, redacts the source messages its own
     * session database holds.
     */
    redactions(project: Project, after?: string): Promise<readonly RedactionEntry[]>;

    /** The audit log, newest first: who changed or deleted what, and why. */
    audit(project: Project, query: AuditQuery): Promise<Page<Knowledge.AuditEntry>>;

    /** Stores an image; the text refers to it as `image:<id>`. */
    putImage(project: Project, image: KnowledgeImage): Promise<Knowledge.ImageId>;

    /** An image, or `undefined` when it is missing (or removed with the item that referred to it). */
    getImage(project: Project, id: Knowledge.ImageId): Promise<KnowledgeImage | undefined>;
}
