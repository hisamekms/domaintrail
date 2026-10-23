# ADR 0015: Handlers per state for commands whose output depends on the input

- Status: accepted
- Date: 2026-10-19
- Amends: the generated TypeScript of ADR 0014
- Amended by: [ADR 0018](0018-command-events-contract.md) (handlers also when the events differ by source state; the
  result keyed by the outcome)

## Context

ADR 0014 made a command whose targets differ by transition (`Draft -> Draft, InProgress -> InProgress`) generic over
the input state, a chain of conditional types picking its output:

```ts
export type ChangeWork = <S extends DraftWork | InProgressWork>(work: S, title: Title) => Result<readonly [
    S extends DraftWork ? DraftWork : InProgressWork,
    readonly WorkChanged[],
], never>;
```

Callers get the precise output, but TypeScript does not narrow `S` inside an implementation: checking
`work.state === 'Draft'` narrows `work`, not `S`, so the conditional type stays unresolved and the result needs a type
assertion. With the assertion in place, an implementation that turns a Draft work into an InProgress one compiles.
The contract was checked where the command is called, not where it is implemented.

## Decision

### Handlers per state

Such a command also gets a type with one handler per source state, named `<Command>ByState`:

```ts
/** Work.change, one handler per source state; implement it with `byState` from the runtime. */
export type ChangeWorkByState = {
    readonly Draft: (work: DraftWork, title: Title) => Result<readonly [DraftWork, readonly WorkChanged[]], never>;
    readonly InProgress: (work: InProgressWork, title: Title) => Result<readonly [InProgressWork, readonly WorkChanged[]], never>;
};
```

- The keys are the source state names, the values of the states' `state` tag.
- Every source of a transition gets a handler; the sources of `A | B -> C` get the same output.
- Commands whose transitions share their targets (the plain function of ADR 0014) and factories get no such type.
- Amended by [ADR 0018](0018-command-events-contract.md): also generated when the events differ by source state
  (`emits X when A ->`), and each handler returns the keyed result (`Result<{ readonly Draft: { aggregate, events } }, …>`)
  instead of a tuple. The samples here show the shape before.

### The contract is stated through the handlers

The generic contract keeps its type parameter and parameters, and its output becomes the result of the handler of the
input's state:

```ts
export type ChangeWork = <S extends DraftWork | InProgressWork>(
    work: S,
    title: Title,
) => ReturnType<ChangeWorkByState[S['state']]>;
```

A caller with a `DraftWork` gets the Draft handler's result. `ReturnType` distributes over a union of handlers, so a
caller with `DraftWork | InProgressWork` gets the union of both results: after `if (r.ok)` the aggregate is
`DraftWork | InProgressWork`, as before. `<Aggregate>Commands` still lists `change: ChangeWork`.

The conditional chain had to go: no function built from the handlers can be shown to return
`S extends DraftWork ? DraftWork : InProgressWork` for every `S` — TypeScript relates two conditional types only when
they are written alike — while `ReturnType<H[S['state']]>` is exactly what a dispatching function returns.

### `byState` in the runtime

`_runtime.ts` exports `byState`, which turns handlers into the contract:

```ts
export const orderCommands: Sales.OrderCommands = {
    // ...
    changeNote: byState<Sales.ChangeNoteOrderByState>({
        Draft: (order, note) => ok([{ ...order, note }, []] as const),
        Confirmed: (order, note) => ok([{ ...order, note }, []] as const),
    }),
};
```

- It calls the handler of the first argument's `state` with all arguments, and its type is
  `<S extends { state: keyof H }>(subject: S, ...args) => ReturnType<H[S['state']]>`, which is assignable to the
  contract when `H` is the command's `…ByState` (or handlers assignable to it).
- Each handler is checked against its own transition: a Draft handler returning an InProgress work, or a missing
  handler, is a compile error, and the user's code needs no type assertion. The one assertion is inside `byState`.
- The type argument gives the handlers their parameter types from context. Without it, handlers need annotated
  parameters and are still checked against the contract.
- Implementing the generic contract directly remains possible, with a type assertion as before.

### Relation to ADR 0011

ADR 0011 keeps generated code to types. `byState` does not change that: it is a generic function of the runtime, like
`ok` and `err`, that knows nothing of the model and is the same for every model. The context modules stay types only;
the `…ByState` types are part of the contract, and the handlers are the user's implementation.

### Rejected

- **Overloads** (`{ (work: DraftWork, …): …Draft; (work: InProgressWork, …): …InProgress }`) as the contract or as
  the implementation's type: the one body behind the overloads is not checked against each overload's return type
  (an overloaded function's implementation signature only has to be loosely compatible with them, and an arrow
  function assigned to an overloaded type needs an assertion), so a wrong output per state still compiles. Callers
  holding a union could not call it either (ADR 0014).
- **A table of outputs** (`Out[S['state']]` with `Out = { Draft: DraftWork; InProgress: InProgressWork }`) in place of
  the conditional chain: it is still indexed by the unnarrowed `S` inside an implementation, so an assertion is needed
  just the same.
- **Handlers as the contract itself** (`<Aggregate>Commands` holding `ChangeWorkByState`): callers would have to pick
  a handler by state themselves and could not pass `DraftWork | InProgressWork`.

## Consequences

- Implementations of commands whose output depends on the input are checked per transition, without assertions.
- The generic contract reads `ReturnType<ChangeWorkByState[S['state']]>`; the outputs per state are read off the
  `…ByState` type next to it.
- For a union input, the result is a union of results rather than one result with a union inside; code that checks
  `ok` first sees the same types.
- `byState` is a runtime name: no declaration may generate it (M011).
