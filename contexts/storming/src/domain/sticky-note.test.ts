import { describe, expect, test } from 'bun:test';
import { estimatedLabelLines, labelOverflowsNote, LINES_AT_FLOOR, STICKY_NOTE } from './sticky-note.js';

describe('the estimate of how a label wraps in a sticky note', () => {
    test('fits 6 lines at the floor font size', () => {
        expect(LINES_AT_FLOOR).toBe(6);
    });

    test('breaks full-width text anywhere: 9 characters a line at 13px, 7 at 17px', () => {
        expect(estimatedLabelLines('注文が確定した')).toBe(1);
        expect(estimatedLabelLines('あ'.repeat(9))).toBe(1);
        expect(estimatedLabelLines('あ'.repeat(10))).toBe(2);
        expect(estimatedLabelLines('あ'.repeat(54))).toBe(6);
        expect(estimatedLabelLines('あ'.repeat(55))).toBe(7);
        expect(estimatedLabelLines('あ'.repeat(8), STICKY_NOTE.maxFontSize)).toBe(2);
    });

    test('moves a word that does not fit the rest of a line to the next, and breaks a word longer than a line', () => {
        // 17 narrow characters a line at 13px
        expect(estimatedLabelLines('abcdefghij abcdefghij')).toBe(2);
        expect(estimatedLabelLines('a'.repeat(17))).toBe(1);
        expect(estimatedLabelLines('a'.repeat(40))).toBe(3);
        expect(estimatedLabelLines('返金は Sales の返金依頼（RefundRequested）と同じもの？')).toBe(4);
    });

    test('takes a label as overflowing only past the lines that fit at the floor', () => {
        expect(labelOverflowsNote('あ'.repeat(54))).toBe(false);
        expect(labelOverflowsNote('あ'.repeat(55))).toBe(true);
        expect(labelOverflowsNote('Certificate issued at the multi-copy machine of the convenience store')).toBe(false);
        expect(labelOverflowsNote('word '.repeat(30))).toBe(true);
    });
});
