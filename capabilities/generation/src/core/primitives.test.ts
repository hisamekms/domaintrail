// What domain primitives make of the generated TypeScript, and the generator's check of their constructors' names (M011)
// (the DSL and its checks: contexts/modeling/src/domain/rules/primitives.test.ts).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { generateTypeScript } from './typescript.js';
import { analyzeForGeneration, checkSales, exampleSources, only } from '../test-helpers.js';

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

describe('domain primitives: the name check of the generator (M011)', () => {
    test('generated constructor names are checked for collisions (M011)', async () => {
        const a = await checkSales(`${DECLS} value MakeQuantity event InvalidEmail error InvalidOrderId`);
        expect(only(a, 'M011').map((d) => d.message)).toEqual([
            "Generated TypeScript name 'MakeQuantity' for value object 'MakeQuantity' collides with the constructor of 'Quantity'.",
            "Generated TypeScript name 'InvalidEmail' for event 'InvalidEmail' collides with the error of 'Email'.",
            "Generated TypeScript name 'InvalidOrderId' for error 'InvalidOrderId' collides with the error of 'OrderId'.",
        ]);
    });
});

describe('generated TypeScript for domain primitives', () => {
    let dir: string;

    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-dp-'));
        const a = await analyzeForGeneration(await exampleSources());
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
            "    readonly type: 'Common.InvalidEmailAddress';\n    readonly value: string;\n    /** The violated invariant. */\n    readonly invariant: 'format' | 'maxLength';",
        );
        expect(common).toContain('export type MakeEmailAddress = (value: string) => Result<EmailAddress, InvalidEmailAddress>;');
        // an ID on UUID checks the form: the invariant 'uuid'
        expect(sales).toContain(
            "export interface InvalidOrderId {\n    readonly type: 'Sales.InvalidOrderId';\n    readonly value: string;\n    /** The violated invariant. */\n    readonly invariant: 'uuid';\n}",
        );
        expect(sales).toContain('export type MakeOrderId = (value: string) => Result<OrderId, InvalidOrderId>;');
        expect(sales).toContain(' * @invariant uuid: the form of a UUID (RFC 9562): 8-4-4-4-12 hexadecimal digits, in either case, of any version');
        expect(common).toContain(' * @invariant format (形式): matches(value, "^[^@\\s]+@[^@\\s]+$")');
    });
});
