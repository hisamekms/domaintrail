// The generated checks of Phase 2's method forms: `.length` counts the code points of a string and the elements of a
// list, by the operand's type in the Semantic IR.
import { expect, test } from 'bun:test';
import { check, generateFromAnalysis } from '../test-helpers.js';

test('`.length` of a string counts code points, of a list its elements; method forms compile as their functions', async () => {
    const a = await check({
        'm.dt': `context M {
  value V {
    s: String
    xs: Int[0..*]
    invariant sizes { s.length <= 8 && xs.length > 0 }
    invariant methods { xs.every(x => x > 0) && xs.some(x => x > 1) && xs.includes(2) && xs.unique() && s.matches("^a") }
  }
}`,
    });
    expect(a.diagnostics).toEqual([]);
    const ts = generateFromAnalysis(a).find((f) => f.path === 'M.ts')!.content;
    expect(ts).toContain("if (!((Array.from(v.s).length <= 8) && (v.xs.length > 0))) violated.push('sizes');");
    expect(ts).toContain('v.xs.every((x) => x > 0) && v.xs.some((x) => x > 1)) && v.xs.some(($2) => $2 === 2)) && distinct(v.xs,');
    expect(ts).toContain("new RegExp('^a', 'u').test(v.s)");
});
