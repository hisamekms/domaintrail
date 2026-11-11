// One extraction's operations applied to the items (ADR 0031, sections 3 and 8): the semantics every store gives
// `KnowledgeStore.applyExtraction`, pure, so that the adapters (the `files` one, the Worker) apply them alike.
//
// Operations, not states. An extraction takes a while; a person may delete or correct an item meanwhile. An operation
// on an item that is gone or deleted, or that changed since the extraction saw it (its `base` is not the item's
// version: a person's correction or another session's new version), is dropped, and the person's change stands. An
// operation the item's command refuses (a source already kept, a conflict with an item without a source) is dropped
// too. Dropping one operation leaves the others: each is applied on its own, in order, over the items as the earlier
// ones left them. A conflict is applied whole or not at all: the new item and the link on the older one.
//
// A retired item is kept from the extractor (it sees only its title and reason): an operation on one is dropped. The
// extractor's proposals to retire an item or to undo a retirement (`ProposeRetire`, `ProposeUnretire`) are decided as
// every store decides a candidate (`admitProposal`, `domain/retirement.ts`), over the proposals about the item and those
// this extraction made before.
import { Knowledge, type Result } from '../generated/index.js';
import { knowledgeItemCommands } from './items.js';
import { admitProposal, isRetired, type ProposalRejection, type RetirementCandidate } from './retirement.js';

/** One item changed by an operation: the item after it, and the event, which is the audit log's record. */
export interface ItemChange {
    readonly item: Knowledge.KnowledgeItem;
    /** The item as it was, when the change made a new version: the store keeps it as a past version. */
    readonly replaced?: Knowledge.LiveKnowledgeItem;
    readonly event: Knowledge.KnowledgeItemEvent;
}

/** Why an operation was dropped: its item is missing, deleted or changed since, or its command refused it. */
export type DropReason =
    | Knowledge.KnowledgeItemNotFound
    | Knowledge.KnowledgeItemGone
    | Knowledge.KnowledgeItemExists
    | Knowledge.StaleOperation
    | Knowledge.DuplicateSource
    | Knowledge.ConflictWithoutSource
    | Knowledge.ConflictWithItself
    | Knowledge.RetiredItem
    | ProposalRejection;

/** A proposal an operation made: the proposal, its event and the version of its item then (for the audit log). */
export interface ProposalChange {
    readonly proposal: Knowledge.OpenRetirementProposal;
    readonly event: Knowledge.RetirementProposed;
    readonly version: Knowledge.ItemVersion;
}

export interface AppliedOperation {
    readonly operation: Knowledge.Operation;
    /** One change, two for a conflict (the new item, then the older one linked to it); none for a proposal. */
    readonly changes: readonly ItemChange[];
    /** The proposal a `ProposeRetire` or `ProposeUnretire` made. */
    readonly proposal?: ProposalChange;
}

export interface DroppedOperation {
    readonly operation: Knowledge.Operation;
    readonly reason: DropReason;
}

/** What an extraction did. */
export interface ExtractionOutcome {
    readonly applied: readonly AppliedOperation[];
    readonly dropped: readonly DroppedOperation[];
    /** Each item the extraction changed, once, as the last of its operations left it: what the store writes. */
    readonly items: readonly Knowledge.KnowledgeItem[];
    /** The past versions to keep: each item as it was before an operation made a new version of it. */
    readonly pastVersions: readonly Knowledge.LiveKnowledgeItem[];
    /** The proposals the extraction made. */
    readonly proposals: readonly Knowledge.OpenRetirementProposal[];
}

/** The items as the store holds them (deleted ones included, until the sweep); `undefined` for an item it has not. */
export type ItemLookup = (id: Knowledge.KnowledgeItemId) => Knowledge.KnowledgeItem | undefined;

/** Every proposal the store holds about an item, in any state (more may be given: those of the candidates' IDs). */
export type ProposalLookup = (item: Knowledge.KnowledgeItemId) => readonly Knowledge.RetirementProposal[];

/** The idempotency key of an extraction: its session and its number (ADR 0031, section 8). */
export const idempotencyKey = (by: Knowledge.ExtractionRef): string => `${by.session}#${by.number}`;

/** The items an extraction's operations read: those the store loads before applying it (a proposal's replacement and decisions too). */
export function itemsTouched(extraction: Knowledge.Extraction): readonly Knowledge.KnowledgeItemId[] {
    const ids = extraction.operations.flatMap((o) => {
        switch (o.kind) {
            case 'Add':
                return [o.id];
            case 'Conflict':
                return [o.id, o.item];
            case 'ProposeRetire':
                return [o.item, ...(o.replacedBy ? [o.replacedBy] : []), ...decisionsOf(o.evidence)];
            case 'ProposeUnretire':
                return [o.item, ...decisionsOf(o.evidence)];
            default:
                return [o.item];
        }
    });
    return [...new Set(ids)];
}

/** The items whose proposals an extraction's operations read: the items it proposes about. */
export function proposalsTouched(extraction: Knowledge.Extraction): readonly Knowledge.KnowledgeItemId[] {
    return [...new Set(extraction.operations.flatMap((o) => (o.kind === 'ProposeRetire' || o.kind === 'ProposeUnretire' ? [o.item] : [])))];
}

const decisionsOf = (evidence: readonly Knowledge.Evidence[]): Knowledge.KnowledgeItemId[] => evidence.flatMap((e) => (e.kind === 'Decision' ? [e.item] : []));

/** The candidate a proposing operation of the extraction `by` makes. */
export function candidateOf(
    operation: Extract<Knowledge.Operation, { readonly kind: 'ProposeRetire' | 'ProposeUnretire' }>,
    by: Knowledge.ExtractionRef,
): RetirementCandidate {
    const proposedBy: Knowledge.Proposer = { kind: 'Extraction', extraction: by };
    return operation.kind === 'ProposeRetire'
        ? {
              item: operation.item,
              action: 'retire',
              reason: operation.retirementReason,
              ...(operation.replacedBy && { replacedBy: operation.replacedBy }),
              explanation: operation.reason,
              evidence: operation.evidence,
              proposedBy,
          }
        : { item: operation.item, action: 'unretire', explanation: operation.reason, evidence: operation.evidence, proposedBy };
}

/** Applies an extraction's operations at `at`, over the items `lookup` gives and the proposals `proposals` gives. */
export function applyExtraction(extraction: Knowledge.Extraction, lookup: ItemLookup, at: Date, proposals: ProposalLookup = () => []): ExtractionOutcome {
    const changed = new Map<Knowledge.KnowledgeItemId, Knowledge.KnowledgeItem>();
    const current = (id: Knowledge.KnowledgeItemId): Knowledge.KnowledgeItem | undefined => changed.get(id) ?? lookup(id);
    const made: Knowledge.OpenRetirementProposal[] = [];
    const proposalsAbout = (item: Knowledge.KnowledgeItemId): readonly Knowledge.RetirementProposal[] => [
        ...proposals(item),
        ...made.filter((p) => p.item === item),
    ];
    const applied: AppliedOperation[] = [];
    const dropped: DroppedOperation[] = [];
    const pastVersions: Knowledge.LiveKnowledgeItem[] = [];
    for (const operation of extraction.operations) {
        if (operation.kind === 'ProposeRetire' || operation.kind === 'ProposeUnretire') {
            const r = admitProposal(candidateOf(operation, extraction.by), { lookup: current, proposals: proposalsAbout(operation.item) }, at);
            const item = current(operation.item);
            if (!r.ok) dropped.push({ operation, reason: r.error });
            else if (r.value.event && r.value.proposal.state === 'Open' && item) {
                made.push(r.value.proposal);
                applied.push({ operation, changes: [], proposal: { proposal: r.value.proposal, event: r.value.event, version: item.version } });
            }
            continue;
        }
        const r = applyOperation(operation, extraction.by, current, at);
        if (!r.ok) {
            dropped.push({ operation, reason: r.error });
            continue;
        }
        applied.push({ operation, changes: r.value });
        for (const c of r.value) {
            changed.set(c.item.id, c.item);
            if (c.replaced) pastVersions.push(c.replaced);
        }
    }
    return { applied, dropped, items: [...changed.values()], pastVersions, proposals: made };
}

/** The live item an operation acts on, unless it is retired (the extractor was not given it). */
function liveAt(
    current: ItemLookup,
    itemId: Knowledge.KnowledgeItemId,
): Result<Knowledge.LiveKnowledgeItem, Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone | Knowledge.RetiredItem> {
    const item = current(itemId);
    if (item === undefined) return { ok: false, error: { type: 'Knowledge.KnowledgeItemNotFound', itemId } };
    if (item.state === 'Deleted') return { ok: false, error: { type: 'Knowledge.KnowledgeItemGone', itemId } };
    if (isRetired(item)) return { ok: false, error: { type: 'Knowledge.RetiredItem', itemId } };
    return { ok: true, value: item };
}

const absent = (current: ItemLookup, itemId: Knowledge.KnowledgeItemId): Result<undefined, Knowledge.KnowledgeItemExists> =>
    current(itemId) === undefined ? { ok: true, value: undefined } : { ok: false, error: { type: 'Knowledge.KnowledgeItemExists', itemId } };

function applyOperation(
    operation: Exclude<Knowledge.Operation, { readonly kind: 'ProposeRetire' | 'ProposeUnretire' }>,
    by: Knowledge.ExtractionRef,
    current: ItemLookup,
    at: Date,
): Result<readonly ItemChange[], DropReason> {
    const reason = operation.reason;
    const why = reason && { reason };
    switch (operation.kind) {
        case 'Add': {
            const free = absent(current, operation.id);
            if (!free.ok) return free;
            const r = knowledgeItemCommands.add({ id: operation.id, content: operation.content, sources: operation.sources, by, ...why, at });
            if (!r.ok) return r;
            return { ok: true, value: [{ item: r.value.Live.aggregate, event: r.value.Live.events['Knowledge.KnowledgeItemAdded'] }] };
        }
        case 'AddSource': {
            const item = liveAt(current, operation.item);
            if (!item.ok) return item;
            const r = knowledgeItemCommands.addSource(item.value, { source: operation.source, agreed: operation.agreed, base: operation.base, by, ...why, at });
            if (!r.ok) return r;
            return { ok: true, value: [{ item: r.value.Live.aggregate, event: r.value.Live.events['Knowledge.KnowledgeSourceAdded'] }] };
        }
        case 'Update': {
            const item = liveAt(current, operation.item);
            if (!item.ok) return item;
            const r = knowledgeItemCommands.update(item.value, {
                revised: operation.revised,
                newSources: operation.sources,
                base: operation.base,
                by,
                ...why,
                at,
            });
            if (!r.ok) return r;
            const { aggregate, events } = r.value.Live;
            if (events['Knowledge.KnowledgeItemRevised'])
                return { ok: true, value: [{ item: aggregate, replaced: item.value, event: events['Knowledge.KnowledgeItemRevised'] }] };
            if (events['Knowledge.KnowledgeItemRewritten'])
                return { ok: true, value: [{ item: aggregate, event: events['Knowledge.KnowledgeItemRewritten'] }] };
            throw new Error('update emitted neither KnowledgeItemRevised nor KnowledgeItemRewritten');
        }
        case 'Conflict': {
            const older = liveAt(current, operation.item);
            if (!older.ok) return older;
            const free = absent(current, operation.id);
            if (!free.ok) return free;
            const added = knowledgeItemCommands.addConflicting({
                id: operation.id,
                content: operation.content,
                sources: operation.sources,
                other: operation.item,
                by,
                ...why,
                at,
            });
            if (!added.ok) return added;
            const linked = knowledgeItemCommands.linkConflict(older.value, { other: operation.id, base: operation.base, by, ...why, at });
            if (!linked.ok) return linked;
            return {
                ok: true,
                value: [
                    { item: added.value.Live.aggregate, event: added.value.Live.events['Knowledge.KnowledgeItemAdded'] },
                    { item: linked.value.Live.aggregate, event: linked.value.Live.events['Knowledge.KnowledgeConflictLinked'] },
                ],
            };
        }
    }
}
