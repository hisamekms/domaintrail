import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { formatStorming } from '@domaintrail/modeling/storming/format';
import { parseStormings } from '@domaintrail/modeling/storming/parse';
import { FormatError } from '@domaintrail/modeling/format/format';

const SAMPLE = await readFile(path.join(import.meta.dir, 'fixtures', 'dtes', 'delivery-cancellation.dtes'), 'utf8');

const lines = (...ls: string[]) => `${ls.join('\n')}\n`;

/** The stormings as parsed, without the source ranges (formatting moves them). */
async function irOf(text: string): Promise<unknown> {
    const r = await parseStormings([{ path: 'a.dtes', text }]);
    expect(r.syntaxOk).toBe(true);
    const strip = (v: unknown): unknown =>
        Array.isArray(v)
            ? v.map(strip)
            : v && typeof v === 'object'
              ? Object.fromEntries(
                    Object.entries(v)
                        .filter(([k]) => !k.endsWith('ange'))
                        .map(([k, x]) => [k, strip(x)]),
                )
              : v;
    return strip(r.stormings);
}

/** The same file squeezed onto as few lines as comments allow, with odd spacing. */
const squeeze = (text: string): string =>
    text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '')
        .map((l) => (l.includes('//') ? `${l}\n` : `${l}   `))
        .join('');

const MESSY = lines(
    '// A storming of deliveries.',
    'storming  A "a"{',
    '',
    '',
    ' /// When it is cancelled.',
    '    event E "e" {}',
    '  event F { }  event G',
    ' command C { ref X . Y.target // the .dt command',
    ' actor P',
    '',
    '',
    ' emits E emits F }',
    '',
    '',
    ' timeline T { E group G2 "g" { E',
    ' F } /* after the group */ G }',
    ' hotspot H "q?" {',
    '   // undecided',
    ' }',
    '  policy Q { on E issues C',
    '  }',
    '',
    '}',
    'storming B {} // empty',
);

describe('formatStorming', () => {
    test('the spec sample is already canonical', () => {
        expect(formatStorming(SAMPLE)).toBe(SAMPLE);
    });

    test('the canonical layout: 2 spaces, one element, clause, step and group event per line', () => {
        expect(formatStorming(MESSY)).toBe(
            lines(
                '// A storming of deliveries.',
                'storming A "a" {',
                '  /// When it is cancelled.',
                '  event E "e"',
                '  event F',
                '  event G',
                '  command C {',
                '    ref X.Y.target // the .dt command',
                '    actor P',
                '',
                '    emits E',
                '    emits F',
                '  }',
                '',
                '  timeline T {',
                '    E',
                '    group G2 "g" {',
                '      E',
                '      F',
                '    } /* after the group */',
                '    G',
                '  }',
                '  hotspot H "q?" {',
                '    // undecided',
                '  }',
                '  policy Q {',
                '    on E',
                '    issues C',
                '  }',
                '}',
                '',
                'storming B {} // empty',
            ),
        );
    });

    test('idempotent: format(format(x)) == format(x)', () => {
        for (const text of [SAMPLE, MESSY, squeeze(SAMPLE), squeeze(MESSY), '', '// only a comment\n', 'storming S {}']) {
            const once = formatStorming(text);
            expect(formatStorming(once)).toBe(once);
        }
    });

    test('whitespace other than blank lines does not matter: the squeezed sample formats back to the sample', () => {
        expect(formatStorming(squeeze(SAMPLE))).toBe(SAMPLE.replaceAll('\n\n', '\n'));
    });

    test('the stormings are unchanged, labels, docs and clauses included', async () => {
        for (const text of [SAMPLE, MESSY]) expect(await irOf(formatStorming(text))).toEqual(await irOf(text));
    });

    test('every comment is kept, in order', () => {
        const comments = (t: string) => t.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) ?? [];
        expect(comments(formatStorming(MESSY))).toEqual(comments(MESSY));
    });

    test('blank lines: up to one between members, none after `{` or before `}`, one between stormings', () => {
        expect(formatStorming('storming A {\n\n\n  event E\n\n\n\n  event F\n\n}\nstorming B {\n}\n')).toBe(
            lines('storming A {', '  event E', '', '  event F', '}', '', 'storming B {}'),
        );
    });

    test('an empty body is dropped unless it holds a comment', () => {
        expect(formatStorming('storming S { command C {} hotspot H { /* ? */ } }')).toBe(
            lines('storming S {', '  command C', '  hotspot H { /* ? */', '  }', '}'),
        );
    });

    test('invalid but well-formed files are formatted (validation is not the formatter’s)', () => {
        expect(formatStorming('storming S { policy P { target Nowhere target Nowhere ref A.B } timeline T { P } }')).toBe(
            lines('storming S {', '  policy P {', '    target Nowhere', '    target Nowhere', '    ref A.B', '  }', '  timeline T {', '    P', '  }', '}'),
        );
    });

    test('a syntax error throws FormatError', () => {
        expect(() => formatStorming('storming S { event }')).toThrow(FormatError);
        expect(() => formatStorming('storming S { timeline T { ref A.B } }')).toThrow(FormatError);
        expect(() => formatStorming('storming S { event E "x }')).toThrow(FormatError);
    });
});
