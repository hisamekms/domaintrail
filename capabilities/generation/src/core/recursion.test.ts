// Recursive value types (M012 lets values and unions be recursive when they have a finite value): the generated types,
// equality and checks work on them; the contract tests generate no values of them yet and leave out what needs one.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { generateTypeScript } from './typescript.js';
import { testsWarnings, untestedTypes } from './tests.js';
import { check, linkNodeModules } from '../test-helpers.js';

const ROOT = path.join(import.meta.dir, '..', '..', '..', '..');

const MODEL = `context M {
  enum Op { and or }
  union Expr {
    lit { value: Int }
    not { operand: Expr }
    binary { op: Op  left: Expr  right: Expr }
  }
  value Rule {
    name: String
    expr: Expr?
    children: Rule[0..*]
    invariant named { length(name) > 0 }
  }
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
    command touch(expr: Expr)
  }
  event Opened { docId: DocId  rule: Rule }
  policy React when Opened -> Note.touch
}
`;

describe('recursive value types', async () => {
    const dirs: string[] = [];
    afterAll(async () => {
        for (const d of dirs) await rm(d, { recursive: true, force: true });
    });
    const a = await check({ 'm.dt': MODEL });
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-recursion-'));
    dirs.push(dir);
    await linkNodeModules(dir);
    // an ES module project, like domaintrail/testing (under nodenext, CommonJS would see fast-check's other types)
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    for (const f of generateTypeScript(a.model!, {}, { dir: 'tests' }, { M: 'required' })) {
        await mkdir(path.dirname(path.join(dir, f.path)), { recursive: true });
        await writeFile(path.join(dir, f.path), f.content);
    }

    test('check without diagnostics', () => {
        expect(a.diagnostics).toEqual([]);
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

    test('the contract tests leave out the recursive types, what needs them and their cases', async () => {
        expect(untestedTypes(a.model!)).toEqual({ recursive: ['M.Expr', 'M.Rule'], types: ['M.Expr', 'M.Rule', 'M.Doc', 'M.Opened'] });
        expect(testsWarnings(a.model!, { M: 'required' })).toEqual([
            'the contract tests generate no values of recursive types yet (M.Expr, M.Rule): no arbitrary is generated for M.Expr, M.Rule, M.Doc, M.Opened, and these cases are left out: M.Doc.start, M.Doc.rename, M.Note.touch, policy M.React.',
        ]);
        const tests = await import(path.join(dir, 'tests', 'index.ts'));
        const arbs = tests.M.arbitraries();
        expect(['Op', 'DocId', 'NoteId', 'Note'].every((n) => n in arbs)).toBe(true);
        expect(['Expr', 'Rule', 'Doc', 'OpenDoc', 'Opened'].filter((n) => n in arbs)).toEqual([]);
        const suite = tests.M.contract({ Note: { write: () => undefined, touch: () => undefined }, policies: {} });
        const { cases } = await import(path.join(dir, 'node_modules', 'domaintrail', 'testing', 'index.ts'));
        const names: string[] = cases(suite).map((c: { name: string }) => c.name);
        expect(names.some((n) => n.startsWith('M > Note > Note.write'))).toBe(true);
        expect(names.filter((n) => /touch|Doc|React/.test(n))).toEqual([]);
    });

    test('the generated modules type-check', () => {
        const r = Bun.spawnSync(
            [
                path.join(ROOT, 'node_modules', '.bin', 'tsc'),
                '--noEmit',
                '--strict',
                '--noUnusedLocals',
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

    test('no warning without recursive types', async () => {
        const plain = await check({ 'm.dt': 'context M { value V { x: Int } }' });
        expect(testsWarnings(plain.model!)).toEqual([]);
    });
});
