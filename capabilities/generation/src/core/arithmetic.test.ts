// Arithmetic in generated checks: Int is JavaScript's, a Decimal is computed exactly by the runtime, and `/` rounds
// half-even to the declared scale.
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { check, generateFromAnalysis } from '../test-helpers.js';

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

test('Int and Decimal arithmetic, Decimal(n) division, and the generated checks evaluate them', async () => {
    const a = await check({
        'a.dt': `context A {
  primitive Money: Decimal(2)
  value Line {
    quantity: Int
    unitPrice: Money
    total: Decimal(2)
    days: Int
    invariant totalIsProduct { total == quantity * unitPrice }
    invariant spare { quantity + 1 > days - 2 }
    invariant average { days != 0 && total / days <= 100.00 }
  }
}`,
    });
    expect(a.diagnostics).toEqual([]);
    const files = generateFromAnalysis(a);
    const ts = files.find((f) => f.path === 'A.ts')!.content;
    expect(ts).toContain('decimalMul(String(line.quantity), String(line.unitPrice))');
    expect(ts).toContain('decimalDiv(String(line.total), String(line.days), 2)');
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-arith-'));
    dirs.push(dir);
    for (const f of files) await writeFile(path.join(dir, f.path), f.content);
    const { A } = await import(path.join(dir, 'index.ts'));
    expect(A.checkLine({ quantity: 3, unitPrice: '1.50', total: '4.50', days: 3 })).toEqual([]);
    expect(A.checkLine({ quantity: 3, unitPrice: '1.50', total: '4.51', days: 3 })).toEqual(['totalIsProduct']);
    expect(A.checkLine({ quantity: 1, unitPrice: '500.00', total: '500.00', days: 4 })).toEqual(['spare', 'average']);
});
