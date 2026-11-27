# Formal verification ADR drafts

Write these in order of dependency. Use the next free ADR number when each draft is accepted; numbers are intentionally
not reserved here. Follow the repository form: title, status/date, amends, context, decision, alternatives,
consequences.

## TLA+ backend, checker roles, and optional Java

**Phase:** Phase 4 foundation; decision should precede implementation.

**Amends or supersedes:** None directly. Clarifies the tool boundary in [ADR
0011](../../adr/0011-generated-code-boundary.md#L1) and [ADR
0027](../../adr/0027-domain-and-application-boundaries.md#L1).

**Context**

Phase 0 recommends a default exhaustive checker and an optional bounded checker, with Java absent from
static workflows.

**Decision:** Use TLA+ as the formal backend and TLC as the default exhaustive finite-state checker. Offer Apalache as
an optional backend for bounded exploration and inductive invariant checks, with bounded passes labeled accordingly.
Java is optional; absent Java yields an explicit skipped result and static checks still run. Pin tool artifacts and
checksums, and allow documented `DT_FV_*` overrides.

**Alternatives considered:** Quint; Apalache as the sole/default checker; requiring Java; accepting user-edited
generated specifications.

**Consequences**

Java-dependent formal checks can be skipped explicitly while static checks remain available; tool
distribution and licensing still need a decision.

**Evidence:** [Spike backend and run recommendation](spike/results.md#L131), [tool checksums and Java
evidence](spike/results.md#L9), [Phase 0 mapping and recommendation](mapping.md#L152).

## Semantic IR and stable declaration identities

**Phase:** Phase 1, before migrating generators.

**Amends or supersedes:** [ADR 0027](../../adr/0027-domain-and-application-boundaries.md#L1) for Modeling's published
language. Phase 1 reproduces existing expression semantics exactly and does not amend ADR 0016.

**Context**

Semantic interpretation is duplicated between the checker and generators, while source sites are available
in Modeling `domain`.

**Decision:** Build a resolved Semantic IR in Modeling `domain` from `SourceModel`, preserving source sites, types,
resolved references, scope, equality kind, optional narrowing, lifecycle facts, and value provenance. Make the checker
the IR builder and migrate TypeScript and contract-test generators to consume it, deleting duplicate semantic
computations. Add stable IDs for fields, parameters, invariants, requirements, and outcomes; settle variant identity
before variants become external property keys. Phase 1 ends after the contract-test consumer migration.

**Alternatives considered:** Build from Typed Model and lose source-site fidelity; add a separate downstream semantic
pass; leave each backend's independent name/type/equality resolution in place.

**Consequences**

Existing semantics and snapshot outputs must remain stable through the Phase 1 migration.

**Evidence:** [IR source and identity design](semantic-ir.md#L1), [duplicate work and migration
steps](semantic-ir.md#L15), [IR shape and stable IDs](semantic-ir.md#L89), [migration steps](semantic-ir.md#L128),
[Phase 1 boundary](semantic-ir.md#L146).

## Language revision and `ensures`

**Phase:** Phase 2; freeze after prototype trial and before Phase 3 runtime work.

**Amends or supersedes:** [ADR 0016](../../adr/0016-collection-constraints-and-declared-invariants.md#L24) equality
semantics; [ADR 0019](../../adr/0019-command-changes-and-decisions.md#L41) command changes; [ADR
0035](../../adr/0035-kind-specific-lifecycles.md#L35) and [ADR 0037](../../adr/0037-aggregate-kinds.md#L5) outcome
syntax and selection.

**Context**

The Level 2 spike records an `addItem` limitation, and Phase 2 proposes a breaking syntax revision.

**Decision:** Add arithmetic `+`, `-`, `*` and conditional `?:`; use `x != null`, `!(p) || q`, and `null`. Add `ensures`
after `changes`/`emits`, with `before.x` and `after.x`; parameters stay unqualified and `before`/`after` are reserved.
Equality follows declared type: owned entity values and value objects structurally, references by ID, unions by tag and
fields, lists element-wise in order, and optionals by presence then value. Rewrite entity `==`, `unique`, and `contains`
to `.id` forms. Align `ensures` with `changes` and carried/kept/new/dropped diagnostics. Exclude recursion, side
effects, external APIs, and implicit clocks; time is explicit input. Do not support old/new syntax coexistence. `dt
migrate domain` is idempotent, supports `--dry-run`, and exits 0/1/2. Use JS names and one canonical spelling per
meaning, subject to a paired AI trial. The trial precedes syntax freeze; Level 2's `addItem` limitation motivates Level
3 postconditions.

**Alternatives considered:** `old(x)` plus unqualified post-state fields; multiple aliases for one operation; equality
by raw record representation; freezing syntax before AI trial; retaining only Level 2 checks.

**Consequences**

The migration must preserve comments, layout, and meaning, report manual work, and support the
specified trial protocol. `ensures` over event payloads remains open.

**Evidence:** [Recommended forms](language-revision.md#L73), [trial protocol](language-revision.md#L250), [`ensures`
placement and scoping](language-revision.md#L119), [remaining language decisions](language-revision.md#L285), [AddItem
Level 2 limitation](language-revision.md#L299).

## TypeScript `ensures` runtime and contract checks

**Phase:** Phase 3; complete before Phase 4 lowering is accepted.

**Amends or supersedes:** [ADR 0019](../../adr/0019-command-changes-and-decisions.md#L1) for `decide` results and [ADR
0020](../../adr/0020-generated-checks-and-contract-tests.md#L1) for generated checks and contract suites.

**Context**

ADR 0019 defines pure decision results, and ADR 0020 provides generated checks and contract tests as the
executable oracle.

**Decision:** Evaluate each successful `decide` result against its `ensures` expression using the before state,
parameters, and returned after state. Generated runtime checks and contract tests share the same declared-type equality
semantics and reject a result that violates its postcondition. Cover creation and named outcomes, optional/list
equality, contradictions, and vacuous contracts. These TypeScript checks define the executable reference semantics
consumed by the Phase 4 backend.

**Alternatives considered:** Enforce postconditions only in formal verification; make application authors duplicate
checks; treat `ensures` as documentation or an outcome selector.

**Consequences**

Phase 4 lowering must agree with these TypeScript semantics.

**Evidence:** [Phase 3 and `decide` requirements](../formal-verification.md#L220), [ADR 0019
decision](../../adr/0019-command-changes-and-decisions.md#L41), [ADR 0020 generated expression
checks](../../adr/0020-generated-checks-and-contract-tests.md#L26), [AddItem contract
example](language-revision.md#L307).

## `check`/`verify` boundary, result schema, and exit codes

**Phase:** Phase 4 CLI and result implementation.

**Amends or supersedes:** [ADR 0024](../../adr/0024-event-storming-dsl.md#L125) (exit code 1 on any error) and [ADR
0032](../../adr/0032-dtes-design-level-grammar.md#L180) (severity info and `summary.infos`); documents a new CLI
contract.

**Context**

The shared schema needs stable rule codes and consistent exit codes across static and formal checks.

**Decision:** Keep `dt check` static, fast, deterministic, and dependency-free; put bounded/exhaustive model checking in
`dt verify`, which runs `check` first and does not explore on static errors. Give both commands the shared version 2
schema with per-record `static` or `formal` origin; `verify` may return both. Adopt shared exit codes 0 success, 1
non-success result, 2 required skip, and 3 error, with error taking precedence over failure and skip. This intentionally
changes `dt check` exit codes to distinguish skips and errors consistently. Codes name the problem, not the command; a
check moves by definition between commands with its code unchanged. `verify` includes `check` before formal exploration.

**Alternatives considered:** `dt check --formal`; a backend-named `dt tla`; separate schemas and exit codes; treating
raw checker exit codes as result classes.

**Consequences**

SYNTAX changes from exit 1 to 3; J001/K001 remain 1, and `noCounterexample` exits 0.

**Evidence:** [Schema and envelope](results-schema.md#L1), [shared exit-code proposal](results-schema.md#L293), [checker
boundary](../formal-verification.md#L103), [TLC transport-code interpretation](spike/results.md#L112).

## Formal classification and positive claims

**Phase:** Phase 4 classification, attribution, and result reporting.

**Amends or supersedes:** None; interprets [ADR
0016](../../adr/0016-collection-constraints-and-declared-invariants.md#L28), [ADR
0019](../../adr/0019-command-changes-and-decisions.md#L41), and [ADR
0035](../../adr/0035-kind-specific-lifecycles.md#L24).

**Context**

Checker traces can arise from nondeterministic outputs; their classification depends on fixed inputs and
provenance.

**Decision:** For each fixed command input, classify a violation forced across all choices of unspecified outputs as
`Counterexample found`; classify one that occurs only under an unspecified output choice as `Underspecified`. Attribute
joint violations with TLC `-continue` and per-action isolation runs, accounting for every all-actions violation. A
positive existential claim requires a reachability witness in the correct constrained model; an over-approximation's
witness may be spurious. An exhaustive pass of a negated-property check establishes non-reachability only within the
reported finite scope. Preserve external/prose obligations separately from executable predicates.

**Alternatives considered:** Classify every checker trace as a defect; collapse underspecification into unsupported;
constrain command arguments during probes; report positive claims directly from an over-approximate model.

**Consequences**

Attribution requires fixed-input probes and per-action isolation when needed.

**Evidence:** [Implemented fixed-input classification](spike/results.md#L31), [seeded AddItem and creation
cases](spike/results.md#L61), [unresolved joint attribution and `-continue`](spike/results.md#L100), [mapping soundness
and existential direction](mapping.md#L8), [IR provenance requirements](semantic-ir.md#L115).

## TLA+ generator shape and tool execution

**Phase:** Phase 4 generator and adapters, after the backend and IR decisions.

**Amends or supersedes:** [ADR 0027](../../adr/0027-domain-and-application-boundaries.md#L1) package architecture; adds
a formal-verification capability and Phase 4 profile rules for bounds as scope and finite type encodings.

**Context**

The spike identifies generator syntax constraints, sound classification probes, checker run requirements,
and finite profile decisions.

**Decision:** Generate one parameterized module per aggregate and mechanically produce constrained actions `A_C(p) ==
A(p) /\ Inv'` and fixed-input probes. Model creation from the absent state and retain parameter identity; never silently
equate parameters with fields. Validate SANY diagnostics, cfg/operator closure, action syntax and Apalache annotation
format; use `DOMAIN` for sequence iteration. Run the per-aggregate unconstrained, constrained, probe, requested
isolation, and existential-witness matrix. Pin tool checksums, support `DT_FV_*` overrides, and skip Java-dependent
checks explicitly when Java is absent.

**Alternatives considered:** Copy modules per seed; hand-maintain constrained actions; bind same-named arguments to
fields; classify by process exit code; require Java for all CLI use.

**Consequences**

Profiles must state bounds, assumptions, and encodings explicitly; values outside finite domains are
outside the checked scope.

**Evidence:** [Generator requirements](spike/results.md#L119), [per-aggregate run matrix](spike/results.md#L131), [tool
capture and checksums](spike/results.md#L3), [Semantic IR verification consumer](semantic-ir.md#L150), [profile
mapping](mapping.md#L65).

## Later phases: diagnostics, Live View, and Level 4

**Phase:** Phase 5–7; draft when implementation scope is scheduled.

**Amends or supersedes:** [ADR 0007](../../adr/0007-pane-roles.md#L1) for Live View presentation; [ADR
0022](../../adr/0022-policy-declarations.md#L1) for policy and event behavior in Level 4.

**Context**

Later phases build on stable single-aggregate verification and source provenance.

**Decision:** Phase 5 presents formal findings with source identity, provenance, bounds, assumptions, and uncertainty;
Phase 6 binds visible results to model and profile revisions and renders traces as business changes. Phase 7 extends the
single-aggregate semantics to multi-aggregate events, delivery, concurrency, safety, liveness, and fairness, with
environment assumptions explicit. Preserve single-aggregate behavior and report symmetry limitations for liveness and
Apalache.

**Alternatives considered:** Expose raw TLA+ traces as the user interface; show unversioned/stale results; expand to
multi-aggregate verification before single-aggregate behavior stabilizes.

**Consequences**

Level 4 results must state delivery and failure assumptions explicitly.

**Evidence:** [Phase 5–7 plan](../formal-verification.md#L261), [mapping result limits](mapping.md#L8), [Phase 7 scope
and symmetry limitation](../formal-verification.md#L276).
