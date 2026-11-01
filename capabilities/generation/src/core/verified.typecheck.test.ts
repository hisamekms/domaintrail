// The generated TypeScript of verified types, type-checked by tsc.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { generateTypeScript } from './typescript.js';
import { check } from '../test-helpers.js';

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

describe('verified types: generated TypeScript', () => {
    let dir: string;
    const TSC = path.join(import.meta.dir, '..', '..', '..', '..', 'node_modules', '.bin', 'tsc');
    const tsc = (file: string, text: string) => {
        const src = path.join(dir, 'src', file);
        return writeFile(src, text).then(() => {
            const r = Bun.spawnSync(
                [
                    process.execPath,
                    TSC,
                    '--noEmit',
                    '--strict',
                    '--target',
                    'ES2023',
                    '--module',
                    'preserve',
                    '--moduleResolution',
                    'bundler',
                    '--lib',
                    'ES2023,DOM',
                    `src/${file}`,
                ],
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
    });
    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
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
        const both = await tsc(
            'both.ts',
            `import type { Sales } from '../generated/index.js';\nexport const x: Sales.AvailableEmail & Sales.Deliverable = {} as never;\nexport const y: Sales.AvailableEmail & Sales.Deliverable = '' as unknown as Sales.AvailableEmail;\n`,
        );
        expect(both).toContain("Property ''verified:Sales.Deliverable'' is missing");
    });
});
