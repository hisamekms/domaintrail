// What `emits` makes of the generated TypeScript, and the generator's check of the events' names (M011) (the DSL and its
// checks: contexts/modeling/src/domain/rules/emits.test.ts).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { generateTypeScript } from './typescript.js';
import { check, only } from '../test-helpers.js';

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

describe('emits: the name check of the generator (M011)', () => {
    test('M011: the events of a command have distinct names, since its result is keyed by them', async () => {
        const a = await check({
            'billing.dt': 'context Billing { id InvoiceId: UUID event Done { invoiceId: InvoiceId } }',
            'sales.dt': `context Sales {${stateful(`
    command a() Draft -> Draft emits Done, Done when Draft ->
    command b() Draft -> Draft emits Done, Billing.Done`)}
}`,
        });
        expect(only(a, 'M011').map((d) => [d.message, d.hint])).toEqual([
            [
                "Event 'Done' is listed more than once in 'emits' of 'Work.a'; the events of its result are keyed by name.",
                "list it once, with a multiplicity such as 'Done[1..*]' or 'Done?'",
            ],
            [
                "Events 'Sales.Done' and 'Billing.Done' of 'Work.b' have the same name, and the events of its result are keyed by name.",
                'rename one of the events',
            ],
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
 * @changes none — the command changes no common field
 * @emits StepRecorded — exactly once when the command succeeds
 * @emits WorkCompleted — exactly once when it ends in Completed
 * @see tasks.dt:19
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
        expect(code).toContain(
            ' * @emits ItemAdded[1..*] — one or more when the command succeeds\n * @emits NoteChanged? — at most once when the command succeeds\n',
        );
        expect(code).toContain(' * @emits ItemAdded[2..5] — between 2 and 5 when the command succeeds (not checked by the types)\n');
    });

    test('events that depend on the source state make the contract generic, documented per source state', () => {
        expect(code).toContain(
            ' * @emits RefundRequested — exactly once when it comes from InProgress\n * @see tasks.dt:24\n */\nexport type CancelWork = <S extends DraftWork | InProgressWork>(',
        );
        expect(code).toContain(
            `) => {
    /** @emits WorkCancelled — exactly once when the command succeeds */
    readonly Draft: Result<{
        readonly Cancelled: {
            readonly aggregate: CancelledWork;
            readonly events: { readonly WorkCancelled: WorkCancelled };
        };
    }, never>;
    /**
     * @emits WorkCancelled — exactly once when the command succeeds
     * @emits RefundRequested — exactly once when the command succeeds
     */
    readonly InProgress: Result<{
        readonly Cancelled: {
            readonly aggregate: CancelledWork;
            readonly events: { readonly WorkCancelled: WorkCancelled; readonly RefundRequested: RefundRequested };
        };
    }, never>;
}[S['state']];`,
        );
        expect(code).toContain(
            `export type CancelWorkDecision = {
    /** @emits WorkCancelled — exactly once when the command succeeds */
    readonly Draft: (work: DraftWork) => Result<{
        readonly Cancelled: {
            readonly set: NoChanges;
            readonly events: { readonly WorkCancelled: WorkCancelled };
        };
    }, never>;`,
        );
        // events that depend on the target only: the input state decides nothing, so a plain function
        expect(code).toContain('export type ProgressWork = (\n    work: InProgressWork,');
    });

    test('outcome and eventList: the key as `to`; events flattened, absent ones skipped, sorted by type', async () => {
        const { outcome, eventList, ok } = await import(path.join(dir, 'generated', '_runtime.ts'));
        const value = {
            Completed: { aggregate: { id: 1 }, events: { WorkCompleted: { type: 'WorkCompleted' }, StepRecorded: { type: 'StepRecorded' } } },
            InProgress: undefined,
        };
        expect(outcome(value)).toEqual({ to: 'Completed', aggregate: { id: 1 }, events: value.Completed.events });
        const a = { type: 'ItemAdded', n: 1 };
        const b = { type: 'ItemAdded', n: 2 };
        expect(eventList({ NoteChanged: undefined, ItemAdded: [a, b], WorkOpened: { type: 'WorkOpened' } })).toEqual([a, b, { type: 'WorkOpened' }]);
        expect(eventList({})).toEqual([]);
        expect(ok(1)).toEqual({ ok: true, value: 1 });
    });
});
