// Hand-written command implementations, checked against the generated contracts.
// Run `domain -r examples/shop generate ts` first; the TypeScript compiler then verifies that every command decides
// exactly its declared outcomes: the fields it may set (`changes`, and the new fields of the target state) and its events.
// `decide` makes the aggregates: it carries over every other field and drops those the target state does not have.
// Commands are pure: the new order's ID and the confirmation time are parameters.
import { Sales, decide, err, ok } from '../generated/domain/index.js';

const noteChanged = (order: Sales.Order, note: string | undefined) =>
    note === order.note ? {} : { NoteChanged: { type: 'NoteChanged', orderId: order.id, note } as const };

export const orderCommands: Sales.OrderCommands = {
    place: decide<Sales.PlaceOrderDecision>(Sales.OrderShape, (id, customer) =>
        ok({ Draft: { set: { id, items: [], customer, note: undefined }, events: { OrderPlaced: { type: 'OrderPlaced', orderId: id } } } }),
    ),

    // `changes items`: the only field it sets.
    addItem: decide<Sales.AddItemOrderDecision>(Sales.OrderShape, {
        Draft: (order, item) => {
            if (order.items.some((i) => i.sku === item.sku)) return err({ type: 'DuplicateSku', sku: item.sku });
            return ok({ Draft: { set: { items: [...order.items, item] }, events: {} } });
        },
    }),

    // Changes no common field: only `confirmedAt`, new in Confirmed, is set.
    confirm: decide<Sales.ConfirmOrderDecision>(Sales.OrderShape, {
        Draft: (order, at) => {
            if (order.items.length === 0) return err({ type: 'EmptyOrder' });
            return ok({ Confirmed: { set: { confirmedAt: at }, events: { OrderConfirmed: { type: 'OrderConfirmed', orderId: order.id, confirmedAt: at } } } });
        },
    }),

    // The events depend on the input state (`RefundRequested when Confirmed ->`); `confirmedAt` is dropped by `decide`.
    // Both handlers check the requirement `noteForOther` first.
    cancel: decide<Sales.CancelOrderDecision>(Sales.OrderShape, {
        Draft: (order, reason) => {
            if (reason === 'Other' && order.note === undefined) return err({ type: 'NoteRequired' });
            return ok({ Cancelled: { set: { reason }, events: { OrderCancelled: { type: 'OrderCancelled', orderId: order.id, reason } } } });
        },
        Confirmed: (order, reason) => {
            if (reason === 'Other' && order.note === undefined) return err({ type: 'NoteRequired' });
            return ok({
                Cancelled: {
                    set: { reason },
                    events: {
                        OrderCancelled: { type: 'OrderCancelled', orderId: order.id, reason },
                        RefundRequested: { type: 'RefundRequested', orderId: order.id },
                    },
                },
            });
        },
    }),

    // `changes note`, in either state; `NoteChanged?`: nothing is emitted when the note stays the same.
    changeNote: decide<Sales.ChangeNoteOrderDecision>(Sales.OrderShape, {
        Draft: (order, note) => ok({ Draft: { set: { note }, events: noteChanged(order, note) } }),
        Confirmed: (order, note) => ok({ Confirmed: { set: { note }, events: noteChanged(order, note) } }),
    }),
};
