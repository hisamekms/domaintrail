// The event store and an in-process bus. `persistent` in the DSL makes storing an event part of its contract
// (`Sales.PersistentEvent`, `Billing.PersistentEvent`); every event, stored or not, is published to the subscribers.
// Event ID, recording time and correlation are technical metadata, kept in an envelope `{ event, meta }` beside the
// generated event (`dt guide metadata`).
import type { Billing, Sales } from '../../generated/domain/index.js';
import type { Providers } from './providers.js';

export type DomainEvent = Sales.DomainEvent | Billing.DomainEvent;
export type PersistentEvent = Sales.PersistentEvent | Billing.PersistentEvent;

/** Which request an event belongs to, and which event caused it (set by policies). */
export interface Cause {
    readonly correlationId: string;
    readonly causationId?: string;
}

export interface EventMeta extends Cause {
    readonly eventId: string;
    /** When the system recorded the event; the business time, if any, is a field of the event (`confirmedAt`). */
    readonly recordedAt: Date;
}

export type Stored<E> = { readonly event: E; readonly meta: EventMeta };

export type Subscriber<E = DomainEvent> = (stored: Stored<E>) => void | Promise<void>;

// The persistent events as data. `satisfies` makes the compiler report this list when `persistent` changes in the DSL.
const persistent = { OrderPlaced: true, OrderConfirmed: true, InvoicePaid: true } satisfies Record<PersistentEvent['type'], true>;

const isPersistent = (s: Stored<DomainEvent>): s is Stored<PersistentEvent> => s.event.type in persistent;

export class InMemoryEventStore {
    readonly #log: Stored<PersistentEvent>[] = [];
    readonly #subscribers: Subscriber[] = [];

    constructor(private readonly providers: Providers) {}

    /** The stored events, oldest first. */
    get stored(): readonly Stored<PersistentEvent>[] {
        return this.#log;
    }

    subscribe(subscriber: Subscriber): void {
        this.#subscribers.push(subscriber);
    }

    on<T extends DomainEvent['type']>(type: T, subscriber: Subscriber<Extract<DomainEvent, { type: T }>>): void {
        const isOfType = (s: Stored<DomainEvent>): s is Stored<Extract<DomainEvent, { type: T }>> => s.event.type === type;
        this.subscribe((s) => (isOfType(s) ? subscriber(s) : undefined));
    }

    /**
     * Stores the persistent events of one command and then publishes all of them, one subscriber after the other.
     * The use cases call it right after saving the aggregate. In memory nothing can fail between the two; a real store
     * would write both in one transaction (or the events to an outbox) so that neither is lost without the other.
     */
    async record(events: readonly DomainEvent[], cause: Cause): Promise<void> {
        const stored = events.map((event) => ({ event, meta: { ...cause, eventId: this.providers.newId('event'), recordedAt: this.providers.now() } }));
        this.#log.push(...stored.filter(isPersistent));
        for (const s of stored) for (const subscriber of this.#subscribers) await subscriber(s);
    }
}
