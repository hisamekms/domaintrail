import { describe, expect, test } from 'bun:test';
import { analyze } from '../src/core/analyze.js';
import { loadWorkspace } from '../src/core/files.js';
import { generateTypeScript } from '../src/generator/typescript.js';
import { buildStateGraph, buildStructureGraph } from '../src/graph/build.js';
import { anyLang, perLang } from '../src/graph/ir.js';
import { EXAMPLES, check, codes, only } from './helpers.js';

const SALES = `context Sales "販売" {
  terms {
    /// 顧客が注文を確定した日時。
    confirmedAt: "確定日時"
    note: "備考"
  }
  id OrderId "注文ID": UUID
  id CustomerId "顧客ID": UUID
  enum Reason "理由" { Requested "顧客都合" Other }
  aggregate Customer "顧客" { id: CustomerId }

  /// 顧客からの購入依頼。
  /// 確定後は変更できない。
  aggregate Order "注文" {
    id: OrderId
    references customer: CustomerId -> Customer
    note: String? "注文メモ"
    state Draft "下書き"
    state Confirmed "確定済み" {
      confirmedAt: Timestamp
      invariant hasNote "備考あり" { exists(note) }
    }
    command confirm(at: Timestamp "確定する日時") "確定する" Draft -> Confirmed
  }
}`;

describe('label resolution', () => {
    test('declarations take inline labels; descriptions come from /// comments', async () => {
        const m = (await check({ 'a.dt': SALES })).model!;
        expect(m.contextLabels).toEqual({ Sales: '販売' });
        expect(m.elements['Sales.Order']).toMatchObject({ label: '注文', doc: '顧客からの購入依頼。\n確定後は変更できない。' });
        expect(m.elements['Sales.Reason'].valueLabels).toEqual({ Requested: '顧客都合' });
        const order = m.elements['Sales.Order'];
        expect(order.states?.map((s) => s.label)).toEqual(['下書き', '確定済み']);
        expect(order.states?.[1].invariants[0]).toMatchObject({ name: 'hasNote', label: '備考あり' });
        expect(order.commands?.[0]).toMatchObject({ label: '確定する' });
    });

    test('fields: inline label, then term, then the type (or the referenced aggregate)', async () => {
        const m = (await check({ 'a.dt': SALES })).model!;
        const order = m.elements['Sales.Order'];
        const field = (name: string) => [...order.fields, ...order.states!.flatMap((s) => s.fields)].find((f) => f.name === name);
        expect(field('note')).toMatchObject({ label: '注文メモ', labelSource: 'inline' });
        expect(field('confirmedAt')).toMatchObject({ label: '確定日時', labelSource: 'term', doc: '顧客が注文を確定した日時。' });
        expect(field('id')).toMatchObject({ label: '注文ID', labelSource: 'type' });
        expect(field('customer')).toMatchObject({ label: '顧客', labelSource: 'type' });
        expect(order.commands?.[0].params[0]).toMatchObject({ label: '確定する日時', labelSource: 'inline' });
        expect(m.terms.Sales).toEqual([
            { name: 'confirmedAt', label: '確定日時', doc: '顧客が注文を確定した日時。' },
            { name: 'note', label: '備考' },
        ]);
    });

    test('terms of a context apply across its files', async () => {
        const m = (
            await check({
                'terms.dt': 'context S { terms { at: "日時" } }',
                'a.dt': 'context S { id AId: UUID aggregate A { id: AId command go(at: Timestamp) } }',
            })
        ).model!;
        expect(m.elements['S.A'].commands?.[0].params[0].label).toBe('日時');
    });
});

describe('label diagnostics', () => {
    test('L001 an inline label disagrees with the term', async () => {
        const a = await check({ 'a.dt': SALES });
        expect(only(a, 'L001').map((d) => d.message)).toEqual([
            "'note' is named '注文メモ' here, but the term 'note' is '備考'.",
        ]);
        expect(a.ok).toBe(true); // label rules are warnings
    });

    test('L001 context fragments disagree on the context label', async () => {
        const a = await check({ 'a.dt': 'context S "販売" { id X: UUID }', 'b.dt': 'context S "営業" { id Y: UUID }' });
        expect(only(a, 'L001')[0].message).toBe("Context 'S' is named '販売' elsewhere, but '営業' here.");
    });

    test('L002 unused term; M002 duplicate term', async () => {
        const a = await check({
            'a.dt': 'context S { terms { unused: "未使用" x: "X" } id AId: UUID value V { x: Int } }',
            'b.dt': 'context S { terms { x: "エックス" } }',
        });
        expect(only(a, 'L002').map((d) => d.message)).toEqual(['Term \'unused\' ("未使用") is not used by any field or parameter in context \'S\'.']);
        expect(only(a, 'M002').map((d) => d.message)).toEqual(["Term 'x' is defined more than once in context 'S'."]);
    });

    test('L003 the same Japanese name for different things in one scope', async () => {
        const a = await check({
            'a.dt': `context S {
  id AId "A番号": UUID
  id PersonId "人物ID": UUID
  aggregate A "注文" {
    id: AId
    buyer: PersonId
    payer: PersonId
    state X "確定"
    state Y "確定"
  }
  event E "注文"
}`,
        });
        expect(only(a, 'L003').map((d) => d.message)).toEqual([
            "'payer' and 'buyer' are both named '人物ID' in 'A'.",
            "'Y' and 'X' are both named '確定' in the states of 'A'.",
            "'E' and 'A' are both named '注文' in context 'S'.",
        ]);
        expect(codes(a)).toEqual([]);
    });
});

describe('labels in views and generated code', () => {
    test('graph texts exist for every language and display mode', async () => {
        const m = (await check({ 'a.dt': SALES })).model!;
        const structure = buildStructureGraph(m);
        const order = structure.nodes.find((n) => n.id === 'Sales.Order')!;
        // names and labels are the same in every language
        expect(order.label).toEqual(anyLang({ name: 'Order', label: '注文', both: '注文 (Order)' }));
        expect(order.lines.find((l) => l.key.en.name.startsWith('→'))).toEqual({
            key: anyLang({ name: '→ customer', label: '→ 顧客', both: '→ 顧客 customer' }),
            value: anyLang({ name: 'CustomerId', label: '顧客ID', both: 'CustomerId' }),
        });
        expect(order.lines.find((l) => l.key.en.name === 'note')!.value).toEqual(anyLang({ name: 'String?', label: '文字列?', both: 'String?' }));
        expect(structure.nodes.find((n) => n.id === 'Sales')!.label.ja.label).toBe('販売');

        const states = buildStateGraph(m.elements['Sales.Order'], m);
        expect(states.edges[0].label).toEqual(anyLang({ name: 'confirm(at)', label: '確定する', both: '確定する confirm(at)' }));
        expect(states.nodes.find((n) => n.id === 'Sales.Order#Confirmed')!.lines.at(-1)).toEqual({
            key: anyLang({ name: '✓ hasNote', label: '✓ 備考あり', both: '✓ 備考あり (hasNote)' }),
        });
    });

    test("the Live View's own words follow the language, whatever the display mode", async () => {
        const m = (await check({ 'a.dt': SALES })).model!;
        const boundary = buildStructureGraph(m).nodes.find((n) => n.id === 'Sales.Order@boundary')!;
        expect(boundary.label).toEqual({
            ja: { name: 'Order 集約', label: '注文 集約', both: '注文 (Order) 集約' },
            en: { name: 'Order aggregate', label: '注文 aggregate', both: '注文 (Order) aggregate' },
        });
        const state = buildStructureGraph(m).nodes.find((n) => n.id === 'Sales.Order')!.lines.find((l) => l.key.en.name === 'state');
        expect(state?.key).toEqual(perLang({ ja: '状態', en: 'state' }));
    });

    test('wide characters reserve more width than ASCII', async () => {
        const m = (await check({ 'a.dt': 'context S { id AId: UUID aggregate A "とても長い日本語の集約名称" { id: AId } }' })).model!;
        const node = buildStructureGraph(m).nodes.find((n) => n.id === 'S.A')!;
        expect(node.width).toBeGreaterThan('とても長い日本語の集約名称 (A)'.length * 8.6 + 28);
    });

    test('generated TypeScript carries labels and descriptions as JSDoc', async () => {
        const a = await analyze(await loadWorkspace(EXAMPLES));
        expect(a.diagnostics).toEqual([]);
        const sales = generateTypeScript(a.model!).find((f) => f.path === 'Sales.ts')!.content;
        expect(sales).toContain('/**\n * 注文\n * 顧客からの購入依頼。確定後は明細を変更できない。\n */\nexport type Order =');
        expect(sales).toContain('    /** 確定日時 — 顧客が注文を確定した日時。キャンセル可否の判定に使う。 */\n    readonly confirmedAt: Timestamp;');
        expect(sales).toContain("    | 'Requested' // 顧客都合");
        expect(sales).toContain(' * @invariant hasItems (明細が1件以上): count(items) > 0');
        expect(sales).toContain(' * 注文を確定する\n * @param at 日時\n * @requires hasItems (明細が1件以上) else EmptyOrder: count(items) > 0\n * @emits OrderConfirmed — exactly once when the command succeeds\n */\nexport type ConfirmOrder');
    });
});
