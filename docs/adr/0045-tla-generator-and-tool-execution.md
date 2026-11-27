# ADR 0045: TLA+ generator shape and tool execution

- Status: proposed
- Date: 2026-11-28
- Amends: [ADR 0027](0027-domain-and-application-boundaries.md) (package architecture); adds
  formal-verification capability and Phase 4 profile rules

## Context

Phase 4 generates finite TLA+ models, executes checker matrices, and reports scope and assumptions. The spike identified
generator syntax constraints, sound classification probes, checker run requirements, and profile choices. This
decision depends on the [TLA+ backend](0039-tla-backend-and-tools.md), [Semantic
IR](0040-semantic-ir-and-stable-identities.md),
[result contract](0041-check-verify-boundary-and-results.md), and [classification
rules](0044-formal-classification-and-claims.md).

## Decision

Use a separate verification file in DSL syntax (for example `sales/order.verify.dt`) with named scopes such as
`scope default { … }` and `scope deep { … }`, selected by `dt verify --scope`. Resolve it in `dt check` and
rename it with the model in the LSP; do not put it in `domaintrail.jsonc`. Without a verification file, derive
defaults from the
model: recursion depth 2; two values per ID type (at least the maximum list length for IDs of entities in lists);
lists up to length two;
numeric ranges from declared bounds; Timestamp and date as small integers preserving only order; Decimal scaled by
literal digits; strings from model literals plus fresh values; `matches` over unbounded strings is Unsupported;
verified types are opaque values satisfying their constraint; events are trace labels, not state. Always print the
selected scope with results.

Install pinned versions with sha256 via `dt tools install`; expose `dt tools status`; retain `DT_FV_*`
overrides. There is no npm postinstall and `dt verify` never fetches tools implicitly. Missing tools yield
`skipped` with the next command. Confirm checker licenses and record them in Phase 4.

Generate one parameterized module per aggregate and mechanically produce constrained actions and fixed-input probes.
`A_C(p)` is the constrained action, defined as `A(p) /\ Inv'`. Model creation from the absent state and retain
parameter identity; never silently equate parameters with fields. Validate SANY diagnostics, cfg/operator
closure, action syntax, and Apalache annotation format;
use `DOMAIN` for sequence iteration. Run the per-aggregate unconstrained, constrained, probe, requested isolation, and
existential-witness matrix. Skip Java-dependent checks when Java is absent.

## Rejected alternatives

- Copy modules per seed.
- Hand-maintain constrained actions.
- Bind same-named arguments to fields.
- Classify by process exit code.
- Require Java for all CLI use.

## Consequences

Report defaults, bounds, assumptions, and encodings with the selected scope. Values outside finite domains are outside
the checked scope. See [generator
requirements](../plans/formal-verification/spike/results.md#phase-4-generator-requirements-and-recommendation),
[per-aggregate run
matrix](../plans/formal-verification/spike/results.md#phase-4-generator-requirements-and-recommendation),
[tool capture and checksums](../plans/formal-verification/spike/results.md#setup-and-reproduction), [Semantic IR
verification consumer](../plans/formal-verification/semantic-ir.md#verification-consumer),
and [profile mapping](../plans/formal-verification/mapping.md#types-and-values).
