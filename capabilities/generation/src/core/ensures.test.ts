// What `changes x = e`, the fields an outcome does not list and `ensures` make of the generated TypeScript: the check
// `check<Command>Ensures` (ADR 0043) and the `@ensures` lines (the DSL and its checks:
// contexts/modeling/src/domain/rules/ensures.test.ts; run by decide: ensures.typecheck.test.ts).
import { describe, expect, test } from 'bun:test';
import { check, generateFromAnalysis } from '../test-helpers.js';

const MODEL = `context Tasks {
  id WorkId: UUID
  id ValueId: UUID
  aggregate Work {
    id: WorkId
    title: String
    tags: String[0..*]
    note: String?
    initial Draft
    state Draft
    state Done { doneAt: Timestamp by: String? }
    create command open(id: WorkId, title: String) {
      outcome opened: -> Draft
        changes id = id, title = title, tags = []
    }
    create command raw(id: WorkId, title: String) -> Draft changes id, title, tags, note
    command finish(at: Timestamp) {
      outcome finished: Draft -> Done
        changes doneAt = at, tags
        ensures { after.tags.every(t => t != "") && before.tags.length <= after.tags.length }
    }
    command retitle(title: String) Draft -> Draft | Done
      changes title = title, doneAt = "2026-01-01T00:00:00Z"
      ensures { after.title != "" }
  }
  aggregate Value {
    id: ValueId
    n: Int
    create command make(id: ValueId) changes id = id, n = 0
  }
}
`;

const generated = async (): Promise<string> => {
    const a = await check({ 'tasks.dt': MODEL });
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    return generateFromAnalysis(a).find((f) => f.path === 'Tasks.ts')!.content;
};

/** The lines of the generated function `name`, from its `export` to its closing brace. */
const fn = (code: string, name: string): string => {
    const start = code.indexOf(`export function ${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    return code.slice(start, code.indexOf('\n}\n', start) + 2);
};

describe('postconditions in the generated TypeScript', () => {
    test('per outcome: each changes x = e, then the frame (a carried field as it was, a new optional one absent), then each conjunct of ensures', async () => {
        const code = await generated();
        expect(fn(code, 'checkFinishWorkEnsures')).toBe(
            [
                "export function checkFinishWorkEnsures(work: DraftWork, params: FinishWorkParams, value: SuccessOf<FinishWorkCommand>): Postcondition<'Tasks.Work:finish->finished.changes.doneAt' | 'Tasks.Work:finish->finished.unchanged.id' | 'Tasks.Work:finish->finished.unchanged.title' | 'Tasks.Work:finish->finished.unchanged.note' | 'Tasks.Work:finish->finished.unchanged.by' | 'Tasks.Work:finish->finished.ensures'> | undefined {",
                "    if ('finished' in value && value.finished !== undefined && work.state === 'Draft') {",
                "        if (value.finished.aggregate.doneAt !== params.at) return { id: 'Tasks.Work:finish->finished.changes.doneAt', outcome: 'finished', kind: 'changes', field: 'doneAt', source: 'doneAt = at' };",
                "        if (value.finished.aggregate.id !== work.id) return { id: 'Tasks.Work:finish->finished.unchanged.id', outcome: 'finished', kind: 'unchanged', field: 'id', source: 'after.id == before.id' };",
                "        if (value.finished.aggregate.title !== work.title) return { id: 'Tasks.Work:finish->finished.unchanged.title', outcome: 'finished', kind: 'unchanged', field: 'title', source: 'after.title == before.title' };",
                "        if (value.finished.aggregate.note !== work.note) return { id: 'Tasks.Work:finish->finished.unchanged.note', outcome: 'finished', kind: 'unchanged', field: 'note', source: 'after.note == before.note' };",
                "        if (value.finished.aggregate.by !== undefined) return { id: 'Tasks.Work:finish->finished.unchanged.by', outcome: 'finished', kind: 'unchanged', field: 'by', source: 'after.by == null' };",
                "        if (!(value.finished.aggregate.tags.every((t) => !(t === '')))) return { id: 'Tasks.Work:finish->finished.ensures', outcome: 'finished', kind: 'ensures', source: 'after.tags.every(t => t != \"\")' };",
                "        if (!(work.tags.length <= value.finished.aggregate.tags.length)) return { id: 'Tasks.Work:finish->finished.ensures', outcome: 'finished', kind: 'ensures', source: 'before.tags.length <= after.tags.length' };",
                '    }',
                '    return undefined;',
                '}',
            ].join('\n'),
        );
    });

    test('a create takes the parameters and the value; a list compares element by element; a field it does not list starts absent', async () => {
        const code = await generated();
        const open = fn(code, 'checkOpenWorkEnsures');
        expect(open).toContain('export function checkOpenWorkEnsures(params: OpenWorkParams, value: SuccessOf<OpenWorkCommand>)');
        expect(open).toContain("    if ('opened' in value && value.opened !== undefined) {");
        expect(open).toContain(
            "if (!sameList(value.opened.aggregate.tags, [], ($0: string, $1: string) => $0 === $1)) return { id: 'Tasks.Work:open->opened.changes.tags'",
        );
        expect(open).toContain("if (value.opened.aggregate.note !== undefined) return { id: 'Tasks.Work:open->opened.unchanged.note'");
        // bare `changes` everywhere and no optional field left out: nothing to check, no function
        expect(code).not.toContain('checkRawWorkEnsures');
        // the value is `result` when the aggregate's parameter takes `value`
        expect(code).toContain('export function checkMakeValueEnsures(params: MakeValueParams, result: SuccessOf<MakeValueCommand>)');
        expect(code).toContain("if ('Value' in result && result.Value !== undefined) {");
    });

    test('the shorthand form: one branch per target, each with the changes the target has; the IDs of its contract are the command’s', async () => {
        const retitle = fn(await generated(), 'checkRetitleWorkEnsures');
        const draft = retitle.slice(retitle.indexOf("if ('Draft' in value"), retitle.indexOf("if ('Done' in value"));
        const done = retitle.slice(retitle.indexOf("if ('Done' in value"));
        expect(draft).toContain("source: 'title = title'");
        expect(draft).not.toContain('doneAt');
        expect(draft).toContain("{ id: 'Tasks.Work:retitle->Draft.unchanged.tags'");
        expect(draft).toContain("{ id: 'Tasks.Work:retitle.ensures', outcome: 'Draft', kind: 'ensures', source: 'after.title != \"\"' }");
        // a date or time literal is compared as its canonical text
        expect(done).toContain(
            "if (value.Done.aggregate.doneAt !== '2026-01-01T00:00:00.000Z') return { id: 'Tasks.Work:retitle.changes.doneAt', outcome: 'Done', kind: 'changes', field: 'doneAt', source: 'doneAt = \"2026-01-01T00:00:00Z\"' };",
        );
        expect(done).toContain("if (value.Done.aggregate.by !== undefined) return { id: 'Tasks.Work:retitle->Done.unchanged.by'");
    });

    test('@ensures lines on the command and its decision', async () => {
        const code = await generated();
        const finish = ' * @ensures finished: after.tags.every(t => t != "") && before.tags.length <= after.tags.length';
        expect(code).toContain(`${finish}\n * @see tasks.dt:17\n */\nexport type FinishWorkCommand = `);
        expect(code).toContain(`${finish}\n * @see tasks.dt:17\n */\nexport type FinishWorkDecision = `);
        const retitle = ' * @changes title, doneAt\n * @ensures after.title != ""\n';
        expect(code.split(retitle).length).toBe(3); // the command and its decision
    });
});
