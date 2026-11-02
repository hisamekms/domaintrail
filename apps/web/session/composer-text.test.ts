// The composer's text as its editor shows it (apps/web/session/composer-text.ts): a value read into lines of text and
// mentions and written back is the same value; a mention deleted in the editor removes its chip (or person) as
// deleting its token did; a mention brought back (undo) brings its chip back.
import { describe, expect, test } from 'bun:test';
import { composerLines, composerValue, mentionFits, type ComposerLine } from './composer-text';
import { EMPTY_COMPOSER, MAX_REQUEST_TARGETS, type ComposerValue } from './mentions';
import type { TargetDraft } from './targets';

const el = (element: string): TargetDraft => ({ target: { kind: 'DtElement', element }, label: element });
const unpaid = el('Billing.Invoice#Unpaid');
const pay = el('Billing.Invoice:pay');
const order = el('Sales.Order');

const value: ComposerValue = {
    text: '#請求書.未払い[1] のとき #請求書.支払う[2] を止めたい。\n@田中[p1] 確認して\n\n#請求書.未払い[1]',
    chips: [
        { target: unpaid, mentioned: true },
        { target: pay, mentioned: true },
        { target: order, mentioned: false },
    ],
    people: ['p:tanaka'],
};

describe('the text read into lines and written back', () => {
    test('a line per line of the text, each token a mention of what it names', () => {
        expect(composerLines(value)).toEqual([
            [
                { kind: 'element', name: '請求書.未払い', target: unpaid },
                { kind: 'text', text: ' のとき ' },
                { kind: 'element', name: '請求書.支払う', target: pay },
                { kind: 'text', text: ' を止めたい。' },
            ],
            [
                { kind: 'person', name: '田中', person: 'p:tanaka' },
                { kind: 'text', text: ' 確認して' },
            ],
            [],
            [{ kind: 'element', name: '請求書.未払い', target: unpaid }],
        ]);
        expect(composerLines(EMPTY_COMPOSER)).toEqual([[]]);
    });

    test('text → lines → text is the identity', () => {
        const values: ComposerValue[] = [
            value,
            EMPTY_COMPOSER,
            { ...EMPTY_COMPOSER, text: '\n\nplain\n' },
            // a token past the chips is text, and stays as written
            { ...EMPTY_COMPOSER, text: '#謎[3] と @誰[p2] と a#b[1]' },
            { text: 'a#b[1]x#c[1]', chips: [{ target: order, mentioned: true }], people: [] },
        ];
        for (const v of values) expect(composerValue(v, composerLines(v))).toEqual(v);
    });

    test("a token written otherwise (the IME's ＃, an element's @name[n] from before #) is written back as the composer writes it", () => {
        const v: ComposerValue = { text: '＃全角[1] @前[1]', chips: [{ target: order, mentioned: true }], people: [] };
        expect(composerValue(v, composerLines(v))).toEqual({ ...v, text: '#全角[1] #前[1]' });
    });
});

describe('editing the lines', () => {
    const lines = composerLines(value);

    test('deleting the last mention of a chip removes the chip and numbers the others down', () => {
        const edited: ComposerLine[] = [lines[0].slice(1), lines[1], lines[2]];
        expect(composerValue(value, edited)).toEqual({
            text: ' のとき #請求書.支払う[1] を止めたい。\n@田中[p1] 確認して\n',
            chips: [
                { target: pay, mentioned: true },
                { target: order, mentioned: false },
            ],
            people: ['p:tanaka'],
        });
        // one mention of 未払い left: it stays
        expect(composerValue(value, [lines[0].slice(1), lines[1], lines[2], lines[3]]).chips).toHaveLength(3);
    });

    test('deleting the mention of a person forgets them; a chip added otherwise stays', () => {
        const v = composerValue(value, [lines[0], lines[1].slice(1)]);
        expect(v.people).toEqual([]);
        expect(v.text).toBe('#請求書.未払い[1] のとき #請求書.支払う[2] を止めたい。\n 確認して');
        expect(v.chips.map((c) => c.target)).toEqual([unpaid, pay, order]);
    });

    test('a mention brought back by undo brings its chip back, after the others', () => {
        const without = composerValue(value, [lines[0].slice(1)]);
        expect(composerValue(without, lines)).toEqual({
            text: '#請求書.未払い[3] のとき #請求書.支払う[1] を止めたい。\n@田中[p1] 確認して\n\n#請求書.未払い[3]',
            chips: [
                { target: pay, mentioned: true },
                { target: order, mentioned: false },
                { target: unpaid, mentioned: true },
            ],
            people: ['p:tanaka'],
        });
    });

    test('mentioning a chip added otherwise marks it; a name is written as a token writes it', () => {
        const v = composerValue(value, [...lines, [{ kind: 'element', name: '注文 (Order)', target: order }]]);
        expect(v.chips[2]).toEqual({ target: order, mentioned: true });
        expect(v.text).toEndWith('\n#注文(Order)[3]');
    });

    test('a new target past the limit stays its name as text', () => {
        const chips = Array.from({ length: MAX_REQUEST_TARGETS }, (_, i) => ({ target: el(`Sales.E${i}`), mentioned: false }));
        const full: ComposerValue = { ...EMPTY_COMPOSER, chips };
        const mention = { kind: 'element', name: '注文', target: order } as const;
        expect(mentionFits(full, mention)).toBe(false);
        expect(composerValue(full, [[mention]])).toEqual({ ...full, text: '注文' });
        expect(mentionFits(full, { ...mention, target: chips[3].target })).toBe(true);
    });
});
