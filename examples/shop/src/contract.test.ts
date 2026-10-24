// The contract tests generated from the model, registered with bun:test: every context, every aggregate's commands and
// every domain primitive's constructor. Run `dt generate ts` first (the config's `generate.ts.tests` writes them), then
// `bun test` in this directory.
import { Billing, Common, Sales, register } from '../generated/domain/tests/index.js';
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
register(Billing.contract({ make: { InvoiceId: makeInvoiceId }, Invoice: invoiceCommands }));
register(Common.contract({ make: { EmailAddress: makeEmailAddress, Amount: makeAmount } }));
