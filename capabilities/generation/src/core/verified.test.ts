// What verified types make of the generated TypeScript and its contract tests, and the generator's check of their
// factories' names (M011) (the DSL and its checks: contexts/modeling/src/domain/rules/verified.test.ts).
import { beforeAll, describe, expect, test } from 'bun:test';
import { generateTypeScript } from './typescript.js';
import { check, only } from '../test-helpers.js';

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

describe('verified types: the name check of the generator (M011)', () => {
    test('generated names do not collide (M011)', async () => {
        const b = await check({ 'x.dt': 'context X {\n  verified V of String\n  value MakeV\n}\n' });
        expect(only(b, 'M011').map((d) => d.message)).toEqual(["Generated TypeScript name 'MakeV' for value object 'MakeV' collides with the factory of 'V'."]);
    });
});

describe('verified types: generated TypeScript', () => {
    let ts: string;

    beforeAll(async () => {
        ts = generateTypeScript((await run()).model!).find((f) => f.path === 'Sales.ts')!.content;
    });

    test('the base with a property per verification, and the factory contract with its context and errors', () => {
        expect(ts).toContain(`/**
 * 未使用のメールアドレス
 * 他の顧客に使われていないことを確かめたメールアドレス。
 * A value of EmailAddress for which MakeAvailableEmail made a check outside the aggregate. Evidence of a check made at that moment, not a guarantee when the aggregate is saved — keep enforcing it where it is stored (e.g. a unique index).
 * Make it with your \`MakeAvailableEmail\` factory; never \`as AvailableEmail\` outside it (see dt guide lint).
 * @see sales.dt:9
 */
export type AvailableEmail = EmailAddress & { readonly 'verified:Sales.AvailableEmail': true };`);
        expect(ts).toContain(
            'export type MakeAvailableEmail = (value: EmailAddress, context: CustomerId | undefined) => Promise<Result<AvailableEmail, EmailTaken>>;',
        );
        expect(ts).toContain('export type MakeDeliverable = (value: EmailAddress, context: TenantId) => Promise<Result<Deliverable, never>>;');
        expect(ts).toContain("export type Reachable = AvailableEmail & { readonly 'verified:Sales.Reachable': true };");
        expect(ts).toContain('export type MakeReachable = (value: AvailableEmail) => Promise<Result<Reachable, never>>;');
        expect(ts).toContain('export type MakeCoveredSpend = (value: Spend) => Promise<Result<CoveredSpend, OverBudget | Unknown>>;');
        // a requirement over a verified parameter reads it as its base
        expect(ts).toContain("export function checkSpendCustomerRequires(customer: Customer, params: SpendCustomerParams): 'positive' | undefined {");
        expect(ts).toContain("if (!((Number(params.spend.amount) > 0) && !(customer.contact === customer.email))) return 'positive';");
        expect(ts).toContain('export function checkChangeEmailCustomerRequires(customer: Customer, params: ChangeEmailCustomerParams)');
    });

    test('the doc comment of the factory says why an optional context is required, and what a rejection means', () => {
        expect(ts).toContain(`/**
 * Checks a value of EmailAddress, given the CustomerId (or \`undefined\`) the check needs, and returns it as AvailableEmail when the check passes. Written by hand (with repositories and services): the only code that may assert the type.
 * The context is required even when there is none: pass \`undefined\` explicitly. Were it optional, a call that forgot it would compile, and the check would then not leave out the one it should (e.g. report an aggregate's own value as taken).
 * The errors of the \`Result\` are the domain's answers: EmailTaken. A rejected promise means the check could not be made (the repository or a service failed): not a domain error, it is left to the application's edge (an error response, a retry).
 * @see sales.dt:9
 */
export type MakeAvailableEmail =`);
        // a required context needs no explanation; a factory without errors says so
        expect(ts).toContain(`/**
 * Checks a value of EmailAddress, given the TenantId the check needs, and returns it as Deliverable when the check passes. Written by hand (with repositories and services): the only code that may assert the type.
 * The errors of the \`Result\` are the domain's answers, none here. A rejected promise means`);
        expect(ts).toContain("The errors of the `Result` are the domain's answers: OverBudget or Unknown.");
    });

    test('the contract tests take values of the base as verified, and the arbitraries can be overridden', async () => {
        // (examples/shop runs such tests: Customer.register and changeEmail take an AvailableEmail)
        const tests = generateTypeScript((await run()).model!, {}, { dir: 'tests' }).find((f) => f.path === 'tests/Sales.ts')!.content;
        expect(tests).toContain('readonly AvailableEmail: fc.Arbitrary<Sales.AvailableEmail>;');
        expect(tests).toContain('AvailableEmail: () => given.AvailableEmail ?? testing.cast<Sales.AvailableEmail>(a.EmailAddress),');
        expect(tests).toContain('Reachable: () => given.Reachable ?? testing.cast<Sales.Reachable>(a.AvailableEmail),');
        expect(tests).not.toContain('MakeAvailableEmail'); // the factories are not tested
    });
});
