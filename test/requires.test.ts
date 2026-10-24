import { describe, expect, test } from 'bun:test';
import { generateTypeScript } from '../src/generator/typescript.js';
import { diffModels } from '../src/graph/diff.js';
import { highlight } from '../web/highlight.js';
import { check, checkSales, codes, only } from './helpers.js';

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

const errors = (a: Awaited<ReturnType<typeof check>>) => a.diagnostics.filter((d) => d.severity === 'error').map((d) => [d.code, d.message]);

describe('requires', () => {
    test('parses with and without an expression, after the transitions and before emits / errors', async () => {
        const a = await review(`
    command accept(person: PersonId) "受入"
      Reviewing | Escalated -> Accepted
      requires authorizedApprover "承認者である" {
        contains(policy.approvers, person)
      } else NotApprover
      /// 阻害がすべて解決済み
      requires noOpenBlocker "未解決の阻害がない" else Blocked
      errors Conflict`);
        expect(a.diagnostics).toEqual([]);
        const accept = a.model!.elements['Review.Review'].commands![0];
        expect(accept.requires).toEqual([
            {
                name: 'authorizedApprover',
                label: '承認者である',
                source: 'contains(policy.approvers, person)',
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
      requires a { contains(policy.approvers, person) } else NotApprover
      requires b { blockers == 0 } else Blocked
      requires c { reviewer != person } else NotApprover
      errors Blocked, Conflict`);
        expect(a.diagnostics).toEqual([]);
        expect(a.model!.elements['Review.Review'].commands![0].errors).toEqual(['Review.Blocked', 'Review.Conflict', 'Review.NotApprover']);
    });

    test('requires and else still name fields and parameters', async () => {
        const a = await checkSales(`
  id OrderId: UUID
  aggregate Order {
    id: OrderId
    requires: Int
    command reject(else: Bool) requires positive { requires > 0 and else } else Rejected
    command touch()
  }
  error Rejected`);
        expect(codes(a).filter((c) => c !== 'M011')).toEqual([]); // `else` is reserved in TypeScript only
        expect(a.model!.elements['Sales.Order'].fields.map((f) => f.name)).toEqual(['id', 'requires']);
    });

    test('M007 the error of else must exist', async () => {
        const a = await review('command accept() Reviewing -> Accepted requires x { true } else Missing');
        expect(errors(a)).toEqual([['M007', "Cannot resolve error 'Missing' in this context (use Context.Name for other contexts)."]]);
    });

    test('M002 requirement names are unique within the command', async () => {
        const a = await review(`
    command accept() Reviewing -> Accepted requires x { true } else Blocked requires x { false } else Blocked
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
      requires x { contains(policy.approvers, person) and exists(auditedBy) implies auditedBy != person } else NotApprover`);
        expect(a.diagnostics).toEqual([]);
    });

    test('fields every source state has with the same name and type', async () => {
        const a = await review('command accept() Reviewing | Escalated -> Accepted requires x { blockers == 0 } else Blocked');
        expect(a.diagnostics).toEqual([]);
    });

    test('a single source state: all of its fields', async () => {
        const a = await review(`
    command accept(person: PersonId) Reviewing -> Accepted
      requires x { reviewer == person and blockers == 0 and exists(note) } else Blocked`);
        expect(a.diagnostics).toEqual([]);
    });

    test('M010 a field not in every source state, or with another type in one of them', async () => {
        const a = await review(`
    command accept(person: PersonId) Reviewing | Escalated -> Accepted
      requires x { exists(note) and reviewer == person and acceptedBy == person } else Blocked`);
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
      requires x { contains(policy.approvers, person) } else NotApprover
      requires y { exists(auditedBy) or blockers > 0 } else Blocked`);
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
    command addEmail(email: String) requires active { active and not contains(emails, email) } else Inactive
  }
  error Inactive`);
        expect(a.diagnostics).toEqual([]);
    });

    test('M019 a parameter is not named like a field its requirements see', async () => {
        const a = await review(`
    command accept(policy: Policy, blockers: Int, note: String) Reviewing | Escalated -> Accepted
      requires x { blockers == 0 } else Blocked
    command reject(policy: Policy) Reviewing -> Accepted
    create command open(policy: Policy) -> Reviewing requires x { count(policy.approvers) > 0 } else NotApprover`);
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
      requires enough { count(policy.approvers) >= needed } else NotApprover
      requires inLimit { needed <= limit } else Blocked`,
            'primitive Count: Int { value in 0..100 }',
        );
        expect(errors(a)).toEqual([['M009', "Operator '<=' cannot be applied to 'Count' and 'Int'."]]);
    });
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

describe('requires in the Live View', () => {
    test('a change to a requirement changes its command (and its aggregate)', async () => {
        const before = await review('command accept() Reviewing -> Accepted requires x { blockers == 0 } else Blocked');
        const after = await review('command accept() Reviewing -> Accepted requires x { blockers < 1 } else Blocked');
        expect(diffModels(before.model, after.model!)).toEqual({ added: [], changed: ['Review.Review', 'Review.Review:accept'], removed: [] });
    });

    test('when is highlighted as a keyword', () => {
        const tokens = highlight('emits Done when Draft ->')[0]
            .filter((t) => t.kind === 'keyword')
            .map((t) => t.text);
        expect(tokens).toEqual(['emits', 'when']);
    });

    test('requires and else are highlighted as keywords', () => {
        const tokens = highlight('requires x { true } else Blocked')[0]
            .filter((t) => t.kind === 'keyword')
            .map((t) => t.text);
        expect(tokens).toEqual(['requires', 'true', 'else']);
    });
});
