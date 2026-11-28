// Lists in expressions (Phase 2): literals with spread, `.map`, `.filter` and `.sum`, checked and generated.
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { check, generateFromAnalysis } from '../test-helpers.js';

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const MODEL = `context L {
  enum Status { Open Held Closed }
  value Line { sku: String  quantity: Int  price: Decimal(2)  gift: Bool }
  value Order {
    lines: Line[0..*]
    status: Status
    total: Decimal(2)
    count: Int
    invariant totalIsSum { total == lines.sum(l => l.price * l.quantity) }
    invariant countIsSum { count == lines.map(l => l.quantity).sum() }
    invariant someGift { lines.filter(l => l.gift).length <= 1 }
    invariant known { [Status.Open, Status.Held].includes(status) || lines.length == 0 }
    invariant distinct { [...lines.map(l => l.sku)].unique() }
  }
}`;

test('lists check, generate and evaluate', async () => {
    const a = await check({ 'l.dt': MODEL });
    expect(a.diagnostics).toEqual([]);
    const files = generateFromAnalysis(a);
    const ts = files.find((f) => f.path === 'L.ts')!.content;
    expect(ts).toContain('.reduce(');
    expect(ts).toContain('decimalAdd(');
    expect(ts).toContain('.filter((l) => l.gift).length <= 1');
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-lists-'));
    dirs.push(dir);
    for (const f of files) await writeFile(path.join(dir, f.path), f.content);
    const { L } = await import(path.join(dir, 'index.ts'));
    const line = (sku: string, quantity: number, price: string, gift = false) => ({ sku, quantity, price, gift });
    const ok = { lines: [line('A', 2, '1.50'), line('B', 1, '3.00', true)], status: 'Open', total: '6.00', count: 3 };
    expect(L.checkOrder(ok)).toEqual([]);
    expect(L.checkOrder({ ...ok, total: '6.01', count: 4, status: 'Closed', lines: [...ok.lines, line('A', 0, '0.00', true)] })).toEqual([
        'totalIsSum',
        'countIsSum',
        'someGift',
        'known',
        'distinct',
    ]);
});

test('list errors: mixed types, spreading a non-list, a non-Bool filter, a sum of strings', async () => {
    const a = await check({
        'l.dt': `context L {
  value Line { sku: String  quantity: Int }
  value V {
    lines: Line[0..*]
    n: Int
    invariant a { [1, "x"].length > 0 }
    invariant b { [...n].length > 0 }
    invariant c { lines.filter(l => l.quantity).length > 0 }
    invariant d { lines.sum(l => l.sku) > 0 }
  }
}`,
    });
    expect(a.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)).toEqual([
        "A list holds values of one type, but '\"x\"' is a 'String', not a 'Int'.",
        "'...' spreads a list, but 'n' is a 'Int'.",
        "The predicate of '.filter(…)' must be Bool, but has type 'Int'.",
        "'.sum(…)' adds Int or Decimal values, but got 'String'.",
    ]);
});
