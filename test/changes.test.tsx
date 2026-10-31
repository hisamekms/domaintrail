import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { generateTypeScript } from '../src/generator/typescript.js';
import { diffModels } from '../src/visualization/domain/graph/diff.js';
import { CommandCard } from '../web/behavior.js';
import { highlight } from '../web/highlight.js';
import { MESSAGES } from '../web/i18n.js';
import { namer } from '../web/model-utils.js';
import { check, only } from './helpers.js';

const TSC = path.join(import.meta.dir, '..', 'node_modules', '.bin', 'tsc');

function tscIn(cwd: string, ...files: string[]): { code: number; output: string } {
    const r = Bun.spawnSync(
        [
            process.execPath,
            TSC,
            '--noEmit',
            '--strict',
            '--target',
            'ES2023',
            '--module',
            'preserve',
            '--moduleResolution',
            'bundler',
            '--lib',
            'ES2023,DOM',
            ...files,
        ],
        { cwd },
    );
    return { code: r.exitCode, output: r.stdout.toString() + r.stderr.toString() };
}

/**
 * Work moves Draft -> Review -> Done -> Archived. `draftNo` is in Draft and Review (carried over between them),
 * `reviewer` in Review and Done (carried over) and in Archived with another type (not carried over).
 */
const work = (commands: string, extra = '') =>
    check({
        'tasks.dt': `context Tasks {
  id WorkId: UUID
  id TagId: UUID
  event Renamed { workId: WorkId }
  error NotReady
  fields Audited { updatedAt: Timestamp? }
  aggregate Work with Audited {
    id: WorkId
    title: String
    note: String?
    tags: String[0..*]
    state Draft { draftNo: Int }
    state Review { draftNo: Int reviewer: String }
    state Done { reviewer: String doneAt: Timestamp }
    state Archived { reviewer: String? }
${commands}
  }
  aggregate Tag {
    id: TagId
    name: String
    color: String
    create command make(id: TagId, name: String, color: String)
    command recolor(color: String) changes color
  }
  ${extra}
}
`,
    });

const COMMANDS = `
    create command open(id: WorkId, title: String) -> Draft
    command rename(newTitle: String, at: Timestamp)
      Draft -> Draft, Review -> Review
      requires named { newTitle != "" } else NotReady
      changes title, updatedAt
      emits Renamed
    command submit(reviewer: String) Draft -> Review
    command renumber(n: Int) Draft -> Draft, Review -> Review changes draftNo
    command finish(at: Timestamp) Review -> Done
    command archive() Done -> Archived
    command clearNote() Draft -> Draft changes note
    command touch() Draft -> Draft`;

describe('changes in the DSL', () => {
    test('lists the fields a command may change, after requires and before emits; the Typed Model holds them', async () => {
        const a = await work(COMMANDS);
        expect(a.diagnostics).toEqual([]);
        const cmd = (name: string) => a.model!.elements['Tasks.Work'].commands!.find((c) => c.name === name)!;
        expect(cmd('rename').changes).toEqual(['title', 'updatedAt']);
        expect(cmd('rename').emits.map((e) => e.event)).toEqual(['Tasks.Renamed']);
        expect(cmd('renumber').changes).toEqual(['draftNo']);
        expect(cmd('submit').changes).toEqual([]);
        expect(a.model!.elements['Tasks.Tag'].commands![1].changes).toEqual(['color']);
    });

    test('after emits it is a syntax error', async () => {
        const a = await work('command x() Draft -> Draft emits Renamed changes title');
        expect(a.syntaxOk).toBe(false);
    });

    test('`changes` is still usable as a field and parameter name', async () => {
        const a = await check({
            'sales.dt': `context Sales {
  id OrderId: UUID
  aggregate Order {
    id: OrderId
    changes: Int
    command count(changes: Int) changes changes
  }
}`,
        });
        expect(a.diagnostics).toEqual([]);
        expect(a.model!.elements['Sales.Order'].fields.map((f) => f.name)).toEqual(['id', 'changes']);
        expect(a.model!.elements['Sales.Order'].commands![0].changes).toEqual(['changes']);
    });

    test('M021: a field the command can change; not on a factory, not the identity', async () => {
        const a = await work(`
    create command make(id: WorkId) -> Draft changes title
    command a() Draft -> Draft changes titel
    command b() Draft -> Draft changes id
    command c() Draft -> Review changes reviewer
    command d() Done -> Archived changes doneAt
    command e() Done -> Archived changes reviewer
    command f() Draft -> Draft, Review -> Review changes reviewer
    command g() Draft | Review -> Review changes draftNo, reviewer`);
        // not reported: f (Review -> Review carries `reviewer` over), g (Review -> Review carries both; Draft -> Review sets `reviewer` anyway)
        expect(only(a, 'M021').map((d) => [d.message, d.hint])).toEqual([
            [
                "Factory command 'make' sets every field of the new 'Work'; 'changes' does not apply to it.",
                "remove 'changes title'; the decision of 'make' gives every field",
            ],
            ["'Work' has no field 'titel'.", "did you mean 'title'?"],
            ["Field 'id' is the identity of 'Work' and never changes.", "remove 'id' from 'changes'"],
            [
                "Field 'reviewer' is in state 'Review', 'Done', 'Archived' only, and no transition of 'c' carries it over (from a state that has it to one that has it, with the same type), so 'changes' cannot apply to it.",
                "every outcome of 'c' that ends in 'Review' sets 'reviewer' anyway; remove it from 'changes'",
            ],
            [
                "Field 'doneAt' is in state 'Done' only, and no transition of 'd' carries it over (from a state that has it to one that has it, with the same type), so 'changes' cannot apply to it.",
                "'d' never ends in 'Done', so 'doneAt' is not kept; remove it from 'changes'",
            ],
            [
                "Field 'reviewer' is in state 'Review', 'Done', 'Archived' only, and no transition of 'e' carries it over (from a state that has it to one that has it, with the same type), so 'changes' cannot apply to it.",
                "every outcome of 'e' that ends in 'Archived' sets 'reviewer' anyway; remove it from 'changes'",
            ],
        ]);
    });

    test('M021: an aggregate without states changes its own fields; M002: a field is listed once', async () => {
        const a = await work(
            'command x() Draft -> Draft, Review -> Review changes title, note, title',
            'aggregate Plain { id: WorkId size: Int command grow() changes sise }',
        );
        expect(only(a, 'M002').map((d) => d.message)).toEqual(["Field 'title' is listed more than once in 'changes' of command 'x'."]);
        expect(only(a, 'M021').map((d) => [d.message, d.hint])).toEqual([["'Plain' has no field 'sise'.", "did you mean 'size'?"]]);
    });

    test('changes is highlighted as a keyword; a change to it changes its command (and its aggregate)', async () => {
        expect(
            highlight('changes note emits X')[0]
                .filter((t) => t.kind === 'keyword')
                .map((t) => t.text),
        ).toEqual(['changes', 'emits']);
        const before = await work('command x() Draft -> Draft changes title');
        const after = await work('command x() Draft -> Draft changes title, note');
        expect(diffModels(before.model, after.model!)).toEqual({ added: [], changed: ['Tasks.Work', 'Tasks.Work:x'], removed: [] });
    });

    test('the command card and the inspector list the fields it changes', async () => {
        const a = await work(COMMANDS);
        const agg = a.model!.elements['Tasks.Work'];
        const card = (name: string) =>
            renderToStaticMarkup(
                <CommandCard
                    agg={agg}
                    c={agg.commands!.find((c) => c.name === name)!}
                    model={a.model!}
                    names={namer('name', a.model!)}
                    tx={MESSAGES.ja}
                    onSelect={() => {}}
                />,
            );
        expect(card('rename')).toContain(
            `<div class="bcard-caption">${MESSAGES.ja.changedFields}</div><div class="bcard-changes"><code class="bcard-change">title</code><code class="bcard-change">updatedAt</code></div>`,
        );
        expect(card('submit')).not.toContain('bcard-changes');
    });
});

describe('changes in the generated TypeScript', () => {
    let dir: string;
    let code: string;

    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-changes-'));
        const a = await work(COMMANDS);
        expect(a.diagnostics).toEqual([]);
        await mkdir(path.join(dir, 'generated'));
        for (const f of generateTypeScript(a.model!)) await writeFile(path.join(dir, 'generated', f.path), f.content);
        code = await readFile(path.join(dir, 'generated', 'Tasks.ts'), 'utf8');
        await mkdir(path.join(dir, 'src'));
    });

    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    /** The `set` of the decision of a command for an outcome (the first one of the source state). */
    const setOf = (decision: string, from: string): string => {
        const start = code.indexOf(`export type ${decision} =`);
        const body = code.slice(start, code.indexOf('\n}', start));
        const at = from ? body.indexOf(`readonly ${from}: (`) : 0;
        return /readonly set: ([^\n]*);\n/.exec(body.slice(at))![1];
    };

    test('set: the fields in changes (rule 5: always given, an optional one as `| undefined`)', () => {
        expect(setOf('RenameWorkDecision', 'Draft')).toBe('{ readonly updatedAt: Timestamp | undefined; readonly title: string }');
        expect(setOf('ClearNoteWorkDecision', 'Draft')).toBe('{ readonly note: string | undefined }');
        // rule 1: without changes, nothing to set
        expect(setOf('TouchWorkDecision', 'Draft')).toBe('NoChanges');
    });

    test('set: the target state`s own fields that are not carried over (rule 2)', () => {
        // draftNo is carried over from Draft to Review; reviewer is new
        expect(setOf('SubmitWorkDecision', 'Draft')).toBe('{ readonly reviewer: string }');
        // reviewer is carried over from Review to Done; doneAt is new
        expect(setOf('FinishWorkDecision', 'Review')).toBe('{ readonly doneAt: Timestamp }');
        // reviewer: String in Done, String? in Archived: not the same type, so not carried over
        expect(setOf('ArchiveWorkDecision', 'Done')).toBe('{ readonly reviewer: string | undefined }');
        // a carried-over field listed in changes is set
        expect(setOf('RenumberWorkDecision', 'Review')).toBe('{ readonly draftNo: number }');
    });

    test('a factory sets every field (rule 3); without states, only the fields in changes (rule 4)', () => {
        expect(setOf('OpenWorkDecision', '')).toBe(
            '{ readonly updatedAt: Timestamp | undefined; readonly id: WorkId; readonly title: string; readonly note: string | undefined; readonly tags: readonly string[]; readonly draftNo: number }',
        );
        expect(code).toContain('export type OpenWorkDecision = (\n    id: WorkId,\n    title: string,\n) => Result<{');
        expect(setOf('RecolorTagDecision', '')).toBe('{ readonly color: string }');
        expect(code).toContain(
            'export type RecolorTagDecision = (\n    tag: Tag,\n    color: string,\n) => Result<{\n    readonly Tag: {\n        readonly set: { readonly color: string };',
        );
    });

    test('the JSDoc says what each command changes, and per outcome what is set, carried over and dropped', () => {
        expect(code).toContain(
            ` * @requires named else NotReady: newTitle != ""
 * @changes title, updatedAt
 * Draft -> Draft — set: updatedAt, title; carried over: id, note, tags, draftNo
 * Review -> Review — set: updatedAt, title; carried over: id, note, tags, draftNo, reviewer
 * @see tasks.dt:18
 */
export type RenameWorkDecision = {`,
        );
        expect(code).toContain(
            ' * @changes none — the command changes no common field\n * Review -> Done — set: doneAt (new in Done); carried over: updatedAt, id, title, note, tags, reviewer; dropped: draftNo\n',
        );
        expect(code).toContain(
            ' * Done -> Archived — set: reviewer (new in Archived); carried over: updatedAt, id, title, note, tags; dropped: reviewer, doneAt\n',
        );
        expect(code).toContain(' * new -> Draft — set: every field\n');
        expect(code).toContain(' * @changes color\n * Tag — set: color; carried over: id, name\n');
        // the contract says it too
        expect(code).toContain(
            ' * Work.submit (Draft -> Review)\n * @changes none — the command changes no common field\n * @emits nothing\n * @see tasks.dt:23\n */\nexport type SubmitWork = ',
        );
        expect(code).toContain("export const TagShape: Shape = { fields: ['id', 'name', 'color'] };");
        expect(code).toContain(
            "export const WorkShape: Shape = {\n    fields: ['updatedAt', 'id', 'title', 'note', 'tags'],\n    states: { Draft: ['draftNo'], Review: ['draftNo', 'reviewer'], Done: ['reviewer', 'doneAt'], Archived: ['reviewer'] },\n};",
        );
    });

    test('decisions that follow the contract compile into the commands with decide, without assertions', async () => {
        await writeFile(
            path.join(dir, 'src', 'ok.ts'),
            `import { Tasks, decide, err, ok } from '../generated/index.js';

export const work: Tasks.WorkCommands = {
    open: decide<Tasks.OpenWorkDecision>(Tasks.WorkShape, (id, title) => ok({ Draft: { set: { updatedAt: undefined, id, title, note: undefined, tags: [], draftNo: 1 }, events: {} } })),
    rename: decide<Tasks.RenameWorkDecision>(Tasks.WorkShape, {
        Draft: (w, newTitle, at) => (newTitle === '' ? err({ type: 'NotReady' }) : ok({ Draft: { set: { title: newTitle, updatedAt: at }, events: { Renamed: { type: 'Renamed', workId: w.id } } } })),
        Review: (w, newTitle, at) => ok({ Review: { set: { title: newTitle, updatedAt: at }, events: { Renamed: { type: 'Renamed', workId: w.id } } } }),
    }),
    submit: decide<Tasks.SubmitWorkDecision>(Tasks.WorkShape, { Draft: (w, reviewer) => ok({ Review: { set: { reviewer }, events: {} } }) }),
    renumber: decide<Tasks.RenumberWorkDecision>(Tasks.WorkShape, {
        Draft: (w, n) => ok({ Draft: { set: { draftNo: n }, events: {} } }),
        // a command that changes a field only in some cases gives the old value in the others
        Review: (w, n) => ok({ Review: { set: { draftNo: n > w.draftNo ? n : w.draftNo }, events: {} } }),
    }),
    finish: decide<Tasks.FinishWorkDecision>(Tasks.WorkShape, { Review: (w, at) => ok({ Done: { set: { doneAt: at }, events: {} } }) }),
    archive: decide<Tasks.ArchiveWorkDecision>(Tasks.WorkShape, { Done: (w) => ok({ Archived: { set: { reviewer: w.reviewer }, events: {} } }) }),
    clearNote: decide<Tasks.ClearNoteWorkDecision>(Tasks.WorkShape, { Draft: () => ok({ Draft: { set: { note: undefined }, events: {} } }) }),
    touch: decide<Tasks.TouchWorkDecision>(Tasks.WorkShape, { Draft: () => ok({ Draft: { set: {}, events: {} } }) }),
};

export const tag: Tasks.TagCommands = {
    make: decide<Tasks.MakeTagDecision>(Tasks.TagShape, (id, name, color) => ok({ Tag: { set: { id, name, color }, events: {} } })),
    recolor: decide<Tasks.RecolorTagDecision>(Tasks.TagShape, (t, color) => ok({ Tag: { set: { color }, events: {} } })),
};
`,
        );
        const r = tscIn(dir, 'src/ok.ts');
        expect(r.output).toBe('');
        expect(r.code).toBe(0);
    });

    test('a wrong set is a compile error whose message names the field', async () => {
        const cases: [string, string][] = [
            // a field not in changes
            [
                `decide<Tasks.SubmitWorkDecision>(Tasks.WorkShape, { Draft: (w, reviewer) => ok({ Review: { set: { reviewer, tags: [] }, events: {} } }) })`,
                "'tags' does not exist in type '{ readonly reviewer: string; }'",
            ],
            // the new field of the target state left out
            [
                `decide<Tasks.FinishWorkDecision>(Tasks.WorkShape, { Review: () => ok({ Done: { set: {}, events: {} } }) })`,
                "Property 'doneAt' is missing in type '{}'",
            ],
            // a field in changes left out (rule 5)
            [
                `decide<Tasks.RenameWorkDecision>(Tasks.WorkShape, { Draft: (w, title, at) => ok({ Draft: { set: { title }, events: { Renamed: { type: 'Renamed', workId: w.id } } } }), Review: (w, title, at) => ok({ Review: { set: { title, updatedAt: at }, events: { Renamed: { type: 'Renamed', workId: w.id } } } }) })`,
                "Property 'updatedAt' is missing in type '{ title: string; }'",
            ],
            // nothing to set
            [
                `decide<Tasks.TouchWorkDecision>(Tasks.WorkShape, { Draft: () => ok({ Draft: { set: { title: 'x' }, events: {} } }) })`,
                "'title' does not exist in type 'NoChanges'",
            ],
            // a carried-over field not in changes
            [
                `decide<Tasks.SubmitWorkDecision>(Tasks.WorkShape, { Draft: (w, reviewer) => ok({ Review: { set: { reviewer, draftNo: 2 }, events: {} } }) })`,
                "'draftNo' does not exist in type '{ readonly reviewer: string; }'",
            ],
            // without states
            [
                `decide<Tasks.RecolorTagDecision>(Tasks.TagShape, (t, color) => ok({ Tag: { set: { color, name: 'x' }, events: {} } }))`,
                "'name' does not exist in type '{ readonly color: string; }'",
            ],
        ];
        await writeFile(
            path.join(dir, 'src', 'wrong.ts'),
            [`import { Tasks, decide, ok } from '../generated/index.js';`, ...cases.map(([body], i) => `export const c${i} = ${body};`), ''].join('\n'),
        );
        const r = tscIn(dir, 'src/wrong.ts');
        expect(r.code).not.toBe(0);
        const lines = r.output.split('\n');
        cases.forEach(([, message], i) => {
            const errors = lines.filter((l) => l.startsWith(`src/wrong.ts(${i + 2},`));
            expect(errors.join('\n')).toContain(message);
        });
        expect(lines.filter((l) => l.startsWith('src/wrong.ts(')).length).toBe(cases.length);
    });

    test('decide makes the aggregates: carries over, drops, sets; a factory from set; without states; errors pass through', async () => {
        const { decide, ok, err } = await import(path.join(dir, 'generated', '_runtime.ts'));
        const { WorkShape, TagShape } = await import(path.join(dir, 'generated', 'Tasks.ts'));
        const review = { state: 'Review', id: 'w1', title: 'T', tags: ['a'], draftNo: 3, reviewer: 'r' };
        const calls: unknown[][] = [];
        const finish = decide(WorkShape, {
            Review: (...args: unknown[]) => (calls.push(args), ok({ Done: { set: { doneAt: 5 }, events: { X: 1 } } })),
        });
        // common fields carried over (`note` absent stays absent), `reviewer` carried over, `draftNo` dropped
        expect(finish(review, 5)).toEqual({
            ok: true,
            value: { Done: { aggregate: { state: 'Done', id: 'w1', title: 'T', tags: ['a'], reviewer: 'r', doneAt: 5 }, events: { X: 1 } } },
        });
        expect(calls).toEqual([[review, 5]]);
        // the handler of the input's state; set replaces, `undefined` clears
        const rename = decide(WorkShape, {
            Draft: () => ok({ Draft: { set: { note: undefined, title: 'U' }, events: {} } }),
            Review: () => err({ type: 'NotReady' }),
        });
        const draft = { state: 'Draft', id: 'w1', title: 'T', note: 'n', tags: [], draftNo: 1 };
        expect(rename(draft).value.Draft.aggregate).toEqual({ state: 'Draft', id: 'w1', title: 'U', tags: [], draftNo: 1 });
        expect(rename(review)).toEqual({ ok: false, error: { type: 'NotReady' } });
        // several outcomes: only the one decided, keyed by its state
        const two = decide(WorkShape, { Draft: () => ok({ Review: { set: { reviewer: 'r' }, events: {} }, Draft: undefined }) });
        expect(two(draft).value).toEqual({
            Review: { aggregate: { state: 'Review', id: 'w1', title: 'T', note: 'n', tags: [], draftNo: 1, reviewer: 'r' }, events: {} },
        });
        // a factory: the aggregate is the state and set
        const open = decide(WorkShape, (id: string) =>
            ok({ Draft: { set: { updatedAt: undefined, id, title: 'T', note: undefined, tags: [], draftNo: 1 }, events: {} } }),
        );
        expect(open('w2').value.Draft.aggregate).toEqual({ state: 'Draft', id: 'w2', title: 'T', tags: [], draftNo: 1 });
        // without states: no state tag; a field not in set is taken from the input
        const recolor = decide(TagShape, (t: object, color: string) => ok({ Tag: { set: { color }, events: {} } }));
        expect(recolor({ id: 't', name: 'N', color: 'red' }, 'blue').value.Tag.aggregate).toEqual({ id: 't', name: 'N', color: 'blue' });
        const make = decide(TagShape, (id: string) => ok({ Tag: { set: { id, name: 'N', color: 'red' }, events: {} } }));
        expect(make('t').value.Tag.aggregate).toEqual({ id: 't', name: 'N', color: 'red' });
    });
});
