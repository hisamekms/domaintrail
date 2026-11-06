import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { referencesTo } from '../../domain/references.js';
import { planStickyEdit, quoteLabel, type StickyEditInput } from './edit.js';
import { parseStormings } from './parse.js';

const SHOP = path.join(import.meta.dir, '..', '..', '..', '..', '..', 'examples', 'shop', 'stormings', 'order-to-cash.dtes');
const text = await readFile(SHOP, 'utf8');

const planned = (source: string, input: StickyEditInput): string => {
    const r = planStickyEdit(source, input);
    if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
    return r.value.text;
};

/** The lines that differ, as `-old` / `+new` pairs (the files keep their line count in these edits). */
function changedLines(before: string, after: string): string[] {
    const a = before.split('\n');
    const b = after.split('\n');
    const out: string[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(`-${a[i] ?? ''}`, `+${b[i] ?? ''}`);
    return out;
}

describe("a sticky's label and name (ADR 0033)", () => {
    test('a new label replaces the label string only, the rest byte for byte', () => {
        const after = planned(text, {
            kind: 'wording',
            storming: 'OrderToCash',
            element: 'OrderPlaced',
            expected: { name: 'OrderPlaced', label: '注文を受け付けた' },
            label: '注文が入った',
        });
        expect(changedLines(text, after)).toEqual(['-  event OrderPlaced "注文を受け付けた" {', '+  event OrderPlaced "注文が入った" {']);
    });

    test('a label with quotes and backslashes is escaped, and reads back as written', async () => {
        const label = 'a "b" \\ c';
        const after = planned(text, { kind: 'wording', storming: 'OrderToCash', element: 'Cart', expected: { name: 'Cart', label: 'カート' }, label });
        expect(after).toContain(`readmodel Cart ${quoteLabel(label)}`);
        const parsed = await parseStormings([{ path: 'a.dtes', text: after }]);
        const cart = parsed.stormings[0].elements.find((e) => e.id === 'Cart');
        expect(cart?.label).toBe(label);
    });

    test('a rename rewrites the declaration and every reference: relations, steps, groups', async () => {
        const r = planStickyEdit(text, {
            kind: 'wording',
            storming: 'OrderToCash',
            element: 'OrderConfirmed',
            expected: { name: 'OrderConfirmed', label: '注文が確定した' },
            name: 'OrderFixed',
        });
        if (!r.ok) throw new Error(r.error.type);
        const before = (await parseStormings([{ path: 'a.dtes', text }])).stormings[0];
        // the AST and the IR find the same places
        expect(r.value.references).toBe(referencesTo(before, 'OrderConfirmed').length);
        expect(r.value.references).toBe(5);
        // the `.dt` ref keeps its own name
        expect(r.value.text.match(/\bOrderConfirmed\b/g)).toEqual(['OrderConfirmed']);
        expect(r.value.text).toContain('ref Sales.OrderConfirmed');
        const after = (await parseStormings([{ path: 'a.dtes', text: r.value.text }])).stormings[0];
        expect(referencesTo(after, 'OrderFixed')).toHaveLength(5);
        // comments and the layout are kept
        expect(r.value.text.split('\n')).toHaveLength(text.split('\n').length);
        expect(r.value.text).toContain('// From Sales to Billing, as the .dt policy Billing.BillConfirmedOrder');
    });

    test("a rename reaches an exception's `then` and a stage's `after`", async () => {
        const source = [
            'storming S "s" {',
            '  event A "a"',
            '  event B "b"',
            '  stage One "1" {',
            '    timeline T1 "t" {',
            '      A',
            '    }',
            '  }',
            '  stage Two "2" after One {',
            '    timeline T2 "t" {',
            '      B',
            '    }',
            '    exception E "e" {',
            '      B',
            '      then A',
            '    }',
            '  }',
            '}',
            '',
        ].join('\n');
        const renamedEvent = planned(source, { kind: 'wording', storming: 'S', element: 'A', expected: { name: 'A', label: 'a' }, name: 'Ax' });
        expect(renamedEvent).toContain('then Ax');
        expect(renamedEvent).toContain('      Ax\n');
        const renamedStage = planned(source, { kind: 'wording', storming: 'S', element: 'One', expected: { name: 'One', label: '1' }, name: 'First' });
        expect(renamedStage).toContain('after First');
        const parsed = await parseStormings([{ path: 'a.dtes', text: renamedStage }]);
        expect(referencesTo(parsed.stormings[0], 'First')).toHaveLength(1);
    });

    test('a label on a sticky without one is added after its name', () => {
        const source = 'storming S {\n  event A\n}\n';
        expect(planned(source, { kind: 'wording', storming: 'S', element: 'A', expected: { name: 'A' }, label: 'えー' })).toBe(
            'storming S {\n  event A "えー"\n}\n',
        );
    });

    test('refusals: stale, a bad or taken name, an empty label, nothing to change, a file that does not parse', () => {
        const base = { kind: 'wording', storming: 'OrderToCash', element: 'OrderPlaced' } as const;
        const seen = { name: 'OrderPlaced', label: '注文を受け付けた' };
        expect(planStickyEdit(text, { ...base, expected: { name: 'OrderPlaced', label: '古い' }, label: 'x' })).toEqual({
            ok: false,
            error: { type: 'Stale', current: seen },
        });
        expect(planStickyEdit(text, { ...base, expected: seen, name: '1abc' })).toEqual({ ok: false, error: { type: 'InvalidName', problem: 'format' } });
        expect(planStickyEdit(text, { ...base, expected: seen, name: 'event' })).toEqual({ ok: false, error: { type: 'InvalidName', problem: 'keyword' } });
        expect(planStickyEdit(text, { ...base, expected: seen, name: 'Order' })).toEqual({ ok: false, error: { type: 'InvalidName', problem: 'duplicate' } });
        expect(planStickyEdit(text, { ...base, expected: seen, label: ' ' })).toEqual({ ok: false, error: { type: 'InvalidLabel' } });
        expect(planStickyEdit(text, { ...base, expected: seen, label: 'a\nb' })).toEqual({ ok: false, error: { type: 'InvalidLabel' } });
        expect(planStickyEdit(text, { ...base, expected: seen, label: seen.label })).toEqual({ ok: false, error: { type: 'NothingToChange' } });
        expect(planStickyEdit(text, { ...base, element: 'Nope', expected: seen, label: 'x' })).toEqual({ ok: false, error: { type: 'NotFound' } });
        expect(planStickyEdit('storming S {', { ...base, expected: seen, label: 'x' })).toEqual({ ok: false, error: { type: 'SyntaxError' } });
    });
});

describe('hotspots (ADR 0033)', () => {
    test('a new hotspot goes after the last one, in the canonical layout', async () => {
        const after = planned(text, { kind: 'addHotspot', storming: 'OrderToCash', on: 'OrderPlaced', name: 'Duplicates', label: '二重の注文は？' });
        expect(after).toContain(
            '    resolution "一つの注文は一つの通貨に限る（Sales.Order の singleCurrency と requires sameCurrency）"\n  }\n  hotspot Duplicates "二重の注文は？" {\n    on OrderPlaced\n  }\n}\n',
        );
        const parsed = await parseStormings([{ path: 'a.dtes', text: after }]);
        expect(parsed.syntaxOk).toBe(true);
    });

    test('a hotspot goes on an event only, under a free name', () => {
        expect(planStickyEdit(text, { kind: 'addHotspot', storming: 'OrderToCash', on: 'PlaceOrder', name: 'Q', label: 'q' })).toEqual({
            ok: false,
            error: { type: 'WrongKind' },
        });
        expect(planStickyEdit(text, { kind: 'addHotspot', storming: 'OrderToCash', on: 'OrderPlaced', name: 'IssuedEvent', label: 'q' })).toEqual({
            ok: false,
            error: { type: 'InvalidName', problem: 'duplicate' },
        });
    });

    test('a question on several lines is written on one, its line breaks escaped, and reads back; a taken name gets a suffix when asked', async () => {
        const source = 'storming S "s" {\n  event A "a"\n  hotspot Q "q?" {\n    on A\n  }\n}\n';
        const after = planned(source, { kind: 'addHotspot', storming: 'S', on: 'A', name: 'Q', label: '一行目\n二行目', uniqueName: true });
        expect(after).toContain('  hotspot Q2 "一行目\\n二行目" {\n    on A\n  }\n');
        const parsed = await parseStormings([{ path: 'a.dtes', text: after }]);
        expect(parsed.stormings[0].elements.find((e) => e.id === 'Q2')?.label).toBe('一行目\n二行目');
        expect(planStickyEdit(source, { kind: 'addHotspot', storming: 'S', on: 'A', name: 'Q', label: 'x' })).toEqual({
            ok: false,
            error: { type: 'InvalidName', problem: 'duplicate' },
        });
    });

    test('an empty storming gets its first hotspot inside its braces', () => {
        const source = 'storming S "s" {\n  event A "a"\n}\n';
        expect(planned(source, { kind: 'addHotspot', storming: 'S', on: 'A', name: 'Q', label: 'q?' })).toBe(
            'storming S "s" {\n  event A "a"\n  hotspot Q "q?" {\n    on A\n  }\n}\n',
        );
    });

    test('resolving writes `status resolved` and the resolution where they belong', () => {
        // `status open` written: its value is replaced, the resolution follows it
        expect(planned(text, { kind: 'resolveHotspot', storming: 'OrderToCash', element: 'InvoiceOfCancelledOrder', resolution: '取り消す' })).toBe(
            text.replace('    on RefundRequested\n    status open\n', '    on RefundRequested\n    status resolved\n    resolution "取り消す"\n'),
        );
        // no status: both after the last clause
        const resolved = planned(text, { kind: 'resolveHotspot', storming: 'OrderToCash', element: 'IssuedEvent', resolution: 'する' });
        expect(resolved).toContain(
            '  hotspot IssuedEvent "請求書の発行を Billing の .dt でイベントにする？" {\n    on InvoiceIssued\n    status resolved\n    resolution "する"\n  }',
        );
        // no body
        expect(planned('storming S {\n  hotspot Q "q?"\n}\n', { kind: 'resolveHotspot', storming: 'S', element: 'Q', resolution: 'r' })).toBe(
            'storming S {\n  hotspot Q "q?" {\n    status resolved\n    resolution "r"\n  }\n}\n',
        );
        // a resolution on several lines, written as one
        expect(planned('storming S {\n  hotspot Q "q?"\n}\n', { kind: 'resolveHotspot', storming: 'S', element: 'Q', resolution: '一\n二' })).toContain(
            'resolution "一\\n二"',
        );
        // not a hotspot
        expect(planStickyEdit(text, { kind: 'resolveHotspot', storming: 'OrderToCash', element: 'OrderPlaced', resolution: 'r' })).toEqual({
            ok: false,
            error: { type: 'WrongKind' },
        });
    });
});
