// Applies `dt migrate domain` (Modeling's `migrateDomain`) to every DomainTrail model in this repository during the
// Phase 2 language revision: the `.dt` files, the ```dt blocks of Markdown, and the models written as template
// literals in TypeScript (test fixtures, `dt guide` templates). A template literal is migrated when it is a whole model
// (it parses, with each `${…}` stood in for by a name); the others are listed for review when they hold an old operator
// word. Run: `bun scripts/migrate-sources.ts [--dry-run]`.
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { $ } from 'bun';
import { migrateDomain } from '@domaintrail/modeling';

const ROOT = path.join(import.meta.dir, '..');
const dryRun = process.argv.includes('--dry-run');
const OLD = /\b(and|or|not|implies)\b/;

/** The template literals of a TypeScript source: `[start, end)` of each one's text between the backticks. */
function templateLiterals(src: string): { start: number; end: number }[] {
    const out: { start: number; end: number }[] = [];
    let i = 0;
    let prev = ''; // the last significant character, to tell a regex literal from a division
    const skipString = (q: string): void => {
        for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++;
        i++;
    };
    const skipTemplate = (): void => {
        const start = ++i;
        while (i < src.length && src[i] !== '`') {
            if (src[i] === '\\') i += 2;
            else if (src[i] === '$' && src[i + 1] === '{') {
                i += 2;
                skipCode('}');
            } else i++;
        }
        out.push({ start, end: i });
        i++;
    };
    const skipCode = (until?: string): void => {
        let depth = 0;
        while (i < src.length) {
            const c = src[i];
            if (until && c === until && depth === 0) {
                i++;
                return;
            }
            if (c === '{') depth++;
            if (c === '}') depth--;
            if (c === '/' && src[i + 1] === '/') {
                while (i < src.length && src[i] !== '\n') i++;
                continue;
            }
            if (c === '/' && src[i + 1] === '*') {
                i = src.indexOf('*/', i + 2) + 2;
                continue;
            }
            if (c === "'" || c === '"') {
                skipString(c);
                prev = 'a';
                continue;
            }
            if (c === '`') {
                skipTemplate();
                prev = 'a';
                continue;
            }
            if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]|^$/.test(prev)) {
                for (i++; i < src.length && src[i] !== '/'; i++) {
                    if (src[i] === '\\') i++;
                    else if (src[i] === '[') while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1;
                }
                i++;
                prev = 'a';
                continue;
            }
            if (!/\s/.test(c)) prev = c;
            i++;
        }
    };
    skipCode();
    return out;
}

/** Migrates one template literal's text; `${…}` parts are kept verbatim. */
function migrateTemplate(text: string): { text: string; count: number } | undefined {
    const parts: string[] = [];
    let probe = '';
    for (let i = 0; i < text.length;) {
        if (text[i] === '$' && text[i + 1] === '{') {
            let depth = 0;
            let j = i;
            for (; j < text.length; j++) {
                if (text[j] === '{') depth++;
                if (text[j] === '}' && --depth === 0) break;
            }
            parts.push(text.slice(i, j + 1));
            probe += `ZzSub${parts.length - 1}Zz`;
            i = j + 1;
        } else probe += text[i++];
    }
    if (!/\bcontext\b/.test(probe)) return undefined;
    const m = migrateDomain(probe.replaceAll('\\`', '`'));
    if (!m.parsed || !m.rewrites.length) return m.parsed ? { text, count: 0 } : undefined;
    const back = m.text.replaceAll('`', '\\`').replace(/ZzSub(\d+)Zz/g, (_, n: string) => parts[Number(n)]);
    return { text: back, count: m.rewrites.length };
}

// sources that are about the old syntax itself
const KEEP = new Set(['contexts/modeling/src/infrastructure/syntax/migrate.test.ts', 'contexts/modeling/src/infrastructure/syntax/logical-forms.test.ts']);
const files = (await $`git ls-files`.cwd(ROOT).text())
    .split('\n')
    .filter((f) => f && !f.includes('/generated/') && !f.includes('node_modules') && !KEEP.has(f) && !f.startsWith('CHANGELOG'));
let total = 0;
const review: string[] = [];
for (const f of files) {
    const file = path.join(ROOT, f);
    const src = await readFile(file, 'utf8');
    let out = src;
    let count = 0;
    if (f.endsWith('.dt')) {
        const m = migrateDomain(src);
        if (!m.parsed) review.push(`${f}: does not parse`);
        out = m.text;
        count = m.rewrites.length;
    } else if (f.endsWith('.md')) {
        out = src.replace(/(```dt\n)([\s\S]*?)(```)/g, (whole, open: string, body: string, close: string) => {
            const m = migrateDomain(body);
            if (!m.parsed) {
                if (OLD.test(body)) review.push(`${f}: a dt block does not parse alone`);
                return whole;
            }
            count += m.rewrites.length;
            return open + m.text + close;
        });
    } else if (/\.(ts|tsx)$/.test(f)) {
        const lits = templateLiterals(src);
        for (const { start, end } of lits.reverse()) {
            const text = out.slice(start, end);
            if (!OLD.test(text)) continue;
            const m = migrateTemplate(text);
            if (!m) {
                if (/\bcontext\b/.test(text)) review.push(`${f}:${out.slice(0, start).split('\n').length}: a model literal that does not parse`);
                continue;
            }
            count += m.count;
            out = out.slice(0, start) + m.text + out.slice(end);
        }
    } else continue;
    if (!count) continue;
    total += count;
    console.log(`${f}: ${count}`);
    if (!dryRun) await writeFile(file, out);
}
console.log(`${total} construct(s) ${dryRun ? 'to rewrite' : 'rewritten'}.`);
if (review.length) console.log(`\nTo review by hand (${review.length}):\n${review.join('\n')}`);
