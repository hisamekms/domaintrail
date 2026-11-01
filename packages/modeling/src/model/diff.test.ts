// The model diff: what counts as an addition, a change and a removal of an element, a state or a command.
import { describe, expect, test } from 'bun:test';
import { diffModels } from './diff.js';
import { check } from '../test-helpers.js';

describe('diff', () => {
    test('identifies added, changed and removed elements, states and commands', async () => {
        const before = (await check({ 'a.dt': 'context S { id AId: UUID aggregate A { id: AId state X state Y command go() X -> Y } value V }' })).model!;
        const after = (await check({ 'a.dt': 'context S { id AId: UUID aggregate A { id: AId note: String? state X state Z command go() X -> Z } value W }' }))
            .model!;
        const d = diffModels(before, after);
        expect(d.added.sort()).toEqual(['S.A#Z', 'S.W']);
        expect(d.changed.sort()).toEqual(['S.A', 'S.A:go']);
        expect(d.removed.sort()).toEqual(['S.A#Y', 'S.V']);
    });

    test('moving declarations between lines or files is not a change', async () => {
        const before = (await check({ 'a.dt': 'context S { id AId: UUID\n value V }' })).model!;
        const after = (await check({ 'b.dt': 'context S { value V }', 'c.dt': '\n\ncontext S { id AId: UUID }' })).model!;
        expect(diffModels(before, after)).toEqual({ added: [], changed: [], removed: [] });
    });
});

/** A review aggregate with states that share some fields; `commands` go into the aggregate. */
const review = (commands: string, extra = '') =>
    check({
        'review.dt': `context Review {
  id ReviewId: UUID
  id PersonId: UUID
  value Policy { approvers: PersonId[0..*] }
  fields Audited { auditedBy: PersonId? }
  aggregate Review with Audited {
    id: ReviewId
    policy: Policy
    state Reviewing { blockers: Int reviewer: PersonId note: String? }
    state Escalated { blockers: Int reviewer: String }
    state Accepted { acceptedBy: PersonId }
    ${commands}
  }
  error NotApprover
  error Blocked { blockers: Int }
  error Conflict
  ${extra}
}
`,
    });

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

describe('requires in the Live View', () => {
    test('a change to a requirement changes its command (and its aggregate)', async () => {
        const before = await review('command accept() Reviewing -> Accepted requires x { blockers == 0 } else Blocked');
        const after = await review('command accept() Reviewing -> Accepted requires x { blockers < 1 } else Blocked');
        expect(diffModels(before.model, after.model!)).toEqual({ added: [], changed: ['Review.Review', 'Review.Review:accept'], removed: [] });
    });
});

describe('changes in the DSL', () => {
    test('a change to it changes its command (and its aggregate)', async () => {
        const before = await work('command x() Draft -> Draft changes title');
        const after = await work('command x() Draft -> Draft changes title, note');
        expect(diffModels(before.model, after.model!)).toEqual({ added: [], changed: ['Tasks.Work', 'Tasks.Work:x'], removed: [] });
    });
});
