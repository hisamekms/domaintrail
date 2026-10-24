// Wires the application: repositories, the event store with its bus, the use cases and the policies.
import type { Billing, Sales } from '../../generated/domain/index.js';
import { makeInvoiceId } from '../domain/primitives.js';
import { InMemoryEventStore, type Subscriber } from './event-store.js';
import { billingPolicies, registerPolicies } from './policies.js';
import type { Providers } from './providers.js';
import { InMemoryRepository } from './repositories.js';
import { useCases, type Deps } from './use-cases.js';

/** `onEvent` sees every event before the policies react to it (for a log in event order). */
export function createShop(providers: Providers, { log = () => {}, onEvent }: { log?: (line: string) => void; onEvent?: Subscriber } = {}) {
    const deps: Deps = {
        customers: new InMemoryRepository<Sales.CustomerId, Sales.Customer>(),
        orders: new InMemoryRepository<Sales.OrderId, Sales.Order>(),
        invoices: new InMemoryRepository<Billing.InvoiceId, Billing.Invoice>(),
        events: new InMemoryEventStore(providers),
        providers,
    };
    if (onEvent) deps.events.subscribe(onEvent);
    const app = useCases(deps);
    const billing = billingPolicies({
        loadOrder: async (id) => (await deps.orders.load(id))?.aggregate,
        newInvoiceId: () => makeInvoiceId(providers.newId('invoice')),
    });
    const policies = registerPolicies(deps.events, deps.invoices, app, billing, log);
    return { ...deps, app, policies };
}
