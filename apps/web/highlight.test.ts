// The keywords of the DSL in the highlighted source.
import { describe, expect, test } from 'bun:test';
import { highlight } from './highlight';

describe('requires in the Live View', () => {
    test('when is highlighted as a keyword', () => {
        const tokens = highlight('emits Done when Draft ->')[0]
            .filter((t) => t.kind === 'keyword')
            .map((t) => t.text);
        expect(tokens).toEqual(['emits', 'when']);
    });
    test('requires and else are highlighted as keywords', () => {
        const tokens = highlight('requires x { true } else Blocked')[0]
            .filter((t) => t.kind === 'keyword')
            .map((t) => t.text);
        expect(tokens).toEqual(['requires', 'true', 'else']);
    });
});

describe('changes in the DSL', () => {
    test('changes is highlighted as a keyword', () => {
        expect(
            highlight('changes note emits X')[0]
                .filter((t) => t.kind === 'keyword')
                .map((t) => t.text),
        ).toEqual(['changes', 'emits']);
    });
});

describe('verified types: the checker', () => {
    test('`verified`, `of` and `for` are highlighted as keywords', () => {
        expect(
            highlight('verified V of String for X?')[0]
                .filter((t) => t.kind === 'keyword')
                .map((t) => t.text),
        ).toEqual(['verified', 'of', 'for']);
    });
});
