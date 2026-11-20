import { describe, expect, test } from 'bun:test';
import { check, only, element } from '../../test-helpers.js';
import { formatDomain } from '../../infrastructure/syntax/format.js';

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
        const cmd = (name: string) => element(a.model, 'Tasks.Work').commands!.find((c) => c.name === name)!;
        expect(cmd('rename').changes).toEqual(['title', 'updatedAt']);
        expect(cmd('rename').emits.map((e) => e.event)).toEqual(['Tasks.Renamed']);
        expect(cmd('renumber').changes).toEqual(['draftNo']);
        expect(cmd('submit').changes).toEqual([]);
        expect(element(a.model, 'Tasks.Tag').commands![1].changes).toEqual(['color']);
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
        expect(element(a.model, 'Sales.Order').fields.map((f) => f.name)).toEqual(['id', 'changes']);
        expect(element(a.model, 'Sales.Order').commands![0].changes).toEqual(['changes']);
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

    test('M021: a path into a field is reported with what to write instead', async () => {
        const a = await work(
            `command plan(at: Timestamp) Draft -> Draft changes title.length, sched.plannedDate
    command tag() Draft -> Draft changes tags.first`,
            `id DeliveryId: UUID
  value Schedule {
    requestedDate: String
    plannedDate: String
    invariant plannedNotBeforeRequested { plannedDate >= requestedDate }
  }
  aggregate Delivery {
    id: DeliveryId
    owns schedule: Schedule
    owns history: Schedule[0..*]
    command carryOver(newPlannedDate: String) changes schedule.plannedDate
    command rewrite() changes history.plannedDate
    state Open
    state Closed
    initial Open
    command close() {
      outcome closed: Open -> Closed changes schedule.requestedDate
    }
  }`,
        );
        expect(only(a, 'M021').map((d) => [d.message, d.hint])).toEqual([
            [
                "'changes' takes a field of 'Work', not a part of one: 'title.length' is inside 'title'.",
                "write 'changes title'; the decision gives its whole new value",
            ],
            ["'Work' has no field 'sched'.", "use a field of 'Work': updatedAt, title, note, tags, draftNo, reviewer, doneAt"],
            [
                "'changes' takes a field of 'Work', not a part of one: 'tags.first' is inside 'tags'.",
                "write 'changes tags'; the decision gives its whole new value",
            ],
            [
                "'changes' takes a field of 'Delivery', not a part of one: 'schedule.plannedDate' is inside 'schedule' (Schedule), and a value is replaced whole.",
                "write 'changes schedule' and give the whole new Schedule; if its parts change under different commands, make them fields of 'Delivery' (share them with a 'fields' set) and write 'changes plannedDate'",
            ],
            [
                "'changes' takes a field of 'Delivery', not a part of one: 'history.plannedDate' is inside 'history'.",
                "write 'changes history'; the decision gives its whole new value",
            ],
            [
                "'changes' takes a field of 'Delivery', not a part of one: 'schedule.requestedDate' is inside 'schedule' (Schedule), and a value is replaced whole.",
                "write 'changes schedule' and give the whole new Schedule; if its parts change under different commands, make them fields of 'Delivery' (share them with a 'fields' set) and write 'changes requestedDate'",
            ],
        ]);
        expect(only(a, 'M028')).toEqual([]);
    });

    test('a path in changes is kept by dt fmt', () => {
        const source = 'context C {\n  aggregate A {\n    command go() changes schedule.plannedDate\n  }\n}\n';
        expect(formatDomain(source)).toContain('changes schedule.plannedDate');
    });
});
