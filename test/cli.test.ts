import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runCli } from '../src/cli/main.js';
import { tempCopyOfExamples } from './helpers.js';

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out, err };
}

describe('dt check', () => {
    test('exits 0 for a valid workspace', async () => {
        const dir = await tempCopyOfExamples();
        dirs.push(dir);
        const r = await run('-r', dir, 'check');
        expect(r.code).toBe(0);
        expect(r.out).toEqual(['6 file(s) checked: 0 error(s), 0 warning(s).']);
    });

    test('exits non-zero with file position and rule ID for each problem', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-cli-'));
        dirs.push(dir);
        await writeFile(
            path.join(dir, 'order.dt'),
            `context Sales {
  id OrderId: UUID
  aggregate Order {
    id: OrderId
    total: Money
    state Draft
    invariant positive { count(total) > 0 }
    command confirm() Draft -> Shipped
  }
  value Money { amount: Decimal owns order: Order }
}
`,
        );
        const r = await run('-r', dir, 'check');
        expect(r.code).toBe(1);
        expect(r.err).toEqual([
            "order.dt:7:32 - error M009: count() requires a collection, but got 'Money'.",
            "order.dt:8:32 - error M006: Cannot resolve state 'Shipped' in this aggregate.",
            "  hint: use a state of 'Order': Draft",
            "order.dt:10:45 - error M004: 'Money' cannot own aggregate 'Order'; aggregates are referenced by ID ('references').",
            "  hint: write 'references order: OrderId -> Order' instead",
            '1 file(s) checked: 3 error(s), 0 warning(s).',
        ]);
    });

    test('exits non-zero when there are no .dt files', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-cli-'));
        dirs.push(dir);
        expect((await run('-r', dir, 'check')).code).toBe(1);
    });
});

describe('--format json', () => {
    const json = (r: { out: string[] }) => {
        expect(r.out).toHaveLength(1);
        return JSON.parse(r.out[0]);
    };

    async function invalidWorkspace(): Promise<string> {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-cli-'));
        dirs.push(dir);
        await writeFile(
            path.join(dir, 'b.dt'),
            `context Sales {
  id OrderId: UUID
  aggregate Order { id: OrderId state Draft state Confirmed command confirm() Draft -> Confirmd }
}
`,
        );
        await writeFile(path.join(dir, 'a.dt'), 'context Sales "販売" {\n  terms { nte: "備考" }\n  value V { note: String }\n}\n');
        return dir;
    }

    test('check prints one document with the sorted diagnostics, hints and a summary; same exit code as text', async () => {
        const dir = await invalidWorkspace();
        const r = await run('-r', dir, 'check', '--format', 'json');
        expect(r.code).toBe(1);
        expect(r.err).toEqual([]);
        expect(json(r)).toEqual({
            diagnostics: [
                {
                    file: 'a.dt',
                    line: 2,
                    column: 11,
                    endLine: 2,
                    endColumn: 14,
                    severity: 'warning',
                    code: 'L002',
                    message: `Term 'nte' ("備考") is not used by any field or parameter in context 'Sales'.`,
                    hint: "did you mean 'note'?",
                },
                {
                    file: 'b.dt',
                    line: 3,
                    column: 88,
                    endLine: 3,
                    endColumn: 96,
                    severity: 'error',
                    code: 'M006',
                    message: "Cannot resolve state 'Confirmd' in this aggregate.",
                    hint: "did you mean 'Confirmed'?",
                },
            ],
            summary: { files: 2, errors: 1, warnings: 1 },
        });
        const text = await run('-r', dir, 'check');
        expect(text.code).toBe(1);
        expect(text.out).toEqual([`a.dt:2:11 - warning L002: Term 'nte' ("備考") is not used by any field or parameter in context 'Sales'.`, "  hint: did you mean 'note'?"]);
    });

    test('a valid workspace: no diagnostics, exit 0', async () => {
        const dir = await tempCopyOfExamples();
        dirs.push(dir);
        const r = await run('-r', dir, 'check', '--format', 'json');
        expect(r.code).toBe(0);
        expect(json(r)).toEqual({ diagnostics: [], summary: { files: 6, errors: 0, warnings: 0 } });
    });

    test('failures are an error message in the document, with the exit codes of text', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-cli-'));
        dirs.push(dir);
        const missing = await run('-r', path.join(dir, 'missing'), 'check', '--format', 'json');
        expect(missing.code).toBe(1);
        expect(json(missing)).toEqual({ error: `Root directory not found: ${path.join(dir, 'missing')}` });

        const empty = await run('-r', dir, 'check', '--format', 'json');
        expect(empty.code).toBe(1);
        expect(json(empty)).toMatchObject({ diagnostics: [], summary: { files: 0 }, error: expect.stringContaining('No .dt files found') });

        await writeFile(path.join(dir, 'domaintrail.json'), '{ "sources": 1 }');
        const config = await run('-r', dir, 'check', '--format', 'json');
        expect(config.code).toBe(2);
        expect(Object.keys(json(config))).toEqual(['error']);
    });

    test('generate ts: the directories written, or why nothing was', async () => {
        const dir = await tempCopyOfExamples();
        dirs.push(dir);
        const ok = await run('-r', dir, 'generate', 'ts', '--out', 'gen', '--format', 'json');
        expect(ok.code).toBe(0);
        expect(json(ok)).toEqual({ diagnostics: [], summary: { files: 6, errors: 0, warnings: 0 }, written: [path.relative(process.cwd(), path.join(dir, 'gen'))] });

        const invalid = await run('-r', await invalidWorkspace(), 'generate', 'ts', '--format', 'json');
        expect(invalid.code).toBe(1);
        expect(json(invalid)).toMatchObject({ summary: { errors: 1 }, error: 'Generation skipped because the model has errors.' });

        const target = await run('-r', dir, 'generate', 'js', '--format', 'json');
        expect(target.code).toBe(2);
        expect(json(target)).toEqual({ error: "Unknown target 'js'. Supported: ts" });
    });

    test('an unknown format is a usage error', async () => {
        const r = await run('check', '--format', 'xml');
        expect(r.code).not.toBe(0);
        expect(r.err.join('\n')).toContain("'xml' is invalid");
    });
});

describe('dt generate ts', () => {
    test('writes one module per context, a runtime and an index', async () => {
        const dir = await tempCopyOfExamples();
        dirs.push(dir);
        const r = await run('-r', dir, 'generate', 'ts', '--out', 'gen');
        expect(r.code).toBe(0);
        expect((await readdir(path.join(dir, 'gen'))).sort()).toEqual(['Billing.ts', 'Common.ts', 'Sales.ts', '_runtime.ts', 'index.ts']);
        expect(await readFile(path.join(dir, 'gen', 'Billing.ts'), 'utf8')).toContain("import type * as Sales from './Sales.js';");
    });

    test('replaces output written when the CLI was called dmtr', async () => {
        const dir = await tempCopyOfExamples();
        dirs.push(dir);
        await run('-r', dir, 'generate', 'ts', '--out', 'gen');
        const oldHeader = '// Generated by domaintrail. DO NOT EDIT — change the .dt sources and run `dmtr generate ts`.\n';
        await writeFile(path.join(dir, 'gen', 'Sales.ts'), `${oldHeader}export {};\n`);
        await writeFile(path.join(dir, 'gen', 'Removed.ts'), `${oldHeader}export {};\n`);
        const r = await run('-r', dir, 'generate', 'ts', '--out', 'gen');
        expect(r.code).toBe(0);
        expect(await readdir(path.join(dir, 'gen'))).not.toContain('Removed.ts');
        expect(await readFile(path.join(dir, 'gen', 'Sales.ts'), 'utf8')).toContain('run `dt generate ts`');
    });

    test('refuses to generate from an invalid model', async () => {
        const dir = await tempCopyOfExamples();
        dirs.push(dir);
        await writeFile(path.join(dir, 'broken.dt'), 'context Sales { value Broken { x: Nope } }');
        const r = await run('-r', dir, 'generate', 'ts', '--out', 'gen');
        expect(r.code).toBe(1);
        expect(r.err.at(-1)).toBe('Generation skipped because the model has errors.');
        expect(await readdir(dir)).not.toContain('gen');
    });

    test('rejects unknown targets', async () => {
        expect((await run('generate', 'rust')).code).toBe(2);
    });
});

describe('expected failures', () => {
    test('a missing or non-directory root is one line on stderr with exit 1', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-cli-'));
        dirs.push(dir);
        await writeFile(path.join(dir, 'file.txt'), '');
        for (const command of ['check', 'view']) {
            expect(await run('-r', path.join(dir, 'missing'), command)).toEqual({
                code: 1,
                out: [],
                err: [`Root directory not found: ${path.join(dir, 'missing')}`],
            });
        }
        expect(await run('-r', path.join(dir, 'file.txt'), 'check')).toEqual({
            code: 1,
            out: [],
            err: [`Root is not a directory: ${path.join(dir, 'file.txt')}`],
        });
    });

    test('an unreadable directory is reported without a stack trace', async () => {
        if (process.getuid?.() === 0) return; // root reads everything
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-cli-'));
        dirs.push(dir);
        await chmod(dir, 0o000);
        try {
            const r = await run('-r', dir, 'check');
            expect(r.code).toBe(1);
            expect(r.err).toEqual([expect.stringContaining('EACCES')]);
        } finally {
            await chmod(dir, 0o700);
        }
    });

    test('an invalid port is a usage error', async () => {
        const r = await run('view', '--port', 'abc');
        expect(r.code).toBe(1);
        expect(r.err).toEqual([expect.stringContaining('Expected a port number')]);
    });

    test('a port in use is one line on stderr', async () => {
        const dir = await tempCopyOfExamples();
        dirs.push(dir);
        const busy = createServer();
        await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
        const { port } = busy.address() as AddressInfo;
        try {
            const r = await run('-r', dir, 'view', '--port', String(port));
            expect(r.code).toBe(1);
            expect(r.err).toEqual([`Port ${port} on 127.0.0.1 is already in use; pick another with --port.`]);
        } finally {
            busy.close();
        }
    });
});
