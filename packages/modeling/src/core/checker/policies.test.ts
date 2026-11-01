import { describe, expect, test } from 'bun:test';
import { formatDomain } from '../../format/format.js';
import { contextDependencies, groupByContext } from '../../model/dependencies.js';
import { check } from '../../test-helpers.js';

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

describe('policy declarations', () => {
    test('a valid model has no problems; `policy` stays usable as a field and parameter name', async () => {
        expect(await problems(BILLING)).toEqual([]);
        const a = await model(
            BILLING.replace('    state Open\n', '    policy: String\n    state Open\n').replace('note: String?)', 'note: String?, policy: String)'),
        );
        expect(a.diagnostics).toEqual([]);
    });

    test('M023: the event, the aggregate of its own context and the command exist', async () => {
        expect(await problems(BILLING.replace('Sales.OrderConfirmed -> Invoice.issue', 'Sales.OrderConfirmd -> Invoice.issue'))).toEqual([
            {
                code: 'M023',
                severity: 'error',
                message: "Policy 'BillConfirmedOrder' reacts to event 'Sales.OrderConfirmd', which does not exist.",
                hint: "did you mean 'Sales.OrderConfirmed'?",
            },
        ]);
        expect(await problems(BILLING.replace('-> Invoice.issue', '-> Order.confirm'))).toEqual([
            {
                code: 'M023',
                severity: 'error',
                message: "Policy 'BillConfirmedOrder' runs a command of 'Sales.Order', but a policy runs a command of its own context 'Billing'.",
                hint: "declare the policy in context 'Sales' (the context that reacts), or run a command of an aggregate of 'Billing'",
            },
        ]);
        expect(await problems(BILLING.replace('-> Invoice.issue', '-> Invoic.issue'))).toEqual([
            {
                code: 'M023',
                severity: 'error',
                message: "Policy 'BillConfirmedOrder' runs a command of aggregate 'Invoic', which is not an aggregate of context 'Billing'.",
                hint: "did you mean 'Invoice'?",
            },
        ]);
        expect(await problems(BILLING.replace('-> Invoice.issue', '-> Invoice.isue'))).toEqual([
            {
                code: 'M023',
                severity: 'error',
                message: "Policy 'BillConfirmedOrder' runs 'Invoice.isue', but 'Invoice' has no command 'isue'.",
                hint: "did you mean 'issue'?",
            },
        ]);
    });

    test('names are unique, the same reaction twice is a warning, and a shared context holds no policy', async () => {
        const twice = BILLING.replace('  policy SendConfirmed', '  policy BillAgain when Sales.OrderConfirmed -> Invoice.issue\n  policy SendConfirmed');
        expect(await problems(twice)).toEqual([
            {
                code: 'M023',
                severity: 'warning',
                message: "Policy 'BillAgain' states the same reaction as 'BillConfirmedOrder': when 'Sales.OrderConfirmed', 'Invoice.issue'.",
                hint: 'remove one of them, or merge their descriptions',
            },
        ]);
        expect((await problems(BILLING.replace('policy SendConfirmed', 'policy BillConfirmedOrder'))).map((p) => p.code)).toEqual(['M002']);
        const shared = 'shared context Common {\n  policy P when Sales.OrderPlaced -> Invoice.issue\n}\n';
        expect((await problems(BILLING, { 'common.dt': shared })).map((p) => p.code)).toEqual(expect.arrayContaining(['M014']));
    });

    test('the context map counts a policy as an event dependency of the reacting context', async () => {
        const deps = contextDependencies((await model()).model!);
        expect(deps.filter((d) => d.kind === 'event')).toEqual([
            { from: 'Billing', to: 'Sales', kind: 'event', source: 'Billing.BillConfirmedOrder', path: 'when OrderConfirmed', target: 'Sales.OrderConfirmed' },
            { from: 'Billing', to: 'Sales', kind: 'event', source: 'Billing.SendConfirmed', path: 'when OrderConfirmed', target: 'Sales.OrderConfirmed' },
        ]);
        expect(groupByContext(deps).map((g) => [g.from, g.to, g.ids, g.types, g.events])).toEqual([['Billing', 'Sales', 2, 0, 2]]);
    });

    test('dt fmt keeps a policy on one line when it fits, else puts `when` on the next', () => {
        expect(formatDomain('context B {\n  policy   P "x"\n  when  E->A . c\n}\n')).toBe('context B {\n  policy P "x" when E -> A.c\n}\n');
        const long = `context B {\n  policy P "${'長'.repeat(50)}" when Sales.OrderConfirmed -> Invoice.issue\n}\n`;
        expect(formatDomain(long)).toBe(`context B {\n  policy P "${'長'.repeat(50)}"\n    when Sales.OrderConfirmed -> Invoice.issue\n}\n`);
    });
});
