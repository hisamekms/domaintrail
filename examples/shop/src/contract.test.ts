// The contract tests generated from the model, registered with bun:test: every context, every aggregate's commands,
// every domain primitive's constructor and Billing's policies (required in domaintrail.jsonc). Run `dt generate ts`
// first (the config's `generate.ts.tests` writes them), then `bun test` in this directory.
import { parseDecimal, type Sales as SalesTypes } from '../generated/domain/index.js';
import { Billing, Common, Sales, register } from '../generated/domain/tests/index.js';
import { billingPolicies } from './app/policies.js';
import { customerCommands } from './domain/customer-commands.js';
import { invoiceCommands } from './domain/invoice-commands.js';
import { orderCommands } from './domain/order-commands.js';
import { makeAmount, makeCustomerId, makeEmailAddress, makeInvoiceId, makeOrderId, makeOrderItemId, makeQuantity, makeSku } from './domain/primitives.js';

register(
    Sales.contract({
        make: { Quantity: makeQuantity, Sku: makeSku, CustomerId: makeCustomerId, OrderId: makeOrderId, OrderItemId: makeOrderItemId },
        Order: orderCommands,
        Customer: customerCommands,
    }),
);
const ok = <T>(r: { ok: true; value: T } | { ok: false }): T => {
    if (!r.ok) throw new Error('invalid example');
    return r.value;
};

// The policy cases feed Billing's handlers generated `OrderConfirmed` events, so the order a handler reads comes from
// here: a confirmed order with that ID. The tests run the handlers with whatever they are wired to.
const confirmed = (id: SalesTypes.OrderId): SalesTypes.ConfirmedOrder => ({
    state: 'Confirmed',
    id,
    customer: makeCustomerId('customer-1'),
    items: [{ id: makeOrderItemId('item-1'), sku: ok(makeSku('ABC-0001')), quantity: ok(makeQuantity(3)), unitPrice: { amount: ok(makeAmount(parseDecimal('12.50')!)), currency: 'USD' } }],
    confirmedAt: new Date('2026-10-24T09:00:00Z'),
});
let invoices = 0;
const policies = billingPolicies({ loadOrder: async (id) => confirmed(id), newInvoiceId: () => makeInvoiceId(`invoice-${++invoices}`) });

register(Billing.contract({ make: { InvoiceId: makeInvoiceId }, Invoice: invoiceCommands, policies }));
register(Common.contract({ make: { EmailAddress: makeEmailAddress, Amount: makeAmount } }));
