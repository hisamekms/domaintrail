import { describe, expect, test } from 'bun:test';
import { checkSales, codes, only } from './helpers.js';

const model = (aggregateInvariants: string, confirmedInvariants = '', extra = '') =>
    checkSales(`
  id OrderId: UUID
  id LineId: UUID
  enum Reason { Requested Other }
  aggregate Order {
    id: OrderId
    owns lines: Line[0..*]
    note: String?
    total: Decimal
    ${aggregateInvariants}
    state Draft
    state Confirmed {
      confirmedAt: Timestamp
      reason: Reason
      ${confirmedInvariants}
    }
  }
  entity Line { id: LineId quantity: Int owns price: Money? }
  value Money { amount: Decimal }
  ${extra}`);

describe('invariant scopes', () => {
    test('aggregate-level invariants see only common fields (M010)', async () => {
        const a = await model('invariant i { confirmedAt == confirmedAt }');
        expect(codes(a)).toEqual(['M010', 'M010']);
        expect(only(a, 'M010')[0].message).toBe("Field 'confirmedAt' exists only in state 'Confirmed' and is not in scope here.");
    });

    test('state-level invariants see common and their own fields', async () => {
        const a = await model('', 'invariant i { count(lines) > 0 and reason == Reason.Other implies total > 0 }');
        expect(a.diagnostics).toEqual([]);
    });

    test('a state cannot see fields of another state', async () => {
        const a = await checkSales(`
  id OrderId: UUID
  aggregate Order {
    id: OrderId
    state A { a: Int }
    state B { b: Int invariant i { a > 0 } }
  }`);
        expect(codes(a)).toEqual(['M010']);
    });

    test('unknown names are M001', async () => {
        const a = await model('invariant i { missing > 0 }');
        expect(codes(a)).toEqual(['M001']);
    });
});

describe('invariant types', () => {
    test('M008 the result must be Bool', async () => {
        const a = await model('invariant i { count(lines) }');
        expect(only(a, 'M008')[0].message).toBe("Invariant 'i' must be a Bool expression, but has type 'Int'.");
    });

    test.each([
        ['note == 1', "Operator '==' cannot be applied to 'String?' and 'Int'. Optional values must be guarded with exists(...) first."],
        ['total > "x"', "Operator '>' cannot be applied to 'Decimal' and 'String'."],
        ['count(total) > 0', "count() requires a collection, but got 'Decimal'."],
        ['all(lines, l => l.quantity)', "The predicate of all() must be Bool, but has type 'Int'."],
        ['exists(total)', "exists() requires an optional value, but 'Decimal' is always present."],
        ['not total', "Operator 'not' requires Bool, but got 'Decimal'."],
        ['total > 0 and 1', "Operator 'and' requires Bool operands, but the right operand has type 'Int'."],
        ['any(lines, l => l.price.amount > 0)', "'l.price' is optional; guard the access with exists(...) first."],
        ['id == 0', "Operator '==' cannot be applied to 'OrderId' and 'Int'."],
    ])('M009 %s', async (expr, message) => {
        const a = await model(`invariant i { ${expr} }`);
        expect(only(a, 'M009').map((d) => d.message)).toEqual([message]);
    });

    test('exists() guards narrow optional values', async () => {
        const a = await model('invariant i { all(lines, l => exists(l.price) implies l.price.amount > 0) and (exists(note) and note != "") }');
        expect(a.diagnostics).toEqual([]);
    });

    test('enum values, qualified enum values and numeric comparisons', async () => {
        const a = await model('', 'invariant i { reason != Sales.Reason.Requested or total >= 1.5 or count(lines) == 0 }');
        expect(a.diagnostics).toEqual([]);
        const b = await model('', 'invariant i { reason == Reason.Unknown }');
        expect(only(b, 'M001')[0].message).toBe("Enum 'Reason' has no value 'Unknown'.");
    });

    test('ids of other aggregates cannot be dereferenced', async () => {
        const a = await checkSales(`
  id OrderId: UUID
  id CustomerId: UUID
  aggregate Customer { id: CustomerId active: Bool }
  aggregate Order { id: OrderId references customer: CustomerId -> Customer invariant i { customer.active } }`);
        expect(only(a, 'M009')[0].message).toContain('cannot be accessed from an invariant');
    });

    test('entity and value object invariants', async () => {
        const a = await model('', '', 'value Range { lo: Int hi: Int invariant ordered { lo <= hi } invariant bad { lo } }');
        expect(codes(a)).toEqual(['M008']);
    });
});

describe('unique and contains', () => {
    const lists = (invariants: string) =>
        checkSales(`
  id OrderId: UUID
  id LineId: UUID
  primitive Sku: String
  enum Reason { Requested Other }
  aggregate Order {
    id: OrderId
    owns lines: Line[0..*]
    skus: Sku[0..*]
    required: Sku[1..*]
    reasons: Reason[0..*]
    reason: Reason?
    prices: Money[0..*]
    favorite: Sku
    total: Decimal
    ${invariants}
  }
  entity Line { id: LineId sku: Sku note: String? tags: String[0..*] owns price: Money? }
  value Money { amount: Decimal }`);

    test('unique over elements, one key and a combination of keys', async () => {
        const a = await lists(`
    invariant distinctLines { unique(lines) }
    invariant distinctSkus { unique(lines, l => l.sku) and unique(skus) }
    invariant distinctPairs { unique(lines, l => l.sku, l.id) }
    invariant distinctPrices { unique(prices) }`);
        expect(a.diagnostics).toEqual([]);
    });

    test('contains: membership, subsets and literals of a domain primitive', async () => {
        const a = await lists(`
    invariant member { contains(skus, favorite) and contains(skus, "ABC") }
    invariant subset { all(required, s => contains(skus, s)) }
    invariant guarded { exists(reason) implies contains(reasons, reason) }
    invariant ofValues { all(lines, l => exists(l.price) implies contains(prices, l.price)) }`);
        expect(a.diagnostics).toEqual([]);
    });

    test.each([
        ['unique(total)', "unique() requires a collection, but got 'Decimal'."],
        ['unique(lines, l => l.note)', "Key 'l.note' of unique() is optional ('String?'); keys must always be present. Group the keys into a value object and use it as the key."],
        ['unique(lines, l => l.sku, l.tags)', "Key 'l.tags' of unique() has type 'String[0..*]', which cannot be compared with '=='."],
        ['unique(lines, l => l.missing)', "'Line' has no field 'missing'."],
        ['contains(total, 1)', "contains() requires a collection, but got 'Decimal'."],
        ['contains(skus, total)', "contains() cannot compare elements of type 'Sku' with 'Decimal'."],
        ['contains(reasons, reason)', "contains() cannot compare elements of type 'Reason' with 'Reason?'. Optional values must be guarded with exists(...) first."],
        ['contains(lines, prices)', "contains() cannot compare elements of type 'Line' with 'Money[0..*]'."],
    ])('M009 %s', async (expr, message) => {
        const a = await lists(`invariant i { ${expr} }`);
        expect(a.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)).toEqual([message]);
    });

    test('function names can still name fields and lambda parameters', async () => {
        const a = await checkSales(`
  id OrderId: UUID
  aggregate Order {
    id: OrderId
    count: Int
    unique: Bool
    contains: String[0..*]
    matches: String
    all: Int[0..*]
    invariant i { count > 0 and unique and count(contains) == count and contains(contains, matches) }
    invariant j { all(all, any => any > count) and unique(all, exists => exists) }
  }`);
        expect(a.diagnostics).toEqual([]);
    });
});

describe('invariants without an expression', () => {
    test('are declared with a label or a description', async () => {
        const a = await model(`
    invariant labelled "明細の在庫が引当済み"
    /// The lines were checked against stock.
    invariant described`, 'invariant both "確定時に通知済み" { total > 0 }');
        expect(a.diagnostics).toEqual([]);
        const order = a.model!.elements['Sales.Order'];
        expect(order.invariants).toEqual([
            { name: 'labelled', label: '明細の在庫が引当済み' },
            { name: 'described', doc: 'The lines were checked against stock.' },
        ]);
        expect(order.states![1].invariants).toEqual([
            { name: 'both', label: '確定時に通知済み', source: 'total > 0', expr: { k: 'binary', op: '>', left: { k: 'name', name: 'total' }, right: { k: 'int', value: 0 } } },
        ]);
    });

    test('M018 an invariant without an expression needs a label or a description', async () => {
        const a = await model('invariant bare', '', 'value Range { lo: Int invariant alsoBare }');
        expect(only(a, 'M018').map((d) => d.message)).toEqual([
            "Invariant 'bare' has no expression; give it a label or a /// description that states what it requires.",
            "Invariant 'alsoBare' has no expression; give it a label or a /// description that states what it requires.",
        ]);
    });

    test('in domain primitives, next to invariants with an expression', async () => {
        const a = await checkSales(`
  primitive Code: String {
    invariant format { matches(value, "^[A-Z]+$") }
    invariant registered "登録済みのコード"
    invariant bare
  }`);
        expect(codes(a)).toEqual(['M018']);
        expect(a.model!.elements['Sales.Code'].invariants.map((i) => [i.name, i.source])).toEqual([
            ['format', 'matches(value, "^[A-Z]+$")'],
            ['registered', undefined],
            ['bare', undefined],
        ]);
    });
});
