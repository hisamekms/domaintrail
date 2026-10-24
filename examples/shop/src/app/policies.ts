// Reactions across contexts: when an event of one context is published, a use case of another runs. The model says
// what happened (the events) and what can be done (the commands); which reaction follows which event is decided here.
// The new request carries the event's correlation ID and names the event as its cause.
import type { Billing, Sales } from '../../generated/domain/index.js';
import type { Cause, InMemoryEventStore, Stored } from './event-store.js';
import type { InvoiceRepository } from './repositories.js';
import type { UseCases } from './use-cases.js';

const causedBy = (s: Stored<unknown>): Cause => ({ correlationId: s.meta.correlationId, causationId: s.meta.eventId });

export interface RefundRequest {
    readonly order: Sales.OrderId;
    /** The order's invoice, if one was issued, with its state at the time of the request. */
    readonly invoice?: Pick<Billing.Invoice, 'id' | 'state'>;
    readonly requestedAt: Date;
}

/** Registers the policies; returns the refund requests they collect. */
export function registerPolicies(events: InMemoryEventStore, invoices: InvoiceRepository, app: UseCases, log: (line: string) => void): { readonly refundRequests: readonly RefundRequest[] } {
    const refundRequests: RefundRequest[] = [];

    // Sales → Billing: a confirmed order is billed for its total.
    events.on('OrderConfirmed', async (s) => {
        const r = await app.issueInvoice(s.event.orderId, causedBy(s));
        if (r.ok) log(`policy: issued ${r.value.id} for ${s.event.orderId}: ${r.value.billedAmount.amount} ${r.value.billedAmount.currency} (caused by ${s.meta.eventId})`);
        else log(`policy: could not issue an invoice for ${s.event.orderId}: ${r.error.type}`);
    });

    // The model has no refund command yet (Billing would need one), so the request is only recorded for a person to
    // handle. Adding the command to the DSL is the way to automate it, not inventing behaviour here.
    events.on('RefundRequested', async (s) => {
        const invoice = (await invoices.find((i) => i.order === s.event.orderId))?.aggregate;
        refundRequests.push({ order: s.event.orderId, ...(invoice && { invoice: { id: invoice.id, state: invoice.state } }), requestedAt: s.meta.recordedAt });
        log(`policy: refund requested for ${s.event.orderId} (${invoice ? `${invoice.id}, ${invoice.state}` : 'no invoice'}), recorded for manual handling (caused by ${s.meta.eventId})`);
    });

    return { refundRequests };
}
