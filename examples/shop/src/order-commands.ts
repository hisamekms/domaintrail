// Hand-written command implementations, checked against the generated contracts.
// Run `domain -r examples/shop generate ts` first; the TypeScript compiler then verifies that
// every command accepts only its declared input states and returns exactly its declared outcome and events.
// Commands are pure: the new order's ID and the confirmation time are parameters.
import { byState, err, ok, type Sales } from '../generated/domain/index.js';

/** A cancelled order; the fields of the state it leaves (`confirmedAt`) are not carried over. */
const cancelled = ({ id, items, customer, note }: Sales.DraftOrder | Sales.ConfirmedOrder, reason: Sales.CancelReason): Sales.CancelledOrder => ({
    id,
    items,
    customer,
    note,
    state: 'Cancelled',
    reason,
});

export const orderCommands: Sales.OrderCommands = {
    place: (id, customer) =>
        ok({ Draft: { aggregate: { state: 'Draft', id, items: [], customer }, events: { OrderPlaced: { type: 'OrderPlaced', orderId: id } } } }),

    addItem: (order, item) => {
        if (order.items.some((i) => i.sku === item.sku)) return err({ type: 'DuplicateSku', sku: item.sku });
        return ok({ Draft: { aggregate: { ...order, items: [...order.items, item] }, events: {} } });
    },

    confirm: (order, at) => {
        if (order.items.length === 0) return err({ type: 'EmptyOrder' });
        return ok({
            Confirmed: {
                aggregate: { ...order, state: 'Confirmed', confirmedAt: at },
                events: { OrderConfirmed: { type: 'OrderConfirmed', orderId: order.id, confirmedAt: at } },
            },
        });
    },

    // The events depend on the input state (`RefundRequested when Confirmed ->`): one handler per state.
    cancel: byState<Sales.CancelOrderByState>({
        Draft: (order, reason) =>
            ok({ Cancelled: { aggregate: cancelled(order, reason), events: { OrderCancelled: { type: 'OrderCancelled', orderId: order.id, reason } } } }),
        Confirmed: (order, reason) =>
            ok({
                Cancelled: {
                    aggregate: cancelled(order, reason),
                    events: {
                        OrderCancelled: { type: 'OrderCancelled', orderId: order.id, reason },
                        RefundRequested: { type: 'RefundRequested', orderId: order.id },
                    },
                },
            }),
    }),

    // The output depends on the input state: one handler per state, each checked against its own transition.
    // `NoteChanged?`: nothing is emitted when the note stays the same.
    changeNote: byState<Sales.ChangeNoteOrderByState>({
        Draft: (order, note) =>
            ok({ Draft: { aggregate: { ...order, note }, events: note === order.note ? {} : { NoteChanged: { type: 'NoteChanged', orderId: order.id, note } } } }),
        Confirmed: (order, note) =>
            ok({ Confirmed: { aggregate: { ...order, note }, events: note === order.note ? {} : { NoteChanged: { type: 'NoteChanged', orderId: order.id, note } } } }),
    }),
};
