import { describe, expect, test } from 'bun:test';
import { analyze } from '../src/core/analyze.js';
import { loadWorkspace } from '../src/core/files.js';
import { EXAMPLES, checkSales, only } from './helpers.js';

/** The M022 messages of a context body, each with its hint. */
async function m022(body: string): Promise<string[]> {
    return only(await checkSales(body), 'M022').map((d) => `${d.message} | ${d.hint}`);
}

const order = (members: string, decls: string): string => `
  id OrderId: UUID
  aggregate Order {
    id: OrderId
${members}
  }
${decls}`;

describe('M022: event and error fields named after their source', () => {
    test('a parameter of another name and the same type: message and hint', async () => {
        expect(await m022(order('    create command place(id: OrderId, at: Timestamp) emits Placed', 'event Placed { orderId: OrderId placedAt: Timestamp }'))).toEqual([
            "Field 'placedAt' of event 'Placed' has no source of the same name in command 'place'; parameter 'at' has its type. | name them alike: rename the parameter 'at' to 'placedAt' (or the event field to 'at'), so that the value's source is clear",
        ]);
    });

    test('a source of the same name and type is fine; the ID type is exempt; the location is the emits entry', async () => {
        const a = await checkSales(order('    create command place(id: OrderId, placedAt: Timestamp) emits Placed', 'event Placed { order: OrderId placedAt: Timestamp }'));
        expect(only(a, 'M022')).toEqual([]);
        const b = await checkSales(order('    create command place(id: OrderId, at: Timestamp)\n      emits Placed', 'event Placed { orderId: OrderId placedAt: Timestamp }'));
        expect(only(b, 'M022').map((d) => [d.start.line, d.start.column, d.end.column])).toEqual([[7, 13, 19]]);
    });

    test('a computed value — no source of its type — and Int, Decimal and Bool fields are not reported', async () => {
        const body = order(
            '    lines: Int\n    create command place(id: OrderId, count: Int, rate: Decimal, flag: Bool, note: String) emits Placed',
            'event Placed { orderId: OrderId total: Int share: Decimal urgent: Bool placedAt: Timestamp }',
        );
        expect(await m022(body)).toEqual([]);
    });

    test('the same name with another type is reported when some source has the type', async () => {
        const body = order('    create command place(id: OrderId, placedAt: String, at: Timestamp) emits Placed', 'event Placed { orderId: OrderId placedAt: Timestamp }');
        expect(await m022(body)).toEqual([
            "Field 'placedAt' of event 'Placed' has no source of the same name and type in command 'place'; parameter 'at' has its type. | name them alike: rename the parameter 'at' to 'placedAt' (or the event field to 'at'), so that the value's source is clear",
        ]);
    });

    test('optionality does not matter; collections match collections of the same element type', async () => {
        expect(await m022(order('    create command place(id: OrderId, placedAt: Timestamp?) emits Placed', 'event Placed { orderId: OrderId placedAt: Timestamp }'))).toEqual([]);
        expect(await m022(order('    create command place(id: OrderId, at: Timestamp?) emits Placed', 'event Placed { orderId: OrderId placedAt: Timestamp }'))).toHaveLength(1);
        // a single value is not a source of a list, and a list not of a single value
        expect(await m022(order('    create command place(id: OrderId, at: Timestamp) emits Placed', 'event Placed { orderId: OrderId times: Timestamp[1..*] }'))).toEqual([]);
        expect(await m022(order('    create command place(id: OrderId, at: Timestamp[0..*]) emits Placed', 'event Placed { orderId: OrderId times: Timestamp[1..*] }'))).toEqual([
            "Field 'times' of event 'Placed' has no source of the same name in command 'place'; parameter 'at' has its type. | name them alike: rename the parameter 'at' to 'times' (or the event field to 'at'), so that the value's source is clear",
        ]);
    });

    test('fields one level inside a parameter of a value object or entity type are sources', async () => {
        const body = `
  id OrderId: UUID
  primitive Sku: String
  value Item { sku: Sku code: Sku }
  aggregate Order {
    id: OrderId
    create command place(id: OrderId, item: Item) emits Placed, Noted
  }
  event Placed { orderId: OrderId sku: Sku }
  event Noted { orderId: OrderId productCode: Sku }`;
        expect(await m022(body)).toEqual([
            "Field 'productCode' of event 'Noted' has no source of the same name in command 'place'; parameters 'item.code', 'item.sku' have its type. | name them alike: rename the event field to 'code', after parameter 'item.code', so that the value's source is clear",
        ]);
        // not inside a list of them
        expect(await m022(body.replace('item: Item', 'item: Item[0..*]'))).toEqual([]);
    });

    test('at most three candidates, the closest names first; parameters and fields are told apart', async () => {
        const body = order(
            '    note: String\n    create command place(id: OrderId, a: String, b: String, comment: String) emits Placed',
            'event Placed { orderId: OrderId comments: String }',
        );
        expect(await m022(body)).toEqual([
            "Field 'comments' of event 'Placed' has no source of the same name in command 'place'; parameters 'comment', 'a' and field 'note' have its type. | name them alike: rename the parameter 'comment' to 'comments' (or the event field to 'comment'), so that the value's source is clear",
        ]);
    });

    test('field sets: in the payload and in the aggregate', async () => {
        const body = `
  id OrderId: UUID
  id StaffId: UUID
  fields Performed { performedBy: StaffId }
  fields Owned { owner: StaffId }
  aggregate Order with Owned {
    id: OrderId
    create command place(id: OrderId, owner: StaffId) emits Placed
  }
  event Placed with Performed { orderId: OrderId owner: StaffId }`;
        expect(await m022(body)).toEqual([
            "Field 'performedBy' of event 'Placed' has no source of the same name in command 'place'; parameter 'owner' and field 'owner' have its type. | name them alike: rename the parameter 'owner' to 'performedBy' (or the event field to 'owner'), so that the value's source is clear",
        ]);
        expect(await m022(body.replace('owner: StaffId)', 'performedBy: StaffId)'))).toEqual([]);
    });

    const work = (commands: string, decls: string): string => `
  id WorkId: UUID
  aggregate Work {
    id: WorkId
    state Draft { draftedAt: Timestamp }
    state Active { startedAt: Timestamp }
    state Done { doneAt: Timestamp }
${commands}
  }
${decls}`;

    test("events: the fields of the target states of the entry's outcomes are sources, not those of others", async () => {
        const decls = 'event Finished { workId: WorkId doneAt: Timestamp } event Started { workId: WorkId doneAt: Timestamp }';
        const cmd = '    command go(at: Timestamp) Draft -> Active | Done emits Finished when -> Done, Started when -> Active';
        expect(await m022(work(cmd, decls))).toEqual([
            "Field 'doneAt' of event 'Started' has no source of the same name in command 'go'; parameter 'at' and field 'startedAt' have its type. | name them alike: rename the parameter 'at' to 'doneAt' (or the event field to 'at'), so that the value's source is clear",
        ]);
    });

    test('an event in several entries of one command is reported once, at its first entry', async () => {
        const decls = 'event Moved { workId: WorkId movedAt: Timestamp }';
        const cmd = '    command go(at: Timestamp) Draft -> Active | Done emits Moved? when -> Done, Moved? when -> Active';
        const a = await checkSales(work(cmd, decls));
        expect(only(a, 'M022')).toHaveLength(1);
    });

    test('errors: the fields of the source states are sources (the aggregate before), not those of the targets', async () => {
        const decls = 'error TooLate { draftedAt: Timestamp } error TooEarly { doneAt: Timestamp }';
        const cmd = '    command go(at: Timestamp) Draft -> Done requires r { true } else TooLate errors TooEarly, TooLate';
        const a = await checkSales(work(cmd, decls));
        const diags = only(a, 'M022');
        expect(diags.map((d) => `${d.message} | ${d.hint}`)).toEqual([
            "Field 'doneAt' of error 'TooEarly' has no source of the same name in command 'go'; parameter 'at' and field 'draftedAt' have its type. | name them alike: rename the parameter 'at' to 'doneAt' (or the error field to 'at'), so that the value's source is clear",
        ]);
        expect(diags[0].start.column).toBe(85); // at `errors TooEarly`
    });

    test('errors: reported once, at the first `else` or `errors` reference', async () => {
        const decls = 'error Rejected { rejectedAt: Timestamp }';
        const cmd = '    command go(at: Timestamp) Draft -> Done requires r { true } else Rejected errors Rejected';
        const diags = only(await checkSales(work(cmd, decls)), 'M022');
        expect(diags).toHaveLength(1);
        expect(diags[0].start.column).toBe(70); // at `else Rejected`
    });

    test('factory errors see the parameters only: no aggregate before the command', async () => {
        const decls = 'error Taken { draftedAt: Timestamp } error Late { lateAt: Timestamp }';
        expect(await m022(work('    create command open(id: WorkId) -> Draft errors Taken', decls))).toEqual([]);
        expect(await m022(work('    create command open(id: WorkId, at: Timestamp) -> Draft errors Late', decls))).toEqual([
            "Field 'lateAt' of error 'Late' has no source of the same name in command 'open'; parameter 'at' has its type. | name them alike: rename the parameter 'at' to 'lateAt' (or the error field to 'at'), so that the value's source is clear",
        ]);
    });

    test('a factory event sees the fields of its initial state', async () => {
        const decls = 'event Opened { workId: WorkId draftedAt: Timestamp }';
        expect(await m022(work('    create command open(id: WorkId, at: Timestamp) -> Draft emits Opened', decls))).toEqual([]);
    });

    test('an aggregate field as the closest candidate: the hint renames it or the event field', async () => {
        const body = order('    placedOn: Timestamp\n    command touch() emits Touched', 'event Touched { orderId: OrderId placedAt: Timestamp }');
        expect(await m022(body)).toEqual([
            "Field 'placedAt' of event 'Touched' has no source of the same name in command 'touch'; field 'placedOn' has its type. | name them alike: rename the field 'placedOn' to 'placedAt' (or the event field to 'placedOn'), so that the value's source is clear",
        ]);
    });

    test('the shop example has no M022 (and no warning at all)', async () => {
        const a = await analyze(await loadWorkspace(EXAMPLES));
        expect(a.diagnostics.filter((d) => d.severity === 'warning')).toEqual([]);
    });
});
