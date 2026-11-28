import { describe, expect, test } from 'bun:test';
import { check, checkSales, codes, only, element } from '../../test-helpers.js';

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
    state Accepted { acceptedBy: PersonId? }
    ${commands}
  }
  error NotApprover
  error Blocked { blockers: Int }
  error Conflict
  ${extra}
}
`,
    });

const errors = (a: Awaited<ReturnType<typeof check>>) => a.diagnostics.filter((d) => d.severity === 'error').map((d) => [d.code, d.message]);

describe('requires', () => {
    test('parses with and without an expression, after the transitions and before emits / errors', async () => {
        const a = await review(`
    command accept(person: PersonId) "受入"
      Reviewing | Escalated -> Accepted
      requires authorizedApprover "承認者である" {
        policy.approvers.includes(person)
      } else NotApprover
      /// 阻害がすべて解決済み
      requires noOpenBlocker "未解決の阻害がない" else Blocked
      errors Conflict`);
        expect(a.diagnostics).toEqual([]);
        const accept = element(a.model, 'Review.Review').commands![0];
        expect(accept.requires).toEqual([
            {
                name: 'authorizedApprover',
                label: '承認者である',
                source: 'policy.approvers.includes(person)',
                expr: {
                    k: 'contains',
                    collection: { k: 'member', receiver: { k: 'name', name: 'policy' }, member: 'approvers' },
                    element: { k: 'name', name: 'person' },
                },
                error: 'Review.NotApprover',
            },
            { name: 'noOpenBlocker', label: '未解決の阻害がない', doc: '阻害がすべて解決済み', error: 'Review.Blocked' },
        ]);
        // the errors of `else` join the listed ones, after them
        expect(accept.errors).toEqual(['Review.Conflict', 'Review.NotApprover', 'Review.Blocked']);
    });

    test('an error listed in errors and named by else, or by several requirements, is listed once', async () => {
        const a = await review(`
    command accept(person: PersonId) Reviewing -> Accepted
      requires a { policy.approvers.includes(person) } else NotApprover
      requires b { blockers == 0 } else Blocked
      requires c { reviewer != person } else NotApprover
      errors Blocked, Conflict`);
        expect(a.diagnostics).toEqual([]);
        expect(element(a.model, 'Review.Review').commands![0].errors).toEqual(['Review.Blocked', 'Review.Conflict', 'Review.NotApprover']);
    });

    test('requires and else still name fields and parameters', async () => {
        const a = await checkSales(`
  id OrderId: UUID
  aggregate Order {
    id: OrderId
    requires: Int
    command reject(else: Bool) requires positive { requires > 0 && else } else Rejected
    command touch()
  }
  error Rejected`);
        expect(codes(a).filter((c) => c !== 'M011')).toEqual([]); // `else` is reserved in TypeScript only
        expect(element(a.model, 'Sales.Order').fields.map((f) => f.name)).toEqual(['id', 'requires']);
    });

    test('M007 the error of else must exist', async () => {
        const a = await review('command accept() Reviewing -> Accepted requires x { true } else Missing');
        expect(errors(a)).toEqual([['M007', "Cannot resolve error 'Missing' in this context (use Context.Name for other contexts)."]]);
    });

    test('M002 requirement names are unique within the command', async () => {
        const a = await review(`
    command accept() Reviewing -> Accepted requires x { true } else Blocked requires x { false } else Blocked changes acceptedBy
    command reject() Reviewing -> Accepted requires x { true } else Blocked`);
        expect(errors(a)).toEqual([['M002', "Requirement 'x' is declared more than once in command 'accept'."]]);
    });

    test('M008 a requirement is a Bool expression', async () => {
        const a = await review('command accept() Reviewing -> Accepted requires x { blockers } else Blocked');
        expect(errors(a)).toEqual([['M008', "Requirement 'x' of command 'accept' must be a Bool expression, but has type 'Int'."]]);
    });

    test('M018 a requirement without an expression needs a label or a description', async () => {
        const a = await review(`
    command accept() Reviewing -> Accepted
      requires labelled "承認済み" else Blocked
      /// Checked by the caller.
      requires described else Blocked
      requires bare else Blocked`);
        expect(errors(a)).toEqual([['M018', "Requirement 'bare' has no expression; give it a label or a /// description that states what it requires."]]);
    });
});

describe('scope of requires', () => {
    test('parameters, common fields and fields taken from field sets', async () => {
        const a = await review(`
    command accept(person: PersonId) Reviewing | Escalated | Accepted -> Accepted
      requires x { !(policy.approvers.includes(person) && auditedBy != null) || auditedBy != person } else NotApprover`);
        expect(a.diagnostics).toEqual([]);
    });

    test('fields every source state has with the same name and type', async () => {
        const a = await review('command accept() Reviewing | Escalated -> Accepted requires x { blockers == 0 } else Blocked');
        expect(a.diagnostics).toEqual([]);
    });

    test('a single source state: all of its fields', async () => {
        const a = await review(`
    command accept(person: PersonId) Reviewing -> Accepted
      requires x { reviewer == person && blockers == 0 && note != null } else Blocked`);
        expect(a.diagnostics).toEqual([]);
    });

    test('M010 a field not in every source state, or with another type in one of them', async () => {
        const a = await review(`
    command accept(person: PersonId) Reviewing | Escalated -> Accepted
      requires x { note != null && reviewer == person && acceptedBy == person } else Blocked`);
        expect(errors(a)).toEqual([
            [
                'M010',
                "Field 'note' is in state 'Reviewing' only; the requirements of command 'accept' see the fields that every source state has (with the same type).",
            ],
            [
                'M010',
                "Field 'reviewer' is in state 'Reviewing', 'Escalated' only; the requirements of command 'accept' see the fields that every source state has (with the same type).",
            ],
            [
                'M010',
                "Field 'acceptedBy' is in state 'Accepted' only; the requirements of command 'accept' see the fields that every source state has (with the same type).",
            ],
        ]);
    });

    test('a factory sees its parameters only', async () => {
        const a = await review(`
    create command open(person: PersonId, policy: Policy) -> Reviewing
      requires x { policy.approvers.includes(person) } else NotApprover
      requires y { auditedBy != null || blockers > 0 } else Blocked
      changes id, policy = policy, blockers = 0, reviewer = person`);
        expect(errors(a)).toEqual([
            ['M010', "Field 'auditedBy' of 'Review' is not in scope: the requirements of a 'create command' see only its parameters."],
            ['M010', "Field 'blockers' of 'Review' is not in scope: the requirements of a 'create command' see only its parameters."],
        ]);
    });

    test('an aggregate without states: all its fields', async () => {
        const a = await checkSales(`
  id CustomerId: UUID
  aggregate Customer {
    id: CustomerId
    active: Bool
    emails: String[0..*]
    command addEmail(email: String) requires active { active && !emails.includes(email) } else Inactive
  }
  error Inactive`);
        expect(a.diagnostics).toEqual([]);
    });

    test('M019 a parameter is not named like a field its requirements see', async () => {
        const a = await review(`
    command accept(policy: Policy, blockers: Int, note: String) Reviewing | Escalated -> Accepted
      requires x { blockers == 0 } else Blocked changes acceptedBy
    command reject(policy: Policy) Reviewing -> Accepted changes acceptedBy
    create command open(policy: Policy) -> Reviewing requires x { policy.approvers.length > 0 } else NotApprover changes id, policy = policy, blockers = 0, reviewer`);
        // `note` is a field of Reviewing only, so it is not seen by the requirements of `accept`
        expect(errors(a)).toEqual([
            ['M019', "Parameter 'policy' of command 'accept' has the name of a field of 'Review' that its requirements see."],
            ['M019', "Parameter 'blockers' of command 'accept' has the name of a field of 'Review' that its requirements see."],
        ]);
        expect(only(a, 'M019')[0].hint).toBe("rename the parameter (e.g. 'newPolicy'), so that 'policy' in a requirement means the field");
    });

    test('a domain primitive parameter compares with count(), a plain Int parameter does not (M009)', async () => {
        const a = await review(
            `
    command accept(needed: Count, limit: Int) Reviewing -> Accepted
      requires enough { policy.approvers.length >= needed } else NotApprover
      requires inLimit { needed <= limit } else Blocked`,
            'primitive Count: Int { value in 0..100 }',
        );
        expect(errors(a)).toEqual([['M009', "Operator '<=' cannot be applied to 'Count' and 'Int'."]]);
    });
});
