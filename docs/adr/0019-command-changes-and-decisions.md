# ADR 0019: The fields a command changes, decisions and `decide`

- Status: accepted
- Date: 2026-10-23
- Supersedes: [ADR 0015](0015-handlers-per-state.md) (`…ByState` handlers and `byState`)
- Amends: [ADR 0011](0011-generated-code-boundary.md) (generated code may hold data without logic), the generated
  contract of [ADR 0014](0014-command-transitions.md) and [ADR 0018](0018-command-events-contract.md) for commands
  whose output depends on the input

## Context

ADR 0018 made a command's events an exact contract, but its aggregate was still open: an implementation returned
the whole aggregate, and the types only checked that it was some aggregate in the target state. Two mistakes
type-checked (verified with tsc):

- `confirm` emptying `items`: `{ ...order, state: 'Confirmed', confirmedAt: at, items: [] }` is a `ConfirmedOrder`.
- a source state's own field leaking into the target: `{ ...confirmed, state: 'Cancelled', reason }` keeps
  `confirmedAt` on the cancelled order, since an object type does not forbid extra properties that are not written in
  the literal.

Nothing in the DSL said which fields a command may change, so neither the compiler nor a reader could tell a command
that changes the note from one that may rewrite anything. The DSL is written by AI agents, and AI agents implement
against the generated TypeScript: what a command may change has to be stated in the model and enforced by the types,
with messages that name the field.

## Decision

### `changes`

```dt
command changeNote(note: Note?)
  Draft -> Draft, Confirmed -> Confirmed
  changes note

command confirm(at: Timestamp)
  Draft -> Confirmed                 // no `changes`: no common field changes
  emits OrderConfirmed
```

`changes f1, f2` lists the fields a command may change. It is written after `requires` and before `emits` (the order
of a command is parameters and label, transitions, `requires`, `changes`, `emits`, `errors`): what the command
requires, what it changes, what it reports.

1. Without `changes`, a command changes **no** common field — strict, as `emits` is exact.
2. A state-specific field that both the source and the target state have, with the same name and type, is **carried
   over**; listing it in `changes` lets the command set it. "Same type" is the same base type, the same multiplicity
   as written, and the same kind of field (with the same target for `references`): a field that is `PersonId?` in one
   state and `PersonId` in the next is not carried over.
3. A `create command` sets every field; `changes` on it is an error.
4. An aggregate without states: only the fields in `changes` can be set.
5. A field in `changes` is **always given** in the decision's `set`: there is no "absent = keep". An optional field is
   cleared by giving `undefined`; a command that changes a field only in some branches gives the old value in the
   others.
6. The unit is a top-level field: `changes items`, not its elements.

The other fields follow from the transition: the target state's own fields that are not carried over are new and
always set, the source state's own fields that are not carried over are dropped, and the remaining common fields are
kept.

Checks:

- M021: a name in `changes` is a field of the aggregate — a common field (also from a field set) or a field of one of
  its states — other than its identity (`id` never changes); `changes` on a `create command` is an error.
- M021: a state-specific field in `changes` must be carried over by at least one outcome of the command, i.e. by a
  transition from a state that has it to a state that has it, with the same type. In every other outcome the field
  is either new in the target (and set anyway) or not in the target (and dropped), so a field no outcome carries over
  could not be changed by listing it. A field that only some outcomes carry over is allowed: in the others it is new
  or absent (`Draft -> Draft, Confirmed -> Confirmed changes confirmedAt` changes it on Confirmed orders; Draft orders
  have none). Unknown names get `did you mean …?`.
- M002: a field is listed once.
- `changes` is a keyword and joins `FeatureName`, so it stays usable as a field or parameter name. The names are
  plain field names, not cross-references (fields are not cross-references elsewhere either): the language server
  shows them in a command's hover and does not rename them.

### Implementation form: decisions, assembled by `decide`

Users (AI agents) no longer return the aggregate. They return a **decision**: per outcome key (the target state, as in
ADR 0018) a `set` and the `events`. Every command gets a `<Command><Aggregate>Decision` type:

```ts
/**
 * Order.confirm, decided per source state; implement it with `decide(OrderShape, …)` from the runtime.
 * Each outcome gives the fields of `set`, and `decide` makes the aggregate, taking the other fields from the input.
 * @requires hasItems (明細が1件以上) else EmptyOrder: count(items) > 0
 * @changes none — the command changes no common field
 * Draft -> Confirmed — set: confirmedAt (new in Confirmed); carried over: id, items, customer, note
 */
export type ConfirmOrderDecision = {
    /** @emits OrderConfirmed — exactly once when the command succeeds */
    readonly Draft: (order: DraftOrder, at: Timestamp) => Result<{
        readonly Confirmed: {
            readonly set: { readonly confirmedAt: Timestamp };
            readonly events: { readonly OrderConfirmed: OrderConfirmed };
        };
    }, EmptyOrder>;
};
```

- **Always one handler per source state**, keyed by the state's name, also with a single source state: one way to
  write every command. A `create command` (no source) and a command of an aggregate without states are a single
  function.
- `set` is the target state's own fields that are not carried over, plus the fields in `changes` that the outcome
  has, every key required (rule 5); an optional field is `T | undefined`. A factory's `set` is every field. An outcome
  with nothing to set has the runtime type `NoChanges`: `{ readonly [nothing]?: never }` with a `unique symbol` key.
  Being an object type with a known (optional) property, it makes TypeScript check excess properties, so
  `set: { items: [] }` is reported as "'items' does not exist in type 'NoChanges'" (an index signature of `never`,
  as `NoEvents` uses, reports only "Type 'never[]' is not assignable to type 'never'").
- With `ok` inferring from the contract only (ADR 0018), the literal stays fresh: `items` in `confirm`'s `set` is
  "Object literal may only specify known properties, and 'items' does not exist in type
  '{ readonly confirmedAt: Timestamp; }'"; a forgotten `confirmedAt` is "Property 'confirmedAt' is missing in type
  '{}' but required in type '{ readonly confirmedAt: Timestamp; }'".
- JSDoc: an `@changes` line (`@changes note`, or `@changes none — the command changes no common field`; also on the
  contract), and one line per outcome saying what is set, carried over and dropped. `@emits` per handler, as before.
- Per aggregate a **data** constant `<Aggregate>Shape`: the common fields, and each state's own fields.

  ```ts
  export const OrderShape: Shape = {
      fields: ['id', 'items', 'customer', 'note'],
      states: { Draft: [], Confirmed: ['confirmedAt'], Cancelled: ['reason'] },
  };
  ```

`_runtime.ts` gets `decide(shape, decision)`, generic and knowing nothing of the model beyond the data passed in:

- It calls the handler of the input's `state` (or the single function) with the command's arguments. An error passes
  through unchanged.
- For the outcome returned, it makes the aggregate: the fields of the target state (the shape's common fields and the
  target's own fields), each from `set` when `set` has it, else from the input; then the target `state` when the
  aggregate has states. Which fields the input supplies is decided by the types: `set` has to give every field that
  is not carried over, so the input supplies exactly the kept common fields and the carried-over state-specific
  fields; the source's other own fields are not among the target's fields and are dropped. For a factory `set` has
  every field, so the aggregate is `{ state, ...set }`. A value of `undefined` leaves the field out. `events` pass
  through.
- Its type, `Decide<D>`, is assignable to the command's contract without assertions in user code: for keyed
  handlers a function generic over the input state (`<S extends { state: keyof D }>`) returning the result of the
  handler of `S['state']`, each outcome's `set` replaced by the aggregate it makes; for a single function, a function
  with its parameters. The aggregate is typed as the input without the fields of `set` and without `state`, plus the
  target `state` and `set`. This is exact for every field the target has, and keeps the source's dropped fields in
  the type — extra properties, which do not stop it from being assignable to the target state. The value is only ever
  used through the contract.

The callers' contract does not change: `ConfirmOrder`, `<Aggregate>Commands` and the keyed result of ADR 0018. Only
the spelling of a contract whose outputs depend on the input changes, since `…ByState` is gone: its result is looked up
in an object keyed by the source states, `{ readonly Draft: Result<…>; readonly InProgress: Result<…> }[S['state']]`,
which behaves as `ReturnType<…ByState[S['state']]>` did (a caller with a union gets the union of the results).

Implementing a contract directly, returning the aggregate, still type-checks; then nothing keeps the command from
changing a field it does not list. `decide` is the documented form.

### ADR 0011 amended: data without logic

ADR 0011 kept generated code to types. The shape constants are values: generated code may now contain **data without
logic** — constants that restate the model (field names) for generic runtime helpers. Still:

- generated files are never edited, and hold only what follows from the DSL;
- generated code never imports users' code; users' code imports the generated modules (now also as values:
  `import { Sales, decide } from …`);
- behaviour lives in the runtime (generic, the same for every model) and in users' code. A shape is read by `decide`;
  it decides nothing.

### Removed

`byState`, the `…ByState` types (ADR 0015) and the mechanism that generated them only for commands whose outputs
vary: every command now has a decision. `decide`, `Decide`, `Shape` and `NoChanges` are runtime names, and
`<Command><Aggregate>Decision` / `<Aggregate>Shape` are generated names (M011).

### Live View and Typed Model

`CommandModel.changes` holds the names as written. The 振る舞い tab and the command cards list them (the inspector says
なし for a command without `changes`), `changes` is highlighted as a keyword, and the change list sees a changed
`changes` as a change of the command.

### Rejected

- **"Absent = keep"** (`set` with optional keys): the AI agent cannot tell a forgotten field from a kept one, and the
  compiler cannot either. Giving the old value is explicit, and rare.
- **Reporting the whole aggregate and diffing it against the input** (rejecting changes outside `changes` at run
  time): the mistake is found by tests, if at all, not by the compiler.
- **`Omit`/`Pick` types on the returned aggregate** (`Pick<ConfirmedOrder, …> & …`): an object type does not forbid
  properties that are not in the literal, so a spread source state still leaks its fields; and the messages would
  name types, not fields.
- **Handlers only for commands whose outputs vary** (as with `byState`): two ways of writing a command, and the
  single-source case would not get the per-source `set`.
- **`changes` per transition**: commands whose transitions change different fields are rare, and can be split.

## Consequences

- Every implementation is rewritten with `decide`; factories give every field, optional ones as `undefined`.
- A command that changes a common field must say so in the DSL. Models gain `changes` lines; reviewers see them.
- Fields that leak from a source state, and fields changed without being listed, are compile errors that name the
  field.
- Generated modules export values (the shapes), so they are imported as values, not only with `import type`.
