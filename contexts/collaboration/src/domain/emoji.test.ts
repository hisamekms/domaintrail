// One emoji, as a reaction holds it (ADR 0026, appendix "Votes and reactions"): what counts as one emoji and the form
// it is kept in (the `Emoji` primitive built on it: marks.test.ts; `collab.quickReactions`:
// application/config.test.ts).
import { describe, expect, test } from 'bun:test';
import { isNormalEmoji, isSingleEmoji, normalizeEmoji, readEmoji } from './emoji.js';

describe('one emoji (a reaction)', () => {
    test.each([
        ['👍', '👍'],
        ['❤', '❤️'],
        ['❤️', '❤️'],
        ['👨‍👩‍👧‍👦', '👨‍👩‍👧‍👦'],
        ['👍🏽', '👍🏽'],
        ['☝🏽', '☝🏽'],
        ['🇯🇵', '🇯🇵'],
        ['1⃣', '1️⃣'],
        ['#️⃣', '#️⃣'],
        ['🏳‍🌈', '🏳️‍🌈'],
        ['🏃🏽‍♂', '🏃🏽‍♂️'],
        ['🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🏴󠁧󠁢󠁳󠁣󠁴󠁿'],
        [' 🎉 ', '🎉'],
    ])('%s is one emoji, kept as %s', (input, kept) => {
        expect(readEmoji(input)).toBe(kept);
        expect(isNormalEmoji(kept)).toBe(true);
    });

    test.each([['ok'], ['1'], ['a'], ['👍👍'], ['👍 ❤️'], ['🇯'], ['👍\u0301'], [''], ['\u200D'], ['🏽'], ['👍'.repeat(20)]])('%j is not', (input) => {
        expect(readEmoji(input)).toBeUndefined();
    });

    test('❤ and ❤️ are the same reaction, in one form', () => {
        expect(normalizeEmoji('❤')).toBe(normalizeEmoji('❤️'));
        expect(isSingleEmoji('❤')).toBe(true);
        expect(isNormalEmoji('❤')).toBe(false);
    });
});
