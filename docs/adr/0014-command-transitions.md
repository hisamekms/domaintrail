# ADR 0014: Command transitions

- Status: accepted
- Date: 2026-10-19
- Supersedes: the command syntax (`from` / `to`) of ADR 0001
- Amended by: [ADR 0015](0015-handlers-per-state.md) (the generated contract of a command whose output depends on its
  input)

## Context

Commands declared their states with two lists: `from Draft | InProgress to Draft | InProgress`. The lists say which
states a command accepts and which it may end in, but not which input leads to which output. A command that edits a
work item and keeps its state could not be told apart from one that may move it anywhere among those states, and the
generated contract allowed both: `(work: DraftWork | InProgressWork) => Result<[DraftWork | InProgressWork, ...]>`
accepts an implementation that turns a Draft work into an InProgress one.

The DSL is in alpha, so the syntax may change without keeping the old form.

## Decision

### Syntax

The unit is a **transition**, `sources -> targets`, written after the parameters (and label), before `emits` /
`errors`:

```text
aggregate Work {
  state Draft
  state InProgress
  state Completed
  state Cancelled

  create command open(title: Title) -> Draft

  command change(title: Title)
    Draft -> Draft
    InProgress -> InProgress
    emits WorkChanged

  command start() Draft -> InProgress
  command finish() InProgress -> Completed errors NotReady
  command cancel() Draft | InProgress -> Cancelled        // fan-in
  command review() InProgress -> InProgress | Completed   // several possible outcomes
  command edit() Draft -> Draft, InProgress -> InProgress  // `,` between transitions is optional
}
```

- A command has zero or more transitions; `A | B -> C | D` reads "in `A` or `B`, the command ends in `C` or `D`".
  Transitions are separated by line breaks (white space) or commas.
- A `create command` has exactly one transition without sources: `-> Draft` (or `-> A | B`).
- `emits` and `errors` stay per command.
- `from` and `to` are no longer keywords (and so become usable as field and parameter names). The old form is a
  syntax error.

### Rules (M006)

- Aggregate with states: a command other than `create` has one or more transitions, each with sources; a `create`
  command has exactly one transition, without sources.
- A state may be the source of only one transition of a command, so that the input state decides the possible
  outputs. Several outcomes of one input are listed on the right (`InProgress -> InProgress | Completed`).
- Aggregate without states: commands have no transitions.
- States must belong to the aggregate (unresolved names are reported from linking, as before); a target listed twice
  in one transition is a warning.

### Generated TypeScript

- When every transition has the same targets — the shape `from`/`to` could express — the command stays a plain
  function: the input is the union of all sources, the output the union of the targets.
- When the targets differ, the command is generic over the input state and a chain of conditional types, one per
  transition, picks its output; the last transition's targets end the chain (amended by
  [ADR 0015](0015-handlers-per-state.md): the output is the result of a generated handler per state, and `byState`
  implements the command from such handlers):

  ```ts
  export type ChangeWork = <S extends DraftWork | InProgressWork>(
      work: S,
      title: Title,
  ) => Result<readonly [
      S extends DraftWork ? DraftWork : InProgressWork,
      readonly WorkChanged[],
  ], never>;
  ```

  The conditional type distributes over a union, so a caller holding `DraftWork | InProgressWork` gets
  `DraftWork | InProgressWork` back, and a caller holding a `DraftWork` gets a `DraftWork`.
- The JSDoc lists the transitions: `Work.change (Draft -> Draft; InProgress -> InProgress)`.

### Live View

The State View draws one edge per source and target of each transition (a transition to its own source is listed in
the state's box, as before). The Detail Panel shows a row per transition.

### Rejected

- **Commands inside `state` blocks** (`state Draft { command change() -> Draft }`): a command that applies to several
  states would be written once per state, with its parameters, events and errors repeated, and could drift apart.
- **`keeps state`** (or `-> same`, and other shorthands for a self transition): one more form for something
  `Draft -> Draft` already says plainly, and it reads differently from every other transition. Spelling out the
  states also keeps each transition readable without knowing the rest of the command; a shorthand can be added later
  without breaking models, while removing one could not.
- **An overloaded function interface** (`{ (work: DraftWork, ...): ...Draft; (work: InProgressWork, ...): ...InProgress }`):
  overloads cannot be called with a union (`DraftWork | InProgressWork`), which is what a caller usually holds after
  loading an aggregate.

## Consequences

- Every model must be migrated: `from A to B` becomes `A -> B`, `to A` of a factory becomes `-> A`.
- Callers of a command whose outputs depend on its input get the precise output type.
- TypeScript does not narrow a type parameter inside an implementation, so an implementation of a generic command
  needs a type assertion on its result: the contract is checked where the command is called, not inside its
  implementation. Commands whose transitions share their targets are unaffected. [ADR 0015](0015-handlers-per-state.md)
  lifts this: implemented with `byState` from one handler per state, each handler is checked against its transition.
