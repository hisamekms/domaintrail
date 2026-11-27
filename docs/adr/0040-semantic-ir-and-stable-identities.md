# ADR 0040: Semantic IR and stable declaration identities

- Status: proposed
- Date: 2026-11-28
- Amends: [ADR 0027](0027-domain-and-application-boundaries.md) (Modeling's published language)

## Context

The checker and generators each resolve declaration names, types, and equality, so the same DSL expression can acquire
backend-specific meaning. Phase 1 needs one shared interpretation in Modeling `domain`, preserving source sites from
`SourceModel`, before migrating consumers. The migration must preserve current expression semantics and does not amend
ADR 0016.

## Decision

Build a resolved Semantic IR in Modeling `domain` from `SourceModel`, preserving source sites, types, resolved
references, scope, equality kind, optional narrowing, lifecycle facts, and value provenance. Make the checker the IR
builder. Migrate the TypeScript and contract-test generators to consume the IR, then remove duplicated semantic
computations.

Add stable IDs in Phase 1 for fields, parameters, invariants, requirements, outcomes, union variants, and variant
fields. Use one identity scheme; choose its separator during Phase 1. The IR remains internal during beta, carries a
version number, and has no compatibility promise. Decide public semver compatibility at 1.0. Phase 1 ends after the
contract-test consumer migration. TLA+ generation consumes this IR as specified by [ADR
0045](0045-tla-generator-and-tool-execution.md).

## Rejected alternatives

- Build from Typed Model and lose source-site fidelity.
- Add a separate downstream semantic pass.
- Leave each backend's independent name, type, and equality resolution in place.

## Consequences

Existing semantics and snapshot outputs must remain stable through the Phase 1 migration. See the [IR source and
identity
design](../plans/formal-verification/semantic-ir.md#current-semantic-work-and-duplication), [IR shape and stable
IDs](../plans/formal-verification/semantic-ir.md#ir-shape-and-identities),
[migration steps](../plans/formal-verification/semantic-ir.md#placement-and-migration), and
[Phase 1 boundary](../plans/formal-verification/semantic-ir.md#placement-and-migration).
