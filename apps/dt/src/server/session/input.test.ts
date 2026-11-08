// A participant's name at the join forms: one line, no control or format characters (a bidi control or a zero-width
// character could make a name read as another's), an emoji's zero-width joiner allowed.
import { describe, expect, test } from 'bun:test';
import { displayName, fallbackHotspotName, hasFormatCharacter, hotspotNameOf, stickyEditInput } from './input.js';

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

describe("a hotspot's name (ADR 0033)", () => {
    test("the light model's name made an ID: PascalCase from its words, letters and digits, at most 40; none when nothing is left", () => {
        expect(hotspotNameOf('DuplicateOrders')).toBe('DuplicateOrders');
        expect(hotspotNameOf('refund after shipping')).toBe('RefundAfterShipping');
        expect(hotspotNameOf('Double returns!')).toBe('DoubleReturns');
        expect(hotspotNameOf('2nd delivery')).toBe('NdDelivery');
        expect(hotspotNameOf('A'.repeat(60))).toHaveLength(40);
        expect(hotspotNameOf('日本語だけ')).toBeUndefined();
        expect(hotspotNameOf(42)).toBeUndefined();
        expect(fallbackHotspotName('ReturnRequested')).toBe('ReturnRequestedQuestion');
    });

    test('a hotspot without a name is read as one for the server to name', () => {
        const read = stickyEditInput({ kind: 'addHotspot', storming: 'S', on: 'A', label: '一行目\n二行目', onLabel: 'えー', onKind: 'event' });
        expect(read).toEqual({
            ok: true,
            value: { kind: 'unnamedHotspot', storming: 'S', on: 'A', label: '一行目\n二行目', onLabel: 'えー', onKind: 'event' },
        });
    });
});
