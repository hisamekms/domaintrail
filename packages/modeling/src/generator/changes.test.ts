// What `changes` makes of the generated TypeScript: the `set` of a decision, the JSDoc, `decide` (the DSL and its checks:
// core/checker/changes.test.ts).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { generateTypeScript } from './typescript.js';
import { check } from './test-helpers.js';

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
