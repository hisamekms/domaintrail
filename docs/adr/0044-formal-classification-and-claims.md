# ADR 0044: Formal classification and positive claims

- Status: proposed
- Date: 2026-11-28
- Interprets: [ADR 0016](0016-collection-constraints-and-declared-invariants.md), [ADR
  0019](0019-command-changes-and-decisions.md), and [ADR 0035](0035-kind-specific-lifecycles.md)

## Context

Checker traces can arise from nondeterministic outputs. Their classification depends on fixed inputs and provenance;
positive claims also need evidence in the correct constrained model.

## Decision

For each fixed command input, classify a violation forced across all choices of unspecified outputs as `Counterexample
found`. Classify a violation that occurs only under an unspecified output choice as `Underspecified`. Attribute joint
violations with TLC `-continue` and per-action isolation runs, accounting for every all-actions violation.

A positive existential claim requires a reachability witness in the correct constrained model; a witness from an
over-approximation may be spurious. An exhaustive pass of a negated-property check establishes non-reachability only
within the reported finite scope. Preserve external and prose obligations separately from executable predicates.

## Rejected alternatives

- Classify every checker trace as a defect.
- Collapse underspecification into unsupported.
- Constrain command arguments during probes.
- Report positive claims directly from an over-approximate model.

## Consequences

Attribution requires fixed-input probes and per-action isolation when needed. See [fixed-input
classification](../plans/formal-verification/spike/results.md#classification-rule-implemented),
[seeded AddItem and creation cases](../plans/formal-verification/spike/results.md#seed-detection), [joint
attribution and
`-continue`](../plans/formal-verification/spike/results.md#correct-model-findings-and-mapped-traces),
[mapping soundness and existential
direction](../plans/formal-verification/mapping.md#commands-aggregates-and-properties), and [IR provenance
requirements](../plans/formal-verification/semantic-ir.md#verification-consumer).
