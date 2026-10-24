// The commands of Billing.Invoice. `pay` accepts only an open invoice (`Open -> Paid`): paying a paid invoice is not a
// decision of the domain but a call the application must not make, so it is rejected there, before the command.
// The billed amount is computed by the caller (see order-total.ts): `issue` records it as given.
import { Billing, decide, ok } from '../../generated/domain/index.js';

export const invoiceCommands: Billing.InvoiceCommands = {
    issue: decide<Billing.IssueInvoiceDecision>(Billing.InvoiceShape, (id, order, billedAmount) =>
        ok({ Open: { set: { id, order, billedAmount }, events: {} } }),
    ),

    pay: decide<Billing.PayInvoiceDecision>(Billing.InvoiceShape, {
        Open: (invoice, paidAt) => ok({ Paid: { set: { paidAt }, events: { InvoicePaid: { type: 'InvoicePaid', invoiceId: invoice.id, paidAt } } } }),
    }),
};
