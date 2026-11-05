// One extraction's operations applied to the items (ADR 0031, sections 3 and 8): the semantics every store gives
// `KnowledgeStore.applyExtraction`, pure, so that the adapters (the `files` one, the Worker) apply them alike.
//
// Operations, not states. An extraction takes a while; a person may delete or correct an item meanwhile. An operation
// on an item that is gone or deleted, or that changed since the extraction saw it (its `base` is not the item's
// version: a person's correction or another session's new version), is dropped, and the person's change stands. An
// operation the item's command refuses (a source already kept, a conflict with an item without a source) is dropped
// too. Dropping one operation leaves the others: each is applied on its own, in order, over the items as the earlier
// ones left them. A conflict is applied whole or not at all: the new item and the link on the older one.
import { Knowledge, type Result } from '../generated/index.js';
import { knowledgeItemCommands } from './items.js';

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
    | Knowledge.ConflictWithItself;

export interface AppliedOperation {
    readonly operation: Knowledge.Operation;
    /** One change, two for a conflict (the new item, then the older one linked to it). */
    readonly changes: readonly ItemChange[];
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
}

/** The items as the store holds them (deleted ones included, until the sweep); `undefined` for an item it has not. */
export type ItemLookup = (id: Knowledge.KnowledgeItemId) => Knowledge.KnowledgeItem | undefined;

/** The idempotency key of an extraction: its session and its number (ADR 0031, section 8). */
export const idempotencyKey = (by: Knowledge.ExtractionRef): string => `${by.session}#${by.number}`;

/** The items an extraction's operations read: those the store loads before applying it. */
export function itemsTouched(extraction: Knowledge.Extraction): readonly Knowledge.KnowledgeItemId[] {
    const ids = extraction.operations.flatMap((o) => (o.kind === 'Add' ? [o.id] : o.kind === 'Conflict' ? [o.id, o.item] : [o.item]));
    return [...new Set(ids)];
}

/** Applies an extraction's operations at `at`, over the items `lookup` gives. */
export function applyExtraction(extraction: Knowledge.Extraction, lookup: ItemLookup, at: Date): ExtractionOutcome {
    const changed = new Map<Knowledge.KnowledgeItemId, Knowledge.KnowledgeItem>();
    const current = (id: Knowledge.KnowledgeItemId): Knowledge.KnowledgeItem | undefined => changed.get(id) ?? lookup(id);
    const applied: AppliedOperation[] = [];
    const dropped: DroppedOperation[] = [];
    const pastVersions: Knowledge.LiveKnowledgeItem[] = [];
    for (const operation of extraction.operations) {
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
    return { applied, dropped, items: [...changed.values()], pastVersions };
}

/** The live item an operation acts on, if it has the version the extraction saw. */
function liveAt(
    current: ItemLookup,
    itemId: Knowledge.KnowledgeItemId,
): Result<Knowledge.LiveKnowledgeItem, Knowledge.KnowledgeItemNotFound | Knowledge.KnowledgeItemGone> {
    const item = current(itemId);
    if (item === undefined) return { ok: false, error: { type: 'KnowledgeItemNotFound', itemId } };
    if (item.state === 'Deleted') return { ok: false, error: { type: 'KnowledgeItemGone', itemId } };
    return { ok: true, value: item };
}

const absent = (current: ItemLookup, itemId: Knowledge.KnowledgeItemId): Result<undefined, Knowledge.KnowledgeItemExists> =>
    current(itemId) === undefined ? { ok: true, value: undefined } : { ok: false, error: { type: 'KnowledgeItemExists', itemId } };

function applyOperation(operation: Knowledge.Operation, by: Knowledge.ExtractionRef, current: ItemLookup, at: Date): Result<readonly ItemChange[], DropReason> {
    const reason = operation.reason;
    const why = reason && { reason };
    switch (operation.kind) {
        case 'Add': {
            const free = absent(current, operation.id);
            if (!free.ok) return free;
            const r = knowledgeItemCommands.add({ id: operation.id, content: operation.content, sources: operation.sources, by, ...why, at });
            if (!r.ok) return r;
            return { ok: true, value: [{ item: r.value.Live.aggregate, event: r.value.Live.events.KnowledgeItemAdded }] };
        }
        case 'AddSource': {
            const item = liveAt(current, operation.item);
            if (!item.ok) return item;
            const r = knowledgeItemCommands.addSource(item.value, { source: operation.source, agreed: operation.agreed, base: operation.base, by, ...why, at });
            if (!r.ok) return r;
            return { ok: true, value: [{ item: r.value.Live.aggregate, event: r.value.Live.events.KnowledgeSourceAdded }] };
        }
        case 'Update': {
            const item = liveAt(current, operation.item);
            if (!item.ok) return item;
            const r = knowledgeItemCommands.update(item.value, { revised: operation.revised, base: operation.base, by, ...why, at });
            if (!r.ok) return r;
            const { aggregate, events } = r.value.Live;
            if (events.KnowledgeItemRevised) return { ok: true, value: [{ item: aggregate, replaced: item.value, event: events.KnowledgeItemRevised }] };
            if (events.KnowledgeItemRewritten) return { ok: true, value: [{ item: aggregate, event: events.KnowledgeItemRewritten }] };
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
                    { item: added.value.Live.aggregate, event: added.value.Live.events.KnowledgeItemAdded },
                    { item: linked.value.Live.aggregate, event: linked.value.Live.events.KnowledgeConflictLinked },
                ],
            };
        }
    }
}
