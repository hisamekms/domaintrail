// A participant's name at the join forms: one line, no control or format characters (a bidi control or a zero-width
// character could make a name read as another's), an emoji's zero-width joiner allowed.
import { describe, expect, test } from 'bun:test';
import { displayName, hasFormatCharacter } from './input.js';

describe('a name', () => {
    test.each([
        ['Ada\u202Eecila', 'a right-to-left override'],
        ['Ada\u200B', 'a zero-width space'],
        ['A\u200Dda', 'a zero-width joiner between letters'],
        ['\u2066Ada\u2069', 'isolates'],
        ['A\uFEFFda', 'a zero-width no-break space inside'],
        ['Ada\u00AD', 'a soft hyphen'],
    ])('%j is refused: %s', (raw) => {
        expect(hasFormatCharacter(raw)).toBe(true);
        expect(displayName(raw).ok).toBe(false);
    });

    test.each(['Ada', '大山 慎之介', 'Ada 👩‍💻', '👨‍👩‍👧', 'Zoë'])('%j is a name', (raw) => {
        expect(hasFormatCharacter(raw)).toBe(false);
        expect(displayName(raw).ok).toBe(true);
    });
});
