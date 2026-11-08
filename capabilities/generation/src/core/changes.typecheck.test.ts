// The generated TypeScript of `changes`, type-checked by tsc.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { generateTypeScript } from './typescript.js';
import { check } from '../test-helpers.js';

const TSC = path.join(import.meta.dir, '..', '..', '..', '..', 'node_modules', '.bin', 'tsc');

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

describe('changes in the generated TypeScript', () => {
    let dir: string;

    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-changes-'));
        const a = await work(COMMANDS);
        expect(a.diagnostics).toEqual([]);
        await mkdir(path.join(dir, 'generated'));
        for (const f of generateTypeScript(a.model!)) await writeFile(path.join(dir, 'generated', f.path), f.content);
        await mkdir(path.join(dir, 'src'));
    });

    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test('decisions that follow the contract compile into the commands with decide, without assertions', async () => {
        await writeFile(
            path.join(dir, 'src', 'ok.ts'),
            `import { Tasks, decide, err, ok } from '../generated/index.js';

export const work: Tasks.WorkCommands = {
    open: decide<Tasks.OpenWorkDecision>(Tasks.WorkShape, ({ id, title }) => ok({ Draft: { set: { updatedAt: undefined, id, title, note: undefined, tags: [], draftNo: 1 }, events: {} } })),
    rename: decide<Tasks.RenameWorkDecision>(Tasks.WorkShape, {
        Draft: (w, { newTitle, at }) => (newTitle === '' ? err({ type: 'NotReady' }) : ok({ Draft: { set: { title: newTitle, updatedAt: at }, events: { Renamed: { type: 'Renamed', workId: w.id } } } })),
        Review: (w, { newTitle, at }) => ok({ Review: { set: { title: newTitle, updatedAt: at }, events: { Renamed: { type: 'Renamed', workId: w.id } } } }),
    }),
    submit: decide<Tasks.SubmitWorkDecision>(Tasks.WorkShape, { Draft: (w, { reviewer }) => ok({ Review: { set: { reviewer }, events: {} } }) }),
    renumber: decide<Tasks.RenumberWorkDecision>(Tasks.WorkShape, {
        Draft: (w, { n }) => ok({ Draft: { set: { draftNo: n }, events: {} } }),
        // a command that changes a field only in some cases gives the old value in the others
        Review: (w, { n }) => ok({ Review: { set: { draftNo: n > w.draftNo ? n : w.draftNo }, events: {} } }),
    }),
    finish: decide<Tasks.FinishWorkDecision>(Tasks.WorkShape, { Review: (w, { at }) => ok({ Done: { set: { doneAt: at }, events: {} } }) }),
    archive: decide<Tasks.ArchiveWorkDecision>(Tasks.WorkShape, { Done: (w) => ok({ Archived: { set: { reviewer: w.reviewer }, events: {} } }) }),
    clearNote: decide<Tasks.ClearNoteWorkDecision>(Tasks.WorkShape, { Draft: () => ok({ Draft: { set: { note: undefined }, events: {} } }) }),
    touch: decide<Tasks.TouchWorkDecision>(Tasks.WorkShape, { Draft: () => ok({ Draft: { set: {}, events: {} } }) }),
};

export const tag: Tasks.TagCommands = {
    make: decide<Tasks.MakeTagDecision>(Tasks.TagShape, ({ id, name, color }) => ok({ Tag: { set: { id, name, color }, events: {} } })),
    recolor: decide<Tasks.RecolorTagDecision>(Tasks.TagShape, (t, { color }) => ok({ Tag: { set: { color }, events: {} } })),
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
                `decide<Tasks.SubmitWorkDecision>(Tasks.WorkShape, { Draft: (w, { reviewer }) => ok({ Review: { set: { reviewer, tags: [] }, events: {} } }) })`,
                "'tags' does not exist in type '{ readonly reviewer: string; }'",
            ],
            // the new field of the target state left out
            [
                `decide<Tasks.FinishWorkDecision>(Tasks.WorkShape, { Review: () => ok({ Done: { set: {}, events: {} } }) })`,
                "Property 'doneAt' is missing in type '{}'",
            ],
            // a field in changes left out (rule 5)
            [
                `decide<Tasks.RenameWorkDecision>(Tasks.WorkShape, { Draft: (w, { newTitle: title }) => ok({ Draft: { set: { title }, events: { Renamed: { type: 'Renamed', workId: w.id } } } }), Review: (w, { newTitle: title, at }) => ok({ Review: { set: { title, updatedAt: at }, events: { Renamed: { type: 'Renamed', workId: w.id } } } }) })`,
                "Property 'updatedAt' is missing in type '{ title: string; }'",
            ],
            // nothing to set
            [
                `decide<Tasks.TouchWorkDecision>(Tasks.WorkShape, { Draft: () => ok({ Draft: { set: { title: 'x' }, events: {} } }) })`,
                "'title' does not exist in type 'NoChanges'",
            ],
            // a carried-over field not in changes
            [
                `decide<Tasks.SubmitWorkDecision>(Tasks.WorkShape, { Draft: (w, { reviewer }) => ok({ Review: { set: { reviewer, draftNo: 2 }, events: {} } }) })`,
                "'draftNo' does not exist in type '{ readonly reviewer: string; }'",
            ],
            // without states
            [
                `decide<Tasks.RecolorTagDecision>(Tasks.TagShape, (t, { color }) => ok({ Tag: { set: { color, name: 'x' }, events: {} } }))`,
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
});
