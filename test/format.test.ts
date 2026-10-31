import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { cliDeps } from '@domaintrail/composition/cli';
import { runCli } from '@domaintrail/presentation/cli/main';
import { loadWorkspace } from '@domaintrail/workspace/infrastructure/files';
import { FormatError, formatDomain } from '@domaintrail/modeling/format/format';
import { EXAMPLES, check, tempCopyOfExamples } from './helpers.js';

const ROOT = path.join(import.meta.dir, '..');
const guide = await readFile(path.join(ROOT, 'docs', 'guide.md'), 'utf8');

/** The `dt` blocks of the guide, by the file name in their first line. */
const guideFiles = (): Record<string, string> =>
    Object.fromEntries([...guide.matchAll(/^```dt\n([\s\S]*?)^```/gm)].map((m) => [/^\/\/ (\S+\.dt)\n/.exec(m[1])![1], m[1]]));

const shopFiles = async (): Promise<Record<string, string>> =>
    Object.fromEntries((await loadWorkspace(EXAMPLES)).filter((s) => s.path.endsWith('.dt')).map((s) => [s.path, s.text]));

/** The Typed Model without the source locations, which formatting moves. */
async function modelOf(files: Record<string, string>): Promise<unknown> {
    const a = await check(files);
    expect(a.syntaxOk).toBe(true);
    const strip = (v: unknown): unknown =>
        Array.isArray(v)
            ? v.map(strip)
            : v && typeof v === 'object'
              ? Object.fromEntries(
                    Object.entries(v)
                        .filter(([k]) => k !== 'location')
                        .map(([k, x]) => [k, strip(x)]),
                )
              : v;
    return strip(a.model);
}

const mapValues = (files: Record<string, string>, f: (text: string) => string) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, f(v)]));

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

describe('formatDomain', () => {
    test('the guide examples and examples/shop are formatted', async () => {
        for (const [name, text] of Object.entries({ ...guideFiles(), ...(await shopFiles()) })) {
            expect(`${name}\n${formatDomain(text)}`).toBe(`${name}\n${text}`);
        }
    });

    test('formatting other whitespace gives the canonical file back, with the same Typed Model', async () => {
        for (const files of [guideFiles(), await shopFiles()]) {
            const scrambled = mapValues(files, scramble);
            expect(scrambled).not.toEqual(files);
            const formatted = mapValues(scrambled, formatDomain);
            expect(formatted).toEqual(files);
            expect(await modelOf(scrambled)).toEqual(await modelOf(formatted));
        }
    });

    test('is idempotent', async () => {
        for (const text of Object.values({ ...guideFiles(), ...(await shopFiles()) })) {
            const once = formatDomain(scramble(text));
            expect(formatDomain(once)).toBe(once);
        }
    });

    test('normalizes [0..1], [1..1], enum and transition commas without changing the model', async () => {
        const input = `context Sales {
  id OrderId: UUID
  enum Kind { A, B "b", C }
  aggregate Order {
    id: OrderId[1..1]
    note: String[0..1]
    tags: String[0..*]
    state Draft { memo: String[0..1] }
    state Placed { memo: String? }
    command touch() Draft -> Draft, Placed -> Placed emits Touched[1..1]
  }
  event Touched { orderId: OrderId }
}
`;
        const out = formatDomain(input);
        expect(out).toBe(`context Sales {
  id OrderId: UUID
  enum Kind { A B "b" C }
  aggregate Order {
    id: OrderId
    note: String?
    tags: String[0..*]
    state Draft {
      memo: String?
    }
    state Placed {
      memo: String?
    }
    command touch()
      Draft -> Draft
      Placed -> Placed
      emits Touched
  }
  event Touched {
    orderId: OrderId
  }
}
`);
        expect((await check({ 'a.dt': input })).diagnostics).toEqual([]);
        expect(await modelOf({ 'a.dt': input })).toEqual(await modelOf({ 'a.dt': out }));
    });

    test('keeps comments in place: on the line of a token, or on lines of their own', () => {
        const input = `// header

/* block
   comment */
context Sales { // trailing the brace
  /// A description.
  id OrderId: UUID /* inline */ // trailing
  // own line


  // after blank lines (kept as one)
  enum Kind { A /* a */ B }
  aggregate Order {
    id: OrderId
    invariant ok { 1 < /* one */ 2 and
      // explained
      2 < 3 }
    command go(
      // the order
      x: Int) emits E
    // at the end
  }
  event E { orderId: OrderId }
}
// trailer
`;
        const out = formatDomain(input);
        expect(out).toBe(`// header

/* block
   comment */
context Sales { // trailing the brace
  /// A description.
  id OrderId: UUID /* inline */ // trailing
  // own line

  // after blank lines (kept as one)
  enum Kind {
    A /* a */
    B
  }
  aggregate Order {
    id: OrderId
    invariant ok {
      1 < /* one */ 2 and
          // explained
          2 < 3
    }
    command go(
        // the order
        x: Int)
      emits E
    // at the end
  }
  event E {
    orderId: OrderId
  }
}
// trailer
`);
        expect(formatDomain(out)).toBe(out);
        expect(formatDomain('context A { // nothing yet\n}')).toBe('context A { // nothing yet\n}\n');
        expect(formatDomain('context A {\n// nothing yet\n}')).toBe('context A {\n  // nothing yet\n}\n');
    });

    test('a short command stays on one line; long lines and expression bodies are broken at clauses and braces', () => {
        const long = 'x'.repeat(100);
        const out = formatDomain(`context S {
  id AId: UUID
  aggregate A {
    id: AId
    n: Int
    state On
    command a()
      On -> On
    command b(${long}: Int) On -> On
    invariant c { n > 0 and n < 1000000000 and n != 5 and n != 7 and n != 11 and n != 13 and n != 17 and n != 19 and n != 23 }
  }
}
`);
        expect(out).toBe(`context S {
  id AId: UUID
  aggregate A {
    id: AId
    n: Int
    state On
    command a() On -> On
    command b(${long}: Int)
      On -> On
    invariant c {
      n > 0 and n < 1000000000 and n != 5 and n != 7 and n != 11 and n != 13 and n != 17 and n != 19 and n != 23
    }
  }
}
`);
    });

    test('leaves string contents and regular expressions untouched; Japanese text counts double for the width', () => {
        const text = `context S {
  primitive P: String { matches(value, "^ a  b\\\\d{2}$") }
}
`;
        expect(formatDomain(text)).toBe(text);
        const label = 'あ'.repeat(50);
        expect(formatDomain(`context S { enum E "${label}" { A "${label}" } }`)).toBe(`context S {\n  enum E "${label}" {\n    A "${label}"\n  }\n}\n`);
    });

    test('refuses a file with syntax errors', () => {
        expect(() => formatDomain('context S { id X UUID }')).toThrow(FormatError);
    });
});

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
