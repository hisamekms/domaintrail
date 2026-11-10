// An extraction's operations applied to the items (ADR 0031, section 8, "operations, not states"): an operation on an
// item a person deleted or corrected meanwhile is dropped, the others are applied.
import { describe, expect, test } from 'bun:test';
import type { Knowledge } from '../generated/index.js';
import { applyExtraction, idempotencyKey, itemsTouched, type ItemLookup } from './extraction.js';
import { auditOf } from './records.js';
import { at, content, extraction, itemId, liveItem, reason, source, userName, version } from '../test-helpers.js';

const by = extraction('s2', 4);
const store = (...items: Knowledge.KnowledgeItem[]): ItemLookup => {
    const byId = new Map(items.map((i) => [i.id, i]));
    return (id) => byId.get(id);
};
const deletedItem = (item: Knowledge.LiveKnowledgeItem): Knowledge.DeletedKnowledgeItem => ({
    ...item,
    state: 'Deleted',
    deletedBy: userName('a@example.com'),
    deletedAt: at,
});
const addSource = (item: string, base = 1): Knowledge.Operation => ({
    kind: 'AddSource',
    item: itemId(item),
    base: version(base),
    source: source('s2', 'm7'),
    agreed: true,
});
const update = (item: string, base = 1, message = 'm8'): Knowledge.Operation => ({
    kind: 'Update',
    item: itemId(item),
    base: version(base),
    revised: content('more precise'),
    sources: [source('s2', message)],
});

describe('applying an extraction', () => {
    test('applies each operation and lists every item changed once, as the last operation left it', () => {
        const older = liveItem('kn_00000001', { createdIn: 's0' });
        const operations: Knowledge.Operation[] = [
            { kind: 'Add', id: itemId('kn_00000002'), content: content('a new rule'), sources: [source('s2', 'm1')], reason: reason('said by sales') },
            addSource('kn_00000001'),
            // a rewording resting on the message it already has
            update('kn_00000002', 1, 'm1'),
        ];
        const outcome = applyExtraction({ by, operations }, store(older), at);
        expect(outcome.dropped).toEqual([]);
        expect(outcome.applied.map((a) => a.changes.map((c) => c.event.type))).toEqual([
            ['KnowledgeItemAdded'],
            ['KnowledgeSourceAdded'],
            ['KnowledgeItemRewritten'],
        ]);
        expect(outcome.items.map((i): unknown[] => [i.id, i.version, i.content.text])).toEqual([
            ['kn_00000002', 1, 'more precise'],
            ['kn_00000001', 1, older.content.text],
        ]);
        // an item made by this extraction's session is rewritten in place: no past version
        expect(outcome.pastVersions).toEqual([]);
    });

    test('an update with a new source makes a new version of an item this session made, the source appended, the replaced item kept', () => {
        const mine = liveItem('kn_00000001', { createdIn: 's2' });
        const outcome = applyExtraction({ by, operations: [update('kn_00000001')] }, store(mine), at);
        expect(outcome.items[0].version).toBe(version(2));
        expect(outcome.items[0].sources).toEqual([...mine.sources, source('s2', 'm8')]);
        expect(outcome.pastVersions).toEqual([mine]);
    });

    test('keeps the replaced item when an update makes a new version', () => {
        const older = liveItem('kn_00000001', { createdIn: 's0' });
        const outcome = applyExtraction({ by, operations: [update('kn_00000001')] }, store(older), at);
        expect(outcome.pastVersions).toEqual([older]);
        expect(outcome.applied[0].changes[0].replaced).toEqual(older);
        expect(outcome.items[0].version).toBe(version(2));
    });

    test('drops the operations on an item deleted, missing or corrected since the extraction saw it, and applies the rest', () => {
        const kept = liveItem('kn_00000001');
        const gone = deletedItem(liveItem('kn_00000002'));
        const corrected = liveItem('kn_00000003', { version: 2 });
        const operations = [update('kn_00000002'), addSource('kn_00000004'), update('kn_00000003'), addSource('kn_00000001')];
        const outcome = applyExtraction({ by, operations }, store(kept, gone, corrected), at);
        expect(outcome.dropped).toEqual([
            { operation: operations[0], reason: { type: 'Knowledge.KnowledgeItemGone', itemId: itemId('kn_00000002') } },
            { operation: operations[1], reason: { type: 'Knowledge.KnowledgeItemNotFound', itemId: itemId('kn_00000004') } },
            { operation: operations[2], reason: { type: 'Knowledge.StaleOperation' } },
        ]);
        expect(outcome.items.map((i) => i.id)).toEqual([kept.id]);
    });

    test('a later operation of the same extraction sees what an earlier one did: a second update of a new version is stale', () => {
        const older = liveItem('kn_00000001', { createdIn: 's0' });
        const outcome = applyExtraction({ by, operations: [update('kn_00000001'), update('kn_00000001')] }, store(older), at);
        expect(outcome.applied).toHaveLength(1);
        expect(outcome.dropped.map((d) => d.reason)).toEqual([{ type: 'Knowledge.StaleOperation' }]);
    });

    test('a conflict adds the new item and links the older one, both with sources; otherwise neither', () => {
        const conflict = (item: string): Knowledge.Operation => ({
            kind: 'Conflict',
            id: itemId('kn_00000009'),
            content: content('the opposite'),
            sources: [source('s2', 'm2')],
            item: itemId(item),
            base: version(1),
        });
        const older = liveItem('kn_00000001');
        const linked = applyExtraction({ by, operations: [conflict('kn_00000001')] }, store(older), at);
        expect(linked.items.map((i): unknown[] => [i.id, i.conflictsWith])).toEqual([
            ['kn_00000009', ['kn_00000001']],
            ['kn_00000001', ['kn_00000009']],
        ]);

        const unsourced = liveItem('kn_00000001', { sources: [] });
        const refused = applyExtraction({ by, operations: [conflict('kn_00000001')] }, store(unsourced), at);
        expect(refused.items).toEqual([]);
        expect(refused.dropped.map((d) => d.reason)).toEqual([{ type: 'Knowledge.ConflictWithoutSource' }]);

        const onDeleted = applyExtraction({ by, operations: [conflict('kn_00000001')] }, store(deletedItem(older)), at);
        expect(onDeleted.items).toEqual([]);
    });

    test('an add with an ID the store has is dropped, never overwriting the item', () => {
        const existing = liveItem('kn_00000001');
        const outcome = applyExtraction(
            { by, operations: [{ kind: 'Add', id: existing.id, content: content('other'), sources: [source('s2', 'm1')] }] },
            store(existing),
            at,
        );
        expect(outcome.dropped.map((d) => d.reason)).toEqual([{ type: 'Knowledge.KnowledgeItemExists', itemId: existing.id }]);
    });

    test('each applied change gives the audit log who, what and why', () => {
        const outcome = applyExtraction(
            {
                by,
                operations: [
                    { kind: 'Add', id: itemId('kn_00000002'), content: content('a rule'), sources: [source('s2', 'm1')], reason: reason('said by sales') },
                ],
            },
            store(),
            at,
        );
        expect(auditOf(outcome.applied[0].changes[0].event)).toEqual({
            item: itemId('kn_00000002'),
            version: version(1),
            operation: 'add',
            actor: { kind: 'Extractor', extraction: by },
            reason: reason('said by sales'),
            at,
        });
    });
});

describe('the idempotency of an extraction', () => {
    test('is keyed by its session and number', () => {
        expect(idempotencyKey(extraction('s2', 4))).toBe('s2#4');
        expect(idempotencyKey(extraction('s2', 4))).not.toBe(idempotencyKey(extraction('s2', 5)));
    });

    test('applying the same extraction again over its own result applies nothing new: the store returns the first result instead', () => {
        // what the key guards against: without it, the adds of a retry would be dropped as existing, the rest applied twice
        const operations: Knowledge.Operation[] = [{ kind: 'Add', id: itemId('kn_00000002'), content: content('a rule'), sources: [source('s2', 'm1')] }];
        const first = applyExtraction({ by, operations }, store(), at);
        const again = applyExtraction({ by, operations }, store(...first.items), at);
        expect(again.applied).toEqual([]);
    });

    test('the items an extraction reads are those its operations name', () => {
        const operations: Knowledge.Operation[] = [
            addSource('kn_00000001'),
            {
                kind: 'Conflict',
                id: itemId('kn_00000009'),
                content: content('x'),
                sources: [source('s2', 'm2')],
                item: itemId('kn_00000001'),
                base: version(1),
            },
        ];
        expect(itemsTouched({ by, operations })).toEqual([itemId('kn_00000001'), itemId('kn_00000009')]);
    });
});
