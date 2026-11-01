import { describe, expect, test } from 'bun:test';
import { check, checkSales, codes, only } from '../../test-helpers.js';

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
            [
                "State 'Completed' is not a target state of command 'b', so 'Done' can never be emitted when it ends there.",
                "use a target state of 'b': InProgress",
            ],
            [
                "'when' matches no transition of command 'c', so 'Done' is never emitted.",
                "its outcomes are Draft -> Draft, InProgress -> Completed; leave out one side of 'when', or remove 'Done'",
            ],
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
            [
                'warning',
                "Factory command 'place' of 'Order' has no parameter of type 'OrderId', so it would have to make the new Order's ID itself; commands are pure.",
                "pass the ID in: 'create command place(id: OrderId, …)', and let the caller generate it",
            ],
            [
                'warning',
                "Factory command 'maybe' of 'Order' has no parameter of type 'OrderId', so it would have to make the new Order's ID itself; commands are pure.",
                "pass the ID in: 'create command maybe(id: OrderId, …)', and let the caller generate it",
            ],
        ]);
    });
});
