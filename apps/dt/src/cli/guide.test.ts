// dt guide's topics: docs/guide.md split by its headings, and what the command prints (the guide's examples:
// test/guide.test.ts).
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { formatDomain } from '@domaintrail/modeling';
import { parseGuide } from './guide.js';
import { runCli } from './main.js';
import type { CliDeps } from './ports.js';
import { check } from '../test-helpers.js';

const guide = await readFile(path.join(import.meta.dir, '..', '..', '..', '..', 'docs', 'guide.md'), 'utf8');

/** Contents of the code blocks in a language of a Markdown text (the guide by default). */
const blocks = (lang: string, markdown = guide): string[] => [...markdown.matchAll(new RegExp('^```' + lang + '\\n([\\s\\S]*?)^```', 'gm'))].map((m) => m[1]);

/** Runs `dt guide …` and returns the exit code with what it printed (the guide needs none of the CLI's adapters). */
async function runGuide(...args: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['guide', ...args], { out: (l) => out.push(l), err: (l) => err.push(l) }, {} as CliDeps);
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
        expect(r.out.split('\n').length).toBeLessThanOrEqual(160);
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
