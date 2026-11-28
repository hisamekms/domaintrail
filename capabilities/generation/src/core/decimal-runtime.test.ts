import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { generateFromAnalysis, check } from '../test-helpers.js';

const dirs: string[] = [];
afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test('generated runtime performs exact decimal arithmetic', async () => {
    const analysis = await check({
        'decimal.dt': `context DecimalTest {
  id ItemId: UUID
  aggregate Item {
    id: ItemId
    amount: Decimal
  }
}`,
    });
    expect(analysis.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-decimal-'));
    dirs.push(dir);
    for (const file of generateFromAnalysis(analysis)) await writeFile(path.join(dir, file.path), file.content);
    const rt = await import(path.join(dir, '_runtime.ts'));

    expect(rt.decimalAdd('1.50', '2')).toBe('3.50');
    expect(rt.decimalSub('1', '1.00')).toBe('0.00');
    expect(rt.decimalMul('1.5', '0.20')).toBe('0.300');
    expect(rt.decimalDiv('10', '3', 2)).toBe('3.33');
    expect(rt.decimalDiv('2.5', '1', 0)).toBe('2');
    expect(rt.decimalDiv('3.5', '1', 0)).toBe('4');
    expect(rt.decimalDiv('-2.5', '1', 0)).toBe('-2');
    expect(rt.decimalAdd('-1.20', '0.2')).toBe('-1.00');
    expect(rt.decimalSub('-2.00', '-3')).toBe('1.00');
    expect(rt.decimalMul('-1.25', '2')).toBe('-2.50');
    expect(rt.decimalDiv('1', '8', 2)).toBe('0.12');
    expect(rt.decimalDiv('3', '8', 2)).toBe('0.38');
    expect(rt.decimalDiv('-3', '8', 2)).toBe('-0.38');
    expect(rt.decimalDiv('5', '2', 0)).toBe('2');
    expect(rt.decimalDiv('7', '2', 0)).toBe('4');
    expect(rt.decimalAdd('123456789012345678901234567890', '10')).toBe('123456789012345678901234567900');
    expect(rt.decimalMul('999999999999999999999999999999', '9')).toBe('8999999999999999999999999999991');
    expect(() => rt.decimalDiv('1', '0.00', 2)).toThrow(new RangeError('division by zero'));
});
