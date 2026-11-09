// dt show's text and JSON (over real files and the CLI: test/show.test.ts).
import { describe, expect, test } from 'bun:test';
import { type AggregateModel, elementOf } from '@domaintrail/modeling';
import { lookup, showJson, showText } from './show.js';
import { check } from '../test-helpers.js';

test('dt show exposes kind-specific named outcomes and selection obligations', async () => {
    const source = `context Delivery {
      id RequestId: UUID
      enum Kind { COLLECT DROP_OFF }
      event Collected
      event Delivered
      aggregate Request {
        id: RequestId
        readonly kind: Kind
        state Unassigned
        state Done
        initial Unassigned
        create command open(id: RequestId, kind: Kind) { outcome opened: -> Unassigned }
        command finish()
        transitions for kind == Kind.COLLECT {
          on finish { outcome collected: Unassigned -> Done emits Collected }
        }
        transitions for kind == Kind.DROP_OFF {
          on finish { outcome delivered: Unassigned -> Done select "carrier confirmed" @externalCheck("carrier service") emits Delivered }
        }
      }
    }`;
    const result = await check({ 'delivery.dt': source });
    expect(result.model).toBeDefined();
    const aggregate = elementOf(result.model!, 'Delivery.Request') as AggregateModel;
    const finish = aggregate.commands.find((command) => command.name === 'finish')!;
    const json = showJson(result.model!, { kind: 'command', agg: aggregate, command: finish });
    expect(json).toMatchObject({
        show: 'command',
        command: {
            outcomes: [
                { name: 'collected', kinds: ['COLLECT'], from: 'Unassigned', to: 'Done', selection: 'single' },
                { name: 'delivered', kinds: ['DROP_OFF'], from: 'Unassigned', to: 'Done', selection: 'external', selectionText: 'carrier confirmed' },
            ],
        },
    });
    const lines = showText(result.model!, { kind: 'command', agg: aggregate, command: finish });
    expect(lines.some((line) => line.includes('delivered') && line.includes('for DROP_OFF') && line.includes('select external'))).toBe(true);
    expect(showText(result.model!, { kind: 'element', el: aggregate }).some((line) => line.includes('kind COLLECT: valid states Unassigned, Done'))).toBe(true);
    const delivered = lookup(result.model!, 'Delivered');
    if (!('found' in delivered)) throw new Error('event missing');
    expect(showJson(result.model!, delivered.found)).toMatchObject({ usedBy: { emittedBy: ['Delivery.Request.finish'] } });
});

describe('policy declarations', () => {
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

    test('dt show: a policy, the command it runs and the event it reacts to', async () => {
        const m = (await model()).model!;
        const el = (id: string) => ({ kind: 'element' as const, el: elementOf(m, id)! });
        expect(showText(m, el('Billing.BillConfirmedOrder'))).toEqual([
            '/// 確定した注文は請求する。',
            'policy Billing.BillConfirmedOrder "請求する" when Sales.OrderConfirmed -> Invoice.issue  // billing.dt:16',
            '  event Sales.OrderConfirmed { orderId: OrderId, at: Timestamp }  // sales.dt:13',
            '  create command Invoice.issue(id: InvoiceId, order: Sales.OrderId, total: Money, note: String?)  // billing.dt:12',
            '  input { id: InvoiceId, order: Sales.OrderId, total: Money, note: String? }  // what the application needs to run it, eventually (any mechanism)',
        ]);
        expect(showText(m, el('Billing.SendConfirmed'))[3]).toBe(
            '  input { invoice: InvoiceId, sentAt: Timestamp, lines: Amount[1..3] }  // what the application needs to run it, eventually (any mechanism)',
        );
        const invoice = elementOf(m, 'Billing.Invoice') as AggregateModel;
        expect(showText(m, { kind: 'command', agg: invoice, command: invoice.commands[0] })[1]).toBe(
            '  // triggered by policy BillConfirmedOrder "請求する" when Sales.OrderConfirmed',
        );
        expect(showText(m, el('Sales.OrderConfirmed'))).toContain('  reacted to by (policy): Billing.BillConfirmedOrder, Billing.SendConfirmed');
        const json = showJson(m, { kind: 'command', agg: invoice, command: invoice.commands[1] }) as { command: { triggeredBy: string[] } };
        expect(json.command.triggeredBy).toEqual(['Billing.SendConfirmed']);
    });
});

describe('verified types: dt show and dependencies', () => {
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
});
