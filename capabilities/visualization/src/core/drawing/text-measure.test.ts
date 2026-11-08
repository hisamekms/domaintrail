// The text measure of `dt export svg`: the widths of the table, the defaults of the characters it lacks, the weights
// and the whole-pixel line metrics.
import { describe, expect, test } from 'bun:test';
import { tableMeasure } from './text-measure';

const fonts = { sans: 'SANS', mono: 'MONO' };
const measure = tableMeasure(fonts);
const sans = (size: number, weight?: number) => ({ family: fonts.sans, size, ...(weight !== undefined && { weight }) });

describe('the table measure', () => {
    test('a wide character is an em, a monospace one 0.602em, combining marks nothing', () => {
        expect(measure.width('注文を確定する', sans(16))).toBe(7 * 16);
        expect(measure.width('Order', { family: fonts.mono, size: 10 })).toBeCloseTo(5 * 6.02, 5);
        expect(measure.width('é', sans(10))).toBe(measure.width('e', sans(10)));
    });

    test('Latin is proportional, bolder is wider, and widths scale with the size', () => {
        const regular = measure.width('Order placed', sans(10));
        expect(regular).toBeGreaterThan(measure.width('iiiii', sans(10)) * 2);
        expect(measure.width('Order placed', sans(10, 700))).toBeGreaterThan(regular);
        expect(measure.width('Order placed', sans(20))).toBeCloseTo(2 * regular, 5);
    });

    test('is the same every time', () => {
        expect(measure.width('ConvenienceStoreIssuance', sans(13, 600))).toBe(tableMeasure(fonts).width('ConvenienceStoreIssuance', sans(13, 600)));
    });

    test('ascent and descent are whole pixels, as a canvas reports them', () => {
        expect(measure.metrics(sans(13))).toEqual({ ascent: 11, descent: 2 });
        expect(measure.metrics(sans(14))).toEqual({ ascent: 12, descent: 2 });
        expect(measure.metrics({ family: fonts.mono, size: 14 })).toEqual({ ascent: 13, descent: 3 });
    });
});
