import { describe, expect, test } from 'bun:test';
import { generateTypeScript } from '../src/generator/typescript.js';
import { check, codes, only } from './helpers.js';

const COMMON = `shared context Common "共通" {
  terms { currency: "通貨" }
  enum Currency { JPY USD }
  value Money { amount: Decimal currency: Currency }
  primitive Email: String { matches(value, "@") }
}`;

describe('shared contexts', () => {
    test('elements of a shared context are usable by simple name from every context', async () => {
        const a = await check({
            'common.dt': COMMON,
            'sales.dt': `context Sales {
  id CustomerId: UUID
  aggregate Customer {
    id: CustomerId
    email: Email
    balance: Common.Money
    preferred: Currency
    invariant yen { preferred == Currency.JPY or preferred == Common.Currency.USD }
  }
}`,
        });
        expect(a.diagnostics).toEqual([]);
        const m = a.model!;
        expect(m.sharedContexts).toEqual(['Common']);
        expect(m.elements['Sales.Customer'].fields.map((f) => f.type)).toMatchObject([
            { ref: 'Sales.CustomerId' },
            { ref: 'Common.Email', target: 'primitive' },
            { ref: 'Common.Money', target: 'valueObject' },
            { ref: 'Common.Currency', target: 'enum' },
        ]);
        // terms of shared contexts apply when the context itself has none
        expect(m.elements['Common.Money'].fields[1].label).toBe('通貨');
        const sales = generateTypeScript(m).find((f) => f.path === 'Sales.ts')!.content;
        expect(sales).toContain("import type * as Common from './Common.js';");
        expect(sales).toContain('readonly email: Common.Email;');
    });

    test('the context own elements win over shared ones, with a warning', async () => {
        const a = await check({
            'common.dt': COMMON,
            'sales.dt': 'context Sales { primitive Email: String id XId: UUID aggregate X { id: XId e: Email } }',
        });
        expect(a.model!.elements['Sales.X'].fields[1].type).toMatchObject({ ref: 'Sales.Email' });
        expect(only(a, 'M014').map((d) => [d.severity, d.message])).toEqual([
            ['warning', "'Sales.Email' hides 'Common.Email' of a shared context inside 'Sales'. Rename it, or use the shared one."],
        ]);
    });

    test('M014 a shared context holds only value types', async () => {
        const a = await check({
            'common.dt': `shared context Common {
  id CId: UUID
  aggregate C { id: CId }
  event E
  error Er
  primitive P: Int
}`,
        });
        expect(only(a, 'M014').map((d) => d.message)).toEqual([
            "Shared context 'Common' can only contain domain primitives, enums, value objects, unions, field sets and terms; found ID 'CId'.",
            "Shared context 'Common' can only contain domain primitives, enums, value objects, unions, field sets and terms; found aggregate 'C'.",
            "Shared context 'Common' can only contain domain primitives, enums, value objects, unions, field sets and terms; found event 'E'.",
            "Shared context 'Common' can only contain domain primitives, enums, value objects, unions, field sets and terms; found error 'Er'.",
        ]);
    });

    test('M014 a shared context depends only on shared contexts', async () => {
        const a = await check({
            'common.dt': 'shared context Common { value Line { sku: Sales.Sku } }',
            'sales.dt': 'context Sales { primitive Sku: String }',
        });
        expect(only(a, 'M014').map((d) => d.message)).toEqual(["Shared context 'Common' cannot depend on 'Sales.Sku' of a non-shared context."]);
    });

    test('M014 all parts of a context agree on shared; names are unique across shared contexts', async () => {
        const a = await check({
            'a.dt': 'shared context Common { primitive A: Int }',
            'b.dt': 'context Common { primitive B: Int }',
            'c.dt': 'shared context Other { primitive A: String }',
        });
        expect(only(a, 'M014').map((d) => d.message)).toEqual([
            "Context 'Common' is declared 'shared' in another file; declare every part of it as 'shared context'.",
            "'A' is defined in shared contexts 'Common' and 'Other'; references by simple name would be ambiguous.",
        ]);
        expect(codes(a)).toEqual(['M014', 'M014']);
    });
});
