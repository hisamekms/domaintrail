# ADR 0011: What the generated code holds and what users write

- Status: accepted
- Date: 2026-10-18
- Amended by: [ADR 0019](0019-command-changes-and-decisions.md) (generated code may also hold data without logic: the
  shape constants read by `decide`), [ADR 0020](0020-generated-checks-and-contract-tests.md) (generated code may hold
  logic derived 1:1 from DSL expressions: checks, equality, `make<Name>`)

## Context

`dt generate ts` writes types and command contracts, and users implement them by hand. Where the line runs between the
two was implicit: the guide said "never business logic", but not whether users may edit or extend the output, where
constructors of domain primitives belong, or what would change if the generator one day checked invariants itself.
Placing contexts in other directories (ADR 0012) makes the generated code part of other packages' builds, so the
boundary has to be stated.

## Decision

- **Generated code is the contract: types only.** The shapes of the model, command signatures
  (`ConfirmOrder`, `<Aggregate>Commands`) and constructor signatures of domain primitives (`Make<Name>`). Invariants
  are documented as JSDoc (`@invariant`) and not checked. (Amended by [ADR 0019](0019-command-changes-and-decisions.md):
  besides types, **data without logic** — one constant per aggregate, `<Aggregate>Shape`, restating its field names
  for `decide` of the runtime. Behaviour stays in the runtime, which is the same for every model, and in users' code.
  Amended by [ADR 0020](0020-generated-checks-and-contract-tests.md): also **logic derived 1:1 from DSL
  expressions** — the checks of invariants and requirements, the equality they use, and `make<Name>` built from them;
  constraints without an expression are slots the user's code passes in.)
- **Users write the implementation**: command implementations, `Make<Name>` constructors and invariant checks, in
  their own files. (Since [ADR 0020](0020-generated-checks-and-contract-tests.md): command implementations and the
  constraints the DSL does not express; constructors and checks are generated, and hand-written ones are optional.)
- **Generated files are never edited.** They hold only what follows from the DSL and are replaced on every run.
- **Dependencies point one way**: users' code imports the generated modules; generated code never imports users' code.
- **Adding properties or methods to generated types is not supported** (declaration merging, editing the output).
  Behaviour is written as functions over the generated types.

### Direction under consideration: generating invariant checks

Decided in [ADR 0020](0020-generated-checks-and-contract-tests.md), along these lines (constructors are generated too).
Recorded so that later work keeps the boundary above:

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
