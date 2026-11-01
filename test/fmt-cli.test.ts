// dt fmt through the CLI over files (formatting itself: contexts/modeling/src/infrastructure/syntax/format.test.ts).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps, runCli } from '@domaintrail/dt';
import { EXAMPLES, tempCopyOfExamples } from './helpers.js';

/**
 * The same file with other whitespace: line breaks where there were spaces (but not next to a comment, whose line
 * decides where it stays), other indentation, several spaces. The number of line breaks of a gap is kept when it has
 * any, so blank lines stay where they were.
 */
function scramble(text: string): string {
    let n = 0;
    return text.replace(
        /("(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*)|([ \t]*\n[\s]*|[ \t]+)/g,
        (all, kept: string | undefined, ws: string | undefined, offset: number) => {
            if (kept || !ws) return all;
            n++;
            const newlines = ws.split('\n').length - 1;
            if (newlines) return '\n'.repeat(newlines) + ' '.repeat(n % 7);
            const nearComment = /^\s*\/[/*]/.test(text.slice(offset + ws.length)) || text.slice(0, offset).endsWith('*/');
            return !nearComment && n % 3 === 0 ? `\n${' '.repeat(n % 5)}` : ' '.repeat(1 + (n % 3));
        },
    );
}

describe('dt fmt', () => {
    const dirs: string[] = [];
    afterEach(async () => {
        for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
    });

    async function run(...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
        const out: string[] = [];
        const err: string[] = [];
        const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, cliDeps());
        return { code, out, err };
    }

    test('examples/shop is formatted', async () => {
        const r = await run('-r', EXAMPLES, 'fmt', '--check');
        expect(r).toEqual({ code: 0, out: ['8 file(s) checked: 0 not formatted.'], err: [] });
    });

    test('--check lists the files to format and writes nothing; fmt writes them', async () => {
        const dir = await tempCopyOfExamples();
        dirs.push(dir);
        const file = path.join(dir, 'billing', 'invoice.dt');
        const original = await readFile(file, 'utf8');
        await writeFile(file, scramble(original));
        const checked = await run('-r', dir, 'fmt', '--check');
        expect(checked).toEqual({ code: 1, out: ['billing/invoice.dt'], err: ['8 file(s) checked: 1 not formatted. Run `dt fmt` to format them.'] });
        expect(await readFile(file, 'utf8')).toBe(scramble(original));
        expect(await run('-r', dir, 'fmt')).toEqual({ code: 0, out: ['billing/invoice.dt', '8 file(s): 1 formatted.'], err: [] });
        expect(await readFile(file, 'utf8')).toBe(original);
    });

    test('formats the files given, relative to the current directory', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-fmt-'));
        dirs.push(dir);
        const file = path.join(dir, 'a.dt');
        await writeFile(file, 'context A {   id X: UUID }');
        const r = await run('fmt', file);
        expect(r.code).toBe(0);
        expect(await readFile(file, 'utf8')).toBe('context A {\n  id X: UUID\n}\n');
    });

    test('reports syntax errors like check and leaves the file untouched', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-fmt-'));
        dirs.push(dir);
        await writeFile(path.join(dir, 'bad.dt'), 'context A { id X UUID }');
        await writeFile(path.join(dir, 'good.dt'), 'context B { id Y: UUID }');
        const r = await run('-r', dir, 'fmt');
        expect(r.code).toBe(1);
        expect(r.out).toEqual(['good.dt']);
        expect(r.err[0]).toMatch(/^bad\.dt:1:\d+ - error SYNTAX: /);
        expect(r.err.at(-1)).toBe('2 file(s): 1 formatted, 1 not formatted because of syntax errors.');
        expect(await readFile(path.join(dir, 'bad.dt'), 'utf8')).toBe('context A { id X UUID }');
    });

    test('no .dt file is an error', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-fmt-'));
        dirs.push(dir);
        expect((await run('-r', dir, 'fmt')).code).toBe(1);
    });
});
