// Arithmetic (Phase 2): Int `+ - *`, Decimal `+ - * /`, `/` to a declared scale with a divisor shown non-zero.
import { describe, expect, test } from 'bun:test';
import { analyzeDomain } from '../../application/analyze.js';

const model = (members: string) => `context A {
  id ItemId: UUID
  primitive Quantity: Int { value > 0 }
  primitive Money: Decimal(2)
  value V {
    id: ItemId
    n: Int
    days: Int
    q: Quantity
    price: Money
    exact: Decimal(2)
    plain: Decimal
    note: String
    maybe: Int?
${members}
  }
}`;

async function errors(members: string): Promise<string[]> {
    const a = await analyzeDomain([{ path: 'a.dt', text: model(members) }]);
    return a.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
}

describe('arithmetic', () => {
    test('valid uses', async () => {
        expect(
            await errors(`    invariant a { n + days * 2 - 1 > 0 }
    invariant b { q * 2 <= 100 && q + n > 1 }
    invariant c { price * q == exact }
    invariant d { days != 0 && exact / days <= 10.00 }
    invariant e { days > 0 ? exact / days > 0.50 : true }
    invariant f { exact / 3 >= price + 0.5 }
    invariant g { plain + exact > plain * 2 }`),
        ).toEqual([]);
    });

    test('errors: Int division, undeclared scale, zero divisors, non-numbers and IDs', async () => {
        expect(
            (
                await errors(`    invariant a { n / 2 > 0 }
    invariant b { plain / 2 > 1 }
    invariant c { exact / 0 > 1 }
    invariant d { exact / days > 1 }
    invariant e { note + 1 > 0 }
    invariant f { maybe + 1 > 0 }
    invariant g { id + 1 > 0 }`)
            ).sort(),
        ).toEqual(
            [
                "M009 Int has no '/': divide Decimal values, e.g. declare the field 'Decimal(2)'.",
                "M009 '/' rounds to a declared scale, but 'plain' is a Decimal of no declared scale: declare it 'Decimal(n)'.",
                'M009 Division by zero.',
                "M009 'days' may be zero: show that it is not where it is divided by (e.g. 'days != 0 && …').",
                "M009 Operator '+' requires Int or Decimal operands, but got 'String'.",
                "M009 Operator '+' requires Int or Decimal operands, but got 'Int?'. Optional values must be compared with null first (x != null && …).",
                "M009 Operator '+' requires Int or Decimal operands, but got 'ItemId'.",
            ].sort(),
        );
    });
});
