// The generated TypeScript of `emits`, type-checked by tsc.
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

const WORK = `context Tasks {
  id WorkId: UUID
  event WorkOpened { workId: WorkId }
  event StepRecorded { workId: WorkId }
  event WorkCompleted { workId: WorkId }
  event WorkCancelled { workId: WorkId }
  event RefundRequested { workId: WorkId }
  event ItemAdded { workId: WorkId }
  event NoteChanged { workId: WorkId }
  error NotReady
  aggregate Work {
    id: WorkId
    state Draft
    state InProgress
    state Completed { completedAt: Timestamp }
    state Cancelled

    create command open(id: WorkId) -> Draft emits WorkOpened, ItemAdded[0..*]
    command progress(at: Timestamp)
      InProgress -> InProgress | Completed
      emits StepRecorded,
            WorkCompleted when -> Completed
      errors NotReady
    command cancel()
      Draft | InProgress -> Cancelled
      emits WorkCancelled, RefundRequested when InProgress ->
    command add() Draft -> Draft emits ItemAdded[1..*], NoteChanged?
    command batch() Draft -> Draft emits ItemAdded[2..5]
    command start() Draft -> InProgress
  }
}
`;

describe('emits in the generated TypeScript', () => {
    let dir: string;

    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-emits-'));
        const a = await check({ 'tasks.dt': WORK });
        expect(a.diagnostics).toEqual([]);
        await mkdir(path.join(dir, 'generated'));
        for (const f of generateTypeScript(a.model!)) await writeFile(path.join(dir, 'generated', f.path), f.content);
        await mkdir(path.join(dir, 'src'));
    });

    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test('implementations that follow the contract compile; outcome and eventList type what they return', async () => {
        await writeFile(
            path.join(dir, 'src', 'ok.ts'),
            `import { Tasks, decide, eventList, ok, outcome, err } from '../generated/index.js';
const ev = <T extends string>(type: T, work: Tasks.Work) => ({ type, workId: work.id });

export const commands: Tasks.WorkCommands = {
    open: (id) => ok({ Draft: { aggregate: { state: 'Draft', id }, events: { WorkOpened: { type: 'WorkOpened', workId: id }, ItemAdded: [] } } }),
    progress: (work, at) => {
        if (at.getTime() < 0) return err({ type: 'NotReady' });
        if (at.getTime() === 0) return ok({ InProgress: { aggregate: work, events: { StepRecorded: ev('StepRecorded', work) } } });
        return ok({
            Completed: {
                aggregate: { ...work, state: 'Completed', completedAt: at },
                events: { StepRecorded: ev('StepRecorded', work), WorkCompleted: ev('WorkCompleted', work) },
            },
        });
    },
    cancel: decide<Tasks.CancelWorkDecision>(Tasks.WorkShape, {
        Draft: (work) => ok({ Cancelled: { set: {}, events: { WorkCancelled: ev('WorkCancelled', work) } } }),
        InProgress: (work) => ok({ Cancelled: { set: {}, events: { WorkCancelled: ev('WorkCancelled', work), RefundRequested: ev('RefundRequested', work) } } }),
    }),
    add: (work) => ok({ Draft: { aggregate: work, events: { ItemAdded: [ev('ItemAdded', work)] } } }),
    batch: (work) => ok({ Draft: { aggregate: work, events: { ItemAdded: [ev('ItemAdded', work), ev('ItemAdded', work)] } } }),
    start: (work) => ok({ InProgress: { aggregate: { ...work, state: 'InProgress' }, events: {} } }),
};

declare const inProgress: Tasks.InProgressWork;
declare const at: Date;
const r = commands.progress(inProgress, at);
if (r.ok) {
    const o = outcome(r.value);
    const to: 'InProgress' | 'Completed' = o.to;
    if (o.to === 'Completed') {
        const done: Tasks.CompletedWork = o.aggregate;
        const completed: Tasks.WorkCompleted = o.events.WorkCompleted;
    }
    const all: readonly (Tasks.StepRecorded | Tasks.WorkCompleted)[] = eventList(o.events);
    // @ts-expect-error not only steps
    const steps: readonly Tasks.StepRecorded[] = eventList(o.events);
}
const s = commands.start({ state: 'Draft', id: inProgress.id });
if (s.ok) {
    const none: readonly never[] = eventList(outcome(s.value).events);
}
const events: readonly Tasks.WorkEvent[] = r.ok ? eventList(outcome(r.value).events) : [];
`,
        );
        const r = tscIn(dir, 'src/ok.ts');
        expect(r.output).toBe('');
        expect(r.code).toBe(0);
    });

    test('a wrong implementation is a compile error whose message names the event', async () => {
        const cases: Record<string, [string, string]> = {
            missing: [
                `ok({ Completed: { aggregate: { ...work, state: 'Completed', completedAt: at }, events: { StepRecorded: step(work) } } })`,
                "Property 'WorkCompleted' is missing in type",
            ],
            wrongOutcome: [
                `ok({ InProgress: { aggregate: work, events: { StepRecorded: step(work), WorkCompleted: done(work) } } })`,
                "'WorkCompleted' does not exist in type",
            ],
            undeclared: [
                `ok({ InProgress: { aggregate: work, events: { StepRecorded: step(work), NoteChanged: { type: 'NoteChanged', workId: work.id } } } })`,
                "'NoteChanged' does not exist in type",
            ],
            twoOutcomes: [
                `ok({ InProgress: { aggregate: work, events: { StepRecorded: step(work) } }, Completed: { aggregate: { ...work, state: 'Completed', completedAt: at }, events: { StepRecorded: step(work), WorkCompleted: done(work) } } })`,
                "Types of property 'Completed' are incompatible",
            ],
        };
        const noEvents = `export const start: Tasks.StartWork = (work) => ok({ InProgress: { aggregate: { ...work, state: 'InProgress' }, events: { StepRecorded: step(work) } } });`;
        const empty = `export const add: Tasks.AddWork = (work) => ok({ Draft: { aggregate: work, events: { ItemAdded: [] } } });`;
        await writeFile(
            path.join(dir, 'src', 'wrong.ts'),
            [
                `import { ok, type Tasks } from '../generated/index.js';`,
                `const step = (w: Tasks.Work): Tasks.StepRecorded => ({ type: 'StepRecorded', workId: w.id });`,
                `const done = (w: Tasks.Work): Tasks.WorkCompleted => ({ type: 'WorkCompleted', workId: w.id });`,
                ...Object.entries(cases).map(([name, [body]]) => `export const ${name}: Tasks.ProgressWork = (work, at) => ${body};`),
                noEvents,
                empty,
                '',
            ].join('\n'),
        );
        const r = tscIn(dir, 'src/wrong.ts');
        expect(r.code).not.toBe(0);
        const lines = r.output.split('\n');
        const errorAt = (line: number) => lines.filter((l) => l.startsWith(`src/wrong.ts(${line},`)).join('\n');
        Object.values(cases).forEach(([, message], i) => {
            const at = lines.findIndex((l) => l.startsWith(`src/wrong.ts(${i + 4},`));
            expect(at).toBeGreaterThanOrEqual(0);
            // the message is the error line or one of the lines that elaborate it
            const block = lines
                .slice(
                    at,
                    lines.findIndex((l, j) => j > at && l.startsWith('src/')),
                )
                .join('\n');
            expect(block).toContain(message);
        });
        expect(errorAt(8)).toContain("Type 'StepRecorded' is not assignable to type 'never'");
        expect(r.output).toContain('Source has 0 element(s) but target requires 1.');
    });
});
