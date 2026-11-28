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
    // the old spellings are errors of their own (they parse only to be migrated); nothing else may be reported
    expect(a.diagnostics.filter((d) => d.severity === 'error' && !d.message.includes('no longer DomainTrail syntax'))).toEqual([]);
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

/** `count(xs)` and `xs.length` are one expression now: the size of a list is `length` as that of a string is. */
function sized(e: ExprModel): ExprModel {
    return JSON.parse(JSON.stringify(e), (_, v: unknown) =>
        v && typeof v === 'object' && (v as { k?: string }).k === 'count' ? { k: 'length', operand: (v as { collection: unknown }).collection } : v,
    ) as ExprModel;
}

describe('migrateDomain: method forms', () => {
    const list = (expr: string) =>
        `context L {\n  value I { n: Int  s: String }\n  value V {\n    xs: I[0..*]  ns: Int[0..*]  t: String  a: Int  b: Int\n    invariant x { ${expr} }\n  }\n}\n`;
    const out = (expr: string): string => {
        const text = migrateDomain(list(expr)).text;
        return text.slice(text.indexOf('invariant x { ') + 'invariant x { '.length, text.lastIndexOf(' }\n  }'));
    };
    const cases: (readonly [string, string])[] = [
        ['count(xs) > 0', 'xs.length > 0'],
        ['length(t) <= 8', 't.length <= 8'],
        ['all(xs, i => i.n > 0)', 'xs.every(i => i.n > 0)'],
        ['any(xs, i => length(i.s) > 0)', 'xs.some(i => i.s.length > 0)'],
        ['contains(ns, a)', 'ns.includes(a)'],
        ['unique(xs)', 'xs.unique()'],
        ['unique(xs, i => i.n, i.s)', 'xs.unique(i => i.n, i.s)'],
        ['matches(t, "^[A-Z]+$")', 't.matches("^[A-Z]+$")'],
        ['count((xs)) > 0', '(xs).length > 0'],
        ['all(xs, i => all(xs, j => i.n >= j.n)) && count(xs) > 1', 'xs.every(i => xs.every(j => i.n >= j.n)) && xs.length > 1'],
    ];
    for (const [old, next] of cases)
        test(`${old} → ${next}`, async () => {
            expect(out(old)).toBe(next);
            expect(await invariantOf(list(next))).toEqual(sized(await invariantOf(list(old))));
            const once = migrateDomain(list(old)).text;
            expect(migrateDomain(once).rewrites).toEqual([]);
        });
});

test('a function form inside parentheses keeps them', () => {
    const src = `context L {\n  value V {\n    ns: Int[0..*]\n    p: Bool\n    invariant x { !(any(ns, n => n > 0)) || p }\n  }\n}\n`;
    expect(migrateDomain(src).text).toContain('{ !(ns.some(n => n > 0)) || p }');
});

describe('migrateDomain: null safety', () => {
    const opt = (expr: string) => `context L {\n  value V {\n    note: String?  p: Bool\n    invariant x { ${expr} }\n  }\n}\n`;
    const out = (expr: string): string => {
        const text = migrateDomain(opt(expr)).text;
        return text.slice(text.indexOf('invariant x { ') + 'invariant x { '.length, text.lastIndexOf(' }\n  }'));
    };
    const cases: (readonly [string, string])[] = [
        ['exists(note)', 'note != null'],
        ['!exists(note) || note.length > 0', 'note == null || note.length > 0'],
        ['!(exists(note)) || note.length > 0', 'note == null || note.length > 0'],
        ['exists(note) && p', 'note != null && p'],
        ['exists(note) == p', '(note != null) == p'],
    ];
    for (const [old, next] of cases)
        test(`${old} → ${next}`, async () => {
            expect(out(old)).toBe(next);
            expect(await invariantOf(opt(next))).toEqual(await invariantOf(opt(old)));
            expect(migrateDomain(migrateDomain(opt(old)).text).rewrites).toEqual([]);
        });
});
