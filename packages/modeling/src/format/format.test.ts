import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { FormatError, formatDomain } from './format.js';
import { check, exampleSources } from '../test-helpers.js';

const ROOT = path.join(import.meta.dir, '..', '..', '..', '..');
const guide = await readFile(path.join(ROOT, 'docs', 'guide.md'), 'utf8');

/** The `dt` blocks of the guide, by the file name in their first line. */
const guideFiles = (): Record<string, string> =>
    Object.fromEntries([...guide.matchAll(/^```dt\n([\s\S]*?)^```/gm)].map((m) => [/^\/\/ (\S+\.dt)\n/.exec(m[1])![1], m[1]]));

const shopFiles = async (): Promise<Record<string, string>> =>
    Object.fromEntries((await exampleSources()).filter((s) => s.path.endsWith('.dt')).map((s) => [s.path, s.text]));

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
