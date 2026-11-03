import { describe, expect, test } from 'bun:test';
import { STICKY_NOTE } from '@domaintrail/storming';
import { fitKey, fitLabel, fontSizes, NOTE_KINDS, rememberedFit, rememberFit } from './note-fit';

/** A label of `chars` full-width characters as a browser wraps it in `width` px: its height at a font size. */
const wrapped =
    (chars: number, width = STICKY_NOTE.labelWidth) =>
    (fontSize: number, lineHeight: number): number =>
        Math.ceil(chars / Math.floor(width / fontSize)) * lineHeight;

describe('fitting a sticky note label', () => {
    test('tries the sizes from the usual one down to the floor, 1px apart, scaled with the text', () => {
        expect(fontSizes()).toEqual([17, 16, 15, 14, 13]);
        expect(fontSizes(1.5)).toEqual([25.5, 24, 22.5, 21, 19.5]);
    });

    test('keeps the usual size for a label that fits it, measuring nothing smaller', () => {
        const measured: number[] = [];
        const fit = fitLabel((size, line) => (measured.push(size), wrapped(7)(size, line)), STICKY_NOTE.labelHeight);
        expect(fit).toEqual({ fontSize: 17, lineHeight: 24 });
        expect(measured).toEqual([17]);
    });

    test('steps down to the largest size at which the label fits', () => {
        // 7 characters a line at 17px and 16px: 40 take 6 lines, too many; 8 at 15px: 5 lines, which fit
        const fit = fitLabel(wrapped(40), STICKY_NOTE.labelHeight);
        expect(fit.fontSize).toBe(15);
        expect(fit.clamp).toBeUndefined();
        expect(fit.lineHeight).toBeCloseTo(15 * STICKY_NOTE.lineHeight);
    });

    test('clamps at the floor to the lines that fit when the label does not fit even there', () => {
        const fit = fitLabel(wrapped(80), STICKY_NOTE.labelHeight);
        expect(fit.fontSize).toBe(STICKY_NOTE.minFontSize);
        expect(fit.clamp).toBe(6);
        // at least one line, however small the room
        expect(fitLabel(wrapped(80), 5).clamp).toBe(1);
    });

    test('tolerates the rounding of fractional line heights', () => {
        // 3 lines at 13px measure 55.06px, a browser reports 55 or 56
        expect(fitLabel((size) => (size > 13 ? 1000 : 56), 55.6)).toEqual({ fontSize: 13, lineHeight: 13 * STICKY_NOTE.lineHeight });
    });

    test('remembers a fit by label, note size, text scale and the fonts loaded', () => {
        const key = fitKey('注文が確定した', 150, 150, 1, 0);
        expect(rememberedFit(key)).toBeUndefined();
        rememberFit(key, { fontSize: 17, lineHeight: 24 });
        expect(rememberedFit(key)).toEqual({ fontSize: 17, lineHeight: 24 });
        expect(rememberedFit(fitKey('注文が確定した', 150, 150, 1, 1))).toBeUndefined();
        expect(rememberedFit(fitKey('注文が確定した', 150, 150, 1.5, 0))).toBeUndefined();
    });

    test('applies to the sticky notes only', () => {
        expect(NOTE_KINDS.has('esEvent')).toBe(true);
        expect(NOTE_KINDS.has('esGroup')).toBe(false);
        expect(NOTE_KINDS.has('aggregateRoot')).toBe(false);
    });
});
