// Hand-written command implementations, checked against the generated contracts.
// Run `domain -r examples/shop generate ts` first; the TypeScript compiler then verifies that
// every command accepts only its declared input states and returns only declared states/events/errors.
import { byState, err, ok, type Sales } from '../generated/domain/index.js';

export const orderCommands: Sales.OrderCommands = {
    place: (customer) => {
        const order: Sales.DraftOrder = { state: 'Draft', id: crypto.randomUUID() as Sales.OrderId, items: [], customer };
        return ok([order, [{ type: 'OrderPlaced', orderId: order.id }]] as const);
    },

    addItem: (order, item) => {
        if (order.items.some((i) => i.sku === item.sku)) return err({ type: 'DuplicateSku', sku: item.sku });
        return ok([{ ...order, items: [...order.items, item] }, []] as const);
    },

    confirm: (order, at) => {
        if (order.items.length === 0) return err({ type: 'EmptyOrder' });
        const confirmed: Sales.ConfirmedOrder = { ...order, state: 'Confirmed', confirmedAt: at };
        return ok([confirmed, [{ type: 'OrderConfirmed', orderId: order.id, confirmedAt: at }]] as const);
    },

    cancel: (order, reason) => {
        const { id, items, customer, note } = order; // state-specific fields are not carried over
        const cancelled: Sales.CancelledOrder = { id, items, customer, note, state: 'Cancelled', reason };
        return ok([cancelled, [{ type: 'OrderCancelled', orderId: order.id, reason }]] as const);
    },

    // The output depends on the input state: one handler per state, each checked against its own transition.
    changeNote: byState<Sales.ChangeNoteOrderByState>({
        Draft: (order, note) => ok([{ ...order, note }, []] as const),
        Confirmed: (order, note) => ok([{ ...order, note }, []] as const),
    }),
};
