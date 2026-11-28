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

    test('round: a computed Decimal(n), half-even; on a Decimal (a domain primitive over one included) with an Int literal n >= 0', async () => {
        expect(
            await errors(`    invariant a { (exact * exact).round(2) == exact }
    invariant b { price.round(0) > 0 && plain.round(3) >= exact }
    invariant c { 2.50.round(0) == 2 && exact.round(4) == exact }`),
        ).toEqual([]);
        expect(
            await errors(`    invariant a { n.round(2) == n }
    invariant b { note.round(2) == note }
    invariant c { exact.round(n) > 0 }
    invariant d { exact.round(-1) > 0 }
    invariant e { exact.round(1.5) > 0 }
    invariant f { maybe.round(0) > 0 }
    invariant g { exact.round(31) > 0 && exact.round(30) > 0 }`),
        ).toEqual([
            "M009 '.round(n)' rounds a Decimal, but 'n' is a 'Int'. An Int needs no rounding.",
            "M009 '.round(n)' rounds a Decimal, but 'note' is a 'String'.",
            "M009 '.round(n)' takes the digits after the point as an Int literal of 0 or more, but got 'n'.",
            "M009 '.round(n)' takes the digits after the point as an Int literal of 0 or more, but got '-1'.",
            "M009 '.round(n)' takes the digits after the point as an Int literal of 0 or more, but got '1.5'.",
            "M009 '.round(n)' rounds a Decimal, but 'maybe' is a 'Int?'.",
            "M009 '.round(n)' rounds to at most 30 digits after the point, but got '31'.",
        ]);
    });

    /** Scale fit: a value of a known scale placed in a declared `Decimal(n)` has at most `n` digits after the point. */
    const placed = async (commands: string, functions: string) => {
        const a = await analyzeDomain([
            {
                path: 'a.dt',
                text: `context A {
  id ItemId: UUID
  primitive Money: Decimal(2)
  value V {
    id: ItemId
    hours: Decimal(2)
    rate: Decimal(2)
    exact: Decimal(2)
    small: Decimal(1)
    broad: Decimal(3)
    plain: Decimal
    amounts: Decimal(2)[0..*]
    price: Money
  }
  function accept(x: Decimal(2)): Decimal(2) { x }
  function money(x: Money): Money { x }
  aggregate Ledger {
    id: ItemId
    total: Decimal(2)
    entries: Decimal(2)[0..*]
    price: Money
    create command open(id: ItemId) changes id = id, total = 0.00, entries = [], price = 0.00
${commands}
  }
${functions}
}`,
            },
        ]);
        return a.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}${d.hint ? ` (${d.hint})` : ''}`);
    };

    test('scale fit: a smaller scale widens, rounding fits, and an unknown scale or a comparison is not checked', async () => {
        expect(
            await placed(
                `    command widen(s: Decimal(1)) changes total = s, entries = [s, 1.2], price = 1.5
    command round(h: Decimal(2), r: Decimal(2)) changes total = (h * r).round(2), entries = [(h * r).round(1)], price = (h * r).round(2)
    command keep(p: Decimal) changes total = before.total + p
    command same(e: Decimal(2)) changes total = before.total + e * 2, entries = [...before.entries, e]`,
                `  function f(h: Decimal(2), r: Decimal(2)): Decimal(2) { (h * r).round(2) }
  function g(s: Decimal(1)): Decimal(2) { s }
  function lit(): Decimal(2) { 1.5 }
  function list(s: Decimal(1)): Decimal(2)[0..*] { [s, 1.25] }
  function pick(b: Bool, s: Decimal(1)): Decimal(2) { b ? s : 1.25 }
  function call(s: Decimal(1), b: Decimal(3)): Bool { accept(s) == accept(b.round(2)) && money(1.5) == money(b.round(2)) }
  function cmp(h: Decimal(2), r: Decimal(2), x: Decimal(2)): Bool { h * r == x && h * r < x }
  function m(h: Decimal(2)): Money { h.round(1) }
`,
            ),
        ).toEqual([]);
    });

    test('scale fit: a larger known scale is M009 with a hint to round it, wherever it is placed', async () => {
        expect(
            await placed(
                `    command charge(h: Decimal(2), r: Decimal(2)) changes total = h * r
    command list(b: Decimal(3)) changes entries = [b]
    command spread(b: Decimal(3)) changes entries = [...before.entries, b]
    command priced(h: Decimal(2), r: Decimal(2)) changes price = h * r / 1.00`,
                `  function pay(hours: Decimal(2), rate: Decimal(2)): Decimal(2) { hours * rate }
  function arg(b: Decimal(3)): Decimal(2) { accept(b) }
  function lit(): Decimal(2) { 1.234 }
  function pick(c: Bool, b: Decimal(3), s: Decimal(1)): Decimal(2) { c ? s : b }
  function either(b: Decimal(3)?, s: Decimal(1)): Decimal(2) { b ?? s }
  function els(s: Decimal(1)): Decimal(2)[0..*] { [s, 1.234] }
  function m(h: Decimal(2), r: Decimal(2)): Money { h * r }
  function marg(b: Decimal(3)): Money { money(b.round(3)) }
`,
            ),
        ).toEqual([
            "M009 'total' is a 'Decimal(2)', but 'h * r' is a 'Decimal(4)'. (round it: '(h * r).round(2)')",
            "M009 'entries' is a 'Decimal(2)[0..*]', but '[b]' is a 'Decimal(3)[0..*]'. (round each element: '[b].map(x => x.round(2))')",
            "M009 'entries' is a 'Decimal(2)[0..*]', but '[...before.entries, b]' is a 'Decimal(3)[0..*]'. (round each element: '[...before.entries, b].map(x => x.round(2))')",
            "M009 'price' is a 'Money', but 'h * r / 1.00' is a 'Decimal(4)'. (round it: '(h * r / 1.00).round(2)')",
            "M009 Function 'pay' returns 'Decimal(2)', but its body has type 'Decimal(4)'. (round it: '(hours * rate).round(2)')",
            "M009 Argument 'x' of 'accept' is a 'Decimal(2)', but 'b' is a 'Decimal(3)'. (round it: 'b.round(2)')",
            "M009 Function 'lit' returns 'Decimal(2)', but its body has type 'Decimal(3)'. (round it: '1.234.round(2)')",
            "M009 Function 'pick' returns 'Decimal(2)', but its body has type 'Decimal(3)'. (round it: '(c ? s : b).round(2)')",
            "M009 Function 'either' returns 'Decimal(2)', but its body has type 'Decimal(3)'. (round it: '(b ?? s).round(2)')",
            "M009 Function 'els' returns 'Decimal(2)[0..*]', but its body has type 'Decimal(3)[0..*]'. (round each element: '[s, 1.234].map(x => x.round(2))')",
            "M009 Function 'm' returns 'Money', but its body has type 'Decimal(4)'. (round it: '(h * r).round(2)')",
            "M009 Argument 'x' of 'money' is a 'Money', but 'b.round(3)' is a 'Decimal(3)'. (round it: 'b.round(3).round(2)')",
        ]);
    });

    /** `? :`, `??`, list literals and `match` take the larger scale of their values; scale fit checks it where it is placed. */
    const joined = async (functions: string) => {
        const a = await analyzeDomain([
            {
                path: 'a.dt',
                text: `context A {
  primitive Money: Decimal(2)
  union U {
    A { x: Decimal(4) }
    B { y: Decimal(2)? }
  }
  union W {
    I { i: Int }
    D { d: Decimal(3) }
  }
${functions}
}`,
            },
        ]);
        return a.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
    };

    test('joined scales: cases and branches agree by type with their scales aside, and the join fits where both fit', async () => {
        expect(
            await joined(`  function f(u: U): Decimal(4)? { match (u) { A { x } => x, B { y } => y } }
  function g(u: U): Decimal(4)? { match (u) { B { y } => y, A { x } => x } }
  function h(c: Bool, m: Money, s: Decimal(1)): Money { c ? m : s.round(1) }
  function k(c: Bool, m: Money?): Money { c ? m ?? 1.5 : 0 }
  function l(m: Money): Money[0..*] { [m, 1.5, 0] }
  function n(c: Bool, x: Decimal(4)?, s: Decimal(1)): Decimal(4) { c ? x ?? s : 0 }
  function w(v: W): Decimal(3) { match (v) { I { i } => i, D { d } => d } }`),
        ).toEqual([]);
    });

    test('joined scales: a domain primitive or an Int joined with a larger scale does not fit the smaller one', async () => {
        expect(
            await joined(`  function f(u: U): Decimal(2)? { match (u) { B { y } => y, A { x } => x } }
  function g(c: Bool, m: Money): Money { c ? m : 1.234 }
  function h(m: Money?): Money { m ?? 1.234 }
  function k(m: Money): Money[0..*] { [m, 1.234] }
  function l(c: Bool): Decimal(2) { c ? 0 : 1.234 }
  function n(): Decimal(2)[0..*] { [0, 1.234] }
  function w(v: W): Decimal(2) { match (v) { I { i } => i, D { d } => d } }`),
        ).toEqual([
            "M009 Function 'f' returns 'Decimal(2)?', but its body has type 'Decimal(4)?'.",
            "M009 Function 'g' returns 'Money', but its body has type 'Decimal(3)'.",
            "M009 Function 'h' returns 'Money', but its body has type 'Decimal(3)'.",
            "M009 Function 'k' returns 'Money[0..*]', but its body has type 'Decimal(3)[0..*]'.",
            "M009 Function 'l' returns 'Decimal(2)', but its body has type 'Decimal(3)'.",
            "M009 Function 'n' returns 'Decimal(2)[0..*]', but its body has type 'Decimal(3)[0..*]'.",
            "M009 Function 'w' returns 'Decimal(2)', but its body has type 'Decimal(3)'.",
        ]);
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
