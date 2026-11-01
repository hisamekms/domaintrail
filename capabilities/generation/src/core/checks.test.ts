import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { quote } from './checks.js';
import { generateTypeScript } from './typescript.js';
import { check } from '../test-helpers.js';

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
  id TicketId: UUID
  aggregate Ticket {
    id: TicketId
    title: String
    invariant titled "件名がある"
    state Open
    state Closed { invariant short { length(title) <= 80 } }
  }
  id MemoId: UUID
  aggregate Memo {
    id: MemoId
    state Open
    state Done
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

    test("check<Aggregate>Common: the aggregate's invariants once, which the check of each state reports first", () => {
        const order = { id: 'o', lines: [line('1', 'ABC-0001'), line('1', 'ABC-0001')], prices: [] };
        expect(Sales.checkOrderCommon(order)).toEqual(['distinctSkus', 'distinctLines']);
        expect(Sales.checkOrderCommon({ ...order, lines: [] })).toEqual([]);
        const cancelled = { ...order, state: 'Cancelled', reason: 'Other' };
        expect(Sales.checkCancelledOrderWith({ audited: () => false })(cancelled)).toEqual(['distinctSkus', 'distinctLines', 'otherNeedsNote', 'audited']);
        // A slot of the aggregate's own: the common check takes it (and the aggregate, the slot's argument)
        const ticket = { state: 'Closed', id: 't', title: 'x'.repeat(81) };
        expect(Sales.checkTicketCommonWith({ titled: () => false })(ticket)).toEqual(['titled']);
        expect(Sales.checkClosedTicketWith({ titled: () => false })(ticket)).toEqual(['titled', 'short']);
        expect(Sales.checkOpenTicketWith({ titled: () => true })({ ...ticket, state: 'Open' })).toEqual([]);
        // An aggregate with states and no invariants still has its common check, which reports none
        expect(Sales.checkMemoCommon({ id: 'm' })).toEqual([]);
        expect(Sales.checkMemo).toBeUndefined();
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

/** Lambda variables named like the check's parameter, reserved words, imports and each other; implications; quotes. */
const NAMES = {
    'common.dt': `shared context Common { enum Unit { Piece } }`,
    'names.dt': `
context Names {
  id BoxId: String
  value Item { name: String  count: Int }
  value Flags {
    a: Bool
    b: Bool
    c: Bool
    invariant implied { a implies b }
    invariant looseLeft { (a or b) implies c }
    invariant nested { (a implies b) and c }
  }
  aggregate Box {
    id: BoxId
    items: Item[0..*]
    invariant shadow { all(items, box => box.count > 0) }
    invariant reserved { all(items, enum => all(items, function => enum.name != function.name or enum == function)) }
    invariant imported { any(items, distinct => distinct.count > 0) implies unique(items, Common => Common.name) }
    invariant same { all(items, item => any(items, item => item.count > 0)) }
    invariant pair { unique(items, item => item.name) }
    invariant quoted { all(items, checks => checks.name != "it's \\"q\\"\\\\") }
    state Open
    create command make(id: BoxId) -> Open
    command add(item: Item, item2: Item?) Open -> Open
      requires fresh { all(items, item => item.name != "x") } else Dup
      requires counted { exists(item2) implies item2.count > 0 } else Dup
      changes items
  }
  error Dup
}`,
};

describe('readable expressions (ADR 0028)', async () => {
    const names = await check(NAMES);
    const source = generateTypeScript(names.model!).find((f) => f.path === 'Names.ts')!.content;
    const { Names } = await generated(NAMES);
    const has = (line: string): void => expect(source).toContain(line);
    const item = (name: string, count = 1) => ({ name, count });
    const box = (items: unknown[]) => ({ state: 'Open', id: 'b', items });

    test('a violated implication is A && !B, the same condition as !(!A || B); inside another expression it keeps its form', () => {
        has(`if (flags.a && !(flags.b)) violated.push('implied');`);
        has(`if ((flags.a || flags.b) && !(flags.c)) violated.push('looseLeft');`);
        has(`if (!((!(flags.a) || flags.b) && flags.c)) violated.push('nested');`);
        has(`if (item2 !== undefined && !(item2.count > 0)) return 'counted';`);
        for (const a of [false, true])
            for (const b of [false, true])
                for (const c of [false, true]) {
                    const expected = [
                        ...(!(!a || b) ? ['implied'] : []),
                        ...(!(!(a || b) || c) ? ['looseLeft'] : []),
                        ...(!((!a || b) && c) ? ['nested'] : []),
                    ];
                    expect(Names.checkFlags({ a, b, c })).toEqual(expected);
                }
        expect(Names.checkAddBoxRequires(box([]), item('y'), undefined)).toBeUndefined();
        expect(Names.checkAddBoxRequires(box([]), item('y'), item('z', 1))).toBeUndefined();
        expect(Names.checkAddBoxRequires(box([]), item('y'), item('z', 0))).toBe('counted');
    });

    test('lambda variables keep their names, with a number only on a clash', () => {
        has(`box.items.every((item) => box.items.some((item2) => item2.count > 0))`); // the inner one shadows the outer
        has(`distinct(box.items, (item, item2) => item.name === item2.name)`); // the second of a pair
        has(`box.items.every((box2) => box2.count > 0)`); // the check's parameter
        has(`box.items.every((enum2) => box.items.every((function2) => `); // reserved words
        has(`box.items.some((distinct2) => distinct2.count > 0) && !(distinct(box.items, (Common2, Common3) => Common2.name === Common3.name))`); // imports
        has(`box.items.every((checks2) => `); // the slots of a check
        has(`if (!(box.items.every((item3) => !(item3.name === 'x')))) return 'fresh';`); // the parameters item and item2
        expect(source).not.toMatch(/\(\$[a-z]/);
        expect(Names.checkBox(box([item('a'), item('b')]))).toEqual([]);
        expect(Names.checkBox(box([item('a', 0)]))).toEqual(['shadow', 'same']);
        expect(Names.checkBox(box([item('a', 1), item('a', 2)]))).toEqual(['reserved', 'imported', 'pair']);
        expect(Names.checkBox(box([item('a'), item('a')]))).toEqual(['imported', 'pair']); // equal values
        expect(Names.checkBox(box([item(`it's "q"\\`)]))).toEqual(['quoted']);
        expect(Names.checkAddBoxRequires(box([item('x')]), item('y'), undefined)).toBe('fresh');
    });

    test('string literals and enum values are in single quotes, escaped as needed', () => {
        has(`!(checks2.name === 'it\\'s "q"\\\\')`);
        expect(source.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l) && l.includes('"') && !l.includes(`'it\\'s "q"`))).toEqual([]);
    });

    test('quote writes a literal that reads back as the text', async () => {
        const texts = ['', `'`, `"`, '\\', `a'b"c\\d`, '\n\t ', 'é'];
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-quote-'));
        dirs.push(dir);
        await writeFile(path.join(dir, 'texts.ts'), `export const texts = [${texts.map(quote).join(', ')}];\n`);
        expect((await import(path.join(dir, 'texts.ts'))).texts).toEqual(texts);
    });
});
