# ADR 0043: TypeScript `ensures` runtime and contract checks

- Status: accepted, implemented (2026-11-29)
- Date: 2026-11-28
- Amends: [ADR 0019](0019-command-changes-and-decisions.md) (`decide` results), [ADR 0020](0020-generated-checks-and-contract-tests.md)
  (generated checks and contract suites), and [ADR 0042](0042-language-revision-and-ensures.md) (`ensures` syntax)

## Context

ADR 0019 defines pure decision results, and ADR 0020 provides generated checks and contract tests as the executable
oracle. The Phase 4 backend needs reference semantics for successful postconditions.

## Decision

### D1. API and postcondition shape

Generate `check<Command><Aggregate>Ensures` only for commands with at least one checkable postcondition. It takes the source aggregate (except for a create), the command parameters (omitted when there are none), and the success value. It returns the first `Postcondition` violation or `undefined`. `Postcondition` carries the declaration `id`, outcome key, `kind` (`changes`, `unchanged` or `ensures`), optional `field`, and source expression. The generated check is pure and can be called directly or supplied as `Verify.ensures` to `decide`; a violation supplied there throws as a bug in the decision.

### D2. Outcome order and contract coverage

Check only the outcome present in the success value and applicable to the source state/kind. For each outcome in declaration order, check kind first, then each `changes x = e` clause in clause order, then carried unlisted fields in field order, then optional fields made to exist unlisted, and finally each top-level `&&` conjunct of `ensures`. A create checks its declared kind too. `changes x` leaves the value open. A field omitted from `changes` must retain its input value; an optional field newly made available by an outcome must remain absent unless listed. A checkable command gets contract-test case T7, generated exactly for commands for which this function exists; commands with no generated check omit T7.

### D3. Comparison semantics

Use the DSL's declared-type equality: numeric Decimal equality by value, lists element by element in order, value objects and owned entities structurally, references and IDs by ID, unions by tag and fields, and dates/times by canonical text. Optional values compare by absent/present contents. Checks report the first violation in the order above.

### D4. Language amendments

`match (before)` and `match (after)` follow the transitions of the selected outcome; the generated checker narrows those branches consistently. Aggregate-valued function parameters are evaluated with the function's full valid state/kind set and are passed through from `before` or `after` as appropriate. These are amendments to the initial equality and outcome design and are exercised by the reference corpus.

A planned change will make these checks always run in `decide`. Until then, wiring is opt-in through `Verify.ensures`.

These TypeScript checks define the executable reference semantics consumed by Phase 4. Formal lowering depends on this decision and the syntax in [ADR 0042](0042-language-revision-and-ensures.md); the backend is described in [ADR 0039](0039-tla-backend-and-tools.md).

## Rejected alternatives

- Enforce postconditions only in formal verification.
- Make application authors duplicate checks.
- Treat `ensures` as documentation or an outcome selector.

## Consequences

Phase 4 lowering must agree with these TypeScript semantics. See [Phase 3 and `decide`
requirements](../plans/formal-verification.md#phase-3--ensures-in-typescript),
[ADR 0019 decision](0019-command-changes-and-decisions.md), [ADR 0020 generated expression
checks](0020-generated-checks-and-contract-tests.md),
and the [AddItem contract
example](../plans/formal-verification/language-revision.md#3-ensures-placement-equality-and-field-lifecycle).
