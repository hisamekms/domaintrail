// Applies design D's `changes` completion (Modeling's `completeChanges`, which `dt migrate domain` runs on a workspace)
// to the models written in TypeScript template literals and in Markdown `dt` blocks: every outcome lists the
// non-optional fields it makes exist (`f = f` where a parameter of that name exists, else `f`). Each literal or block is
// analyzed alone. Run: `bun scripts/complete-sources.ts [--dry-run] [files...]`.
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { $ } from 'bun';
import { analyzeDomain, completeChanges } from '@domaintrail/modeling';

const ROOT = path.join(import.meta.dir, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args.filter((a) => !a.startsWith('--'));

/** The template literals of a TypeScript source: `[start, end)` of each one's text between the backticks. */
function templateLiterals(src: string): { start: number; end: number }[] {
    const out: { start: number; end: number }[] = [];
    let i = 0;
    let prev = '';
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

/** The text with each `${…}` stood in for by a name, and the parts to put back. */
function probeOf(text: string): { probe: string; parts: string[] } {
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
    return { probe, parts };
}

const WRAP = 'context Sales {\n';

/** A literal without its own `context` is a fragment the test helpers wrap in one (`checkSales`); it is wrapped the same way. */
async function complete(text: string): Promise<{ text: string; count: number }> {
    const wrapped = !/\bcontext\b/.test(text);
    const full = wrapped ? `${WRAP}${text}\n}\n` : text;
    const a = await analyzeDomain([{ path: 'm.dt', text: full }]);
    if (!a.syntaxOk) return { text, count: 0 };
    const done = completeChanges(a)[0];
    if (!done) return { text, count: 0 };
    return { text: wrapped ? done.text.slice(WRAP.length, done.text.length - 3) : done.text, count: done.added.length };
}

const files = only.length
    ? only
    : (await $`git ls-files`.cwd(ROOT).text())
          .split('\n')
          .filter((f) => /\.(ts|tsx|md)$/.test(f) && !f.includes('/generated/') && !f.includes('node_modules') && !f.startsWith('CHANGELOG'));
let total = 0;
for (const f of files) {
    const file = path.join(ROOT, f);
    const src = await readFile(file, 'utf8');
    let out = src;
    let count = 0;
    if (f.endsWith('.md')) {
        const blocks = [...src.matchAll(/(```dt\n)([\s\S]*?)(```)/g)].reverse();
        for (const b of blocks) {
            if (!/\bcommand\b/.test(b[2]!)) continue;
            const m = await complete(b[2]!);
            if (!m.count) continue;
            count += m.count;
            const start = b.index! + b[1]!.length;
            out = out.slice(0, start) + m.text + out.slice(start + b[2]!.length);
        }
    } else {
        for (const { start, end } of templateLiterals(src).reverse()) {
            const text = out.slice(start, end);
            if (!/\bcommand\b/.test(text) || !/\b(context|aggregate)\b/.test(text)) continue;
            const { probe, parts } = probeOf(text);
            const m = await complete(probe.replaceAll('\\`', '`'));
            if (!m.count) continue;
            count += m.count;
            out = out.slice(0, start) + m.text.replaceAll('`', '\\`').replace(/ZzSub(\d+)Zz/g, (_, n: string) => parts[Number(n)]!) + out.slice(end);
        }
    }
    if (!count) continue;
    total += count;
    console.log(`${f}: ${count}`);
    if (!dryRun) await writeFile(file, out);
}
console.log(`${total} outcome(s) ${dryRun ? 'to complete' : 'completed'}.`);
