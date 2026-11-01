// What policies make of the generated TypeScript, its contract tests run, and the generator's check of their names
// (M011) (the DSL and its checks: core/checker/policies.test.ts).
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { generateTypeScript, type PolicyMode } from './typescript.js';
import { check } from '../test-helpers.js';

const ROOT = path.join(import.meta.dir, '..', '..', '..', '..');

const SALES = `context Sales {
  id OrderId: UUID
  aggregate Order {
    id: OrderId
    state Draft
    state Confirmed
    create command place(id: OrderId) -> Draft emits OrderPlaced
    command confirm(at: Timestamp)
      Draft -> Confirmed
      emits OrderConfirmed
  }
  event OrderPlaced { orderId: OrderId }
  event OrderConfirmed {
    orderId: OrderId
    at: Timestamp
  }
}
`;

const BILLING = `context Billing {
  id InvoiceId: UUID
  primitive Amount: Int { value >= 0 }
  value Money { amount: Amount }
  aggregate Invoice {
    id: InvoiceId
    references order: Sales.OrderId -> Sales.Order
    state Open
    state Sent {
      sentAt: Timestamp
    }
    create command issue(id: InvoiceId, order: Sales.OrderId, total: Money, note: String?) -> Open
    command send(sentAt: Timestamp, lines: Amount[1..3]) Open -> Sent
  }
  /// 確定した注文は請求する。
  policy BillConfirmedOrder "請求する" when Sales.OrderConfirmed -> Invoice.issue
  policy SendConfirmed when Sales.OrderConfirmed -> Invoice.send
}
`;

const model = (billing = BILLING, extra: Record<string, string> = {}) => check({ 'sales.dt': SALES, 'billing.dt': billing, ...extra });
const problems = async (billing: string, extra: Record<string, string> = {}) =>
    (await model(billing, extra)).diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message, ...(d.hint && { hint: d.hint }) }));

describe('policies: the name check of the generator (M011)', () => {
    test('M011: the generated names of a policy do not collide', async () => {
        const clash = BILLING.replace(
            '  id InvoiceId: UUID\n',
            '  id InvoiceId: UUID\n  value IssueInvoiceInput { x: Int }\n  value BillConfirmedOrderPolicy { x: Int }\n',
        );
        expect((await problems(clash)).filter((p) => p.code === 'M011').map((p) => p.message)).toEqual([
            "Generated TypeScript name 'BillConfirmedOrderPolicy' for the handler of policy 'BillConfirmedOrder' collides with value object 'BillConfirmedOrderPolicy'.",
            "Generated TypeScript name 'IssueInvoiceInput' for the input of 'Invoice.issue' collides with value object 'IssueInvoiceInput'.",
        ]);
    });
});

describe('generated policies', () => {
    const generate = async (mode: PolicyMode) => {
        const files = generateTypeScript((await model()).model!, {}, { dir: 'tests', runner: 'bun' }, { Billing: mode });
        return (p: string) => files.find((f) => f.path === p)!.content;
    };

    test('optional: a handler type per policy and the input of each command run, nothing required', async () => {
        const file = await generate('optional');
        const billing = file('Billing.ts');
        expect(billing).toContain(`export interface IssueInvoiceInput {
    readonly id: InvoiceId;
    readonly order: Sales.OrderId;
    readonly total: Money;
    readonly note?: string;
}`);
        expect(billing).toContain(`export interface SendInvoiceInput {
    /** The Invoice to run the command on. */
    readonly invoice: InvoiceId;
    readonly sentAt: Timestamp;
    readonly lines: readonly [Amount, ...Amount[]];
}`);
        expect(billing).toContain(`/**
 * Policy BillConfirmedOrder: when Sales.OrderConfirmed happens, Invoice.issue is run — eventually.
 * 請求する
 * 確定した注文は請求する。`);
        expect(billing).toContain('export type BillConfirmedOrderPolicy = (event: Sales.OrderConfirmed) => Promise<IssueInvoiceInput>;');
        expect(billing).toContain(' * Optional (`generate.ts.policies`): nothing requires an implementation.\n * @see billing.dt:16');
        expect(billing).not.toContain('BillingPolicyHandlers');
        expect(file('tests/Billing.ts')).not.toContain('policies');
    });

    test('required: the handlers of the context, which the contract tests require', async () => {
        const file = await generate('required');
        expect(file('Billing.ts')).toContain(`export interface BillingPolicyHandlers {
    /** 請求する */
    readonly BillConfirmedOrder: BillConfirmedOrderPolicy;
    readonly SendConfirmed: SendConfirmedPolicy;
}`);
        expect(file('tests/Billing.ts')).toContain('    readonly policies: Billing.BillingPolicyHandlers;');
        expect(file('Sales.ts')).not.toContain('PolicyHandlers');
    });
});

describe('generated policy cases', async () => {
    const dirs: string[] = [];
    afterAll(async () => {
        for (const d of dirs) await rm(d, { recursive: true, force: true });
    });
    const dir = await mkdtemp(path.join(tmpdir(), 'domaintrail-policies-'));
    dirs.push(dir);
    await symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
    for (const f of generateTypeScript((await model()).model!, {}, { dir: 'tests' }, { Billing: 'required' })) {
        await mkdir(path.dirname(path.join(dir, f.path)), { recursive: true });
        await writeFile(path.join(dir, f.path), f.content);
    }
    const tests = await import(path.join(dir, 'tests', 'index.ts'));

    /** Correct handlers; `change` replaces some. */
    const handlers = (change: Record<string, unknown> = {}) => ({
        BillConfirmedOrder: async (e: { orderId: string }) => ({ id: `invoice-${e.orderId}`, order: e.orderId, total: { amount: 3 } }),
        SendConfirmed: async (e: { at: Date }) => ({ invoice: 'invoice-1', sentAt: e.at, lines: [1, 2] }),
        ...change,
    });
    const failures = async (policies: object): Promise<Record<string, string>> => {
        const out: Record<string, string> = {};
        for (const c of tests.cases(tests.Billing.contract({ policies }, { runs: 20 }))) {
            try {
                await c.run();
            } catch (e) {
                out[c.name] = (e as Error).message;
            }
        }
        return out;
    };
    const NAME =
        'Billing > policies > BillConfirmedOrder (when Sales.OrderConfirmed -> Invoice.issue) resolves every event to an input that the command accepts';

    test('pass for handlers that resolve every event to a valid input', async () => {
        expect(await failures(handlers())).toEqual({});
    });

    test('fail for a missing argument, an invalid value (a nested invariant), a list out of its bounds and a rejection', async () => {
        const broken = async (BillConfirmedOrder: unknown) => (await failures(handlers({ BillConfirmedOrder })))[NAME];
        expect(await broken(async (e: { orderId: string }) => ({ order: e.orderId, total: { amount: 3 } }))).toContain(
            "resolved to an input that the command does not accept: 'id' is missing.",
        );
        expect(await broken(async (e: { orderId: string }) => ({ id: 'i', order: e.orderId, total: { amount: -1 } }))).toContain(
            '\'total\' is not a valid value of its type: {"amount":-1}',
        );
        expect(await broken(async () => Promise.reject(new Error('no order')))).toContain(
            'rejected with no order; the handler of a policy resolves every event to the input of its command.',
        );
        const send = await failures(handlers({ SendConfirmed: async (e: { at: Date }) => ({ invoice: 'i', sentAt: e.at, lines: [] }) }));
        expect(Object.values(send)[0]).toContain("'lines' has 0 elements; declared [1..3]");
    });
});
