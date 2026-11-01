// Recursive value types (M012 lets values and unions be recursive when they have a finite value): the generated types,
// equality and checks work on them, and the contract tests draw their values with `fc.letrec`, up to a maximum depth
// (ADR 0028, decision 8). A project with a tree (`Rule`) and a cycle across two types (`Expr` and `Call`), whose
// generated contract tests run and pass.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as fc from 'fast-check';
import { generateTypeScript } from './typescript.js';
import { recursiveCycles, testsWarnings } from './tests.js';
import { check, linkNodeModules } from '../test-helpers.js';

const ROOT = path.join(import.meta.dir, '..', '..', '..', '..');

const MODEL = `context M {
  enum Op { and or }
  union Expr {
    lit { value: Int }
    not { operand: Expr }
    binary { op: Op  left: Expr  right: Expr }
    call { call: Call }
  }
  value Call { name: String  args: Expr[0..*] }
  value Rule {
    name: String
    expr: Expr?
    children: Rule[0..*]
    invariant named { length(name) > 0 }
  }
  value Chain { label: String  next: Chain? }
  id DocId: UUID
  aggregate Doc {
    id: DocId
    rule: Rule
    state Open
    create command start(id: DocId, rule: Rule) -> Open emits Opened
    command rename(name: String) Open -> Open
  }
  id NoteId: UUID
  aggregate Note {
    id: NoteId
    text: String
    create command write(id: NoteId, text: String)
    command touch(expr: Expr, chain: Chain)
  }
  event Opened { docId: DocId  rule: Rule }
  policy React when Opened -> Note.touch
}
`;

type Value = Record<string, unknown>;
type Case = { name: string; run: () => unknown; todo?: boolean };

/** How many times a value nests through its cycle, counted at each choice that could end it (depth 1: it holds none). */
function depthOf(v: Value): number {
    const nested = (x: unknown): number => (x === undefined ? 0 : depthOf(x as Value));
    const most = (xs: readonly unknown[]): number => Math.max(0, ...xs.map(nested));
    if ('kind' in v) return 1 + most([v.operand, v.left, v.right, v.call]);
    if ('args' in v) return 1 + most(v.args as unknown[]);
    if ('children' in v) return 1 + most(v.children as unknown[]);
    return 1 + nested(v.next);
}

const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

/** Writes the generated code of a model into a temporary ES module project and imports its tests and the support. */
async function project(
    files: Record<string, string>,
    tests: Omit<Parameters<typeof generateTypeScript>[2] & object, 'dir'>,
    policies: Parameters<typeof generateTypeScript>[3] = {},
    dirs: string[],
): Promise<{ dir: string; diagnostics: unknown[]; model: NonNullable<Awaited<ReturnType<typeof check>>['model']> }> {
    const a = await check(files);
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-recursion-'));
    dirs.push(dir);
    await linkNodeModules(dir);
    // an ES module project, like domaintrail/testing (under nodenext, CommonJS would see fast-check's other types)
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    for (const f of generateTypeScript(a.model!, {}, { dir: 'tests', ...tests }, policies)) {
        await mkdir(path.dirname(path.join(dir, f.path)), { recursive: true });
        await writeFile(path.join(dir, f.path), f.content);
    }
    return { dir, diagnostics: a.diagnostics, model: a.model! };
}

describe('recursive value types', async () => {
    const dirs: string[] = [];
    afterAll(async () => {
        for (const d of dirs) await rm(d, { recursive: true, force: true });
    });
    const types = { 'M.Rule': { maxRecursionDepth: 3 }, 'M.Chain': { maxRecursionDepth: 2 } };
    const { dir, diagnostics, model } = await project({ 'm.dt': MODEL }, { maxRecursionDepth: 5, types }, { M: 'required' }, dirs);
    const tests = await import(path.join(dir, 'tests', 'index.ts'));
    const { cases } = await import(path.join(dir, 'node_modules', 'domaintrail', 'testing', 'index.ts'));

    test('check without diagnostics', () => {
        expect(diagnostics).toEqual([]);
    });

    test('the generated types, equality and checks work on nested values', async () => {
        const m = await import(path.join(dir, 'M.ts'));
        const e1 = { kind: 'binary', op: 'and', left: { kind: 'lit', value: 1 }, right: { kind: 'not', operand: { kind: 'lit', value: 2 } } };
        const e2 = { ...e1, right: { kind: 'not', operand: { kind: 'lit', value: 3 } } };
        expect([m.equalExpr(e1, e1), m.equalExpr(e1, e2)]).toEqual([true, false]);
        const rule = { name: 'r', expr: e1, children: [{ name: 'c', children: [] }] };
        expect([m.equalRule(rule, rule), m.equalRule(rule, { ...rule, children: [] })]).toEqual([true, false]);
        expect(m.checkRule({ name: '', children: [rule] })).toEqual(['named']);
    });

    test('the cycles, each with the greatest depth of its types, and the variant that ends a union', () => {
        const cycles = recursiveCycles(model, 3, { 'M.Call': { maxRecursionDepth: 6 } });
        expect([...new Set(cycles.values())].map((c) => ({ ...c, ending: Object.fromEntries(c.ending) }))).toEqual([
            { id: 'M.Expr', members: ['M.Expr', 'M.Call'], maxRecursionDepth: 6, ending: { 'M.Expr': 'lit' } },
            { id: 'M.Rule', members: ['M.Rule'], maxRecursionDepth: 3, ending: {} },
            { id: 'M.Chain', members: ['M.Chain'], maxRecursionDepth: 3, ending: {} },
        ]);
        expect(cycles.has('M.Doc')).toBe(false);
    });

    test('values of recursive types hold their invariants and go up to the maximum depth', () => {
        const m = tests.M.arbitraries();
        for (const [type, max] of [
            ['Expr', 5],
            ['Call', 5],
            ['Rule', 3],
            ['Chain', 2],
        ] as const) {
            const depths = fc.sample<Value>(m[type], { seed: 1, numRuns: 300 }).map(depthOf);
            expect([type, Math.min(...depths), Math.max(...depths)]).toEqual([type, 1, max]);
        }
        expect(fc.sample<Value>(m.Rule, { seed: 2, numRuns: 100 }).every((r) => (r.name as string).length > 0)).toBe(true);
        // an optional field drawn absent is left out, not undefined
        expect(fc.sample<Value>(m.Chain, { seed: 3, numRuns: 50 }).every((c) => !('next' in c) || c.next !== undefined)).toBe(true);
    });

    test('an arbitrary passed in the options replaces the generated one, inside the cycle too', () => {
        const m = tests.M.arbitraries({ arbitraries: { M: { Expr: fc.constant({ kind: 'lit', value: 7 }) } } });
        expect(fc.sample(m.Expr, { seed: 1, numRuns: 5 })).toEqual(Array(5).fill({ kind: 'lit', value: 7 }));
        const args = fc.sample<Value>(m.Call, { seed: 1, numRuns: 50 }).flatMap((c) => c.args as Value[]);
        expect(args.length > 0 && args.every((e) => e.kind === 'lit' && e.value === 7)).toBe(true);
    });

    test('the contract tests of the commands and policies with recursive inputs run and pass', async () => {
        const suite = tests.M.contract(
            {
                Doc: {
                    start: (id: string, rule: Value) =>
                        ok({ Open: { aggregate: { state: 'Open', id, rule }, events: { Opened: { type: 'Opened', docId: id, rule } } } }),
                    rename: (doc: Value, name: string) => ok({ Open: { aggregate: { ...doc, rule: { ...(doc.rule as Value), name } }, events: {} } }),
                },
                Note: {
                    write: (id: string, text: string) => ok({ Note: { aggregate: { id, text }, events: {} } }),
                    touch: (note: Value) => ok({ Note: { aggregate: note, events: {} } }),
                },
                policies: { React: async () => ({ note: '00000000-0000-4000-8000-000000000001', expr: { kind: 'lit', value: 1 }, chain: { label: 'c' } }) },
            },
            { runs: 50 },
        );
        const all: Case[] = cases(suite);
        const names = all.map((c) => c.name);
        expect(['Doc.start', 'Doc.rename', 'Note.touch', 'React'].filter((n) => !names.some((x) => x.includes(n)))).toEqual([]);
        const failed: string[] = [];
        for (const c of all.filter((c) => !c.todo)) {
            try {
                await c.run();
            } catch (e) {
                failed.push(`${c.name}: ${(e as Error).message}`);
            }
        }
        expect(failed).toEqual([]);
        // an impure rename: the contract tests find it with recursive inputs too
        let calls = 0;
        const rename = (doc: Value): unknown => ok({ Open: { aggregate: { ...doc, rule: { name: `r${++calls}`, children: [] } }, events: {} } });
        const broken: Case[] = cases(tests.M.contract({ Doc: { start: () => ok({}), rename }, policies: {} }, { runs: 20 }));
        const failing: string[] = [];
        for (const c of broken.filter((c) => c.name.includes('Doc.rename'))) {
            try {
                await c.run();
            } catch (e) {
                failing.push((e as Error).message);
            }
        }
        expect(failing.join('\n')).toContain('returned different results for the same input');
    });

    test('the generated modules type-check', () => {
        const r = Bun.spawnSync(
            [
                path.join(ROOT, 'node_modules', '.bin', 'tsc'),
                '--noEmit',
                '--strict',
                '--noUnusedLocals',
                '--noUnusedParameters',
                '--exactOptionalPropertyTypes',
                '--module',
                'nodenext',
                '--moduleResolution',
                'nodenext',
                '--target',
                'es2022',
                '--types',
                'bun',
                'tests/index.ts',
                'index.ts',
            ],
            { cwd: dir },
        );
        expect(r.stdout.toString() + r.stderr.toString()).toBe('');
        expect(r.exitCode).toBe(0);
    });

    test('a per-type setting of a type that is not recursive is warned about', () => {
        expect(testsWarnings(model, { 'M.Rule': { maxRecursionDepth: 2 }, 'M.Note': { maxRecursionDepth: 2 } })).toEqual([
            "'generate.ts.tests.types' names 'M.Note', which is not a recursive type: its 'maxRecursionDepth' is not used.",
        ]);
        expect(testsWarnings(model)).toEqual([]);
    });
});

describe('a cycle across contexts', async () => {
    const dirs: string[] = [];
    afterAll(async () => {
        for (const d of dirs) await rm(d, { recursive: true, force: true });
    });
    const files = {
        'a.dt': 'context A {\n  union Node {\n    leaf { value: Int }\n    branch { other: B.Other }\n  }\n}\n',
        'b.dt': 'context B {\n  value Other { name: String  node: A.Node }\n}\n',
    };
    const { dir, diagnostics } = await project(files, { maxRecursionDepth: 3 }, {}, dirs);

    test('values go through both contexts, within the depth of the cycle', async () => {
        expect(diagnostics).toEqual([]);
        const tests = await import(path.join(dir, 'tests', 'index.ts'));
        const depth = (v: Value): number => (v.kind === 'branch' ? 1 + depth((v.other as Value).node as Value) : 1);
        // only the union's choice could end the cycle: a branch per level, up to 3 levels
        const depths = fc.sample<Value>(tests.A.arbitraries().Node, { seed: 1, numRuns: 200 }).map(depth);
        expect([Math.min(...depths), Math.max(...depths)]).toEqual([1, 3]);
        expect(fc.sample<Value>(tests.B.arbitraries().Other, { seed: 1, numRuns: 20 }).every((o) => typeof o.name === 'string')).toBe(true);
    });
});
