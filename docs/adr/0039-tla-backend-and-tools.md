# ADR 0039: TLA+ backend, checker roles, and optional Java

- Status: proposed
- Date: 2026-11-28
- Amends: [ADR 0011](0011-generated-code-boundary.md) (clarifies the generated specification boundary), [ADR
  0027](0027-domain-and-application-boundaries.md) (clarifies the formal verification capability boundary)

## Context

Formal verification needs an executable model backend and checker policy while keeping static checks available when Java
or checker tools are missing. Phase 0 compared backend and run strategies; it recommends TLA+ with TLC exhaustive by
default and optional bounded Apalache. Phase 4 owns installation, status, and license records.

## Decision

Use TLA+ as the formal backend and TLC as the default exhaustive finite-state checker. Offer Apalache as an optional
backend for bounded exploration and inductive invariant checks; label bounded passes accordingly. Java is optional.
When Java is absent, return an explicit skipped result while static checks remain available. Pin tool artifacts and
checksums, and allow documented `DT_FV_*` overrides. Generated specifications are produced by DomainTrail; users do
not edit them as the model input.

Distribution is decided in ADR 0045: explicit `dt tools install` / `dt tools status`, pinned versions with
sha256, no npm postinstall, and no implicit fetch. Checker licenses are confirmed and recorded in Phase 4. This
ADR establishes the backend and tool boundary. The verification generator and profile behavior are specified in
[ADR 0045](0045-tla-generator-and-tool-execution.md).

## Rejected alternatives

- Use Quint as the formal backend.
- Make Apalache the sole or default checker.
- Require Java for every CLI workflow.
- Accept user-edited generated specifications.

## Consequences

Java-dependent formal checks can be skipped explicitly while static checks still run. Tool installation is explicit;
checker licenses are confirmed and recorded in Phase 4. See [Phase 4 generator requirements and
recommendation](../plans/formal-verification/spike/results.md#phase-4-generator-requirements-and-recommendation)
and [Phase 0 tool and runtime notes](../plans/formal-verification/mapping.md#phase-0-tool-and-runtime-notes).
