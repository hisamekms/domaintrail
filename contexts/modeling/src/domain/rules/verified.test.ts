import { describe, expect, test } from 'bun:test';
import { formatDomain } from '../../infrastructure/syntax/format.js';
import { contextDependencies } from '../dependencies.js';
import { check, codes, only, element } from '../../test-helpers.js';

/** A Sales context with verified types; `extra` goes into the context, `members` into the aggregate. */
const sales = (extra = '', members = 'contact: EmailAddress') => `context Sales {
  id CustomerId: UUID
  id TenantId: UUID
  primitive EmailAddress: String { matches(value, "^[^@]+@[^@]+$") }
  value Spend {
    amount: Decimal
  }
  /// 他の顧客に使われていないことを確かめたメールアドレス。
  verified AvailableEmail "未使用のメールアドレス" of EmailAddress for CustomerId? errors EmailTaken
  verified Deliverable of EmailAddress for TenantId
  verified Reachable of AvailableEmail
  verified CoveredSpend of Spend errors OverBudget, Unknown
${extra ? `  ${extra}\n` : ''}
  aggregate Customer {
    id: CustomerId
    email: EmailAddress
    spent: Decimal
    create command register(id: CustomerId, email: AvailableEmail) emits CustomerRegistered
    command changeEmail(newEmail: AvailableEmail)
      requires changed { newEmail != email } else Unchanged
      changes email
    command reach(email: Reachable) changes email
    command spend(spend: CoveredSpend)
      requires positive { spend.amount > 0 and contact != email } else Unchanged
      changes spent
    ${members}
  }

  event CustomerRegistered {
    customerId: CustomerId
    email: EmailAddress
  }
  error EmailTaken {
    email: EmailAddress
  }
  error OverBudget
  error Unknown
  error Unchanged
}
`;

const run = (extra?: string, members?: string) => check({ 'sales.dt': sales(extra, members) });

describe('verified types: the checker', () => {
    test('parse, check, format, and go into the Typed Model', async () => {
        const a = await run();
        expect(a.diagnostics).toEqual([]);
        expect(formatDomain(sales())).toBe(sales());
        const m = a.model!;
        expect(element(m, 'Sales.AvailableEmail')).toMatchObject({
            kind: 'verified',
            label: '未使用のメールアドレス',
            doc: '他の顧客に使われていないことを確かめたメールアドレス。',
            verified: {
                of: { kind: 'ref', ref: 'Sales.EmailAddress', target: 'primitive' },
                for: { type: { kind: 'ref', ref: 'Sales.CustomerId' }, optional: true },
                errors: ['Sales.EmailTaken'],
            },
        });
        expect(element(m, 'Sales.Reachable').verified).toEqual({
            of: { kind: 'ref', ref: 'Sales.AvailableEmail', text: 'AvailableEmail', target: 'verified' },
            errors: [],
        });
        expect(element(m, 'Sales.Deliverable').verified?.for).toMatchObject({ optional: false });
        // the errors of the factory are not the command's
        expect(element(m, 'Sales.Customer').commands!.find((c) => c.name === 'changeEmail')!.errors).toEqual(['Sales.Unchanged']);
        // a parameter takes its label from the verified type
        expect(element(m, 'Sales.Customer').commands![0].params[1]).toMatchObject({ label: '未使用のメールアドレス', labelSource: 'type' });
    });

    test('in expressions a verified value is a value of its base; M022 matches it by its base type', async () => {
        const a = await run();
        expect(only(a, 'M009')).toEqual([]);
        expect(only(a, 'M022')).toEqual([]); // CustomerRegistered.email comes from `email: AvailableEmail`
        const b = await run('', 'contact: TenantId');
        expect(only(b, 'M009').map((d) => d.message)).toEqual(["Operator '!=' cannot be applied to 'TenantId' and 'EmailAddress'."]);
    });

    test('M024: no field holds a verified type; the hint names the base type that is stored', async () => {
        const a = await run(
            `value Contact {
    email: Reachable
  }
  fields Mailed {
    mail: AvailableEmail?
  }
  event Mailed2 {
    to: AvailableEmail[0..*]
  }`,
            `contact: EmailAddress
    owns other: AvailableEmail
    state Active {
      checked: AvailableEmail
    }`,
        );
        const m024 = only(a, 'M024');
        expect(m024.map((d) => [d.message, d.hint])).toEqual(
            ['other', 'checked', 'email', 'mail', 'to'].map(() => [
                expect.stringMatching(
                    /^Verified type '\w+' is the evidence of a check at one moment and types command parameters only; field '\w+' cannot hold it\.$/,
                ),
                "store the base type 'EmailAddress'",
            ]),
        );
        expect(codes(a).filter((c) => c !== 'M024' && c !== 'M006')).toEqual([]); // no M004 on top
    });

    test('M024: the base and the context are value types; a context is not verified; no cycle', async () => {
        const a = await run(`entity Thing {
    id: TenantId
  }
  verified OfEntity of Thing
  verified OfAggregate of Customer for Customer
  verified ForVerified of String for AvailableEmail
  verified Loop1 of Loop2
  verified Loop2 of Loop1`);
        expect(only(a, 'M024').map((d) => [d.message, d.hint])).toEqual([
            ["Verified type 'OfEntity' must verify a value type, not entity 'Thing'.", "verify a value of 'Thing' instead"],
            [
                "Verified type 'OfAggregate' must verify a value type, not aggregate 'Customer'.",
                "verify a value of 'Customer' instead (its ID type, to verify which Customer is meant)",
            ],
            ["The context of verified type 'OfAggregate' must be a value type, not aggregate 'Customer'.", "name the ID type of 'Customer'"],
            ["The context of verified type 'ForVerified' must be a value type, not verified type 'AvailableEmail'.", "name the base type 'EmailAddress'"],
            ['Verified types verify each other in a cycle: Loop1 -> Loop2 -> Loop1.', 'make one of them verify the type that is stored'],
            ['Verified types verify each other in a cycle: Loop2 -> Loop1 -> Loop2.', 'make one of them verify the type that is stored'],
        ]);
    });

    test('unknown base, context and errors are reported like other references', async () => {
        const a = await check({ 'x.dt': 'context X {\n  verified V of Nope for Nada errors Gone\n}\n' });
        expect(a.diagnostics.map((d) => [d.code, d.message])).toEqual([
            ['M001', "Cannot resolve type 'Nope' in this context (use Context.Name for other contexts)."],
            ['M001', "Cannot resolve type 'Nada' in this context (use Context.Name for other contexts)."],
            ['M007', "Cannot resolve error 'Gone' in this context (use Context.Name for other contexts)."],
        ]);
    });

    test('a verified type is not allowed in a shared context (M014)', async () => {
        const a = await check({ 'c.dt': 'shared context C {\n  verified V of String\n}\n' });
        expect(only(a, 'M014').map((d) => d.message)).toEqual([
            "Shared context 'C' can only contain domain primitives, enums, value objects, unions, field sets and terms; found verified type 'V'.",
        ]);
    });

    test('`verified`, `of` and `for` are still names of fields and parameters', async () => {
        const a = await check({
            'x.dt': `context X {
  id AId: UUID
  value V {
    verified: Bool
    of: Int
    for: String
    invariant k { verified == true implies of > 0 }
  }
  aggregate A {
    id: AId
    command c(verified: Bool, of: Int)
  }
}
`,
        });
        expect(a.diagnostics).toEqual([]);
    });
});

describe('verified types: dt show and dependencies', () => {
    test('a verified type depends on the contexts of its base, context and errors', async () => {
        const a = await check({
            'common.dt': 'shared context Common {\n  primitive Email: String\n}\n',
            'ids.dt': 'context Ids {\n  id TenantId: UUID\n}\n',
            'x.dt': 'context X {\n  verified V of Common.Email for Ids.TenantId errors Y.Bad\n}\n',
            'y.dt': 'context Y {\n  error Bad\n}\n',
        });
        expect(a.diagnostics).toEqual([]);
        expect(contextDependencies(a.model!).map((d) => `${d.from}->${d.to} ${d.path} ${d.kind}`)).toEqual([
            'X->Common of type',
            'X->Ids for id',
            'X->Y ⇒ Bad type',
        ]);
    });
});
