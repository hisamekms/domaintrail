// The generated TypeScript of domain primitives, type-checked by tsc.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { generateTypeScript } from './typescript.js';

import { analyzeForGeneration, EXAMPLES, exampleSources } from '../test-helpers.js';

describe('generated TypeScript for domain primitives', () => {
    let dir: string;
    const TSC = path.join(import.meta.dir, '..', '..', '..', '..', 'node_modules', '.bin', 'tsc');
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
        const a = await analyzeForGeneration(await exampleSources());
        expect(a.diagnostics).toEqual([]);
        await mkdir(path.join(dir, 'generated', 'domain'), { recursive: true });
        for (const f of generateTypeScript(a.model!)) await writeFile(path.join(dir, 'generated', 'domain', f.path), f.content);
        await mkdir(path.join(dir, 'src'));
    });
    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
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
    err({ type: 'Common.InvalidEmailAddress', value, invariant: 'tooShort' });
export const amount: Decimal = price.amount; // Decimal-based values keep their brand
`,
        );
        expect(tsc('src/domain/primitives.ts', 'src/misuse.ts')).toBe('');
    });
});
