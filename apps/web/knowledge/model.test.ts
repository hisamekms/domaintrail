// The knowledge as the page shows it (model.ts): a sticky's selection, the orders, the conflicts, the marks, the
// filters' query, the text without its images, the message ホットスポットにする sends, and the extraction's switch.
import { describe, expect, test } from 'bun:test';
import {
    conflictPairs,
    extractionControl,
    extractionOfMessage,
    hotspotBody,
    imagesOf,
    marksOf,
    missingConflicts,
    NO_FILTERS,
    ordered,
    outsideConflicts,
    plainText,
    queryOf,
    selectionOfSticky,
    stickyOfSelection,
    toggled,
    type KnowledgeItem,
} from './model';

const item = (id: string, over: { kind?: string; at?: string; about?: string[]; conflictsWith?: string[]; text?: string } = {}): KnowledgeItem =>
    ({
        state: 'Live',
        id,
        content: {
            text: over.text ?? `text of ${id}`,
            labels: { when: 'as_is', kind: over.kind ?? 'rule', origin: 'said' },
            about: over.about ?? ['Ordering.Placed'],
        },
        sources: [],
        version: 1,
        conflictsWith: over.conflictsWith ?? [],
        createdAt: new Date(over.at ?? '2026-11-05T09:00:00Z'),
        updatedAt: new Date(over.at ?? '2026-11-05T09:00:00Z'),
    }) as unknown as KnowledgeItem;

describe('the knowledge on the page', () => {
    test('a sticky and its selection on the canvas', () => {
        expect(stickyOfSelection('es/Ordering/Placed')).toBe('Ordering.Placed');
        expect([stickyOfSelection('es/Ordering'), stickyOfSelection('Shop.Order'), stickyOfSelection(undefined)]).toEqual([undefined, undefined, undefined]);
        expect(selectionOfSticky('Ordering.Placed')).toBe('es/Ordering/Placed');
    });

    test('newest first by default, by kind on request (newest first within a kind)', () => {
        const items = [
            item('a', { kind: 'pain', at: '2026-11-01T00:00:00Z' }),
            item('b', { kind: 'rule', at: '2026-11-02T00:00:00Z' }),
            item('c', { kind: 'pain', at: '2026-11-03T00:00:00Z' }),
        ];
        expect(ordered(items, 'newest').map((i) => i.id as string)).toEqual(['c', 'b', 'a']);
        expect(ordered(items, 'kind').map((i) => i.id as string)).toEqual(['b', 'c', 'a']);
    });

    test('conflicts: each pair once, the newer first; the other side fetched when not listed', () => {
        const a = item('a', { at: '2026-11-01T00:00:00Z', conflictsWith: ['b'] });
        const b = item('b', { at: '2026-11-02T00:00:00Z', conflictsWith: ['a'] });
        const all = new Map([a, b].map((i) => [i.id as string, i]));
        expect(conflictPairs([a, b], (id) => all.get(id)).map((p) => [p.a.id, p.b.id])).toEqual([['b', 'a']] as never);
        expect(missingConflicts([a])).toEqual(['b']);
        expect(conflictPairs([a], () => undefined)).toEqual([]);
    });

    test("a sticky's detail lists the items of a conflict in its box only", () => {
        const a = item('a', { at: '2026-11-01T00:00:00Z', conflictsWith: ['b'] });
        const b = item('b', { at: '2026-11-02T00:00:00Z', conflictsWith: ['a'] });
        const c = item('c', { at: '2026-11-03T00:00:00Z', conflictsWith: ['x'] });
        const d = item('d');
        const all = new Map([a, b, c, d].map((i) => [i.id as string, i]));
        const pairs = conflictPairs([a, b, c, d], (id) => all.get(id));
        // c's other side is unknown: no box, so it stays in the list (with its mark)
        expect(outsideConflicts([a, b, c, d], pairs).map((i) => i.id as string)).toEqual(['c', 'd']);
        expect(outsideConflicts([a, b], pairs)).toEqual([]);
    });

    test("the extraction's state from dt's WebSocket", () => {
        expect(extractionOfMessage({ type: 'knowledge.extraction', enabled: true } as never)).toBe(true);
        expect(extractionOfMessage({ type: 'knowledge.extraction', enabled: false } as never)).toBe(false);
        expect(extractionOfMessage({ type: 'knowledge.changed' })).toBeUndefined();
        expect(extractionOfMessage({ type: 'knowledge.extraction' })).toBeUndefined();
    });

    test('the facilitator switches the extraction; the others see it only while it is on; nothing without a store', () => {
        const at = (enabled: boolean | undefined, facilitator: boolean, live = true): string => extractionControl({ enabled, facilitator, live });
        expect([at(true, true), at(false, true)]).toEqual(['switch', 'switch']);
        expect([at(true, false), at(false, false)]).toEqual(['on', 'none']);
        expect([at(undefined, true), at(undefined, false)]).toEqual(['none', 'none']);
        expect([at(true, true, false), at(true, false, false)]).toEqual(['none', 'none']);
    });

    test('the dot and the mark by canvas element', () => {
        const marks = marksOf([
            { sticky: 'Ordering.Placed', hasItems: true, hasConflict: false },
            { sticky: 'Ordering.Paid', hasItems: true, hasConflict: true },
        ]);
        expect([...marks]).toEqual([
            ['es/Ordering/Placed', 'dot'],
            ['es/Ordering/Paid', 'conflict'],
        ]);
    });

    test('the filters as the query of the search', () => {
        let f = toggled(NO_FILTERS, 'kind', 'rule');
        f = toggled(f, 'origin', 'said');
        f = toggled({ ...f, q: ' 締め ' }, 'kind', 'pain');
        expect(queryOf(f).toString()).toBe('kind=rule&kind=pain&origin=said&q=%E7%B7%A0%E3%82%81');
        expect(toggled(f, 'kind', 'rule').kind).toEqual(['pain']);
        expect(queryOf(NO_FILTERS, 'c1').toString()).toBe('cursor=c1');
    });

    test('the text without its images, and the images apart', () => {
        const text = '締めは前日\n\n![](image:img_abcdefgh)\n';
        expect(plainText(text)).toBe('締めは前日');
        expect(imagesOf(text)).toEqual(['img_abcdefgh']);
    });

    test('ホットスポットにする: a message to the AI about both items, with their stickies as targets', () => {
        const a = item('a', { text: '締めは前日17時', about: ['Ordering.Placed'] });
        const b = item('b', { text: '締めは当日9時', about: ['Ordering.Placed', 'Ordering.Paid'] });
        const body = hotspotBody({
            pair: { a, b } as never,
            label: (s) => (s === 'Ordering.Placed' ? '注文した' : '支払った'),
            revision: 'r1',
            aiName: 'AI',
            text: (targets, x, y) => `${targets}: ${x} / ${y}`,
        });
        expect(body).toEqual({
            targets: [
                { target: { kind: 'DtesElement', storming: 'Ordering', local: 'Placed' }, label: '注文した', sourceRevision: 'r1' },
                { target: { kind: 'DtesElement', storming: 'Ordering', local: 'Paid' }, label: '支払った', sourceRevision: 'r1' },
            ],
            body: '@AI[p1] #注文した[1] #支払った[2]: 締めは前日17時 / 締めは当日9時',
            mentions: ['ai'],
        });
    });
});
