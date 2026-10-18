# ADR 0008: Persistent events

- Status: accepted
- Date: 2026-10-18

## Context

Some domain events are facts the system must keep (an order was placed, an invoice was paid); others only notify
whoever is listening at the moment (an order was viewed). Which is which is part of the domain's contract — code that
stores events, an outbox, an audit trail and AI agents implementing commands all need to know it — but the model had
no way to say it, so it lived in people's heads or in implementation code.

How events are stored (event store, table, outbox, retention) is an implementation concern and stays out of the DSL,
as business logic does.

## Decision

```text
persistent event OrderPlaced "注文受付" { orderId: OrderId }   // persisted by contract
event OrderViewed { orderId: OrderId }                         // not persisted
```

- A `persistent` modifier before `event`, written like `shared context` and `create command`. It states only that
  storing the event is part of its contract, not how.
- **Default: not persisted.** Persistence is opted into per event, so existing models keep their meaning and no
  `transient` keyword is needed. There is no context-wide default: each event says it where it is declared.
- `persistent` stays usable as a field and parameter name.
- No new rule. A command may emit persistent and non-persistent events alike.
- Typed Model: `persistent: true` on event elements (absent otherwise), so a change of persistence shows in the
  changes list like any other change.
- Generated TypeScript: a `@persistent` JSDoc tag on the event type, and per context
  `export type PersistentEvent = OrderPlaced | …` when the context has a persistent event, so code that stores events
  can name exactly the persisted ones. The name is checked for collisions by M011 when it is generated.
- Live View: the inspector of an event shows 永続化 / 非永続 next to the kind, the aggregate's 発生させる Event list
  marks each event the same way, and the explorer marks persistent events with an icon. The Structure view is
  unchanged.
