import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { runCli } from '../src/cli/main.js';
import { parseJsonc } from '../src/core/config.js';
import { check } from './helpers.js';

const ROOT = path.join(import.meta.dir, '..');
const guide = await readFile(path.join(ROOT, 'docs', 'guide.md'), 'utf8');
const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8');

/** Contents of the code blocks in a language of a Markdown text (the guide by default). */
const blocks = (lang: string, markdown = guide): string[] => [...markdown.matchAll(new RegExp('^```' + lang + '\\n([\\s\\S]*?)^```', 'gm'))].map((m) => m[1]);

/** The `dt` blocks as files of one workspace, named by their first line (`// sales/order.dt`). */
function workspace(): Record<string, string> {
    const files: Record<string, string> = {};
    for (const block of blocks('dt')) {
        const name = /^\/\/ (\S+\.dt)\n/.exec(block)?.[1];
        expect(name).toBeDefined();
        expect(files[name!]).toBeUndefined();
        files[name!] = block;
    }
    return files;
}

describe('dt guide', () => {
    test('prints docs/guide.md', async () => {
        const out: string[] = [];
        expect(await runCli(['guide'], { out: (l) => out.push(l), err: () => {} })).toBe(0);
        expect(out).toEqual([guide.trimEnd()]);
    });

    test('its DSL examples are one workspace that checks without any diagnostic', async () => {
        const files = workspace();
        expect(Object.keys(files).length).toBeGreaterThan(3);
        const a = await check(files);
        expect(a.diagnostics).toEqual([]);
        expect(a.ok).toBe(true);
    });

    test('its DSL examples use every keyword of the grammar', async () => {
        const grammar = await readFile(path.join(ROOT, 'src', 'language', 'domain.langium'), 'utf8');
        const keywords = new Set([...grammar.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]));
        const examples = blocks('dt').join('\n').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const missing = [...keywords].filter((k) => !new RegExp(`\\b${k}\\b`).test(examples));
        expect(missing).toEqual([]);
    });

    test('its rules table lists every diagnostic code', async () => {
        const source = await readFile(path.join(ROOT, 'src', 'core', 'diagnostics.ts'), 'utf8');
        const union = /export type RuleId =([^;]*);/.exec(source)![1];
        const codes = [...union.matchAll(/'([A-Z0-9]+)'/g)].map((m) => m[1]);
        expect(codes.length).toBeGreaterThan(10);
        for (const code of codes) expect(guide).toContain(`| ${code} |`);
    });

    test('its config example is valid JSONC', () => {
        const [config] = blocks('jsonc');
        expect(parseJsonc(config)).toMatchObject({ sources: expect.any(Array) });
    });

    test('the README links to it and its DSL example checks', async () => {
        expect(readme).toContain('(docs/guide.md)');
        for (const anchor of readme.matchAll(/docs\/guide\.md#([a-z-]+)/g)) {
            const headings = [...guide.matchAll(/^#+ (.+)$/gm)].map((m) => m[1].toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-'));
            expect(headings).toContain(anchor[1]);
        }
        const examples = blocks('dt', readme);
        expect(examples.length).toBeGreaterThan(0);
        for (const [i, text] of examples.entries()) expect((await check({ [`readme-${i}.dt`]: text })).diagnostics).toEqual([]);
    });
});
