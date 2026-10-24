// Reactions across contexts: when an event of one context is published, a use case of another runs. The model states
// the rule as a policy of the reacting context — `policy BillConfirmedOrder when Sales.OrderConfirmed -> Invoice.issue`
// in billing/context.dt — and the generated `Billing.BillConfirmedOrderPolicy` is its handler: from the event to the
// input of `Invoice.issue`. The rule only says that the command runs eventually; here the in-process bus runs it right
// after the event, and a batch or a queue would satisfy it as well. Billing's policies are `required` in
// domaintrail.jsonc, so `Billing.BillingPolicyHandlers` must list every one, and the contract tests run them.
// The new request carries the event's correlation ID and names the event as its cause.
import type { Billing, Sales } from '../../generated/domain/index.js';
import { orderTotal } from '../domain/order-total.js';
import type { Cause, InMemoryEventStore, Stored } from './event-store.js';
import type { InvoiceRepository } from './repositories.js';
import type { UseCases } from './use-cases.js';

const causedBy = (s: Stored<unknown>): Cause => ({ correlationId: s.meta.correlationId, causationId: s.meta.eventId });

/** What Billing's handlers read and make: the order to bill, and the new invoice's ID. */
export interface PolicyDeps {
    readonly loadOrder: (id: Sales.OrderId) => Promise<Sales.Order | undefined>;
    readonly newInvoiceId: () => Billing.InvoiceId;
}

/**
 * The handlers of Billing's policies. They read and make what they need through `deps`, so that the application and the
 * contract tests (src/contract.test.ts) wire them differently. A handler that cannot compute the input rejects.
 */
export function billingPolicies({ loadOrder, newInvoiceId }: PolicyDeps): Billing.BillingPolicyHandlers {
    return {
        // a confirmed order is billed for its total
        BillConfirmedOrder: async (event) => {
            const order = await loadOrder(event.orderId);
            if (order?.state !== 'Confirmed') throw new Error(`order ${event.orderId} is ${order ? order.state : 'not found'}, not Confirmed`);
            return { id: newInvoiceId(), order: order.id, billedAmount: orderTotal(order) };
        },
    };
}

export interface RefundRequest {
    readonly order: Sales.OrderId;
    /** The order's invoice, if one was issued, with its state at the time of the request. */
    readonly invoice?: Pick<Billing.Invoice, 'id' | 'state'>;
    readonly requestedAt: Date;
}

/** Subscribes the policies to the events they react to; returns the refund requests collected. */
export function registerPolicies(
    events: InMemoryEventStore,
    invoices: InvoiceRepository,
    app: UseCases,
    billing: Billing.BillingPolicyHandlers,
    log: (line: string) => void,
): { readonly refundRequests: readonly RefundRequest[] } {
    const refundRequests: RefundRequest[] = [];

    events.on('OrderConfirmed', async (s) => {
        let input: Billing.IssueInvoiceInput;
        try {
            input = await billing.BillConfirmedOrder(s.event);
        } catch (e) {
            log(`policy BillConfirmedOrder: no invoice for ${s.event.orderId}: ${(e as Error).message}`);
            return;
        }
        const r = await app.issueInvoice(input, causedBy(s));
        if (r.ok) log(`policy BillConfirmedOrder: issued ${r.value.id} for ${s.event.orderId}: ${r.value.billedAmount.amount} ${r.value.billedAmount.currency} (caused by ${s.meta.eventId})`);
        else log(`policy BillConfirmedOrder: could not issue an invoice for ${s.event.orderId}: ${r.error.type}`);
    });

    // Not a policy of the DSL: a policy names the command it runs, and Billing has no refund command yet. So the request
    // is only recorded for a person to handle. Adding the command (and then the policy) to the DSL is the way to
    // automate it, not inventing behaviour here.
    events.on('RefundRequested', async (s) => {
        const invoice = (await invoices.find((i) => i.order === s.event.orderId))?.aggregate;
        refundRequests.push({ order: s.event.orderId, ...(invoice && { invoice: { id: invoice.id, state: invoice.state } }), requestedAt: s.meta.recordedAt });
        log(`policy: refund requested for ${s.event.orderId} (${invoice ? `${invoice.id}, ${invoice.state}` : 'no invoice'}), recorded for manual handling (caused by ${s.meta.eventId})`);
    });

    return { refundRequests };
}
