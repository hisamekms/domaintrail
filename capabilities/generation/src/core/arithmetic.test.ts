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

test('generated checks evaluate round with half-even decimal semantics', async () => {
    const a = await check({
        'a.dt': `context A {
  value V {
    h: Decimal(2)
    r: Decimal(2)
    amount: Decimal(2)
    invariant rounded { amount == (h * r).round(2) }
    invariant tieEvenDown { 0.125.round(2) == 0.12 }
    invariant tieEvenUp { 0.135.round(2) == 0.14 }
    invariant negativeTie { (-0.125).round(2) == -0.12 }
    invariant whole { 2.50.round(0) == 2 }
  }
}`,
    });
    expect(a.diagnostics).toEqual([]);
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-round-'));
    dirs.push(dir);
    for (const f of generateFromAnalysis(a)) await writeFile(path.join(dir, f.path), f.content);
    const { A } = await import(path.join(dir, 'index.ts'));
    expect(A.checkV({ h: '2.00', r: '10.50', amount: '21.00' })).toEqual([]);
    expect(A.checkV({ h: '2.00', r: '10.50', amount: '20.00' })).toEqual(['rounded']);
    expect(A.checkV({ h: '1.25', r: '1.01', amount: '1.26' })).toEqual([]); // 1.2625
    expect(A.checkV({ h: '-1.25', r: '1.01', amount: '-1.26' })).toEqual([]);
    expect(generateFromAnalysis(a).find((f) => f.path.endsWith('A.ts'))!.content).toContain("decimalDiv(String(decimalMul(String(v.h), String(v.r))), '1', 2)");
    // the text `round` gives: `n` digits after the point, none for 0, half-even on either side of zero
    const { decimalDiv } = await import(path.join(dir, '_runtime.ts'));
    const round = (x: string, n: number) => decimalDiv(x, '1', n);
    expect([round('2.5', 0), round('3.5', 0), round('-2.5', 0), round('-3.5', 0), round('2.51', 0)]).toEqual(['2', '4', '-2', '-4', '3']);
    expect([round('0.125', 2), round('-0.135', 2), round('1.2', 3), round('-0.004', 2)]).toEqual(['0.12', '-0.14', '1.200', '0.00']);
});
