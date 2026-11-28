// Phase 2's logical operators: `&&`, `||` and `!`. The old `and`, `or`, `not` and `implies` parse only so that
// `dt migrate domain` can rewrite them; `dt check` reports each one as an error.
import { expect, test } from 'bun:test';
import { analyzeDomain } from '../../application/analyze.js';
import { formatDomain } from './format.js';

const model = (expr: string) => `context L { value V { a: Int  b: Int  p: Bool  invariant r { ${expr} } } }`;

test('the new operators check without diagnostics', async () => {
    const a = await analyzeDomain([{ path: 'l.dt', text: model('a > 0 && b > 0 || !(a == b) || !p') }]);
    expect(a.diagnostics).toEqual([]);
});

test('each old spelling is an error that names its replacement and the migration', async () => {
    const a = await analyzeDomain([{ path: 'l.dt', text: model('a > 0 and b > 0 or not p implies p') }]);
    expect(a.diagnostics.map((d) => [d.code, d.start.column, d.message, d.hint])).toEqual([
        ['SYNTAX', 68, "'and' is no longer DomainTrail syntax: write &&.", '`dt migrate domain` rewrites every file'],
        ['SYNTAX', 78, "'or' is no longer DomainTrail syntax: write ||.", '`dt migrate domain` rewrites every file'],
        ['SYNTAX', 81, "'not' is no longer DomainTrail syntax: write !.", '`dt migrate domain` rewrites every file'],
        ['SYNTAX', 87, "'implies' is no longer DomainTrail syntax: write !(p) || q.", '`dt migrate domain` rewrites every file'],
    ]);
});

test('`!` is written next to its operand, in the source text and by `dt fmt`', async () => {
    const a = await analyzeDomain([{ path: 'l.dt', text: model('! (a > 0) || ! p') }]);
    const v = a.model!.elements.find((e) => e.name === 'V')!;
    expect('invariants' in v ? v.invariants[0].source : '').toBe('!(a > 0) || !p');
    expect(formatDomain(model('! (a > 0) || ! p'))).toContain('{ !(a > 0) || !p }');
});
