// What a deleted item leaves (ADR 0031, section 7): the redaction log's entry, IDs only; the audit without reasons.
import { describe, expect, test } from 'bun:test';
import type { Knowledge } from '../generated/index.js';
import { auditOf, imagesIn, pastVersionOf, redactionOf, withoutReason } from './records.js';
import { at, extraction, later, liveItem, reason, source, userName } from '../test-helpers.js';

describe('the redaction log', () => {
    test("records a deleted item's ID and the messages it came from, once each, and nothing of its text", () => {
        const item = liveItem('kn_00000001', { sources: [source('s1', 'm1'), source('s2', 'm1'), source('s1', 'm2')] });
        const deleted: Knowledge.DeletedKnowledgeItem = { ...item, state: 'Deleted', deletedBy: userName('a@example.com'), deletedAt: at };
        expect(redactionOf(deleted)).toEqual({
            item: item.id,
            messages: [
                { session: 's1', message: 'm1' },
                { session: 's2', message: 'm1' },
                { session: 's1', message: 'm2' },
            ],
        } as unknown as Knowledge.Redaction);
    });
});

describe('the audit log', () => {
    test("a person's deletion names the person; the sweep drops the reasons", () => {
        const person = userName('a@example.com');
        const item = liveItem('kn_00000001');
        expect(auditOf({ type: 'KnowledgeItemDeleted', itemId: item.id, version: item.version, by: person, at })).toEqual({
            item: item.id,
            version: item.version,
            operation: 'delete',
            actor: { kind: 'Person', user: person },
            at,
        });
        const added = auditOf({
            type: 'KnowledgeItemAdded',
            itemId: item.id,
            version: item.version,
            conflictsWith: [],
            by: extraction('s1', 1),
            reason: reason('quoted'),
            at,
        });
        expect(withoutReason(added)).toEqual({
            item: item.id,
            version: item.version,
            operation: 'add',
            actor: { kind: 'Extractor', extraction: extraction('s1', 1) },
            at,
        });
    });
});

test('a past version is the content it had and when it was replaced', () => {
    const item = liveItem('kn_00000001');
    expect(pastVersionOf(item, { ...item, updatedAt: later })).toEqual({ version: item.version, content: item.content, replacedAt: later });
});

test('the images of a text are its `image:` references to valid IDs, once each', () => {
    expect(imagesIn('![a](image:img_0000abcd) and ![b](image:img_0000abcd) ![c](image:img_x) ![d](image:img_1111efgh)')).toEqual([
        'img_0000abcd',
        'img_1111efgh',
    ] as unknown as Knowledge.ImageId[]);
});
