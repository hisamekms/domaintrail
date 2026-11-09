import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps, runCli } from '@domaintrail/dt';

const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function project(source: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-gate-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'model.dt'), source);
    return dir;
}

async function run(root: string, ...args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['-r', root, ...args], { out: (s) => out.push(s), err: (s) => err.push(s) }, cliDeps());
    return { code, out, err };
}

const DECLARED = `context S {
  id AId: UUID
  aggregate A {
    id: AId
    invariant decidedElsewhere "The caller must check the business rule."
  }
}`;

describe('generation gate CLI', () => {
    test('ordinary check allows an expression-free decision; --for-generation rejects it in text and JSON', async () => {
        const dir = await project(DECLARED);
        const ordinary = await run(dir, 'check');
        expect(ordinary.code).toBe(0);

        const strict = await run(dir, 'check', '--for-generation');
        expect(strict.code).toBe(1);
        expect(strict.err.some((line) => line.includes('model.dt:') && line.includes('error'))).toBe(true);
        expect(strict.err.at(-1)).toContain('1 error(s)');

        const json = await run(dir, 'check', '--for-generation', '--format', 'json');
        expect(json.code).toBe(1);
        expect(json.err).toEqual([]);
        const report = JSON.parse(json.out.join('\n'));
        expect(report.summary).toMatchObject({ files: 1, errors: 1 });
        expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'model.dt', severity: 'error' })]));
    });

    test('generate applies the same gate before writing files', async () => {
        const dir = await project(DECLARED);
        const result = await run(dir, 'generate', 'ts', '--format', 'json');
        expect(result.code).toBe(1);
        expect(result.err).toEqual([]);
        const report = JSON.parse(result.out.join('\n'));
        expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'model.dt', severity: 'error' })]));
        expect(report.written).toBeUndefined();
        expect(await readdir(dir)).toEqual(['model.dt']);
    });

    test('a fully expressed model passes the generation gate', async () => {
        const dir = await project(DECLARED.replace('invariant decidedElsewhere "The caller must check the business rule."', 'invariant decidedElsewhere { true }'));
        const result = await run(dir, 'check', '--for-generation', '--format', 'json');
        expect(result.code).toBe(0);
        expect(JSON.parse(result.out.join('\n')).summary.errors).toBe(0);
    });

    test('an external obligation requires contract tests when generating', async () => {
        const dir = await project(
            DECLARED.replace(
                'invariant decidedElsewhere "The caller must check the business rule."',
                'invariant decidedElsewhere "The caller must check the business rule." @externalCheck("The rule is maintained outside this model.")',
            ),
        );
        const ready = await run(dir, 'check', '--for-generation', '--format', 'json');
        expect(ready.code).toBe(0);
        expect(JSON.parse(ready.out.join('\n')).diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'info' })]));

        const result = await run(dir, 'generate', 'ts', '--format', 'json');
        expect(result.code).toBe(1);
        const report = JSON.parse(result.out.join('\n'));
        expect(report.error).toContain('external checks require generate.ts.tests');
        expect(report.written).toBeUndefined();
        expect(await readdir(dir)).toEqual(['model.dt']);
    });
});
