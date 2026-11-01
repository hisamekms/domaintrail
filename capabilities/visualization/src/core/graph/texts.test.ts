// The texts of the graphs in every language and display mode (the Live View's own words among them).
import { describe, expect, test } from 'bun:test';
import { analyze } from '@domaintrail/analysis';
import { elementOf } from '@domaintrail/modeling';
import { buildStateGraph, buildStructureGraph } from './build.js';
import { buildContextMapGraph } from './context-map.js';
import { anyLang, perLang, type Graph } from './ir.js';
import { check, exampleSources } from '../../test-helpers.js';

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

/** Latin words of a Japanese text that are not allowed in it. */
const englishIn = (text: string): string[] => (text.replace(/<[^>]*>/g, '').match(/[A-Za-z]+/g) ?? []).filter((w) => !LATIN_IN_JA.has(w));

/**
 * Latin words allowed in Japanese texts (as in apps/web/i18n.test.ts): abbreviations, the DSL's keywords and file names, which are written as
 * they are in Japanese too (the workspace's `.domaintrail` directory among them), git's (`git`, and the refs `main` and `HEAD` given as examples), and the names of keys on
 * the keyboard. `X` is the sample argument.
 */
const LATIN_IN_JA = new Set([
    'AI',
    'BC',
    'DSL',
    'ID',
    'OS',
    'dt',
    'dtes',
    'storming',
    'persistent',
    'value',
    'terms',
    'X',
    'git',
    'main',
    'HEAD',
    'Ctrl',
    'Enter',
    'Tab',
    'Esc',
    'Shift',
    'U',
    'domaintrail',
]);

describe('labels in views', () => {
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

        const states = buildStateGraph(elementOf(m, 'Sales.Order')!, m);
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
        const state = buildStructureGraph(m)
            .nodes.find((n) => n.id === 'Sales.Order')!
            .lines.find((l) => l.key.en.name === 'state');
        expect(state?.key).toEqual(perLang({ ja: '状態', en: 'state' }));
    });

    test('wide characters reserve more width than ASCII', async () => {
        const m = (await check({ 'a.dt': 'context S { id AId: UUID aggregate A "とても長い日本語の集約名称" { id: AId } }' })).model!;
        const node = buildStructureGraph(m).nodes.find((n) => n.id === 'S.A')!;
        expect(node.width).toBeGreaterThan('とても長い日本語の集約名称 (A)'.length * 8.6 + 28);
    });
});

describe('i18n of the diagrams', () => {
    test('Japanese diagrams leave no English words untranslated', async () => {
        const model = (await analyze(await exampleSources())).model!;
        const contexts = model.contexts.filter((c) => !c.shared).map((c) => c.name);
        const graphs: Graph[] = [
            buildContextMapGraph(model, { all: true }),
            buildStructureGraph(model),
            buildStructureGraph(model, { level: 'aggregates' }),
            // stubs of the other contexts
            ...contexts.flatMap((c) => [buildStructureGraph(model, { focus: [c] }), buildStructureGraph(model, { focus: [c], level: 'aggregates' })]),
            ...model.elements.filter((e) => e.kind === 'aggregate').map((agg) => buildStateGraph(agg, model)),
        ];
        // the Live View's own words in diagrams: the captions, and the counts on the context map
        const words = graphs.flatMap((g) =>
            g.nodes.flatMap((n) => [
                ...(n.stereotype ? [n.stereotype.ja.name] : []),
                ...(n.kind === 'boundedContext' ? n.lines.map((l) => l.key.ja.name) : []),
            ]),
        );
        expect(words.length).toBeGreaterThan(0);
        expect([...new Set(words.flatMap(englishIn))]).toEqual([]);
    });
});
