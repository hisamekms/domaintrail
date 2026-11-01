import { describe, expect, test } from 'bun:test';
import {
    clampComposerRows,
    DEFAULT_COMPOSER_ROWS,
    draggedComposerRows,
    keyedComposerRows,
    maxComposerRows,
    MIN_COMPOSER_ROWS,
} from '@domaintrail/web/session/composer-size';

describe("the chat composer's height", () => {
    test('at most 60% of the pillar, in whole rows, and never fewer than the minimum', () => {
        // 600px pillar: 360px, less 10px of padding and border, in rows of 20px
        expect(maxComposerRows(600, 20, 10)).toBe(17);
        expect(maxComposerRows(50, 20, 10)).toBe(MIN_COMPOSER_ROWS);
        // not measured yet (a hidden pillar)
        expect(maxComposerRows(0, 20, 10)).toBe(DEFAULT_COMPOSER_ROWS);
    });

    test('rows are clamped to [2, max]; a bad saved value is the default', () => {
        expect(clampComposerRows(6, 17)).toBe(6);
        expect(clampComposerRows(1, 17)).toBe(2);
        expect(clampComposerRows(40, 17)).toBe(17);
        expect(clampComposerRows(4.6, 17)).toBe(5);
        expect(clampComposerRows('tall', 17)).toBe(DEFAULT_COMPOSER_ROWS);
        expect(clampComposerRows(Number.NaN, 17)).toBe(DEFAULT_COMPOSER_ROWS);
        expect(clampComposerRows(9, 4)).toBe(4);
        expect(clampComposerRows(9, Number.POSITIVE_INFINITY)).toBe(9);
    });

    test('dragging up grows it by whole rows, down shrinks it', () => {
        expect(draggedComposerRows(6, -60, 20, 17)).toBe(9);
        expect(draggedComposerRows(6, -5, 20, 17)).toBe(6);
        expect(draggedComposerRows(6, 200, 20, 17)).toBe(MIN_COMPOSER_ROWS);
        expect(draggedComposerRows(6, -1000, 20, 17)).toBe(17);
    });

    test('↑/↓ by a row, Home/End to the fewest/most, other keys nothing', () => {
        expect(keyedComposerRows('ArrowUp', 6, 17)).toBe(7);
        expect(keyedComposerRows('ArrowDown', 6, 17)).toBe(5);
        expect(keyedComposerRows('ArrowDown', 2, 17)).toBe(2);
        expect(keyedComposerRows('ArrowUp', 17, 17)).toBe(17);
        expect(keyedComposerRows('Home', 6, 17)).toBe(MIN_COMPOSER_ROWS);
        expect(keyedComposerRows('End', 6, 17)).toBe(17);
        expect(keyedComposerRows('Enter', 6, 17)).toBeUndefined();
    });
});
