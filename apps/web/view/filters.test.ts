import { describe, expect, test } from 'bun:test';
import { activeFilterCount, shownKinds, toggleKind } from './filters';

describe("the view toolbar's 絞り込み button", () => {
    test('the context map: active when the shared and external BCs are shown (not the default)', () => {
        expect(activeFilterCount({ view: 'contextMap', mapAll: false })).toBe(0);
        expect(activeFilterCount({ view: 'contextMap', mapAll: true })).toBe(1);
    });

    test('the structure view: one for the BCs picked (some, or none) and one for hidden stubs', () => {
        expect(activeFilterCount({ view: 'structure', contexts: 4, checked: 4, hidden: 0 })).toBe(0);
        expect(activeFilterCount({ view: 'structure', contexts: 4, checked: 1, hidden: 0 })).toBe(1);
        expect(activeFilterCount({ view: 'structure', contexts: 4, checked: 0, hidden: 0 })).toBe(1);
        expect(activeFilterCount({ view: 'structure', contexts: 4, checked: 1, hidden: 2 })).toBe(2);
    });

    test('the catalog: one for the BCs and one for the kinds; the text filter is not counted', () => {
        expect(activeFilterCount({ view: 'catalog', contexts: null, kinds: [] })).toBe(0);
        expect(activeFilterCount({ view: 'catalog', contexts: ['Sales'], kinds: [] })).toBe(1);
        expect(activeFilterCount({ view: 'catalog', contexts: [], kinds: ['events'] })).toBe(2);
    });

    test('the storming: one for each kind it hides (its exceptions, its resolved hotspots)', () => {
        expect(activeFilterCount({ view: 'storming', hidden: 0 })).toBe(0);
        expect(activeFilterCount({ view: 'storming', hidden: 1 })).toBe(1);
        expect(activeFilterCount({ view: 'storming', hidden: 2 })).toBe(2);
    });
});

describe("the catalog's kinds as checkboxes (checked: shown; none chosen: every kind)", () => {
    const all = ['a', 'b', 'c'] as const;

    test('none chosen shows every kind', () => {
        expect(shownKinds(all, [])).toEqual(all);
        expect(shownKinds(all, ['b'])).toEqual(['b']);
    });

    test('unchecking a kind from all of them chooses the others; checking the last one back chooses none again', () => {
        expect(toggleKind(all, [], 'b')).toEqual(['a', 'c']);
        expect(toggleKind(all, ['a', 'c'], 'b')).toEqual([]);
    });

    test('checking a kind adds it in the kinds’ order', () => {
        expect(toggleKind(all, ['c'], 'a')).toEqual(['a', 'c']);
    });

    test('the last kind shown stays shown', () => {
        expect(toggleKind(all, ['b'], 'b')).toEqual(['b']);
    });
});
