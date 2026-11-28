// `migrateDomain`, the logical operators' group: token rewrites that keep the meaning, the layout and the comments.
import { describe, expect, test } from 'bun:test';
import type { ExprModel } from '../../domain/model.js';
import { analyzeDomain } from '../../application/analyze.js';
import { migrateDomain } from './migrate.js';

const model = (expr: string) => `context L {\n  value V {\n    p: Bool  q: Bool  r: Bool  s: Bool  a: Int  b: Int\n    invariant x { ${expr} }\n  }\n}\n`;

const migrated = (expr: string): string => {
    const out = migrateDomain(model(expr)).text;
    return out.slice(out.indexOf('invariant x { ') + 'invariant x { '.length, out.lastIndexOf(' }\n  }'));
};

async function invariantOf(source: string): Promise<ExprModel> {
    const a = await analyzeDomain([{ path: 'l.dt', text: source }]);
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const v = a.model!.elements.find((e) => e.name === 'V')!;
    return ('invariants' in v ? v.invariants[0].expr : undefined)!;
}

/** The old tree with `p implies q` spelled as `!(p) || q`: what the migrated source must mean. */
function expanded(e: ExprModel): ExprModel {
    if (e.k === 'binary' && e.op === 'implies') return { k: 'binary', op: 'or', left: { k: 'not', operand: expanded(e.left) }, right: expanded(e.right) };
    if (e.k === 'binary') return { ...e, left: expanded(e.left), right: expanded(e.right) };
    if (e.k === 'not') return { ...e, operand: expanded(e.operand) };
    return e;
}

/** `||` and `&&` chains as flat operand lists: `a || (b || c)` and `(a || b) || c` mean the same. */
function flat(e: ExprModel): unknown {
    if (e.k === 'binary' && (e.op === 'or' || e.op === 'and')) {
        const op = e.op;
        const operands = (x: ExprModel): unknown[] => (x.k === 'binary' && x.op === op ? [...operands(x.left), ...operands(x.right)] : [flat(x)]);
        return { op, operands: operands(e) };
    }
    if (e.k === 'binary') return { ...e, left: flat(e.left), right: flat(e.right) };
    if (e.k === 'not') return { ...e, operand: flat(e.operand) };
    return e;
}

const cases: (readonly [string, string])[] = [
    ['p and q', 'p && q'],
    ['p or q', 'p || q'],
    ['not p', '!p'],
    ['not (p and q)', '!(p && q)'],
    ['not p == q', '!p == q'],
    ['p or q and r', 'p || q && r'],
    ['p implies q', '!(p) || q'],
    ['p implies q implies r', '!(!(p) || q) || r'],
    ['p and q implies r or s', '!(p && q) || r || s'],
    ['not p implies q', '!(!p) || q'],
    ['(p implies q) and r', '(!(p) || q) && r'],
    ['p implies (q implies r)', '!(p) || (!(q) || r)'],
];

describe('migrateDomain: logical operators', () => {
    for (const [old, next] of cases)
        test(`${old} → ${next}`, async () => {
            expect(migrated(old)).toBe(next);
            expect(flat(await invariantOf(model(next)))).toEqual(flat(expanded(await invariantOf(model(old)))));
        });

    test('is idempotent', () => {
        for (const [old] of cases) {
            const once = migrateDomain(model(old));
            expect(migrateDomain(once.text)).toEqual({ text: once.text, rewrites: [], parsed: true });
        }
    });

    test('keeps comments and line breaks, and leaves an enum value named like an operator alone', () => {
        const source = `context L {\n  enum Op { and or }\n  value V {\n    o: Op\n    p: Bool\n    invariant x {\n      o == Op.and /* keep */ and\n        not p\n    }\n  }\n}\n`;
        const out = migrateDomain(source);
        expect(out.text).toBe(
            `context L {\n  enum Op { and or }\n  value V {\n    o: Op\n    p: Bool\n    invariant x {\n      o == Op.and /* keep */ &&\n        !p\n    }\n  }\n}\n`,
        );
        expect(out.rewrites).toEqual([
            { line: 7, from: 'and', to: '&&' },
            { line: 8, from: 'not', to: '!' },
        ]);
    });

    test('leaves a source that does not parse as it is', () => {
        expect(migrateDomain('context {')).toEqual({ text: 'context {', rewrites: [], parsed: false });
    });
});
