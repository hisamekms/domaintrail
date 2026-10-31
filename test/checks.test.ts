import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { generateTypeScript } from '../src/modeling/generator/typescript.js';
import { check } from './helpers.js';

const ROOT = path.join(import.meta.dir, '..');
const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** Generates the TypeScript of a workspace into a temporary directory and imports its index. */
async function generated(files: Record<string, string>): Promise<Record<string, any>> {
    const a = await check(files);
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-checks-'));
    dirs.push(dir);
    const out = generateTypeScript(a.model!);
    for (const f of out) await writeFile(path.join(dir, f.path), f.content);
    return import(path.join(dir, 'index.ts'));
}

/** Type-checks generated files strictly (also against unused parameters). */
function tsc(dir: string, files: string[]): string {
    const flags = [
        '--ignoreConfig',
        '--noEmit',
        '--strict',
        '--noUnusedLocals',
        '--noUnusedParameters',
        '--exactOptionalPropertyTypes',
        '--target',
        'ES2023',
        '--module',
        'preserve',
        '--moduleResolution',
        'bundler',
        '--verbatimModuleSyntax',
    ];
    const r = Bun.spawnSync([process.execPath, path.join(ROOT, 'node_modules', '.bin', 'tsc'), ...flags, ...files], { cwd: dir });
    return r.stdout.toString() + r.stderr.toString();
}

const MODEL = {
    'common.dt': `
shared context Common {
  enum Currency { JPY USD }
  primitive Amount: Decimal { invariant nonNegative { value >= 0 } }
  value Money { amount: Amount  currency: Currency }
  value Caption { text: String  max: Amount  invariant fits { length(text) <= max } }
}`,
    'sales.dt': `
context Sales {
  id LineId: UUID
  id OrderId: UUID
  primitive Quantity: Int { value in 1..999 }
  primitive Sku: String {
    invariant format { matches(value, "^[A-Z]{3}-\\d{4}$") }
    invariant reserved "予約語でない"
    invariant short { length(value) <= 8 }
  }
  primitive Code: String { matches(value, "^a/b$") }
  enum Reason { Requested Other }
  value Period {
    from: Timestamp
    until: Timestamp?
    invariant ordered { exists(until) implies from <= until }
  }
  value Tags { names: String[0..*]  invariant distinctNames { unique(names) } }
  value Approval {
    needed: Quantity
    confirmedBy: String[0..*]
    invariant enough { count(confirmedBy) >= needed }
    invariant exact { needed == count(confirmedBy) or (count(confirmedBy) in 0..needed) }
  }
  entity Line {
    id: LineId
    sku: Sku
    quantity: Quantity
    price: Money
  }
  union Payment {
    Card { last4: String  invariant digits { matches(last4, "^\\d{4}$") } }
    Cash
  }
  aggregate Order {
    id: OrderId
    owns lines: Line[0..*]
    payment: Payment?
    prices: Money[0..*]
    invariant distinctSkus { unique(lines, l => l.sku) }
    invariant distinctLines { unique(lines) }
    state Draft
    state Cancelled {
      reason: Reason
      note: String?
      invariant otherNeedsNote { reason == Reason.Other implies exists(note) }
      invariant audited "監査済み"
    }
    create command place(id: OrderId) -> Draft
    command add(line: Line, total: Decimal)
      Draft -> Draft
      requires newSku { all(lines, x => x.sku != line.sku) } else Duplicate
      requires known "既知の商品" else Unknown
      requires small { total < 100.5 } else TooLarge
      requires priced { contains(prices, line.price) } else Unpriced
      changes lines
    command cancel(reason: Reason) Draft -> Cancelled
  }
  error Duplicate
  error Unknown
  error TooLarge
  error Unpriced
}`,
};

const g = await generated(MODEL);
const { Sales, Common } = g;
const yen = (amount: string) => ({ amount, currency: 'JPY' });
const line = (id: string, sku: string, amount = '100') => ({ id, sku, quantity: 1, price: yen(amount) });

describe('generated checks', () => {
    test('type-check strictly, with unused parameters reported', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-checks-tsc-'));
        dirs.push(dir);
        const a = await check(MODEL);
        const files = generateTypeScript(a.model!);
        for (const f of files) await writeFile(path.join(dir, f.path), f.content);
        expect(
            tsc(
                dir,
                files.map((f) => f.path),
            ),
        ).toBe('');
    });

    test('ranges and Decimal values (carried as strings) compare as numbers', () => {
        expect(Sales.checkQuantity(1)).toEqual([]);
        expect(Sales.checkQuantity(999)).toEqual([]);
        expect(Sales.checkQuantity(0)).toEqual(['valid']);
        expect(Sales.checkQuantity(1000)).toEqual(['valid']);
        expect(Common.checkAmount('0')).toEqual([]);
        expect(Common.checkAmount('10.5')).toEqual([]);
        expect(Common.checkAmount('-0.01')).toEqual(['nonNegative']);
    });

    test('parseDecimal accepts digits with an optional - and fraction, and keeps the text', () => {
        for (const text of ['0', '1200', '-3', '12.50', '0.001']) expect(g.parseDecimal(text)).toBe(text);
        for (const text of ['', '+1', '.5', '5.', '1e3', '1,000', ' 1', '1 ', '--1', 'abc', '1.2.3']) expect(g.parseDecimal(text)).toBeUndefined();
    });

    test('domain primitives compare with the numbers count() and length() compute (Decimals as numbers)', () => {
        expect(Sales.checkApproval({ needed: 2, confirmedBy: ['a', 'b'] })).toEqual([]);
        expect(Sales.checkApproval({ needed: 2, confirmedBy: ['a'] })).toEqual(['enough']);
        expect(Sales.checkApproval({ needed: 2, confirmedBy: ['a', 'b', 'c'] })).toEqual(['exact']);
        expect(Common.checkCaption({ text: 'abc', max: '3.0' })).toEqual([]);
        expect(Common.checkCaption({ text: 'abcd', max: '3.5' })).toEqual(['fits']);
    });

    test('make<Name> reports the first violated invariant, and creation without invariants cannot fail', () => {
        expect(Sales.makeQuantity(5)).toEqual({ ok: true, value: 5 });
        expect(Sales.makeQuantity(0)).toEqual({ ok: false, error: { type: 'InvalidQuantity', value: 0, invariant: 'valid' } });
        expect(Sales.makeOrderId('x')).toBe('x');
    });

    test('regular expressions are JavaScript, with a slash in the pattern', () => {
        expect(Sales.checkCode('a/b')).toEqual([]);
        expect(Sales.checkCode('ab')).toEqual(['valid']);
    });

    test('a declared invariant is a slot: makeWith combines it with the generated ones in declaration order', () => {
        expect(Sales.makeSku).toBeUndefined();
        const reserved = (v: string) => v !== 'ABC-0000';
        const make = Sales.makeSkuWith({ reserved });
        expect(make('ABC-1234')).toEqual({ ok: true, value: 'ABC-1234' });
        expect(make('ABC-0000')).toMatchObject({ ok: false, error: { invariant: 'reserved' } });
        expect(make('abc')).toMatchObject({ ok: false, error: { invariant: 'format' } });
        expect(Sales.checkSkuWith({ reserved: () => false })('abc-123456')).toEqual(['format', 'reserved', 'short']);
    });

    test('exists and implies over optional values, Timestamps by time', () => {
        const t = (s: string) => new Date(s);
        expect(Sales.checkPeriod({ from: t('2026-01-01') })).toEqual([]);
        expect(Sales.checkPeriod({ from: t('2026-01-01'), until: t('2026-01-01') })).toEqual([]);
        expect(Sales.checkPeriod({ from: t('2026-01-02'), until: t('2026-01-01') })).toEqual(['ordered']);
    });

    test('unique over plain values', () => {
        expect(Sales.checkTags({ names: ['a', 'b'] })).toEqual([]);
        expect(Sales.checkTags({ names: ['a', 'b', 'a'] })).toEqual(['distinctNames']);
    });

    test('entities are equal by id, value objects by all fields, Decimals by number', () => {
        expect(Sales.equalLine(line('1', 'ABC-0001'), line('1', 'XYZ-0002'))).toBe(true);
        expect(Sales.equalLine(line('1', 'ABC-0001'), line('2', 'ABC-0001'))).toBe(false);
        expect(Common.equalMoney(yen('1.50'), yen('1.5'))).toBe(true);
        expect(Common.equalMoney(yen('1'), { amount: '1', currency: 'USD' })).toBe(false);
        expect(Sales.equalPeriod({ from: new Date(0) }, { from: new Date(0) })).toBe(true);
        expect(Sales.equalPeriod({ from: new Date(0) }, { from: new Date(0), until: new Date(0) })).toBe(false);
    });

    test('unions are equal by discriminator and fields, and checked by the invariants of their variant', () => {
        expect(Sales.equalPayment({ kind: 'Card', last4: '1234' }, { kind: 'Card', last4: '1234' })).toBe(true);
        expect(Sales.equalPayment({ kind: 'Card', last4: '1234' }, { kind: 'Card', last4: '9999' })).toBe(false);
        expect(Sales.equalPayment({ kind: 'Cash' }, { kind: 'Card', last4: '1234' })).toBe(false);
        expect(Sales.checkPayment({ kind: 'Card', last4: '12a4' })).toEqual(['digits']);
        expect(Sales.checkPayment({ kind: 'Cash' })).toEqual([]);
    });

    test('unique with keys and without (entities by id); aggregate and state invariants together', () => {
        const checks = { audited: () => true };
        const draft = (lines: unknown[]) => ({ state: 'Draft', id: 'o', lines, prices: [] });
        const check = Sales.checkDraftOrderWith(checks);
        expect(check(draft([line('1', 'ABC-0001'), line('2', 'ABC-0002')]))).toEqual([]);
        expect(check(draft([line('1', 'ABC-0001'), line('2', 'ABC-0001')]))).toEqual(['distinctSkus']);
        expect(check(draft([line('1', 'ABC-0001'), line('1', 'ABC-0002')]))).toEqual(['distinctLines']);
        const cancelled = { state: 'Cancelled', id: 'o', lines: [], prices: [], reason: 'Other' };
        expect(Sales.checkOrderWith(checks)(cancelled)).toEqual(['otherNeedsNote']);
        expect(Sales.checkOrderWith({ audited: () => false })({ ...cancelled, note: 'n' })).toEqual(['audited']);
        expect(Sales.checkOrderWith(checks)({ ...cancelled, reason: 'Requested' })).toEqual([]);
    });

    test('requirements: the first that does not hold in declaration order, a slot for the one without expression', () => {
        const order = { state: 'Draft', id: 'o', lines: [line('1', 'ABC-0001')], prices: [yen('100')] };
        const known = { known: () => true };
        const req = Sales.checkAddOrderRequiresWith(known);
        expect(req(order, line('2', 'ABC-0002'), '1')).toBeUndefined();
        expect(req(order, line('2', 'ABC-0001'), '1000')).toBe('newSku');
        expect(Sales.checkAddOrderRequiresWith({ known: () => false })(order, line('2', 'ABC-0002'), '1000')).toBe('known');
        expect(req(order, line('2', 'ABC-0002'), '100.5')).toBe('small');
        expect(req(order, line('2', 'ABC-0002', '100.0'), '1')).toBeUndefined(); // contains: Money by value, Decimal by number
        expect(req(order, line('2', 'ABC-0002', '5'), '1')).toBe('priced');
        expect(Sales.checkCancelOrderRequires).toBeUndefined();
    });
});
