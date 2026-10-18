# ADR 0011: What the generated code holds and what users write

- Status: accepted
- Date: 2026-10-18

## Context

`dt generate ts` writes types and command contracts, and users implement them by hand. Where the line runs between the
two was implicit: the guide said "never business logic", but not whether users may edit or extend the output, where
constructors of domain primitives belong, or what would change if the generator one day checked invariants itself.
Placing contexts in other directories (ADR 0012) makes the generated code part of other packages' builds, so the
boundary has to be stated.

## Decision

- **Generated code is the contract: types only.** The shapes of the model, command signatures
  (`ConfirmOrder`, `<Aggregate>Commands`) and constructor signatures of domain primitives (`Make<Name>`). Invariants
  are documented as JSDoc (`@invariant`) and not checked.
- **Users write the implementation**: command implementations, `Make<Name>` constructors and invariant checks, in
  their own files.
- **Generated files are never edited.** They hold only what follows from the DSL and are replaced on every run.
- **Dependencies point one way**: users' code imports the generated modules; generated code never imports users' code.
- **Adding properties or methods to generated types is not supported** (declaration merging, editing the output).
  Behaviour is written as functions over the generated types.

### Direction under consideration: generating invariant checks

Not decided, recorded so that later work keeps the boundary above:

- Invariants the DSL can express (ranges, regular expressions, lengths, …) → the generated code gets a pure check
  function, e.g. `checkQuantity(value): InvalidQuantity | undefined`.
- Invariants the DSL cannot express → the generated code gets only the type of the function needed (a slot), and
  users implement it.
- Constructors (`makeQuantity`, …) → still a generated type and a user implementation, built from the generated
  check functions.

This keeps "generated code holds only what follows from the DSL and is not edited" and "users' code imports the
generated code". Generation Gap (a `.gen.ts` per module plus a user file scaffolded once) is reconsidered only if this
approach stops working.

## Consequences

- Regenerating never loses user work, and generated files can be deleted and recreated at any time (ADR 0012 relies
  on this to remove stale output).
- Users needing methods on domain types write functions or wrap the types themselves.
- The guide's "Generated code and your code" section states this for users and AI agents.
