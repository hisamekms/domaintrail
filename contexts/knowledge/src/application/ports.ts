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
//
// A retired item (廃止, `retire`) is live, and read by its ID (`get`), but left out of the lists (`about`, `search`,
// `counts`) unless a search asks for it (`retired`): the answerer, the runner and the review read through these and
// never see one. The AI proposes retirements (`propose`); a person approves or dismisses them.
import type { Knowledge, Result } from '../generated/index.js';
import type { DroppedOperation } from '../domain/extraction.js';
import type { PastVersion } from '../domain/records.js';
import type { ApprovalError, ProposalRejection, RetirementCandidate } from '../domain/retirement.js';

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
    /** The retired items too (`include`), or those only (`only`); absent: the items not retired. */
    readonly retired?: RetiredFilter;
    /** Only items bookmarked by the project, when true. */
    readonly bookmarked?: true;
    /** At most this many per page (the store's own default and maximum otherwise). */
    readonly limit?: number;
    /** Where the previous page ended (`Page.next`). */
    readonly cursor?: string;
}

/** Whether a search lists the retired items: with the others, or alone. */
export type RetiredFilter = 'include' | 'only';

/** What a person gives to retire an item: a reason or none, and the newer item for `replaced`. */
export interface RetirementInput {
    readonly reason?: Knowledge.RetirementReason;
    readonly replacedBy?: Knowledge.KnowledgeItemId;
}

/** Why a person's retirement is refused: the item, or what was given (a replacement for another reason, or itself). */
export type RetireError =
    | Knowledge.KnowledgeItemNotFound
    | Knowledge.KnowledgeItemGone
    | Knowledge.AlreadyRetired
    | Knowledge.ReplacementWithoutReason
    | Knowledge.ReplacedByItself
    | Knowledge.ProposalRefused;

/** A proposal approved: the proposal and the item as they are now. */
export interface ApprovedProposal {
    readonly proposal: Knowledge.ApprovedRetirementProposal;
    readonly item: Knowledge.LiveKnowledgeItem;
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
    /** The proposals to retire (or to unretire) the extraction made (absent from a store before them). */
    readonly proposals?: readonly Knowledge.OpenRetirementProposal[];
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

/** A person's correction was based on an older item version. */
export interface KnowledgeItemVersionConflict {
    readonly type: 'Knowledge.KnowledgeItemVersionConflict';
    readonly itemId: Knowledge.KnowledgeItemId;
    readonly expectedVersion: Knowledge.ItemVersion;
    readonly currentVersion: Knowledge.ItemVersion;
}

export interface KnowledgeStore {
    /** The live items about any of these stickies, newest first, the retired ones left out: the panel of a sticky, the extractor's context. */
    about(project: Project, stickies: readonly Knowledge.StickyRef[]): Promise<readonly Knowledge.LiveKnowledgeItem[]>;

    /** The live items that match, newest first, a page at a time. */
    search(project: Project, query: KnowledgeQuery): Promise<Page<Knowledge.LiveKnowledgeItem>>;

    /** Per sticky of a storming that has items (retired ones do not count): whether it has a conflict. Stickies without items are left out. */
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

    /** A person's edit of the text, labels or `about`; an expected version refuses a stale edit atomically. */
    correct(
        project: Project,
        id: ItemId,
        corrected: Knowledge.ItemContent,
        by: Knowledge.UserName,
    ): Promise<Result<Knowledge.LiveKnowledgeItem, Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone>>;
    correct(
        project: Project,
        id: ItemId,
        corrected: Knowledge.ItemContent,
        by: Knowledge.UserName,
        expectedVersion: Knowledge.ItemVersion,
    ): Promise<Result<Knowledge.LiveKnowledgeItem, Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone | KnowledgeItemVersionConflict>>;

    /** Set the project's shared bookmark; a repeated setting changes neither the item nor its audit. */
    setBookmark(
        project: Project,
        id: ItemId,
        bookmarked: boolean,
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
     * A conflict a person made a hotspot (ホットスポットにする) is handed over to the hotspot the AI's run added (ADR 0031
     * section 4): on both sides (the other's only while it is live) the hotspot joins `about` and the link goes, each in
     * one decision recorded in the audit log with the hotspot as its reason, by the person who pressed the button; the
     * text, the labels and the versions stay. Returns the items as they are now (the item first). Handing over again
     * answers the items as they are.
     */
    handOverToHotspot(
        project: Project,
        id: ItemId,
        other: ItemId,
        hotspot: Knowledge.StickyRef,
        by: Knowledge.UserName,
    ): Promise<Result<readonly Knowledge.LiveKnowledgeItem[], Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone>>;

    /**
     * A person deletes an item: hidden from every read at once, and recorded in the audit log. It can be restored until
     * the store's own sweep — every few minutes, after the page's undo window (ADR 0031 section 7), whether or not the
     * page that deleted it is still open — removes every version of it and the images only it refers to, drops the
     * reasons of its audit records (`withoutReason`), forgets the proposals about it or quoting its messages
     * (`proposalsToForget`), and appends its `redactionOf` to the redaction log. Returns the messages the item came from.
     */
    delete(project: Project, id: ItemId, by: Knowledge.UserName): Promise<Result<Deletion, Knowledge.KnowledgeItemNotFound>>;

    /** A person deletes every item made in a session, as `delete` does each (`DELETE /knowledge?session=`). */
    deleteSession(project: Project, session: Knowledge.SessionRef, by: Knowledge.UserName): Promise<Deletion>;

    /** A person undoes a deletion the sweep has not yet removed. */
    restore(project: Project, id: ItemId, by: Knowledge.UserName): Promise<Result<Knowledge.LiveKnowledgeItem, Knowledge.KnowledgeItemNotFound>>;

    /**
     * A person retires an item (廃止する): it stays — text, sources, versions — but is left out of the lists and kept
     * from the AI; recorded in the audit log. A replacement must be a live item not retired (`ProposalRefused`
     * `replacementUnavailable` otherwise). Returns the item as it is now.
     */
    retire(project: Project, id: ItemId, retirement: RetirementInput, by: Knowledge.UserName): Promise<Result<Knowledge.LiveKnowledgeItem, RetireError>>;

    /** A person undoes a retirement (廃止を取り消す, and the page's 元に戻す): recorded in the audit log. */
    unretire(
        project: Project,
        id: ItemId,
        by: Knowledge.UserName,
    ): Promise<Result<Knowledge.LiveKnowledgeItem, Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone | Knowledge.NotRetired>>;

    /**
     * The AI proposes to retire an item, or to undo its retirement (the review, through this call; the extractor, as
     * operations of its extraction), with its reason and evidence. Decided by `admitProposal` (`domain/retirement.ts`):
     * refused when the item is gone, the proposal moot or already waiting, the same as one dismissed without new
     * evidence, or an AS-IS item's retirement for differing from the stickies only. The same candidate sent again
     * answers the proposal made the first time. Recorded in the audit log.
     */
    propose(project: Project, candidate: RetirementCandidate): Promise<Result<Knowledge.RetirementProposal, ProposalRejection>>;

    /** The proposals waiting for a person (open, and not moot), newest first: the 廃止の候補 of the list. */
    proposals(project: Project): Promise<readonly Knowledge.OpenRetirementProposal[]>;

    /** A person approves a proposal: the item is retired (or unretired) at once, recorded in the audit log. */
    approveProposal(project: Project, id: Knowledge.RetirementProposalId, by: Knowledge.UserName): Promise<Result<ApprovedProposal, ApprovalError>>;

    /** A person dismisses a proposal: kept, dismissed, so that the same is not proposed again; recorded in the audit log. */
    dismissProposal(
        project: Project,
        id: Knowledge.RetirementProposalId,
        by: Knowledge.UserName,
    ): Promise<Result<Knowledge.DismissedRetirementProposal, Knowledge.ProposalNotFound | Knowledge.ProposalDecided>>;

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

// ---- the published stormings (ADR 0031, section 11) -------------------------------------------------------------

/** The levels of a storming that are published: its Big Picture and its Design Level, each the whole storming. */
export const PUBLISHED_LEVELS = ['big-picture', 'design-level'] as const;
export type PublishedLevel = (typeof PUBLISHED_LEVELS)[number];

/** A sticky of a published storming: its reference and its label (the name stands in without one). */
export interface PublishedSticky {
    readonly ref: Knowledge.StickyRef;
    readonly label?: string;
}

/**
 * The published form of a storming (`dt publish`, run by CI when `main` changes): what the read-only page of the
 * Worker draws, the stickies with their labels, links and places, and when the drawing was made. It holds the
 * business's words only (the drawing is assumed to hold no personal data): no chat, no person, no file path.
 */
export interface PublishedStorming {
    /** The form's version: 1. */
    readonly format: 1;
    /** The storming's ID. */
    readonly storming: string;
    readonly label?: string;
    /** The drawing's own version: a hash of what is drawn, so that publishing the same drawing again changes nothing. */
    readonly version: string;
    /** The commit of the drawing and its date (absent: drawn from files not committed, dated when published). */
    readonly drawing: { readonly at: Date; readonly commit?: string };
    /** Every sticky of the storming (its declarations but the timelines, groups and stages), in source order. */
    readonly stickies: readonly PublishedSticky[];
    /** The drawing of each level: the Live View's laid-out graph, which the store keeps as it is and the page draws. */
    readonly views: Readonly<Record<PublishedLevel, unknown>>;
}

/** A published storming as the list of them says it, without its drawing. */
export interface PublishedEntry {
    readonly storming: string;
    readonly label?: string;
    readonly version: string;
    readonly drawing: { readonly at: Date; readonly commit?: string };
    /** When it was last published. */
    readonly publishedAt: Date;
}

/** What publishing a storming did: the entry as it is now, and whether the drawing differed from the one kept. */
export interface PublishResult {
    readonly entry: PublishedEntry;
    readonly changed: boolean;
}

/** The items about stickies that no published storming has (a sticky renamed or removed since): listed apart. */
export interface MissingStickies {
    /** The stickies the items name that no published storming has, sorted. */
    readonly stickies: readonly Knowledge.StickyRef[];
    /** The live items about them, newest first. */
    readonly items: readonly Knowledge.LiveKnowledgeItem[];
}

/**
 * Where `dt publish` sends the published stormings: the `cloudflare` store's Worker, with the service token that
 * writes. The `files` store has none (its items are read with the workspace, and the Live View draws the stormings).
 */
export interface StormingPublisher {
    /** Replaces the published form of a storming (`PUT /published/:storming`). */
    publish(project: Project, published: PublishedStorming): Promise<PublishResult>;
    /** The published stormings of the project, by ID (`GET /published`). */
    published(project: Project): Promise<readonly PublishedEntry[]>;
    /**
     * Removes the published form of a storming (`DELETE /published/:storming`), for one no longer in the workspace
     * (`dt publish --prune`); whether there was one. The knowledge about its stickies stays.
     */
    unpublish(project: Project, storming: string): Promise<boolean>;
}
