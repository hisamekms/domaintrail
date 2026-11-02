// The composer's chips collapsed to two rows (apps/web/session/chip-rows.ts): the rows they wrap into, and how many show
// before `+n`.
import { describe, expect, test } from 'bun:test';
import { collapsedCount, rowCount } from './chip-rows';

describe('chip rows', () => {
    test('chips wrap as flex-wrap places them, a chip wider than the row taking a row of its own', () => {
        expect(rowCount([], 100, 4)).toBe(0);
        expect(rowCount([48, 48], 100, 4)).toBe(1);
        expect(rowCount([48, 49], 100, 4)).toBe(2);
        expect(rowCount([30, 300, 30], 100, 4)).toBe(3);
        // a subpixel overflow still fits
        expect(rowCount([48, 48.3], 100, 4)).toBe(1);
    });

    test('all chips show when they fit in two rows', () => {
        expect(collapsedCount([40, 40, 40, 40], 100, 4, 30)).toBe(4);
        expect(collapsedCount([], 100, 4, 30)).toBe(0);
    });

    test('else the first chips that fit with +n at the end of the second row', () => {
        // rows of 100: [40 40] [40 40] [40] → two rows hold four; +n (30) needs the room of one 40
        expect(collapsedCount([40, 40, 40, 40, 40], 100, 4, 30)).toBe(3);
        // widths differ: [60 30] [20 20 50]; +n fits after the 20s
        expect(collapsedCount([60, 30, 20, 20, 50, 10], 100, 4, 30)).toBe(4);
        // +n itself must fit in the second row: [90] [90] → one chip and +n
        expect(collapsedCount([90, 90, 90], 100, 4, 30)).toBe(1);
    });

    test('nothing measured yet (no width): every chip shows', () => {
        expect(collapsedCount([40, 40, 40, 40, 40], 0, 4, 30)).toBe(5);
    });
});
