import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parseGuide } from '../src/cli/guide.js';
import { runCli } from '../src/cli/main.js';
import { analyze } from '../src/core/analyze.js';
import { parseJsonc } from '../src/core/config.js';
import { loadWorkspace } from '../src/core/files.js';
import { formatDomain } from '../src/format/format.js';
import { generateTypeScript } from '../src/generator/typescript.js';
import { EXAMPLES, check } from './helpers.js';

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

/** Runs `dt guide …` and returns the exit code with what it printed. */
async function runGuide(...args: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['guide', ...args], { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('dt guide topics', () => {
    const parsed = parseGuide(guide);

    test('--all prints docs/guide.md', async () => {
        expect(await runGuide('--all')).toEqual({ code: 0, out: guide.trimEnd(), err: '' });
    });

    test('every ## and ### heading has a topic, and every topic a unique name and a non-empty section', async () => {
        const headings = guide.replace(/^```[\s\S]*?^```/gm, '').match(/^#{2,3} .+$/gm)!;
        expect(parsed.topics.map((t) => `${'#'.repeat(t.level)} ${t.title}`)).toEqual(headings);
        expect(new Set(parsed.topics.map((t) => t.name)).size).toBe(parsed.topics.length);
        for (const t of parsed.topics) {
            const r = await runGuide(t.name);
            expect(r.code).toBe(0);
            expect(r.out).toBe(t.text);
            expect(r.out.startsWith(`${'#'.repeat(t.level)} ${t.title}\n\n`)).toBe(true);
            expect(r.out.split('\n').length).toBeGreaterThan(2);
            expect(r.out).not.toContain('<!-- topic:');
        }
    });

    test('a ## topic includes its ### topics, a ### topic only itself', async () => {
        const dsl = (await runGuide('dsl')).out;
        expect(dsl).toContain('### Command requirements');
        expect(dsl).not.toContain('## Generated TypeScript');
        const requires = (await runGuide('requires')).out;
        expect(requires).not.toContain('### Command changes');
    });

    test('without a topic, prints the intro, the quick reference and the list of topics, about one screen', async () => {
        const r = await runGuide();
        expect(r.code).toBe(0);
        expect(r.out.startsWith(parsed.intro)).toBe(true);
        expect(r.out).toContain(parsed.topics.find((t) => t.name === 'quick')!.text);
        for (const t of parsed.topics) expect(r.out).toMatch(new RegExp(`^ +${t.name} +`, 'm'));
        expect(r.out.split('\n').length).toBeLessThanOrEqual(150);
    });

    test('the quick reference example is a file that checks without any diagnostic and is formatted', async () => {
        const quick = parsed.topics.find((t) => t.name === 'quick')!.text;
        const [example] = blocks('dt', quick);
        expect(example).toContain('aggregate');
        const a = await check({ 'library/loan.dt': example });
        expect(a.diagnostics).toEqual([]);
        expect(formatDomain(example)).toBe(example);
    });

    test('an unknown topic is an error with a suggestion and the topics', async () => {
        const r = await runGuide('requries');
        expect(r.code).toBe(1);
        expect(r.out).toBe('');
        expect(r.err).toContain("did you mean 'requires'?");
        expect(r.err).toContain('workflow, layout, dsl');
        expect((await runGuide('requires', '--all')).code).toBe(1);
    });

    test('a rule code prints its row of the rules table and the topics that explain it', async () => {
        const r = await runGuide('m010');
        expect(r.code).toBe(0);
        expect(r.out).toContain('| M010 | state-specific fields');
        expect(r.out).toContain('`dt guide requires`');
        const m022 = await runGuide('M022');
        expect(m022.out).toContain('| M022 | (warning) a field of an event or error');
        expect(m022.out).toContain('Explained in: `dt guide requires`, `dt guide events`, `dt guide verified`.');
    });
});

describe('dt guide', () => {
    test('its DSL examples are one workspace that checks without any diagnostic', async () => {
        const files = workspace();
        expect(Object.keys(files).length).toBeGreaterThan(3);
        const a = await check(files);
        expect(a.diagnostics).toEqual([]);
        expect(a.ok).toBe(true);
    });

    test('its DSL examples are formatted', () => {
        for (const block of blocks('dt')) expect(formatDomain(block)).toBe(block);
    });

    test('its DSL examples use every keyword of the grammar', async () => {
        const grammar = await readFile(path.join(ROOT, 'src', 'language', 'domain.langium'), 'utf8');
        const keywords = new Set([...grammar.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]));
        const examples = blocks('dt')
            .join('\n')
            .replace(/\/\/.*$/gm, '')
            .replace(/\/\*[\s\S]*?\*\//g, '');
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

    test('its TypeScript files type-check against the code generated for examples/shop', async () => {
        // blocks that start with `// src/<file>.ts` are files of the user's code
        const files = blocks('ts').flatMap((b) => {
            const name = /^\/\/ (src\/\S+\.ts)/.exec(b)?.[1];
            return name ? [[name, b] as const] : [];
        });
        expect(files.map(([n]) => n)).toEqual(expect.arrayContaining(['src/stored.ts', 'src/meta-by-event.ts']));
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-guide-'));
        try {
            const a = await analyze(await loadWorkspace(EXAMPLES));
            await mkdir(path.join(dir, 'generated', 'domain'), { recursive: true });
            for (const f of generateTypeScript(a.model!)) await writeFile(path.join(dir, 'generated', 'domain', f.path), f.content);
            await mkdir(path.join(dir, 'src'));
            for (const [name, text] of files) await writeFile(path.join(dir, name), text);
            const tsc = path.join(ROOT, 'node_modules', '.bin', 'tsc');
            const flags = ['--noEmit', '--strict', '--target', 'ES2023', '--module', 'preserve', '--moduleResolution', 'bundler', '--lib', 'ES2023,DOM'];
            const r = Bun.spawnSync([process.execPath, tsc, ...flags, ...files.map(([n]) => n)], { cwd: dir });
            expect(r.stdout.toString() + r.stderr.toString()).toBe('');
            expect(r.exitCode).toBe(0);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('its blocks that name a file of examples/shop show that file', async () => {
        const quoted = blocks('ts').filter((b) => b.startsWith('// examples/shop/'));
        expect(quoted.length).toBeGreaterThan(0);
        for (const b of quoted) {
            const [first, ...rest] = b.split('\n');
            const file = await readFile(path.join(ROOT, first.slice(3)), 'utf8');
            expect(file).toContain(rest.join('\n').trim());
        }
    });

    test('its config example is valid JSONC', () => {
        const config = blocks('jsonc').find((b) => b.includes('"sources"')) ?? '';
        expect(parseJsonc(config)).toMatchObject({ sources: expect.any(Array) });
    });

    test('its JSON output example has the properties of the schema', async () => {
        const schema = JSON.parse(await readFile(path.join(ROOT, 'schema', 'diagnostics.schema.json'), 'utf8'));
        const [example] = blocks('json');
        const report = JSON.parse(example);
        expect(Object.keys(report)).toEqual(Object.keys(schema.properties).filter((k) => k in report));
        const diagnostic = schema.definitions.diagnostic;
        for (const d of report.diagnostics) {
            for (const key of diagnostic.required) expect(d).toHaveProperty(key);
            for (const key of Object.keys(d)) expect(Object.keys(diagnostic.properties)).toContain(key);
        }
    });

    test('the README links to it and its DSL example checks', async () => {
        expect(readme).toContain('(docs/guide.md)');
        for (const anchor of readme.matchAll(/docs\/guide\.md#([a-z-]+)/g)) {
            const headings = [...guide.matchAll(/^#+ (.+)$/gm)].map((m) =>
                m[1]
                    .toLowerCase()
                    .replace(/[^a-z0-9 -]/g, '')
                    .replace(/ /g, '-'),
            );
            expect(headings).toContain(anchor[1]);
        }
        const examples = blocks('dt', readme);
        expect(examples.length).toBeGreaterThan(0);
        for (const [i, text] of examples.entries()) expect((await check({ [`readme-${i}.dt`]: text })).diagnostics).toEqual([]);
    });
});
