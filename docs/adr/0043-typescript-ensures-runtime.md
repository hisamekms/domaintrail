# ADR 0043: TypeScript `ensures` runtime and contract checks

- Status: proposed
- Date: 2026-11-28
- Amends: [ADR 0019](0019-command-changes-and-decisions.md) (`decide` results), [ADR
  0020](0020-generated-checks-and-contract-tests.md) (generated checks and contract suites)

## Context

ADR 0019 defines pure decision results, and ADR 0020 provides generated checks and contract tests as the executable
oracle. The Phase 4 backend needs reference semantics for successful postconditions.

## Decision

Evaluate each successful `decide` result against its `ensures` expression using the before state, parameters, and
returned after state. Generated runtime checks and contract tests share declared-type equality semantics and reject a
result that violates its postcondition. Cover creation and named outcomes, optional and list equality, contradictions,
and vacuous contracts. These TypeScript checks define the executable reference semantics consumed by Phase 4.

Formal lowering depends on this decision and the syntax in [ADR 0042](0042-language-revision-and-ensures.md);
the backend
is described in [ADR 0039](0039-tla-backend-and-tools.md).

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
