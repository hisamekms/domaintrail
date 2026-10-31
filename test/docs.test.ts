import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps } from '@domaintrail/composition/cli';
import { runCli } from '@domaintrail/presentation/cli/main';
import { parseJsonc } from '@domaintrail/modeling/core/config';
import { formatStorming } from '@domaintrail/modeling/storming/format';
import { formatDomain } from '@domaintrail/modeling/format/format';
import { check } from './helpers.js';

const ROOT = path.join(import.meta.dir, '..');
const read = (file: string) => readFile(path.join(ROOT, file), 'utf8');
const EN = 'docs/getting-started.md';
const JA = 'docs/getting-started.ja.md';
const pages = { [EN]: await read(EN), [JA]: await read(JA) };

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

interface Block {
    lang: string;
    text: string;
}

/** The fenced code blocks of a Markdown text, in order. */
const codeBlocks = (markdown: string): Block[] => [...markdown.matchAll(/^```(\S*)\n([\s\S]*?)^```/gm)].map((m) => ({ lang: m[1], text: m[2] }));
const blocksOf = (markdown: string, lang: string): string[] =>
    codeBlocks(markdown)
        .filter((b) => b.lang === lang)
        .map((b) => b.text);

/** The `##` / `###` headings outside code blocks, as `## Title`. */
const headings = (markdown: string): string[] => markdown.replace(/^```[\s\S]*?^```/gm, '').match(/^#{2,3} .+$/gm) ?? [];

/**
 * A code block with its comments left out: a page may translate the comments of its code, nothing else. A first line
 * that names a file (`// src/x.ts`) is kept.
 */
const withoutComments = (text: string): string =>
    text
        .split('\n')
        .map((line, i) => (i === 0 && /^\/\/ \S+$/.test(line) ? line : line.replace(/(^|\s+)(\/\/|#) .*$/, '').replace(/^(\s*)\/\*\*.*\*\/$/, '$1')))
        .join('\n');

/** The anchor GitHub gives a heading: lower case, without punctuation, spaces as hyphens (other scripts kept). */
const slug = (heading: string): string =>
    heading
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-');

/** The anchors of a Markdown file's headings, with GitHub's `-1`, `-2` … for repeated ones. */
function anchors(markdown: string): Set<string> {
    const seen = new Map<string, number>();
    const result = new Set<string>();
    for (const [, title] of markdown.replace(/^```[\s\S]*?^```/gm, '').matchAll(/^#{1,6} (.+)$/gm)) {
        const base = slug(title);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        result.add(n === 0 ? base : `${base}-${n}`);
    }
    return result;
}

describe('getting started', () => {
    for (const [file, page] of Object.entries(pages)) {
        test(`${file}: each dt block is the next version of a file of one workspace that checks without any diagnostic and is formatted`, async () => {
            const files: Record<string, string> = {};
            const blocks = blocksOf(page, 'dt');
            expect(blocks.length).toBeGreaterThanOrEqual(4);
            for (const block of blocks) {
                const name = /^\/\/ (\S+\.dt)\n/.exec(block)?.[1];
                expect(name).toBeDefined();
                files[name!] = block;
                expect((await check(files)).diagnostics).toEqual([]);
                expect(formatDomain(block)).toBe(block);
            }
        });

        test(`${file}: its storming checks without any diagnostic against the last model, and is formatted`, async () => {
            const [storming, ...more] = blocksOf(page, 'dtes');
            expect(more).toEqual([]);
            const name = /^\/\/ (\S+\.dtes)\n/.exec(storming!)![1]!;
            expect(formatStorming(storming!)).toBe(storming!);
            const a = await check({ 'domain/booking/reservation.dt': blocksOf(page, 'dt').at(-1)!, [name]: storming! });
            expect(a.diagnostics).toEqual([]);
            expect(a.stormings.stormings.map((s) => s.id)).toEqual(['RoomBooking']);
        });

        test(`${file}: its JSONC blocks are valid`, () => {
            const blocks = blocksOf(page, 'jsonc');
            expect(blocks.length).toBeGreaterThan(0);
            for (const block of blocks) expect(parseJsonc(block)).toBeInstanceOf(Object);
        });
    }

    test('the Japanese page has the headings of the English one, level by level', () => {
        const levels = (markdown: string) => headings(markdown).map((h) => h.split(' ')[0]);
        expect(levels(pages[JA])).toEqual(levels(pages[EN]));
        expect(headings(pages[EN]).length).toBeGreaterThan(10);
    });

    test('the Japanese page has the code blocks of the English one, its comments aside', () => {
        const normalized = (markdown: string) => codeBlocks(markdown).map((b) => ({ lang: b.lang, text: withoutComments(b.text) }));
        expect(normalized(pages[JA])).toEqual(normalized(pages[EN]));
        // the dt blocks are the same, comments included
        expect(blocksOf(pages[JA], 'dt')).toEqual(blocksOf(pages[EN], 'dt'));
    });

    test('its blocks that name a file of examples/shop show that file', async () => {
        const quoted = blocksOf(pages[EN], 'ts').filter((b) => b.startsWith('// examples/shop/'));
        expect(quoted.length).toBeGreaterThan(0);
        for (const b of quoted) {
            const [first, ...rest] = b.split('\n');
            expect(await read(first.slice(3))).toContain(rest.join('\n').trim());
        }
    });

    test('its model, config and code generate, type-check and pass the generated contract tests', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-getting-started-'));
        dirs.push(dir);
        await symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
        const page = pages[EN];
        // the last version of the model, and the config with `generate`, run with bun:test instead of vitest
        const model = blocksOf(page, 'dt').at(-1)!;
        const config = blocksOf(page, 'jsonc').find((b) => b.includes('"generate"'))!;
        expect(config).toContain('"runner": "vitest"');
        await mkdir(path.join(dir, 'domain', 'booking'), { recursive: true });
        await writeFile(path.join(dir, 'domain', 'booking', 'reservation.dt'), model);
        await writeFile(path.join(dir, 'domaintrail.jsonc'), config.replace('"runner": "vitest"', '"runner": "bun"'));
        await writeFile(
            path.join(dir, '.oxlintrc.json'),
            blocksOf(page, 'jsonc').find((b) => b.startsWith('// .oxlintrc.json'))!,
        );
        const out: string[] = [];
        expect(await runCli(['-r', dir, 'generate', 'ts'], { out: (l) => out.push(l), err: (l) => out.push(l) }, cliDeps())).toBe(0);
        // the page's lint config takes away the hint
        expect(out).toEqual(['1 file(s) checked: 0 error(s), 0 warning(s).', expect.stringMatching(/^TypeScript written to .*generated\/domain\/tests$/)]);

        const files = blocksOf(page, 'ts').flatMap((b) => {
            const name = /^\/\/ (src\/\S+\.ts)\n/.exec(b)?.[1];
            return name ? [[name, b] as const] : [];
        });
        expect(files.map(([n]) => n)).toEqual(['src/reservation-commands.ts', 'src/request.ts', 'src/contract.test.ts']);
        await mkdir(path.join(dir, 'src'));
        for (const [name, text] of files) await writeFile(path.join(dir, name), text);
        await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
        await writeFile(
            path.join(dir, 'tsconfig.json'),
            blocksOf(page, 'jsonc').find((b) => b.startsWith('// tsconfig.json'))!,
        );

        // with the page's tsconfig.json; the types of bun:test for the bun runner, which vitest would not need
        const tsc = Bun.spawnSync([process.execPath, path.join(ROOT, 'node_modules', '.bin', 'tsc'), '-p', dir, '--types', 'bun']);
        expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe('');
        expect(tsc.exitCode).toBe(0);
        const r = Bun.spawnSync([process.execPath, 'test'], { cwd: dir });
        const output = r.stdout.toString() + r.stderr.toString();
        expect(output).toContain(' 6 pass');
        expect(output).toContain(' 0 fail');
        expect(r.exitCode).toBe(0);
    }, 30_000);
});

describe('documentation links', () => {
    const FILES = ['README.md', 'CONTRIBUTING.md', EN, JA, 'docs/guide.md', 'docs/live-view.md', 'docs/session-access.md', 'CHANGELOG.md', 'CHANGELOG.ja.md'];

    for (const file of FILES) {
        test(`the relative links of ${file} resolve to files and headings`, async () => {
            const text = (await read(file)).replace(/^```[\s\S]*?^```/gm, '');
            const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((l) => !/^[a-z]+:/.test(l));
            expect(links.length).toBeGreaterThan(0);
            for (const link of links) {
                const [target, anchor] = link.split('#');
                const resolved = target ? path.join(path.dirname(path.join(ROOT, file)), target) : path.join(ROOT, file);
                const exists = await stat(resolved).then(
                    () => true,
                    () => false,
                );
                expect({ link, exists }).toEqual({ link, exists: true });
                if (anchor !== undefined) {
                    expect(resolved.endsWith('.md')).toBe(true);
                    expect({ link, anchor: anchors(await readFile(resolved, 'utf8')).has(anchor) }).toEqual({ link, anchor: true });
                }
            }
        });
    }

    test('the README links to the pages for people starting out', async () => {
        const readme = await read('README.md');
        for (const link of ['docs/getting-started.md', 'docs/getting-started.ja.md', 'docs/guide.md', 'examples/shop/README.md', 'CONTRIBUTING.md']) {
            expect(readme).toContain(`(${link})`);
        }
        expect(readme.split('\n').length).toBeLessThanOrEqual(110);
    });
});
