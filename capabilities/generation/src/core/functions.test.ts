// Functions (Phase 2): pure, typed, expression-bodied, called in expressions; no recursion (M032).
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { check, generateFromAnalysis } from '../test-helpers.js';

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

test('functions check, generate as TypeScript functions, and are called from invariants and other functions', async () => {
    const a = await check({
        'common.dt': `shared context Common {
  function isCode(text: String): Bool { text.matches("^[A-Z]{3}$") }
}`,
        'f.dt': `context F {
  value Line { quantity: Int  price: Decimal(2) }
  value Order {
    lines: Line[0..*]
    code: String
    total: Decimal(2)
    invariant coded { isCode(code) }
    invariant summed { total == subtotal(lines) }
    invariant small { !(isLarge(lines)) || total >= 100.00 }
  }
  /// The sum of the lines.
  function subtotal(lines: Line[0..*]): Decimal(2) { lines.sum(l => l.price * l.quantity) }
  function isLarge(lines: Line[0..*]): Bool { lines.length > 2 && subtotal(lines) > 0.00 }
}`,
    });
    expect(a.diagnostics).toEqual([]);
    const files = generateFromAnalysis(a);
    const ts = files.find((f) => f.path === 'F.ts')!.content;
    expect(ts).toContain('export function subtotal(lines: readonly Line[]): Decimal {');
    expect(ts).toContain('Common.isCode(order.code)');
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-fn-'));
    dirs.push(dir);
    for (const f of files) await writeFile(path.join(dir, f.path), f.content);
    const { F } = await import(path.join(dir, 'index.ts'));
    const line = (quantity: number, price: string) => ({ quantity, price });
    expect(F.subtotal([line(2, '1.50'), line(1, '3.00')])).toBe('6.00');
    expect(F.checkOrder({ lines: [line(2, '1.50')], code: 'ABC', total: '3.00' })).toEqual([]);
    expect(F.checkOrder({ lines: [line(1, '1.00'), line(1, '1.00'), line(1, '1.00')], code: 'abc', total: '3.01' })).toEqual(['coded', 'summed', 'small']);
});

test('M032: an unknown function, wrong arguments, a body of another type, and recursion', async () => {
    const a = await check({
        'f.dt': `context F {
  value V {
    n: Int
    invariant a { nope(n) }
    invariant b { even(n, n) }
    invariant c { even("x") }
  }
  function even(n: Int): Bool { n == 0 || odd(n - 1) }
  function odd(n: Int): Bool { n != 0 && even(n - 1) }
  function name(n: Int): String { n > 0 }
}`,
    });
    expect(
        a.diagnostics
            .filter((d) => d.code === 'M032')
            .map((d) => d.message)
            .sort(),
    ).toEqual(
        [
            "No function 'nope' in context 'F' or a shared context.",
            "Function 'even' takes 1 argument(s), but 2 are given.",
            "Argument 'n' of 'even' is a 'Int', but '\"x\"' is a 'String'.",
            "Function 'name' returns 'String', but its body has type 'Bool'.",
            "Function 'even' calls itself: even -> odd -> even; functions cannot recurse.",
        ].sort(),
    );
});
