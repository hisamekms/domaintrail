import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { showJson, showText, lookup } from '../src/cli/show.js';
import { formatDomain } from '../src/format/format.js';
import { generateTypeScript } from '../src/generator/typescript.js';
import { contextDependencies } from '../src/model/dependencies.js';
import { highlight } from '../web/highlight.js';
import { check, codes, only } from './helpers.js';

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
        expect(m.elements['Sales.AvailableEmail']).toMatchObject({
            kind: 'verified',
            label: '未使用のメールアドレス',
            doc: '他の顧客に使われていないことを確かめたメールアドレス。',
            verified: {
                of: { kind: 'ref', ref: 'Sales.EmailAddress', target: 'primitive' },
                for: { type: { kind: 'ref', ref: 'Sales.CustomerId' }, optional: true },
                errors: ['Sales.EmailTaken'],
            },
        });
        expect(m.elements['Sales.Reachable'].verified).toEqual({ of: { kind: 'ref', ref: 'Sales.AvailableEmail', text: 'AvailableEmail', target: 'verified' }, errors: [] });
        expect(m.elements['Sales.Deliverable'].verified?.for).toMatchObject({ optional: false });
        // the errors of the factory are not the command's
        expect(m.elements['Sales.Customer'].commands!.find((c) => c.name === 'changeEmail')!.errors).toEqual(['Sales.Unchanged']);
        // a parameter takes its label from the verified type
        expect(m.elements['Sales.Customer'].commands![0].params[1]).toMatchObject({ label: '未使用のメールアドレス', labelSource: 'type' });
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
            ['other', 'checked', 'email', 'mail', 'to'].map(() => [expect.stringMatching(/^Verified type '\w+' is the evidence of a check at one moment and types command parameters only; field '\w+' cannot hold it\.$/), "store the base type 'EmailAddress'"]),
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
            ["Verified type 'OfAggregate' must verify a value type, not aggregate 'Customer'.", "verify a value of 'Customer' instead (its ID type, to verify which Customer is meant)"],
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

    test('a verified type is not allowed in a shared context (M014), and generated names do not collide (M011)', async () => {
        const a = await check({ 'c.dt': 'shared context C {\n  verified V of String\n}\n' });
        expect(only(a, 'M014').map((d) => d.message)).toEqual(["Shared context 'C' can only contain domain primitives, enums, value objects, unions, field sets and terms; found verified type 'V'."]);
        const b = await check({ 'x.dt': 'context X {\n  verified V of String\n  value MakeV\n}\n' });
        expect(only(b, 'M011').map((d) => d.message)).toEqual(["Generated TypeScript name 'MakeV' for value object 'MakeV' collides with the factory of 'V'."]);
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
        expect(highlight('verified V of String for X?')[0].filter((t) => t.kind === 'keyword').map((t) => t.text)).toEqual(['verified', 'of', 'for']);
    });
});

describe('verified types: dt show and dependencies', () => {
    test('show prints of, for and errors, and who uses it', async () => {
        const m = (await run()).model!;
        const target = lookup(m, 'AvailableEmail');
        if (!('found' in target)) throw new Error('not found');
        expect(showText(m, target.found)).toEqual([
            '/// 他の顧客に使われていないことを確かめたメールアドレス。',
            'verified Sales.AvailableEmail "未使用のメールアドレス" of EmailAddress for CustomerId? errors EmailTaken  // sales.dt:9',
            '',
            'used by',
            '  type of: Sales.Customer.register(email), Sales.Customer.changeEmail(newEmail)',
            '  verified as: Sales.Reachable',
        ]);
        const taken = lookup(m, 'EmailTaken');
        if (!('found' in taken)) throw new Error('not found');
        expect(showJson(m, taken.found)).toMatchObject({ usedBy: { returnedBy: ['Sales.AvailableEmail'] } });
        const tenant = lookup(m, 'TenantId');
        if (!('found' in tenant)) throw new Error('not found');
        expect(showJson(m, tenant.found)).toMatchObject({ usedBy: { contextOf: ['Sales.Deliverable'] } });
    });

    test('a verified type depends on the contexts of its base, context and errors', async () => {
        const a = await check({
            'common.dt': 'shared context Common {\n  primitive Email: String\n}\n',
            'ids.dt': 'context Ids {\n  id TenantId: UUID\n}\n',
            'x.dt': 'context X {\n  verified V of Common.Email for Ids.TenantId errors Y.Bad\n}\n',
            'y.dt': 'context Y {\n  error Bad\n}\n',
        });
        expect(a.diagnostics).toEqual([]);
        expect(contextDependencies(a.model!).map((d) => `${d.from}->${d.to} ${d.path} ${d.kind}`)).toEqual(['X->Common of type', 'X->Ids for id', 'X->Y ⇒ Bad type']);
    });
});

describe('verified types: generated TypeScript', () => {
    let dir: string;
    let ts: string;
    const TSC = path.join(import.meta.dir, '..', 'node_modules', '.bin', 'tsc');
    const tsc = (file: string, text: string) => {
        const src = path.join(dir, 'src', file);
        return writeFile(src, text).then(() => {
            const r = Bun.spawnSync(
                [process.execPath, TSC, '--noEmit', '--strict', '--target', 'ES2023', '--module', 'preserve', '--moduleResolution', 'bundler', '--lib', 'ES2023,DOM', `src/${file}`],
                { cwd: dir },
            );
            return r.stdout.toString() + r.stderr.toString();
        });
    };

    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-verified-'));
        const a = await run();
        await mkdir(path.join(dir, 'generated'), { recursive: true });
        await mkdir(path.join(dir, 'src'));
        for (const f of generateTypeScript(a.model!, {}, { dir: 'tests' })) {
            await mkdir(path.dirname(path.join(dir, 'generated', f.path)), { recursive: true });
            await writeFile(path.join(dir, 'generated', f.path), f.content);
        }
        ts = generateTypeScript(a.model!).find((f) => f.path === 'Sales.ts')!.content;
    });
    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
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
        expect(ts).toContain('export type MakeAvailableEmail = (value: EmailAddress, context: CustomerId | undefined) => Promise<Result<AvailableEmail, EmailTaken>>;');
        expect(ts).toContain('export type MakeDeliverable = (value: EmailAddress, context: TenantId) => Promise<Result<Deliverable, never>>;');
        expect(ts).toContain("export type Reachable = AvailableEmail & { readonly 'verified:Sales.Reachable': true };");
        expect(ts).toContain('export type MakeReachable = (value: AvailableEmail) => Promise<Result<Reachable, never>>;');
        expect(ts).toContain('export type MakeCoveredSpend = (value: Spend) => Promise<Result<CoveredSpend, OverBudget | Unknown>>;');
        // a requirement over a verified parameter reads it as its base
        expect(ts).toContain("export function checkSpendCustomerRequires(customer: Customer, spend: CoveredSpend): 'positive' | undefined {");
        expect(ts).toContain("if (!((Number(spend.amount) > 0) && !(customer.contact === customer.email))) return 'positive';");
        expect(ts).toContain('export function checkChangeEmailCustomerRequires(customer: Customer, newEmail: AvailableEmail)');
    });

    test('skipping the check, or another check, is a compile error; storing the value as its base is not', async () => {
        const out = await tsc(
            'use.ts',
            `import { Sales, decide, ok } from '../generated/index.js';
declare const raw: Sales.EmailAddress;
declare const available: Sales.AvailableEmail;
declare const deliverable: Sales.Deliverable;
declare const both: Sales.AvailableEmail & Sales.Deliverable;
declare const register: Sales.RegisterCustomer;
declare const id: Sales.CustomerId;
// @ts-expect-error the check was skipped
register(id, raw);
// @ts-expect-error another check is not this one
register(id, deliverable);
register(id, available);
register(id, both); // a value with both checks is either
export const stored: Sales.EmailAddress = available;
export const reach: Sales.Reachable extends Sales.AvailableEmail ? true : false = true; // a chain carries both
export const changeEmail = decide<Sales.ChangeEmailCustomerDecision>(Sales.CustomerShape, (_c, email) => ok({ Customer: { set: { email }, events: {} } }));
export const make: Sales.MakeAvailableEmail = async (value, customer) => (customer === undefined ? ok(value as Sales.AvailableEmail) : ok(value as Sales.AvailableEmail));
`,
        );
        expect(out).toBe('');
        const both = await tsc('both.ts', `import type { Sales } from '../generated/index.js';\nexport const x: Sales.AvailableEmail & Sales.Deliverable = {} as never;\nexport const y: Sales.AvailableEmail & Sales.Deliverable = '' as unknown as Sales.AvailableEmail;\n`);
        expect(both).toContain("Property ''verified:Sales.Deliverable'' is missing");
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
