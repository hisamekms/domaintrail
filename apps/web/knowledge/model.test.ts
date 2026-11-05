// The knowledge as the page shows it (model.ts): a sticky's selection, the orders, the conflicts, the marks, the
// filters' query and an item's label chips, the message ホットスポットにする sends, the items kept with a hotspot,
// why a press got its buttons back, and the extraction's switch.
import { describe, expect, test } from 'bun:test';
import { MESSAGES } from '../i18n';
import {
    clearedReasons,
    conflictPairs,
    extractionControl,
    extractionOfMessage,
    hotspotBody,
    hotspotGroups,
    labelChips,
    marksOf,
    missingConflicts,
    NO_FILTERS,
    onlyLabel,
    ordered,
    outsideConflicts,
    queryOf,
    sourcesNewestFirst,
    selectionOfSticky,
    stickyOfSelection,
    pairKey,
    toggled,
    type KnowledgeItem,
} from './model';

const item = (id: string, over: { kind?: string; at?: string; about?: string[]; conflictsWith?: string[]; title?: string } = {}): KnowledgeItem =>
    ({
        state: 'Live',
        id,
        content: {
            title: over.title ?? `title of ${id}`,
            text: `text of ${id}`,
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
        expect(queryOf({ ...NO_FILTERS, perspective: '営業' }).toString()).toBe('perspective=%E5%96%B6%E6%A5%AD');
    });

    test("an item's label chips: when (not none), kind, origin and the perspective it has", () => {
        expect(labelChips({ when: 'to_be', kind: 'pain', origin: 'said', perspective: '営業' } as never)).toEqual([
            { axis: 'when', value: 'to_be' },
            { axis: 'kind', value: 'pain' },
            { axis: 'origin', value: 'said' },
            { axis: 'perspective', value: '営業' },
        ]);
        expect(labelChips({ when: 'none', kind: 'rule', origin: 'agreed' } as never).map((c) => c.axis)).toEqual(['kind', 'origin']);
    });

    test('a label chip pressed: the list filtered by that label alone', () => {
        expect(onlyLabel({ axis: 'kind', value: 'pain' })).toEqual({ ...NO_FILTERS, kind: ['pain'] });
        expect(onlyLabel({ axis: 'when', value: 'as_is' })).toEqual({ ...NO_FILTERS, when: ['as_is'] });
        expect(onlyLabel({ axis: 'origin', value: 'inferred' })).toEqual({ ...NO_FILTERS, origin: ['inferred'] });
        expect(onlyLabel({ axis: 'perspective', value: '営業' })).toEqual({ ...NO_FILTERS, perspective: '営業' });
    });

    test('ホットスポットにする: a message to the AI naming both items by their titles, with their stickies as targets', () => {
        const a = item('a', { title: '締めは前日17時', about: ['Ordering.Placed'] });
        const b = item('b', { title: '締めは当日9時', about: ['Ordering.Placed', 'Ordering.Paid'] });
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

    test('ホットスポットにする asks the runner to reuse a hotspot that asks the same question, and to name the one it made or used', () => {
        const text = MESSAGES.ja.knowledge.hotspotText('#注文した[1]', 'a', 'b');
        expect(text).toContain('同じ問いのホットスポットがすでにあれば、新しく作らずにそれを使ってください');
        expect(text).toContain('作った、または使ったホットスポットを返答で名指ししてください');
    });

    test('why a press got its buttons back, by its conflict whichever side comes first', () => {
        const reasons = clearedReasons([
            { items: ['b', 'a'], reason: 'none' },
            { items: ['c', 'd'], reason: 'several' },
        ]);
        expect(reasons.get(pairKey('a', 'b'))).toBe('none');
        expect(reasons.get(pairKey('d', 'c'))).toBe('several');
    });
});

describe('the items kept with a hotspot (ADR 0031, section 4)', () => {
    const isHotspot = (s: string): boolean => s.startsWith('Ordering.Hot');

    test('items about the sticky and one hotspot: grouped by it, newest first; later items about it join', () => {
        const handed = [
            item('a', { about: ['Ordering.Placed', 'Ordering.HotCutOff'], at: '2026-11-05T09:00:00Z' }),
            item('b', { about: ['Ordering.Placed', 'Ordering.HotCutOff'], at: '2026-11-05T09:01:00Z' }),
        ];
        const later = item('c', { about: ['Ordering.HotCutOff', 'Ordering.Placed', 'Ordering.Paid'], at: '2026-11-05T10:00:00Z' });
        const plain = item('d', { about: ['Ordering.Placed'] });
        const { groups, rest } = hotspotGroups([plain, ...handed, later], 'Ordering.Placed', isHotspot);
        expect(groups.map((g) => [g.hotspot, g.items.map((i) => i.id as string)])).toEqual([['Ordering.HotCutOff', ['c', 'b', 'a']]]);
        expect(rest.map((i) => i.id as string)).toEqual(['d']);
    });

    test('two hotspots: each its own box; an item about two hotspots stays in the list', () => {
        const items = [
            item('a', { about: ['Ordering.Placed', 'Ordering.HotA'], at: '2026-11-05T09:00:00Z' }),
            item('b', { about: ['Ordering.Placed', 'Ordering.HotB'], at: '2026-11-05T10:00:00Z' }),
            item('c', { about: ['Ordering.Placed', 'Ordering.HotA', 'Ordering.HotB'] }),
        ];
        const { groups, rest } = hotspotGroups(items, 'Ordering.Placed', isHotspot);
        expect(groups.map((g) => g.hotspot)).toEqual(['Ordering.HotB', 'Ordering.HotA']);
        expect(rest.map((i) => i.id as string)).toEqual(['c']);
    });

    test("in the hotspot's own detail, nothing is grouped", () => {
        const items = [item('a', { about: ['Ordering.Placed', 'Ordering.HotCutOff'] }), item('b', { about: ['Ordering.Paid', 'Ordering.HotCutOff'] })];
        expect(hotspotGroups(items, 'Ordering.HotCutOff', isHotspot)).toEqual({ groups: [], rest: items });
    });

    test('no hotspots known (no storming read): nothing is grouped', () => {
        const items = [item('a', { about: ['Ordering.Placed', 'Ordering.HotCutOff'] })];
        expect(hotspotGroups(items, 'Ordering.Placed', () => false)).toEqual({ groups: [], rest: items });
    });
});

describe("an item's sources", () => {
    test('newest first, so that the message of a correction is on top; those of the same time, the later one first', () => {
        const source = (message: string, at: string) => ({ message, at });
        expect(
            sourcesNewestFirst([source('m1', '2026-11-05T09:00:00Z'), source('m2', '2026-11-05T09:10:00Z'), source('m3', '2026-11-05T09:10:00Z')]).map(
                (s) => s.message,
            ),
        ).toEqual(['m3', 'm2', 'm1']);
    });
});
