// In-memory repositories. The version, `createdAt` and `updatedAt` are technical metadata: they are in no `.dt` file
// and in no generated type, so they travel next to the aggregate in an envelope (`dt guide metadata`) instead of
// being mixed into it.
import { err, ok, type Billing, type Result, type Sales } from '../../generated/domain/index.js';

export interface AggregateMeta {
    /** Counts the saves: 1 after the first. */
    readonly version: number;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

export type Versioned<A, M extends AggregateMeta = AggregateMeta> = { readonly aggregate: A; readonly meta: M };

/** Someone else saved the aggregate after it was loaded (or created one with the same ID). */
export interface VersionConflict {
    readonly type: 'VersionConflict';
    readonly id: string;
    readonly expected: number | undefined;
    readonly actual: number | undefined;
}

export interface Repository<Id extends string, A extends { readonly id: Id }> {
    load(id: Id): Promise<Versioned<A> | undefined>;
    /** The first aggregate that matches; a real repository would offer named queries (an index) instead. */
    find(matches: (aggregate: A) => boolean): Promise<Versioned<A> | undefined>;
    /** Optimistic locking: `expected` is the version that was loaded, `undefined` for a new aggregate. */
    save(aggregate: A, expected: number | undefined, at: Date): Promise<Result<Versioned<A>, VersionConflict>>;
}

export class InMemoryRepository<Id extends string, A extends { readonly id: Id }> implements Repository<Id, A> {
    readonly #items = new Map<Id, Versioned<A>>();

    async load(id: Id): Promise<Versioned<A> | undefined> {
        return this.#items.get(id);
    }

    async find(matches: (aggregate: A) => boolean): Promise<Versioned<A> | undefined> {
        return [...this.#items.values()].find((v) => matches(v.aggregate));
    }

    async save(aggregate: A, expected: number | undefined, at: Date): Promise<Result<Versioned<A>, VersionConflict>> {
        const current = this.#items.get(aggregate.id);
        if (current?.meta.version !== expected) return err({ type: 'VersionConflict', id: aggregate.id, expected, actual: current?.meta.version });
        const saved = { aggregate, meta: { version: (expected ?? 0) + 1, createdAt: current?.meta.createdAt ?? at, updatedAt: at } };
        this.#items.set(aggregate.id, saved);
        return ok(saved);
    }
}

export type CustomerRepository = Repository<Sales.CustomerId, Sales.Customer>;
export type OrderRepository = Repository<Sales.OrderId, Sales.Order>;
export type InvoiceRepository = Repository<Billing.InvoiceId, Billing.Invoice>;
