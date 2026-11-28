import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { check, generateFromAnalysis } from './helpers.js';

type Case = {
    command: string;
    subject: unknown;
    params: unknown;
    value: unknown;
    expected: null | { id: string; outcome: string; kind: 'changes' | 'unchanged' | 'ensures'; field?: string; source: string };
};
const ROOT = path.join(import.meta.dir, 'fixtures', 'ensures');
const dirs: string[] = [];
afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ensures reference corpus', async () => {
    const files = await readdir(ROOT);
    const models = files.filter((name) => name.endsWith('.dt')).sort();
    for (const json of files.filter((name) => name.endsWith('.json'))) {
        expect(models, `${json} has a matching model`).toContain(`${json.slice(0, -5)}.dt`);
    }
    for (const file of models) {
        test(file, async () => {
            const name = file.slice(0, -3);
            const model = await readFile(path.join(ROOT, file), 'utf8');
            const cases = JSON.parse(await readFile(path.join(ROOT, `${name}.json`), 'utf8')) as Case[];
            expect(cases.length, `${name} has corpus cases`).toBeGreaterThan(0);
            const analysis = await check({ [file]: model });
            expect(analysis.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
            const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-ensures-'));
            dirs.push(dir);
            for (const generated of generateFromAnalysis(analysis)) {
                const target = path.join(dir, generated.path);
                await (await import('node:fs/promises')).mkdir(path.dirname(target), { recursive: true });
                await writeFile(target, generated.content);
            }
            const module = (await import(path.join(dir, 'index.ts'))) as Record<string, any>;
            const tested = new Set(cases.map((row) => row.command));
            for (const key of Object.keys(module.Corpus)) {
                const match = key.match(/^check(.+?)ItemEnsures$/);
                if (match) expect(tested, `${name} covers ${key}`).toContain(match[1]![0]!.toLowerCase() + match[1]!.slice(1));
            }
            for (const [caseIndex, row] of cases.entries()) {
                const fn = module.Corpus[`check${row.command[0]!.toUpperCase()}${row.command.slice(1)}ItemEnsures`];
                expect(typeof fn, `${row.command} generated ensures check: ${Object.keys(module).join(', ')}`).toBe('function');
                const result =
                    row.subject === null
                        ? fn(row.params, row.value)
                        : Object.keys(row.params as object).length === 0
                          ? fn(row.subject, row.value)
                          : fn(row.subject, row.params, row.value);
                if (row.expected === null) {
                    expect(result, `${name} case ${caseIndex} (${row.command})`).toBeUndefined();
                } else {
                    expect(row.expected.id).toBeString();
                    expect(row.expected.outcome).toBeString();
                    expect(row.expected.kind).toBeString();
                    // An ensures conjunct names no field; a changes or frame violation names its field.
                    if (row.expected.kind === 'ensures') {
                        expect(row.expected.field).toBeUndefined();
                        expect(result?.field, `${name} case ${caseIndex} (${row.command})`).toBeUndefined();
                    } else expect(row.expected.field).toBeString();
                    expect(row.expected.source).toBeString();
                    expect(result, `${name} case ${caseIndex} (${row.command})`).toMatchObject(row.expected);
                }
            }
        });
    }
});
