import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { analyze } from '@domaintrail/modeling/core/analyze';
import { loadWorkspace } from '@domaintrail/workspace/infrastructure/files';
import { generateTypeScript } from '@domaintrail/modeling/generator/typescript';
import { EXAMPLES, checkSales, codes, only } from './helpers.js';

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
        expect(m.elements['Sales.Quantity']).toMatchObject({
            kind: 'primitive',
            base: 'Int',
            label: '数量',
            invariants: [{ name: 'valid', source: 'value > 0' }],
        });
        expect(m.elements['Sales.Email'].invariants.map((i) => [i.name, i.label])).toEqual([
            ['format', '形式'],
            ['maxLength', undefined],
        ]);
        expect(m.elements['Sales.InvoiceNo']).toMatchObject({ kind: 'id', invariants: [{ source: 'matches(value, "^INV-\\d{8}$")' }] });
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

    test('generated constructor names are checked for collisions (M011)', async () => {
        const a = await checkSales(`${DECLS} value MakeQuantity event InvalidEmail`);
        expect(only(a, 'M011').map((d) => d.message)).toEqual([
            "Generated TypeScript name 'MakeQuantity' for value object 'MakeQuantity' collides with the constructor of 'Quantity'.",
            "Generated TypeScript name 'InvalidEmail' for event 'InvalidEmail' collides with the error of 'Email'.",
        ]);
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
        expect(m.elements['Sales.Order'].fields.find((f) => f.name === 'quantity')).toMatchObject({ label: '数量', labelSource: 'type' });
    });
});

describe('generated TypeScript for domain primitives', () => {
    let dir: string;
    const TSC = path.join(import.meta.dir, '..', 'node_modules', '.bin', 'tsc');
    const tsc = (...files: string[]) => {
        const r = Bun.spawnSync(
            [
                process.execPath,
                TSC,
                '--noEmit',
                '--strict',
                '--target',
                'ES2023',
                '--module',
                'preserve',
                '--moduleResolution',
                'bundler',
                '--lib',
                'ES2023,DOM',
                ...files,
            ],
            { cwd: dir },
        );
        return r.stdout.toString() + r.stderr.toString();
    };

    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-dp-'));
        const a = await analyze(await loadWorkspace(EXAMPLES));
        expect(a.diagnostics).toEqual([]);
        await mkdir(path.join(dir, 'generated', 'domain'), { recursive: true });
        for (const f of generateTypeScript(a.model!)) await writeFile(path.join(dir, 'generated', 'domain', f.path), f.content);
        await mkdir(path.join(dir, 'src'));
    });
    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test('branded type, error type and constructor contract', async () => {
        const sales = await readFile(path.join(dir, 'generated', 'domain', 'Sales.ts'), 'utf8');
        expect(sales).toContain("export type Quantity = number & { readonly __domain: 'Sales.Quantity' };");
        const common = await readFile(path.join(dir, 'generated', 'domain', 'Common.ts'), 'utf8');
        expect(common).toContain(
            "    readonly type: 'InvalidEmailAddress';\n    readonly value: string;\n    /** The violated invariant. */\n    readonly invariant: 'format' | 'maxLength';",
        );
        expect(common).toContain('export type MakeEmailAddress = (value: string) => Result<EmailAddress, InvalidEmailAddress>;');
        expect(sales).toContain('export type MakeOrderId = (value: string) => OrderId;');
        expect(common).toContain(' * @invariant format (形式): matches(value, "^[^@\\s]+@[^@\\s]+$")');
    });

    test("the example's constructors compile; misuse is rejected", async () => {
        await mkdir(path.join(dir, 'src', 'domain'));
        await writeFile(path.join(dir, 'src', 'domain', 'primitives.ts'), await readFile(path.join(EXAMPLES, 'src', 'domain', 'primitives.ts'), 'utf8'));
        await writeFile(
            path.join(dir, 'src', 'misuse.ts'),
            `import { err, type Common, type Decimal, type Sales } from '../generated/domain/index.js';
declare const item: Sales.OrderItem;
declare const price: Common.Money;
// @ts-expect-error a plain number is not a Quantity
export const q: Sales.Quantity = 3;
// @ts-expect-error domain primitives with the same base are not interchangeable
export const sku: Sales.Sku = 'x' as Common.EmailAddress;
export const n: number = item.quantity; // a Quantity can be read as its base value
export const bad: Common.MakeEmailAddress = (value) =>
    // @ts-expect-error only declared invariant names can be reported
    err({ type: 'InvalidEmailAddress', value, invariant: 'tooShort' });
export const amount: Decimal = price.amount; // Decimal-based values keep their brand
`,
        );
        expect(tsc('src/domain/primitives.ts', 'src/misuse.ts')).toBe('');
    });
});
