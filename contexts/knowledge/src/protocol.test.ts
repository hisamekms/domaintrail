// The wire of the store's API: the port's values survive JSON both ways, and what is not a value of the model is a
// WireError that says where.
import { describe, expect, test } from 'bun:test';
import type { Knowledge } from './generated/index.js';
import type { AppliedExtraction } from './application/ports.js';
import { WireError, appliedExtraction, extraction, extractionSwitch, knowledgeItem, knowledgeQueryOf, knowledgeQueryParams } from './protocol.js';
import { at, content, extraction as extractionRef, itemId, liveItem, reason, source, userName, version } from './test-helpers.js';

const overJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

describe('the wire', () => {
    test('an extraction and its result come back as they were sent', () => {
        const sent: Knowledge.Extraction = {
            by: extractionRef('s1', 3),
            operations: [
                { kind: 'Add', id: itemId('kn_00000001'), content: content('a rule'), sources: [source('s1', 'm1')], reason: reason('said') },
                { kind: 'AddSource', item: itemId('kn_00000002'), base: version(2), source: source('s1', 'm2'), agreed: true },
                {
                    kind: 'Update',
                    item: itemId('kn_00000002'),
                    base: version(2),
                    revised: content('more precise', 'agreed', []),
                    sources: [source('s1', 'm4')],
                },
                {
                    kind: 'Conflict',
                    id: itemId('kn_00000003'),
                    content: content('the other way'),
                    sources: [source('s1', 'm3')],
                    item: itemId('kn_00000002'),
                    base: version(2),
                },
            ],
        };
        expect(extraction(overJson(sent), 'body')).toEqual(sent);
        const deleted: Knowledge.KnowledgeItem = {
            ...liveItem('kn_00000004', { createdIn: 's1' }),
            state: 'Deleted',
            deletedBy: userName('a@example.com'),
            deletedAt: at,
        };
        expect(knowledgeItem(overJson(deleted), 'item')).toEqual(deleted);
        const result: AppliedExtraction = {
            items: [liveItem('kn_00000001')],
            dropped: [{ operation: sent.operations[1], reason: { type: 'StaleOperation' } }],
            replayed: false,
        };
        expect(appliedExtraction(overJson(result), 'body')).toEqual(result);
    });

    test('a value that is not the model’s is refused with where it is', () => {
        const bad = overJson({ by: extractionRef('s1', 1), operations: [{ kind: 'Add', id: 'kn_1', content: content('x'), sources: [source('s1', 'm1')] }] });
        expect(() => extraction(bad, 'body')).toThrow(
            new WireError('body.operations[0].id: not valid ({"type":"InvalidKnowledgeItemId","value":"kn_1","invariant":"valid"})'),
        );
        expect(() =>
            extraction(overJson({ by: extractionRef('s1', 1), operations: [{ kind: 'Add', id: 'kn_00000001', content: content('x'), sources: [] }] }), 'body'),
        ).toThrow('body.operations[0].sources: expected at least one');
        expect(() =>
            extraction(
                overJson({
                    by: extractionRef('s1', 1),
                    operations: [{ kind: 'Update', item: 'kn_00000001', base: 1, revised: content('x', 'said', ['A.b', 'A.b']) }],
                }),
                'b',
            ),
        ).toThrow('b.operations[0].revised.about: a sticky named twice');
        expect(() => knowledgeItem({ ...(overJson(liveItem('kn_00000001')) as object), createdAt: 'yesterday' }, 'item')).toThrow(
            'item.createdAt: expected an ISO 8601 time',
        );
    });

    test('a search goes through its query and back', () => {
        const query = {
            about: content('x', 'said', ['A.b', 'C.d']).about,
            kind: ['rule', 'pain'] as Knowledge.KnowledgeKind[],
            q: '見積 もり',
            limit: 20,
            cursor: 'abc',
        };
        expect(knowledgeQueryOf(new URLSearchParams(knowledgeQueryParams(query).toString()))).toEqual(query);
        expect(() => knowledgeQueryOf(new URLSearchParams('when=later'))).toThrow('when[0]: expected one of as_is, to_be, none');
        expect(() => knowledgeQueryOf(new URLSearchParams('limit=1000'))).toThrow('limit: expected an integer from 1 to 200');
    });

    test("the extraction switch's body", () => {
        expect(extractionSwitch({ enabled: false }, 'body')).toEqual({ enabled: false });
        expect(() => extractionSwitch({ enabled: 'yes' }, 'body')).toThrow('body.enabled: expected a boolean');
    });
});
