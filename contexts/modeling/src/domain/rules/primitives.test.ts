import { describe, expect, test } from 'bun:test';
import { checkSales, codes, only, element } from '../../test-helpers.js';

const DECLS = `
  id OrderId: UUID
  primitive Quantity "数量": Int { value > 0 }
  primitive Price: Int { value in 0..1000000 }
  primitive Celsius: Decimal { value in -273.15..1000 }
  primitive Email: String {
    invariant format "形式" { matches(value, "^[^@\\s]+@[^@\\s]+$") }
    invariant maxLength { length(value) <= 254 }
  }
  id InvoiceNo: String { matches(value, "^INV-\\d{8}$") }
`;

const withOrder = (invariants: string) =>
    checkSales(`${DECLS}
  aggregate Order {
    id: OrderId
    quantity: Quantity
    maxQuantity: Quantity
    price: Price
    rawCount: Int
    email: Email?
    notes: String[0..*]
    title: String
    temperature: Celsius
    ${invariants}
  }`);

describe('domain primitive declarations', () => {
    test('primitives, IDs with invariants and the anonymous constraint form are valid', async () => {
        const a = await withOrder('');
        expect(codes(a)).toEqual([]);
        const m = a.model!;
        expect(element(m, 'Sales.Quantity')).toMatchObject({
            kind: 'primitive',
            base: 'Int',
            label: '数量',
            invariants: [{ name: 'valid', source: 'value > 0' }],
        });
        expect(element(m, 'Sales.Email').invariants.map((i) => [i.name, i.label])).toEqual([
            ['format', '形式'],
            ['maxLength', undefined],
        ]);
        expect(element(m, 'Sales.InvoiceNo')).toMatchObject({ kind: 'id', invariants: [{ source: 'matches(value, "^INV-\\d{8}$")' }] });
    });

    test('invariants see only `value`, typed as the base primitive', async () => {
        const a = await checkSales(`
  primitive A: Int { length(value) > 0 }
  primitive B: String { value > 0 }
  primitive C: Int { value }
  primitive D: Int { other > 0 }
  primitive E: Decimal { value in 0..1.5 }`);
        expect(a.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([
            "M009 length() requires a String value, but got 'Int'.",
            "M009 Operator '>' cannot be applied to 'String' and 'Int'.",
            "M008 The constraint of 'C' must be a Bool expression, but has type 'Int'.",
            "M001 Cannot resolve name 'other'.",
        ]);
    });

    test('regular expressions are taken literally and checked', async () => {
        const a = await checkSales(String.raw`primitive Code: String { matches(value, "\d+\"x") } primitive Bad: String { matches(value, "([a-z") }`);
        const [d, ...rest] = only(a, 'M009');
        expect(rest).toEqual([]); // "\d+\"x" is a valid pattern: backslashes are not string escapes
        expect(d.message).toContain('Invalid regular expression'); // wording depends on the JS engine
        expect(d.message).toContain('([a-z');
    });

    test('primitives cannot be owned, referenced or used as identity', async () => {
        const a = await checkSales(`${DECLS}
  aggregate X { id: Quantity owns q: Quantity references o: Quantity -> Order }
  aggregate Order { id: OrderId }`);
        expect(codes(a).sort()).toEqual(['M004', 'M005', 'M013']);
    });
});

describe('domain primitives in other invariants', () => {
    test('compare with literals and with the same domain primitive', async () => {
        const a = await withOrder(
            'invariant ok { quantity > 0 and quantity <= maxQuantity and quantity in 1..10 and exists(email) implies length(email) > 3 }',
        );
        expect(codes(a)).toEqual([]);
    });

    test.each([
        ['quantity > price', "Operator '>' cannot be applied to 'Quantity' and 'Price'."],
        ['quantity > rawCount', "Operator '>' cannot be applied to 'Quantity' and 'Int'."],
        ['quantity == "1"', "Operator '==' cannot be applied to 'Quantity' and 'String'."],
        ['quantity in 0..rawCount', "Range 'Int..Int' cannot be applied to 'Quantity'."],
        ['exists(email) implies email == count(notes)', "Operator '==' cannot be applied to 'Email' and 'Int'."],
        ['count(notes) <= price and price > rawCount', "Operator '>' cannot be applied to 'Price' and 'Int'."],
    ])('M009 %s', async (expr, message) => {
        const a = await withOrder(`invariant i { ${expr} }`);
        expect(only(a, 'M009').map((d) => d.message)).toEqual([message]);
    });

    test('Int and Decimal domain primitives compare with the numbers count() and length() compute, on either side', async () => {
        const exprs = [
            'count(notes) >= quantity',
            'quantity == count(notes)',
            'price != length(title)',
            '(count(notes)) < (price)',
            'quantity in 0..count(notes)',
            'count(notes) in quantity..maxQuantity',
            'length(title) <= temperature',
            'exists(email) implies length(email) <= quantity',
        ];
        const a = await withOrder(exprs.map((x, i) => `invariant i${i} { ${x} }`).join('\n    '));
        expect(codes(a)).toEqual([]);
    });

    test('field labels fall back to the primitive label', async () => {
        const m = (await withOrder('')).model!;
        expect(element(m, 'Sales.Order').fields.find((f) => f.name === 'quantity')).toMatchObject({ label: '数量', labelSource: 'type' });
    });
});
