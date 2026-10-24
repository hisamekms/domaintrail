// The use cases: the application around the pure commands. Each one turns raw input into domain values (with the
// `make…` constructors, and the factories of verified types for the checks beyond the aggregate), loads the aggregate, rejects a state the command does not accept, calls the command with the
// IDs and the time from the providers, and on success saves the aggregate and records its events. A domain error is
// returned as it is, typed by the command's contract; nothing is saved and no event is recorded.
import { eventList, err, ok, outcome, type Billing, type Common, type Result, type Sales } from '../../generated/domain/index.js';
import { customerCommands } from '../domain/customer-commands.js';
import { invoiceCommands } from '../domain/invoice-commands.js';
import { orderCommands } from '../domain/order-commands.js';
import { makeAmount, makeCustomerId, makeEmailAddress, makeOrderId, makeOrderItemId, makeQuantity, makeSku, parseDecimal } from '../domain/primitives.js';
import type { Cause, DomainEvent, InMemoryEventStore } from './event-store.js';
import type { Providers } from './providers.js';
import type { CustomerRepository, InvoiceRepository, OrderRepository, Repository, VersionConflict, Versioned } from './repositories.js';
import { verifications } from './verifications.js';

export interface Deps {
    readonly customers: CustomerRepository;
    readonly orders: OrderRepository;
    readonly invoices: InvoiceRepository;
    readonly events: InMemoryEventStore;
    readonly providers: Providers;
}

export interface NotFound {
    readonly type: 'NotFound';
    readonly aggregate: 'Customer' | 'Order' | 'Invoice';
    readonly id: string;
}

/**
 * The aggregate is in a state the command does not accept (`confirm` of a cancelled order, `pay` of a paid invoice).
 * The contracts make this the caller's check: a command's parameter is typed by its source states, so the domain has no
 * error for it.
 */
export interface NotAllowed {
    readonly type: 'NotAllowed';
    readonly command: string;
    readonly state: string;
}

export interface NotADecimal {
    readonly type: 'NotADecimal';
    readonly value: string;
}

/** Errors of the application, as opposed to those the domain decides. */
export type AppError = NotFound | NotAllowed | VersionConflict;

/** An order item as it comes in from outside: plain values, not yet domain primitives. */
export interface ItemInput {
    readonly sku: string;
    readonly quantity: number;
    readonly unitPrice: { readonly amount: string; readonly currency: Common.Currency };
}

export type UseCases = ReturnType<typeof useCases>;

export function useCases({ customers, orders, invoices, events, providers }: Deps) {
    const request = (): Cause => ({ correlationId: providers.newId('request') });
    const { makeAvailableEmail } = verifications(customers);

    async function load<Id extends string, A extends { readonly id: Id }>(repo: Repository<Id, A>, aggregate: NotFound['aggregate'], id: Id): Promise<Result<Versioned<A>, NotFound>> {
        const loaded = await repo.load(id);
        return loaded ? ok(loaded) : err({ type: 'NotFound', aggregate, id });
    }

    /** Saves the outcome of a command and records its events; `expected` is the loaded version. */
    async function commit<Id extends string, A extends { readonly id: Id }, T extends A>(
        repo: Repository<Id, A>,
        aggregate: T,
        expected: number | undefined,
        emitted: readonly DomainEvent[],
        cause: Cause,
    ): Promise<Result<T, VersionConflict>> {
        const saved = await repo.save(aggregate, expected, providers.now());
        if (!saved.ok) return saved;
        await events.record(emitted, cause);
        return ok(aggregate);
    }

    const notAllowed = (command: string, state: string) => err<NotAllowed>({ type: 'NotAllowed', command, state });

    return {
        async registerCustomer(name: string, email: string, cause = request()): Promise<Result<Sales.Customer, Common.InvalidEmailAddress | Sales.EmailTaken | AppError>> {
            const address = makeEmailAddress(email);
            if (!address.ok) return address;
            const available = await makeAvailableEmail(address.value, undefined); // a new customer: no one to leave out
            if (!available.ok) return available;
            const r = customerCommands.register(makeCustomerId(providers.newId('customer')), name, available.value);
            if (!r.ok) return r; // `never` today; kept so that an error added to the DSL is returned, not lost
            const { aggregate, events: emitted } = outcome(r.value);
            return commit(customers, aggregate, undefined, eventList(emitted), cause);
        },

        async renameCustomer(id: Sales.CustomerId, name: string, cause = request()): Promise<Result<Sales.Customer, AppError>> {
            const loaded = await load(customers, 'Customer', id);
            if (!loaded.ok) return loaded;
            const r = customerCommands.rename(loaded.value.aggregate, name);
            if (!r.ok) return r;
            const { aggregate, events: emitted } = outcome(r.value);
            return commit(customers, aggregate, loaded.value.meta.version, eventList(emitted), cause);
        },

        async changeEmail(id: Sales.CustomerId, email: string, cause = request()): Promise<Result<Sales.Customer, Common.InvalidEmailAddress | Sales.EmailTaken | AppError>> {
            const address = makeEmailAddress(email);
            if (!address.ok) return address;
            const loaded = await load(customers, 'Customer', id);
            if (!loaded.ok) return loaded;
            const available = await makeAvailableEmail(address.value, id); // the customer may keep its own address
            if (!available.ok) return available;
            const r = customerCommands.changeEmail(loaded.value.aggregate, available.value);
            if (!r.ok) return r;
            const { aggregate, events: emitted } = outcome(r.value);
            return commit(customers, aggregate, loaded.value.meta.version, eventList(emitted), cause);
        },

        // `references customer` is an ID only; that the customer exists is the application's check, not the command's.
        async placeOrder(customer: Sales.CustomerId, cause = request()): Promise<Result<Sales.DraftOrder, AppError>> {
            const known = await load(customers, 'Customer', customer);
            if (!known.ok) return known;
            const r = orderCommands.place(makeOrderId(providers.newId('order')), customer);
            if (!r.ok) return r;
            const { aggregate, events: emitted } = outcome(r.value);
            return commit(orders, aggregate, undefined, eventList(emitted), cause);
        },

        async addItem(
            id: Sales.OrderId,
            input: ItemInput,
            cause = request(),
        ): Promise<Result<Sales.DraftOrder, Sales.DuplicateSku | Sales.CurrencyMismatch | Sales.InvalidSku | Sales.InvalidQuantity | Common.InvalidAmount | NotADecimal | AppError>> {
            const sku = makeSku(input.sku);
            if (!sku.ok) return sku;
            const quantity = makeQuantity(input.quantity);
            if (!quantity.ok) return quantity;
            const decimal = parseDecimal(input.unitPrice.amount);
            if (decimal === undefined) return err({ type: 'NotADecimal', value: input.unitPrice.amount });
            const amount = makeAmount(decimal);
            if (!amount.ok) return amount;
            const loaded = await load(orders, 'Order', id);
            if (!loaded.ok) return loaded;
            const order = loaded.value.aggregate;
            if (order.state !== 'Draft') return notAllowed('addItem', order.state);
            const item: Sales.OrderItem = { id: makeOrderItemId(providers.newId('item')), sku: sku.value, quantity: quantity.value, unitPrice: { amount: amount.value, currency: input.unitPrice.currency } };
            const r = orderCommands.addItem(order, item);
            if (!r.ok) return r;
            const { aggregate, events: emitted } = outcome(r.value);
            return commit(orders, aggregate, loaded.value.meta.version, eventList(emitted), cause);
        },

        // The business time of the confirmation is the time of the request here; an import would pass the original one.
        async confirmOrder(id: Sales.OrderId, cause = request()): Promise<Result<Sales.ConfirmedOrder, Sales.EmptyOrder | AppError>> {
            const loaded = await load(orders, 'Order', id);
            if (!loaded.ok) return loaded;
            const order = loaded.value.aggregate;
            if (order.state !== 'Draft') return notAllowed('confirm', order.state);
            const r = orderCommands.confirm(order, providers.now());
            if (!r.ok) return r;
            const { aggregate, events: emitted } = outcome(r.value);
            return commit(orders, aggregate, loaded.value.meta.version, eventList(emitted), cause);
        },

        async cancelOrder(id: Sales.OrderId, reason: Sales.CancelReason, cause = request()): Promise<Result<Sales.CancelledOrder, Sales.NoteRequired | AppError>> {
            const loaded = await load(orders, 'Order', id);
            if (!loaded.ok) return loaded;
            const order = loaded.value.aggregate;
            if (order.state === 'Cancelled') return notAllowed('cancel', order.state);
            const r = orderCommands.cancel(order, reason);
            if (!r.ok) return r;
            const { aggregate, events: emitted } = outcome(r.value);
            return commit(orders, aggregate, loaded.value.meta.version, eventList(emitted), cause);
        },

        async changeNote(id: Sales.OrderId, note: string | undefined, cause = request()): Promise<Result<Sales.DraftOrder | Sales.ConfirmedOrder, AppError>> {
            const loaded = await load(orders, 'Order', id);
            if (!loaded.ok) return loaded;
            const order = loaded.value.aggregate;
            if (order.state === 'Cancelled') return notAllowed('changeNote', order.state);
            const r = orderCommands.changeNote(order, note);
            if (!r.ok) return r;
            const { aggregate, events: emitted } = outcome(r.value);
            return commit(orders, aggregate, loaded.value.meta.version, eventList(emitted), cause);
        },

        /**
         * Billing: issues an invoice. Run by the policy `BillConfirmedOrder` on `OrderConfirmed`, with the input its
         * handler computed (the generated `IssueInvoiceInput`: the new ID, the order and the amount).
         */
        async issueInvoice({ id, order, billedAmount }: Billing.IssueInvoiceInput, cause = request()): Promise<Result<Billing.OpenInvoice, AppError>> {
            const r = invoiceCommands.issue(id, order, billedAmount);
            if (!r.ok) return r;
            const { aggregate, events: emitted } = outcome(r.value);
            return commit(invoices, aggregate, undefined, eventList(emitted), cause);
        },

        async payInvoice(id: Billing.InvoiceId, cause = request()): Promise<Result<Billing.PaidInvoice, AppError>> {
            const loaded = await load(invoices, 'Invoice', id);
            if (!loaded.ok) return loaded;
            const invoice = loaded.value.aggregate;
            if (invoice.state !== 'Open') return notAllowed('pay', invoice.state);
            const r = invoiceCommands.pay(invoice, providers.now());
            if (!r.ok) return r;
            const { aggregate, events: emitted } = outcome(r.value);
            return commit(invoices, aggregate, loaded.value.meta.version, eventList(emitted), cause);
        },
    };
}
