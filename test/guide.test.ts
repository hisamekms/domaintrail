import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DEFAULT_AGENT_TOOLS } from '@domaintrail/agent';
import { formatDomain } from '@domaintrail/modeling';
import { formatStorming } from '@domaintrail/storming';
import { generateTypeScript } from '@domaintrail/generation';
import { analyze, sourceSelection } from '@domaintrail/analysis';
import { resolveConfig } from '@domaintrail/dt';
import { loadWorkspace } from '@domaintrail/workspace';
import { EXAMPLES, check } from './helpers.js';

const ROOT = path.join(import.meta.dir, '..');
const guide = await readFile(path.join(ROOT, 'docs', 'guide.md'), 'utf8');
const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8');

/** Contents of the code blocks in a language of a Markdown text (the guide by default). */
const blocks = (lang: string, markdown = guide): string[] => [...markdown.matchAll(new RegExp('^```' + lang + '\\n([\\s\\S]*?)^```', 'gm'))].map((m) => m[1]);

/** The `dt` blocks as files of one workspace, named by their first line (`// sales/order.dt`). */
/** Every rule ID, as its owners declare them: Modeling's (`ModelingRuleId`, generated from its `.dt`) and Storming's (`StormingRuleId`), joined. */
async function ruleIds(): Promise<string> {
    const union = async (file: string[], name: string): Promise<string> =>
        new RegExp(`export type ${name} =([^;]*);`).exec(await readFile(path.join(ROOT, ...file), 'utf8'))![1];
    return [
        await union(['contexts', 'modeling', 'src', 'generated', 'Modeling.ts'], 'ModelingRuleId'),
        await union(['contexts', 'storming', 'src', 'domain', 'rule-ids.ts'], 'StormingRuleId'),
    ].join('');
}

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
        const grammar = await readFile(path.join(ROOT, 'contexts', 'modeling', 'src', 'infrastructure', 'syntax', 'domain.langium'), 'utf8');
        const keywords = new Set([...grammar.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]));
        const examples = blocks('dt')
            .join('\n')
            .replace(/\/\/.*$/gm, '')
            .replace(/\/\*[\s\S]*?\*\//g, '');
        const missing = [...keywords].filter((k) => !new RegExp(`\\b${k}\\b`).test(examples));
        expect(missing).toEqual([]);
    });

    test('its storming examples are files of the workspace that check without any diagnostic, and are formatted', async () => {
        const stormings = blocks('dtes').filter((b) => /^\/\/ \S+\.dtes\n/.test(b));
        expect(stormings.length).toBeGreaterThan(0);
        const files = { ...workspace() };
        for (const block of stormings) {
            expect(formatStorming(block)).toBe(block);
            files[/^\/\/ (\S+\.dtes)\n/.exec(block)![1]!] = block;
        }
        const a = await check(files);
        expect(a.diagnostics).toEqual([]);
        expect(a.stormings.stormings.length).toBe(stormings.length);
    });

    test('its storming examples use every keyword of the .dtes grammar, but the relations ADR 0032 removed', async () => {
        const grammar = await readFile(path.join(ROOT, 'contexts', 'storming', 'src', 'infrastructure', 'syntax', 'storming.langium'), 'utf8');
        // `target` is parsed only to be reported (S023); `actor` is still the keyword of the element
        const keywords = new Set([...grammar.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]).filter((k) => k !== 'target'));
        const examples = blocks('dtes')
            .filter((b) => /^\/\/ \S+\.dtes\n/.test(b))
            .join('\n')
            .replace(/\/\/.*$/gm, '');
        expect([...keywords].filter((k) => !new RegExp(`\\b${k}\\b`).test(examples))).toEqual([]);
    });

    test('each S rule has an example storming that reports it and nothing else (infos aside) against the workspace, formatted', async () => {
        const rules = [...(await ruleIds()).matchAll(/'(S\d{3})'/g)].map((m) => m[1]);
        const examples = blocks('dtes').flatMap((b) => {
            const code = /^\/\/ (S\d{3})\n/.exec(b)?.[1];
            return code ? [[code, b] as const] : [];
        });
        expect(examples.map(([code]) => code)).toEqual(rules);
        for (const [code, block] of examples) {
            expect(formatStorming(block)).toBe(block);
            const a = await check({ ...workspace(), 'example.dtes': block });
            // an info (S029) informs about the rest of a one-problem example: only its own rule counts
            const found = a.diagnostics.filter((d) => d.code === code || d.severity !== 'info');
            expect({ code, found: [...new Set(found.map((d): string => d.code))] }).toEqual({ code, found: [code] });
        }
    });

    test('its rules table lists every diagnostic code', async () => {
        const codes = [...new Set([...(await ruleIds()).matchAll(/'([A-Z0-9]+)'/g)].map((m) => m[1]))];
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
            const a = await analyze(await loadWorkspace(EXAMPLES, sourceSelection()));
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
        expect(resolveConfig(config, path.join(ROOT, 'domaintrail.jsonc'))).toMatchObject({ sources: expect.any(Array) });
    });

    test('its session config example is a valid config, with the defaults it says', () => {
        const example = blocks('jsonc').find((b) => b.includes('"collab"'))!;
        const file = path.join(ROOT, 'domaintrail.jsonc');
        const { open, collab, agent, classifier } = resolveConfig(example, file);
        const defaults = resolveConfig('{}', file);
        expect(open).toEqual(defaults.open);
        expect({ ...collab, access: undefined }).toEqual({ ...defaults.collab, access: undefined });
        expect(agent).toEqual(defaults.agent);
        expect(classifier).toEqual(defaults.classifier);
        expect(agent.run.allowedTools).toEqual([...DEFAULT_AGENT_TOOLS]);
        expect(collab.access).toMatchObject({ acceptCookie: false, avatarHosts: [] });
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
