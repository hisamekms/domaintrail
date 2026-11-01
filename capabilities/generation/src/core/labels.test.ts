// Labels and descriptions in the generated TypeScript (the DSL's labels and their checks: contexts/modeling/src/infrastructure/syntax/labels.test.ts).
import { describe, expect, test } from 'bun:test';
import { generateTypeScript } from './typescript.js';
import { analyzeForGeneration, exampleSources } from '../test-helpers.js';

describe('labels in generated code', () => {
    test('generated TypeScript carries labels and descriptions as JSDoc', async () => {
        const a = await analyzeForGeneration(await exampleSources());
        expect(a.diagnostics).toEqual([]);
        const sales = generateTypeScript(a.model!).find((f) => f.path === 'Sales.ts')!.content;
        expect(sales).toContain('/**\n * 注文\n * 顧客からの購入依頼。確定後は明細を変更できない。\n * @see sales/order.dt:13\n */\nexport type Order =');
        expect(sales).toContain('    /** 確定日時 — 顧客が注文を確定した日時。キャンセル可否の判定に使う。 */\n    readonly confirmedAt: Timestamp;');
        expect(sales).toContain("    | 'Requested' // 顧客都合");
        expect(sales).toContain(' * @invariant hasItems (明細が1件以上): count(items) > 0');
        expect(sales).toContain(
            ' * 注文を確定する\n * @requires hasItems (明細が1件以上) else EmptyOrder: count(items) > 0\n * @changes none — the command changes no common field\n * @emits OrderConfirmed — exactly once when the command succeeds\n * @see sales/order.dt:51\n */\nexport type ConfirmOrder',
        );
        // the label of a parameter is on its property in the parameters object
        expect(sales).toContain('export interface ConfirmOrderParams {\n    /** 日時 */\n    readonly at: Timestamp;\n}');
    });
});
