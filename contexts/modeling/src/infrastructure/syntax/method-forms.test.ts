// Phase 2's method forms build the expressions of the function forms they replace, so the models and the IR keep
// their shape: `xs.every(x => p)` is `all(xs, x => p)`, `xs.length` is the size of a list or of a string.
import { describe, expect, test } from 'bun:test';
import { analyzeDomain } from '../../application/analyze.js';
import type { ExprModel } from '../../domain/model.js';

const model = (members: string) => `context M {
  value Item { name: String  n: Int }
  value V {
    xs: Int[0..*]
    items: Item[0..*]
    s: String
    every: Int
    includes: Int
${members}
  }
}`;

async function invariants(members: string): Promise<{ exprs: ExprModel[]; errors: string[] }> {
    const a = await analyzeDomain([{ path: 'm.dt', text: model(members) }]);
    const v = a.model!.elements.find((e) => e.name === 'V')!;
    return {
        exprs: 'invariants' in v ? v.invariants.map((i) => i.expr!) : [],
        errors: a.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`),
    };
}

describe('method forms', () => {
    const pairs: [string, string][] = [
        ['xs.every(x => x > 0)', 'all(xs, x => x > 0)'],
        ['xs.some(x => x > 0)', 'any(xs, x => x > 0)'],
        ['xs.includes(1)', 'contains(xs, 1)'],
        ['items.unique()', 'unique(items)'],
        ['items.unique(i => i.name, i.n)', 'unique(items, i => i.name, i.n)'],
        ['s.matches("^[A-Z]\\\\d+$")', 'matches(s, "^[A-Z]\\\\d+$")'],
        ['s.length <= 8', 'length(s) <= 8'],
    ];
    for (const [next, old] of pairs)
        test(`${next} is ${old}`, async () => {
            const { exprs, errors } = await invariants(`    invariant a { ${next} }\n    invariant b { ${old} }`);
            expect(errors).toEqual([]);
            expect(exprs[0]).toEqual(exprs[1]);
        });

    test('`.length` of a list is its size', async () => {
        const { exprs, errors } = await invariants('    invariant a { xs.length > 0 && items.length == xs.length }');
        expect(errors).toEqual([]);
        expect(exprs[0]).toMatchObject({ left: { left: { k: 'length', operand: { k: 'name', name: 'xs' } } } });
    });

    test('a field named like a method is still a field, read as a name', async () => {
        const { errors } = await invariants('    invariant a { every == includes }');
        expect(errors).toEqual([]);
    });

    test('`.length` of anything but a list or a string, and a call that is no method form, are errors', async () => {
        const { errors } = await invariants(
            '    invariant a { every.length > 0 }\n    invariant b { xs.count() }\n    invariant c { xs.every(1) }\n    invariant d { s.matches(s) }',
        );
        expect(errors.sort()).toEqual(
            [
                "M001 'count' is not a method: the methods are every, some, includes, unique and matches.",
                "M001 '.every(…)' is written xs.every(x => condition).",
                `M001 '.matches(…)' is written text.matches("pattern").`,
                "M009 '.length' is the size of a list or a string, not of 'Int'.",
            ].sort(),
        );
    });
});
