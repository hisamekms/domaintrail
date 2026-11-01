// What requirements make of the generated TypeScript (the DSL and its checks: core/checker/requires.test.ts).
import { describe, expect, test } from 'bun:test';
import { generateTypeScript } from './typescript.js';
import { check } from './test-helpers.js';

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

describe('requires in the generated TypeScript', () => {
    test('documents the requirements on the command and its decision, and adds their errors to the error type', async () => {
        const a = await review(`
    command accept(person: PersonId) "受入"
      Reviewing -> Accepted
      Escalated -> Escalated | Accepted
      requires authorizedApprover "承認者である" { contains(policy.approvers, person) } else NotApprover
      requires noOpenBlocker "未解決の阻害がない" else Blocked
      errors Blocked, Conflict`);
        expect(a.diagnostics).toEqual([]);
        const code = generateTypeScript(a.model!).find((f) => f.path === 'Review.ts')!.content;
        const lines = [
            ' * @requires authorizedApprover (承認者である) else NotApprover: contains(policy.approvers, person)',
            ' * @requires noOpenBlocker (未解決の阻害がない) else Blocked: not expressed in the DSL',
        ].join('\n');
        const changes = ' * @changes none — the command changes no common field';
        expect(code).toContain(
            `/**\n * Review.accept (Reviewing -> Accepted; Escalated -> Escalated | Accepted)\n * 受入\n${lines}\n${changes}\n * @emits nothing\n * @see review.dt:13\n */\nexport type AcceptReview = `,
        );
        expect(code).toContain(
            `/**\n * Review.accept, decided per source state; implement it with \`decide(ReviewShape, …)\` from the runtime.\n * Each outcome gives the fields of \`set\`, and \`decide\` makes the aggregate, taking the other fields from the input.\n${lines}\n${changes}\n`,
        );
        expect(code).toContain('    }, Blocked | Conflict | NotApprover>;');
        expect(code).not.toContain('Blocked | Conflict | NotApprover | Blocked');
    });

    test('a command without errors gets the errors of its requirements', async () => {
        const a = await review('command accept() Reviewing -> Accepted requires x { blockers == 0 } else Blocked');
        const code = generateTypeScript(a.model!).find((f) => f.path === 'Review.ts')!.content;
        expect(code).toContain(' * @requires x else Blocked: blockers == 0\n');
        expect(code).toContain('}, Blocked>;');
    });
});
