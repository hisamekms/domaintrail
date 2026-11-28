// What shared contexts make of the generated TypeScript (the DSL and its checks: contexts/modeling/src/domain/rules/shared.test.ts).
import { describe, expect, test } from 'bun:test';
import { generateFromAnalysis, check } from '../test-helpers.js';

const COMMON = `shared context Common "共通" {
  terms { currency: "通貨" }
  enum Currency { JPY USD }
  value Money { amount: Decimal currency: Currency }
  primitive Email: String { value.matches("@") }
}`;

describe('shared contexts: generated TypeScript', () => {
    test('a context imports a shared context as a namespace and names its elements through it', async () => {
        const a = await check({
            'common.dt': COMMON,
            'sales.dt': `context Sales {
  id CustomerId: UUID
  aggregate Customer {
    id: CustomerId
    email: Email
    balance: Common.Money
    preferred: Currency
    invariant yen { preferred == Currency.JPY || preferred == Common.Currency.USD }
  }
}`,
        });
        expect(a.diagnostics).toEqual([]);
        const sales = generateFromAnalysis(a).find((f) => f.path === 'Sales.ts')!.content;
        expect(sales).toContain("import type * as Common from './Common.js';");
        expect(sales).toContain('readonly email: Common.Email;');
    });
});
