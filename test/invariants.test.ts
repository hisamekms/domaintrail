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
