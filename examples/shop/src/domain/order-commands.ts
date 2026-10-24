// The commands of Sales.Order, checked against the generated contracts.
// Run `dt -r examples/shop generate ts` first; the TypeScript compiler then verifies that every command decides
// exactly its declared outcomes: the fields it may set (`changes`, and the new fields of the target state) and its events.
// `decide` makes the aggregates: it carries over every other field and drops those the target state does not have.
// Commands are pure: the new order's ID and the confirmation time are parameters.
// The requirements are checked with the generated `check…Requires`: their expressions are the DSL's, so the two cannot
// drift apart. What is written here is the rest: which error each requirement returns, and what the outcome sets.
import { Sales, decide, err, ok } from '../../generated/domain/index.js';

const noteChanged = (order: Sales.Order, note: string | undefined) =>
    note === order.note ? {} : { NoteChanged: { type: 'NoteChanged', orderId: order.id, note } as const };

export const orderCommands: Sales.OrderCommands = {
    place: decide<Sales.PlaceOrderDecision>(Sales.OrderShape, (id, customer) =>
        ok({ Draft: { set: { id, items: [], customer, note: undefined }, events: { OrderPlaced: { type: 'OrderPlaced', orderId: id } } } }),
    ),

    // `changes items`: the only field it sets. The requirements in declaration order: the first that fails decides the error.
    addItem: decide<Sales.AddItemOrderDecision>(Sales.OrderShape, {
        Draft: (order, item) => {
            switch (Sales.checkAddItemOrderRequires(order, item)) {
                case 'newSku':
                    return err({ type: 'DuplicateSku', sku: item.sku });
                case 'sameCurrency':
                    return err({ type: 'CurrencyMismatch' });
            }
            return ok({ Draft: { set: { items: [...order.items, item] }, events: {} } });
        },
    }),

    // Changes no common field: only `confirmedAt`, new in Confirmed, is set.
    confirm: decide<Sales.ConfirmOrderDecision>(Sales.OrderShape, {
        Draft: (order, at) => {
            if (Sales.checkConfirmOrderRequires(order, at) === 'hasItems') return err({ type: 'EmptyOrder' });
            return ok({ Confirmed: { set: { confirmedAt: at }, events: { OrderConfirmed: { type: 'OrderConfirmed', orderId: order.id, confirmedAt: at } } } });
        },
    }),

    // The events depend on the input state (`RefundRequested when Confirmed ->`); `confirmedAt` is dropped by `decide`.
    cancel: decide<Sales.CancelOrderDecision>(Sales.OrderShape, {
        Draft: (order, reason) => {
            if (Sales.checkCancelOrderRequires(order, reason) === 'noteForOther') return err({ type: 'NoteRequired' });
            return ok({ Cancelled: { set: { reason }, events: { OrderCancelled: { type: 'OrderCancelled', orderId: order.id, reason } } } });
        },
        Confirmed: (order, reason) => {
            if (Sales.checkCancelOrderRequires(order, reason) === 'noteForOther') return err({ type: 'NoteRequired' });
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
