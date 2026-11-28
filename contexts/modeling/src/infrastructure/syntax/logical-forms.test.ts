// The transitional grammar of Phase 2: `&&`, `||` and `!` parse to the same model as `and`, `or` and `not`.
import { expect, test } from 'bun:test';
import { analyzeDomain } from '../../application/analyze.js';

const model = (expr: string) => `context L { value V { a: Int  b: Int  invariant r { ${expr} } } }`;

async function typed(expr: string) {
    const a = await analyzeDomain([{ path: 'l.dt', text: model(expr) }]);
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const v = a.model!.elements.find((e) => e.name === 'V')!;
    return 'invariants' in v ? v.invariants[0].expr : undefined;
}

test.each([
    ['a > 0 and b > 0', 'a > 0 && b > 0'],
    ['a > 0 or b > 0', 'a > 0 || b > 0'],
    ['not (a > 0)', '!(a > 0)'],
    ['a > 0 and b > 0 or not (a == b)', 'a > 0 && b > 0 || !(a == b)'],
    ['a != b', 'a != b'],
])('%s and %s give the same expression', async (old, next) => {
    expect(await typed(next)).toEqual(await typed(old));
});
