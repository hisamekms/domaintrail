import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { generateTypeScript } from '../src/generator/typescript.js';
import { check, checkSales, codes, only } from './helpers.js';

const TSC = path.join(import.meta.dir, '..', 'node_modules', '.bin', 'tsc');

function tscIn(cwd: string, ...files: string[]): { code: number; output: string } {
    const r = Bun.spawnSync(
        [process.execPath, TSC, '--noEmit', '--strict', '--target', 'ES2023', '--module', 'preserve', '--moduleResolution', 'bundler', '--lib', 'ES2023,DOM', ...files],
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

const stateful = (commands: string): string => `
  id WorkId: UUID
  event Done { workId: WorkId }
  aggregate Work {
    id: WorkId
    state Draft
    state InProgress
    state Completed
${commands}
  }`;

describe('emits in the DSL', () => {
    test('entries take a multiplicity and `when`; the Typed Model holds them', async () => {
        const a = await check({ 'tasks.dt': WORK });
        expect(a.diagnostics).toEqual([]);
        const cmd = (name: string) => a.model!.elements['Tasks.Work'].commands!.find((c) => c.name === name)!;
        expect(cmd('progress').emits).toEqual([
            { event: 'Tasks.StepRecorded', cardinality: 'one', multiplicity: '', lower: 1, upper: 1 },
            { event: 'Tasks.WorkCompleted', cardinality: 'one', multiplicity: '', lower: 1, upper: 1, when: { from: [], to: ['Completed'] } },
        ]);
        expect(cmd('cancel').emits[1].when).toEqual({ from: ['InProgress'], to: [] });
        expect(cmd('add').emits.map((e) => [e.multiplicity, e.cardinality, e.lower, e.upper])).toEqual([
            ['[1..*]', 'nonEmpty', 1, undefined],
            ['?', 'optional', 0, 1],
        ]);
        expect(cmd('batch').emits[0]).toMatchObject({ multiplicity: '[2..5]', lower: 2, upper: 5 });
    });

    test('`when` is still usable as a field and parameter name', async () => {
        const a = await checkSales(`
  id OrderId: UUID
  event Moved { orderId: OrderId when: Timestamp }
  aggregate Order {
    id: OrderId
    when: Timestamp
    state Draft
    state Done
    command move(when: Timestamp) Draft -> Done emits Moved when Draft -> Done
  }`);
        expect(a.diagnostics).toEqual([]);
        expect(a.model!.elements['Sales.Order'].fields.map((f) => f.name)).toContain('when');
    });

    test('M006: the states of `when` are sources / targets of the command, and it matches an outcome', async () => {
        const a = await checkSales(
            stateful(`
    command a() Draft -> InProgress emits Done when Completed ->
    command b() Draft -> InProgress emits Done when -> Completed
    command c() Draft -> Draft, InProgress -> Completed emits Done when Draft -> Completed
    command d() Draft -> Draft emits Done when ->
    create command e(id: WorkId) -> Draft emits Done when Draft ->
    command f() Draft -> Draft emits Done when Missing ->`),
        );
        expect(only(a, 'M006').map((d) => [d.message, d.hint])).toEqual([
            ["State 'Completed' is not a source state of command 'a', so 'Done' can never be emitted from it.", "use a source state of 'a': Draft"],
            ["State 'Completed' is not a target state of command 'b', so 'Done' can never be emitted when it ends there.", "use a target state of 'b': InProgress"],
            ["'when' matches no transition of command 'c', so 'Done' is never emitted.", "its outcomes are Draft -> Draft, InProgress -> Completed; leave out one side of 'when', or remove 'Done'"],
            ["'when' needs a source or a target state.", "write 'when Draft ->' (from a state) or 'when -> Draft' (into a state)"],
            ["Factory command 'e' has no source state to select by.", "select by the new aggregate's state: 'when -> Draft'"],
            ["Cannot resolve state 'Missing' in this aggregate.", "use a state of 'Work': Draft, InProgress, Completed"],
        ]);
    });

    test('M006: an aggregate without states has no `when`', async () => {
        const a = await checkSales(`
  id CustomerId: UUID
  event Renamed { customerId: CustomerId }
  aggregate Customer {
    id: CustomerId
    command rename() emits Renamed when -> Customer
  }`);
        expect(codes(a)).toContain('M006');
        expect(only(a, 'M006').map((d) => d.message)).toContain("'when' selects outcomes by state, but aggregate 'Customer' has no states.");
    });

    test('M011: the events of a command have distinct names, since its result is keyed by them', async () => {
        const a = await check({
            'billing.dt': 'context Billing { id InvoiceId: UUID event Done { invoiceId: InvoiceId } }',
            'sales.dt': `context Sales {${stateful(`
    command a() Draft -> Draft emits Done, Done when Draft ->
    command b() Draft -> Draft emits Done, Billing.Done`)}
}`,
        });
        expect(only(a, 'M011').map((d) => [d.message, d.hint])).toEqual([
            ["Event 'Done' is listed more than once in 'emits' of 'Work.a'; the events of its result are keyed by name.", "list it once, with a multiplicity such as 'Done[1..*]' or 'Done?'"],
            ["Events 'Sales.Done' and 'Billing.Done' of 'Work.b' have the same name, and the events of its result are keyed by name.", 'rename one of the events'],
        ]);
    });

    test('M020 (warning): a factory takes the ID of the new aggregate', async () => {
        const a = await checkSales(`
  id OrderId: UUID
  aggregate Order {
    id: OrderId
    create command place(note: String)
    create command import(id: OrderId)
    create command maybe(id: OrderId?)
  }`);
        expect(only(a, 'M020').map((d) => [d.severity, d.message, d.hint])).toEqual([
            ['warning', "Factory command 'place' of 'Order' has no parameter of type 'OrderId', so it would have to make the new Order's ID itself; commands are pure.", "pass the ID in: 'create command place(id: OrderId, …)', and let the caller generate it"],
            ['warning', "Factory command 'maybe' of 'Order' has no parameter of type 'OrderId', so it would have to make the new Order's ID itself; commands are pure.", "pass the ID in: 'create command maybe(id: OrderId, …)', and let the caller generate it"],
        ]);
    });
});

describe('emits in the generated TypeScript', () => {
    let dir: string;
    let code: string;

    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-emits-'));
        const a = await check({ 'tasks.dt': WORK });
        expect(a.diagnostics).toEqual([]);
        await mkdir(path.join(dir, 'generated'));
        for (const f of generateTypeScript(a.model!)) await writeFile(path.join(dir, 'generated', f.path), f.content);
        code = await readFile(path.join(dir, 'generated', 'Tasks.ts'), 'utf8');
        await mkdir(path.join(dir, 'src'));
    });

    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test('the success value is keyed by the outcome; events by their name, typed by their multiplicity', () => {
        expect(code).toContain(
            `/**
 * Work.progress (InProgress -> InProgress | Completed)
 * @emits StepRecorded — exactly once when the command succeeds
 * @emits WorkCompleted — exactly once when it ends in Completed
 */
export type ProgressWork = (
    work: InProgressWork,
    at: Timestamp,
) => Result<
    | {
          readonly InProgress: {
              readonly aggregate: InProgressWork;
              readonly events: { readonly StepRecorded: StepRecorded };
          };
          readonly Completed?: never;
      }
    | {
          readonly Completed: {
              readonly aggregate: CompletedWork;
              readonly events: { readonly StepRecorded: StepRecorded; readonly WorkCompleted: WorkCompleted };
          };
          readonly InProgress?: never;
      },
    NotReady
>;`,
        );
        expect(code).toContain('readonly events: { readonly WorkOpened: WorkOpened; readonly ItemAdded: readonly ItemAdded[] };');
        expect(code).toContain('readonly events: { readonly ItemAdded: readonly [ItemAdded, ...ItemAdded[]]; readonly NoteChanged?: NoteChanged };');
        expect(code).toContain('readonly events: { /** between 2 and 5 */ readonly ItemAdded: readonly ItemAdded[] };');
        expect(code).toContain(' * @emits ItemAdded[0..*] — zero or more when the command succeeds\n');
        expect(code).toContain(' * @emits ItemAdded[1..*] — one or more when the command succeeds\n * @emits NoteChanged? — at most once when the command succeeds\n');
        expect(code).toContain(' * @emits ItemAdded[2..5] — between 2 and 5 when the command succeeds (not checked by the types)\n');
    });

    test('events that depend on the source state get handlers per state, documented per handler', () => {
        expect(code).toContain(' * @emits RefundRequested — exactly once when it comes from InProgress\n */\nexport type CancelWork = <S extends DraftWork | InProgressWork>(');
        expect(code).toContain(
            `export type CancelWorkByState = {
    /** @emits WorkCancelled — exactly once when the command succeeds */
    readonly Draft: (work: DraftWork) => Result<{
        readonly Cancelled: {
            readonly aggregate: CancelledWork;
            readonly events: { readonly WorkCancelled: WorkCancelled };
        };
    }, never>;
    /**
     * @emits WorkCancelled — exactly once when the command succeeds
     * @emits RefundRequested — exactly once when the command succeeds
     */
    readonly InProgress: (work: InProgressWork) => Result<{
        readonly Cancelled: {
            readonly aggregate: CancelledWork;
            readonly events: { readonly WorkCancelled: WorkCancelled; readonly RefundRequested: RefundRequested };
        };
    }, never>;
};`,
        );
        // events that depend on the target only: the input state still decides nothing, so no handlers
        expect(code).not.toContain('ProgressWorkByState');
    });

    test('implementations that follow the contract compile; outcome and eventList type what they return', async () => {
        await writeFile(
            path.join(dir, 'src', 'ok.ts'),
            `import { byState, eventList, ok, outcome, err, type Tasks } from '../generated/index.js';
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
    cancel: byState<Tasks.CancelWorkByState>({
        Draft: (work) => ok({ Cancelled: { aggregate: { ...work, state: 'Cancelled' }, events: { WorkCancelled: ev('WorkCancelled', work) } } }),
        InProgress: (work) =>
            ok({ Cancelled: { aggregate: { ...work, state: 'Cancelled' }, events: { WorkCancelled: ev('WorkCancelled', work), RefundRequested: ev('RefundRequested', work) } } }),
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
            wrongOutcome: [`ok({ InProgress: { aggregate: work, events: { StepRecorded: step(work), WorkCompleted: done(work) } } })`, "'WorkCompleted' does not exist in type"],
            undeclared: [`ok({ InProgress: { aggregate: work, events: { StepRecorded: step(work), NoteChanged: { type: 'NoteChanged', workId: work.id } } } })`, "'NoteChanged' does not exist in type"],
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
            const block = lines.slice(at, lines.findIndex((l, j) => j > at && l.startsWith('src/'))).join('\n');
            expect(block).toContain(message);
        });
        expect(errorAt(8)).toContain("Type 'StepRecorded' is not assignable to type 'never'");
        expect(r.output).toContain("Source has 0 element(s) but target requires 1.");
    });

    test('outcome and eventList: the key as `to`; events flattened, absent ones skipped, sorted by type', async () => {
        const { outcome, eventList, ok } = await import(path.join(dir, 'generated', '_runtime.ts'));
        const value = { Completed: { aggregate: { id: 1 }, events: { WorkCompleted: { type: 'WorkCompleted' }, StepRecorded: { type: 'StepRecorded' } } }, InProgress: undefined };
        expect(outcome(value)).toEqual({ to: 'Completed', aggregate: { id: 1 }, events: value.Completed.events });
        const a = { type: 'ItemAdded', n: 1 };
        const b = { type: 'ItemAdded', n: 2 };
        expect(eventList({ NoteChanged: undefined, ItemAdded: [a, b], WorkOpened: { type: 'WorkOpened' } })).toEqual([a, b, { type: 'WorkOpened' }]);
        expect(eventList({})).toEqual([]);
        expect(ok(1)).toEqual({ ok: true, value: 1 });
    });
});
