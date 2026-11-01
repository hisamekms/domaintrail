// What the diff counts as a change of a command (the diff itself: build.test.ts).
import { describe, expect, test } from 'bun:test';
import { buildStructureGraph } from './build.js';
import { diffModels, markLineChanges } from './diff.js';
import { check } from '../../test-helpers.js';

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

describe('markLineChanges', () => {
    test('leaves graphs without a baseline and unchanged nodes as they are', async () => {
        const a = (await check({ 'a.dt': 'context A {\n  value V { x: Int y: String }\n}\n' })).model!;
        const b = (await check({ 'a.dt': 'context A {\n  value V { x: Int z: Bool }\n}\n' })).model!;
        const g = buildStructureGraph(b);
        expect(markLineChanges(g, undefined)).toBe(g);
        expect(markLineChanges(g, buildStructureGraph(b)).nodes).toEqual(g.nodes);
        const v = markLineChanges(g, buildStructureGraph(a)).nodes.find((n) => n.id === 'A.V')!;
        expect(v.lines.map((l) => [l.key.en.name, l.change])).toEqual([
            ['x', undefined],
            ['y', 'removed'],
            ['z', 'added'],
        ]);
        expect(v.height).toBe(g.nodes.find((n) => n.id === 'A.V')!.height + 21);
    });
});
