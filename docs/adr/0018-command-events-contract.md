# ADR 0018: Command events as an exact contract, keyed outcomes, pure commands

- Status: accepted
- Date: 2026-10-23
- Amends: the `emits` of [ADR 0014](0014-command-transitions.md), the generated contract of
  [ADR 0015](0015-handlers-per-state.md), and the event list of [ADR 0001](0001-mvp-implementation-decisions.md)
- Amended by: [ADR 0019](0019-command-changes-and-decisions.md) (`…ByState` and `byState` replaced by decisions and
  `decide`; the JSDoc of each handler moves to the decision type)

## Context

`emits OrderConfirmed` meant "may emit": the generated contract was a tuple
`Result<readonly [ConfirmedOrder, readonly OrderConfirmed[]], EmptyOrder>`, so an implementation could emit the event
zero, one or ten times, and nothing said whether the confirmation must produce it. The DSL is written by AI agents and
the generated TypeScript is what AI agents implement against: a contract that leaves the count of events open is one
they guess at, and the compiler accepts every guess. Events that only some outcomes emit ("a refund is requested only
when a confirmed order is cancelled") could not be written at all.

Command implementations also made IDs and read the clock themselves (`crypto.randomUUID()` inside `place`), so the
same inputs gave different results, and a command could not be tested — or later generated tests run — without
controlling the environment.

## Decision

### `emits` is exact, with multiplicities

- `emits X`: the command emits **exactly one** `X` when it succeeds — the same notation and meaning as a field `x: T`.
- Multiplicities as for fields: `X?` (at most one), `X[0..*]`, `X[1..*]`, `X[n..m]`.
- On failure (an error) the command emits nothing.
- An event is listed once per command, and two events with the same simple name (of different contexts) cannot be
  emitted by one command: the result is keyed by name (M011).

### `when`: events that depend on the transition

```dt
command cancel(reason: CancelReason)
  Draft | Confirmed -> Cancelled
  emits OrderCancelled,
        RefundRequested when Confirmed ->   // only from Confirmed

command progress(step: Step)
  InProgress -> InProgress | Completed
  emits StepRecorded,
        WorkCompleted when -> Completed     // only when it ends in Completed
```

- `when Sources? -> Targets?` reuses the transition notation, with at least one side; `A | B` on either side. An entry
  applies to an outcome (source state, target state) when the pattern matches it. A multiplicity comes first:
  `ItemAdded[1..*] when -> Draft`.
- M006: the states are sources (left) / targets (right) of the command; the pattern matches at least one outcome; a
  factory has no source (`when -> X` only); commands of an aggregate without states take no `when`. Unknown states are
  reported from linking, as for transitions.
- `when` is a keyword and joins `FeatureName`, so it stays usable as a field or parameter name.

### Generated success value: keyed by the outcome

```ts
export type ConfirmOrder = (order: DraftOrder, at: Timestamp) => Result<{
    readonly Confirmed: {
        readonly aggregate: ConfirmedOrder;
        readonly events: { readonly OrderConfirmed: OrderConfirmed };
    };
}, EmptyOrder>;

export type ProgressWork = (work: InProgressWork, step: Step) => Result<
    | { readonly InProgress: { readonly aggregate: InProgressWork; readonly events: { readonly StepRecorded: StepRecorded } }; readonly Completed?: never }
    | { readonly Completed: { readonly aggregate: CompletedWork; readonly events: { readonly StepRecorded: StepRecorded; readonly WorkCompleted: WorkCompleted } }; readonly InProgress?: never },
    never
>;
```

- The key is the target state's name; every command has this shape, also with one target. An aggregate without
  states is keyed by the aggregate's name (`{ Customer: { aggregate, events } }`).
- With several keys, each branch marks the other keys `?: never`, so a value with two outcomes is rejected.
- `events` is always present, keyed by the events' names (their `type` tag; an event of another context by its simple
  name). By multiplicity: `X` → `X: X`; `X?` → `X?: X`; `X[0..*]` → `X: readonly X[]` (written even when empty);
  `X[1..*]` → `X: readonly [X, ...X[]]`; other `[n..m]` → `X: readonly X[]` with the bounds in JSDoc. Without events,
  the runtime type `NoEvents` (`{ readonly [type: string]: never }`): `{}` is assignable, nothing else.
- Events have **no order** in the contract: they are facts of one decision. With event sourcing, applying the events
  of one command must not depend on their order.
- The JSDoc of the command and of each `…ByState` handler states each entry in words, one `@emits` line each:
  `@emits OrderConfirmed — exactly once when the command succeeds`, `@emits WorkCompleted — exactly once when it ends in
  Completed`, `@emits ItemAdded[2..5] — between 2 and 5 when the command succeeds (not checked by the types)`. A command
  without events says `@emits nothing`.
- `ok` infers its type argument from the contract only (`<T>(value: NoInfer<T>)`), so the object literal is checked
  against the contract exactly. A missing event is reported as "Property 'WorkCompleted' is missing", an event in the
  wrong outcome as "'WorkCompleted' does not exist in type …". With the previous `ok<T>(value: T)`, `T` was inferred
  from the argument, the literal lost its freshness, and an extra event passed silently. Code without a contract to
  return into passes the type: `ok<T>(value)`.

### Handlers per state when the events differ by source

ADR 0015 generated `…ByState` handlers when the targets differ by transition. They are now also generated when the
events differ by source state (a `when` with sources): the outputs differ by source state either way. The generic
contract `ReturnType<…ByState[S['state']]>` stays. Events that depend on the target only (`when -> Completed`) need no
handlers: each outcome's key already tells them apart.

### Runtime helpers

Like `byState`, generic and the same for every model (ADR 0011, 0015):

- `outcome(value)` → `{ to, aggregate, events }`, for infrastructure that handles any command (save, publish).
- `eventList(events)` → the events as one `readonly Event[]`: arrays flattened, absent optional events skipped, sorted
  by event type and then in array order. The order is one of convenience, stable and documented; the contract has none.

`NoEvents`, `Outcome`, `EventOf`, `outcome` and `eventList` are runtime names (M011).

### Pure commands

A command is a pure function of the aggregate and its parameters: no I/O, no clock, no randomness. IDs and times come
in as parameters. This makes implementations reproducible and testable, and is what generated tests (planned) rely
on.

- M020 (warning): a `create command` without a parameter of the aggregate's ID type; it would have to make the ID
  itself.
- `<Aggregate>Commands` says so in its JSDoc.

### When the contract and the implementation disagree

If following the contract would make the implementation do something wrong in business terms — emitting an event
although nothing changed — the DSL is changed (`emits X?`), not the implementation bent to the types.

### Live View and Typed Model

- `CommandModel.emits` holds entries `{ event, cardinality, multiplicity, lower, upper?, when? }`; `emittedEvents(c)`
  gives the event names. Dependencies, the catalog's "used by" and the change list read the events from the entries.
- The behaviour tab and command cards show each event's multiplicity and `when`; the State View writes on each edge
  only the events of that outcome, with their multiplicity. `when` is highlighted as a keyword.
- The language server's hover on a command lists its `emits` entries; renaming a state renames it in `when` too.

### Rejected

- **Tuples** (`readonly [ConfirmedOrder, readonly [OrderConfirmed]]`, or one tuple slot per event): positions carry
  an order the domain does not have, and a wrong implementation is reported by position ("Source has 1 element(s) but
  target requires 2"), not by the event's name.
- **A plain union of outcomes without the key** (`{ aggregate: InProgressWork; events: … } | { aggregate:
  CompletedWork; events: … }`): an InProgress outcome carrying `WorkCompleted` was accepted, since the union is checked
  structurally against its members.
- **A top-level discriminant** (`{ to: 'Completed'; aggregate; events }`): it works, but a wrong event gives a message
  about the whole union rather than the outcome, and `to` repeats what the aggregate's `state` already says.
- **"May emit"** (keeping `emits` as a list of possible events, adding a separate "must emit"): the default would
  still be the weak reading, and AI agents reading `emits X` read "emits X".
- **Exact only for persistent events**: a non-persistent event is still published and still part of the decision;
  whether it is stored does not change whether the command must produce it.

## Consequences

- Every implementation must be rewritten to the keyed shape; implementations that emitted events optionally need
  `X?` (or `[0..*]`) in the DSL.
- Factories take their ID as a parameter (M020 warns until they do); callers generate IDs.
- The compiler reports missing, extra and misplaced events by name. Bounds other than `?`, `[0..*]` and `[1..*]` are
  documented, not checked; generated tests are to check them.
- ADR 0001's "a command without `emits` returns `readonly never[]`" no longer holds: such a command's `events` is
  `NoEvents`.
