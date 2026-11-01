// One emoji and its normal form (the rule of Collaboration's `Emoji`, T6 moves it there; its reactions:
// packages/collaboration/src/domain/marks.test.ts).
import { describe, expect, test } from 'bun:test';
import { isSingleEmoji, normalizeEmoji } from './emoji.js';

describe('one emoji (a reaction)', () => {
    test('❤ and ❤️ normalize to the same emoji, and ❤ alone is one emoji', () => {
        expect(normalizeEmoji('❤')).toBe(normalizeEmoji('❤️'));
        expect(isSingleEmoji('❤')).toBe(true);
    });
});
