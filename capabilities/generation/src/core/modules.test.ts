// Contexts written into another package and imported by its module (`generate.ts.contexts.<Ctx>.module`, ADR 0028):
// the code and the contract tests of other directories import the context and its tests through the package, the
// code of its own directory by relative path. The output of both packages type-checks together (tsc, a child process).
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { generateTypeScript } from './typescript.js';
import { check, linkNodeModules } from '../test-helpers.js';

const TSC = path.join(import.meta.dir, '..', '..', '..', '..', 'node_modules', '.bin', 'tsc');

const KERNEL = `shared context Kernel {
  value Location {
    file: String
    line: Int
  }
  primitive Line: Int { value >= 1 }
}`;

const SALES = `context Sales {
  id OrderId: UUID
  value Stop {
    at: Location
  }
  aggregate Order {
    id: OrderId
    at: Location
    line: Line
    create command place(id: OrderId, at: Location, line: Line)
    command move(at: Location)
  }
}`;

const KERNEL_OUT = 'packages/kernel/src/generated';
const DIRS = { Kernel: KERNEL_OUT };
const MODULES = { Kernel: '@acme/kernel' };

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const contentOf = (files: { path: string; content: string }[], p: string): string => files.find((f) => f.path === p)?.content ?? '';

describe('a context written into another package', () => {
    test('is imported by its module from other directories', async () => {
        const a = await check({ 'kernel.dt': KERNEL, 'sales.dt': SALES });
        expect(a.diagnostics).toEqual([]);
        const files = generateTypeScript(a.model!, DIRS, undefined, {}, MODULES);
        expect(files.map((f) => f.path).sort()).toEqual([
            'Sales.ts',
            '_runtime.ts',
            'index.ts',
            `${KERNEL_OUT}/Kernel.ts`,
            `${KERNEL_OUT}/_runtime.ts`,
            `${KERNEL_OUT}/index.ts`,
        ]);
        const sales = contentOf(files, 'Sales.ts');
        // its equality is called: a value import
        expect(sales).toContain("import * as Kernel from '@acme/kernel';");
        expect(sales).toContain('readonly at: Kernel.Location;');
        expect(sales).toContain('Kernel.equalLocation(');
    });

    test('a context of the same directory keeps its relative path', async () => {
        const a = await check({ 'kernel.dt': KERNEL, 'sales.dt': SALES });
        const files = generateTypeScript(a.model!, { Kernel: 'gen', Sales: 'gen' }, undefined, {}, { Kernel: '@acme/kernel', Sales: '@acme/kernel' });
        expect(contentOf(files, 'gen/Sales.ts')).toContain("import * as Kernel from './Kernel.js';");
    });

    test('its contract tests are written into its package, and other tests reach them through it', async () => {
        const a = await check({ 'kernel.dt': KERNEL, 'sales.dt': SALES });
        const files = generateTypeScript(a.model!, DIRS, { dir: 'tests', runner: 'bun' }, {}, MODULES);
        const paths = files.map((f) => f.path);
        expect(paths.filter((p) => p.startsWith('tests/')).sort()).toEqual(['tests/Sales.ts', 'tests/_register.ts', 'tests/index.ts']);
        expect(paths.filter((p) => p.startsWith(`${KERNEL_OUT}/tests/`)).sort()).toEqual(
            ['Kernel.ts', '_register.ts', 'index.ts'].map((f) => `${KERNEL_OUT}/tests/${f}`),
        );
        const sales = contentOf(files, 'tests/Sales.ts');
        expect(sales).toContain("import * as KernelTests from '@acme/kernel/tests';");
        expect(sales).toContain('readonly Kernel?: Partial<KernelTests.Arbitraries>');
        expect(contentOf(files, 'tests/index.ts')).not.toContain('Kernel');
        // the kernel's own tests: its context by relative path, and nothing of a package it does not depend on
        const kernel = contentOf(files, `${KERNEL_OUT}/tests/Kernel.ts`);
        expect(kernel).toContain("from '../Kernel.js';");
        expect(kernel).not.toContain('Sales');
    });

    test('the output of both packages type-checks together, contract tests included', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-module-'));
        dirs.push(dir);
        const write = async (rel: string, content: string): Promise<void> => {
            await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
            await writeFile(path.join(dir, rel), content);
        };
        const a = await check({ 'kernel.dt': KERNEL, 'sales.dt': SALES });
        for (const f of generateTypeScript(a.model!, DIRS, { dir: 'tests' }, {}, MODULES)) await write(f.path, f.content);
        // the kernel's package exports its context and its tests
        await write(
            'packages/kernel/package.json',
            JSON.stringify({
                name: '@acme/kernel',
                type: 'module',
                exports: { '.': './src/generated/Kernel.ts', './tests': './src/generated/tests/Kernel.ts' },
            }),
        );
        // fast-check and domaintrail/testing, as a project with domaintrail as a dev dependency has them
        await linkNodeModules(dir);
        await mkdir(path.join(dir, 'node_modules', '@acme'), { recursive: true });
        await Bun.write(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
        await symlink(path.join(dir, 'packages', 'kernel'), path.join(dir, 'node_modules', '@acme', 'kernel'));
        await write(
            'tsconfig.json',
            JSON.stringify({
                compilerOptions: {
                    strict: true,
                    noEmit: true,
                    target: 'ES2023',
                    module: 'preserve',
                    moduleResolution: 'bundler',
                    allowImportingTsExtensions: true,
                    lib: ['ES2023', 'DOM'],
                    types: [],
                },
                include: ['*.ts', 'tests/*.ts', 'packages/**/*.ts'],
            }),
        );
        const r = Bun.spawnSync([process.execPath, TSC, '-p', 'tsconfig.json'], { cwd: dir });
        expect({ code: r.exitCode, output: r.stdout.toString() + r.stderr.toString() }).toEqual({ code: 0, output: '' });
    }, 60_000);
});
