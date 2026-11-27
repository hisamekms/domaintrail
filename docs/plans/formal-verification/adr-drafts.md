# Formal verification ADR drafts

The first seven drafts have been written as proposed ADRs. The final "Later phases" section remains a draft. Follow the
repository form: title, status/date, amends, context, decision, alternatives, consequences.

## TLA+ backend, checker roles, and optional Java — now [ADR 0039](../../adr/0039-tla-backend-and-tools.md)

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
checksums, and allow documented `DT_FV_*` overrides. Distribution is decided in ADR 0045: explicit `dt tools install` /
`dt tools status`, pinned versions with sha256, no npm postinstall, and no implicit fetch; licenses are confirmed and recorded
in Phase 4.

**Alternatives considered:** Quint; Apalache as the sole/default checker; requiring Java; accepting user-edited
generated specifications.

**Consequences**

Java-dependent formal checks can be skipped explicitly while static checks remain available; tool distribution is decided in ADR 0045; checker licenses are confirmed and recorded in Phase 4.

**Evidence:** [Spike backend and run recommendation](spike/results.md#L131), [tool checksums and Java
evidence](spike/results.md#L9), [Phase 0 mapping and recommendation](mapping.md#L152).

## Semantic IR and stable declaration identities — now [ADR 0040](../../adr/0040-semantic-ir-and-stable-identities.md)

**Phase:** Phase 1, before migrating generators.

**Amends or supersedes:** [ADR 0027](../../adr/0027-domain-and-application-boundaries.md#L1) for Modeling's published
language. Phase 1 reproduces existing expression semantics exactly and does not amend ADR 0016.

**Context**

Semantic interpretation is duplicated between the checker and generators, while source sites are available
in Modeling `domain`.

**Decision:** Build a resolved Semantic IR in Modeling `domain` from `SourceModel`, preserving source sites, types,
resolved references, scope, equality kind, optional narrowing, lifecycle facts, and value provenance. Make the checker
the IR builder and migrate TypeScript and contract-test generators to consume it, deleting duplicate semantic
computations. Add stable IDs for fields, parameters, invariants, requirements, outcomes, variants and variant fields in
Phase 1 using the same scheme, with separator chosen there. The IR remains internal during beta, carries a version
number, and has no compatibility promise; decide public semver compatibility at 1.0. Phase 1 ends after the
contract-test
consumer migration.

**Alternatives considered:** Build from Typed Model and lose source-site fidelity; add a separate downstream semantic
pass; leave each backend's independent name/type/equality resolution in place.

**Consequences**

Existing semantics and snapshot outputs must remain stable through the Phase 1 migration.

**Evidence:** [IR source and identity design](semantic-ir.md#L1), [duplicate work and migration
steps](semantic-ir.md#L15), [IR shape and stable IDs](semantic-ir.md#L89), [migration steps](semantic-ir.md#L128),
[Phase 1 boundary](semantic-ir.md#L146).

## Language revision and `ensures` — now [ADR 0042](../../adr/0042-language-revision-and-ensures.md)

**Phase:** Phase 2; freeze after prototype trial and before Phase 3 runtime work.

**Amends or supersedes:** [ADR 0016](../../adr/0016-collection-constraints-and-declared-invariants.md#L24) equality
semantics; [ADR 0019](../../adr/0019-command-changes-and-decisions.md#L41) command changes, including create commands
with `changes`; [ADR
0035](../../adr/0035-kind-specific-lifecycles.md#L35) and [ADR 0037](../../adr/0037-aggregate-kinds.md#L5) outcome
syntax and selection.

**Context**

The Level 2 spike records an `addItem` limitation, and Phase 2 proposes a breaking syntax revision.

**Decision:** Use TS-like surface syntax with strict null safety (`T?` means `T | null`, narrowing by `x != null`, `?.`,
and `??`), `?:` conditional expressions, and `!(p) || q` in place of `implies`; use the `null` keyword and exhaustive
`match` expressions over unions and states. Compare only match forms and quantifier names in the AI trial; confirm
`x => …`. `==`/`!=` use declared-type equality: owned entity values and value objects are structural, references compare
by
ID, unions by tag and fields, and lists element by element in order. Reject `===` with a diagnostic suggesting
`==`.
Rewrite entity `==`, `unique`, and `contains` to `.id` forms. Values are immutable; reject mutating methods such
as `push`.
Int supports only `+`, `-`, `*`; there is no Int `/`. Decimal supports `+`, `-`, `*`, `/` with declared scale and half-even rounding.
Diagnose division by zero unless the divisor is shown non-zero. Domain primitive arithmetic yields its base type, whose
constraint is checked again on assignment. Use the decided changes/postcondition model: per-field `changes x` means permitted but unspecified;
`changes x = expr` determines the value using the `ensures` scope (parameters bare, fields `before.x`, no `after`);
omitted fields are unchanged; `ensures { … }` is for relations. Diagnose a lone equality in `ensures` and move it to
value-determining `changes`. Keep `before.x`/`after.x` qualification, parameters unqualified and forbidden from being
named `before` or
`after`, and place optional `ensures` after `emits`. Create commands set fields through `changes`: list every
non-optional field; an unlisted optional field is `null`; the same rule applies to fields new in a transition's target
state. Fields carried over and kept stay unchanged unless listed, carried fields listed in `changes` follow that
clause, new target fields follow the create rule, and dropped fields are not mentioned. Grammar adds `ChangedField:
FeatureName ('=' Expression)?`
and optional
`ensures` after `emits` in Outcome and shorthand Command. Adopt list literals, spread, `.map`, `.filter`, `.sum`, and
typed expression-bodied predicates/functions without recursion or call cycles. Equality is deep structural for recursive
value objects; optionals compare absent with absent and present contents with present contents, one absent is unequal;
optional-to-non-optional `==` is allowed. TLA+ bounds recursion through the profile. Exclude side effects, external APIs
and implicit clocks; time is explicit input. Do not support old/new syntax coexistence. `dt migrate domain` is
idempotent,
supports `--dry-run`, exits 0/1/2, and preserves comments/layout while reporting manual work.

**Alternatives considered:** Freeze the syntax before the AI trial (rejected because the trial still decides `match` and
quantifier names); `old(x)` plus unqualified post-state fields; multiple aliases for one operation; equality by raw
record representation; retaining only Level 2 checks.

**Consequences**

The migration must preserve comments, layout, and meaning, report manual work, and support the narrowed trial protocol.
`ensures` over event payloads remains open.

**Evidence:** [Recommended forms](language-revision.md#L113), [trial protocol](language-revision.md#L296), [`ensures`
placement and scoping](language-revision.md#L158), [decision status](language-revision.md#L330), [AddItem
Level 2 limitation](language-revision.md#L345).

## TypeScript `ensures` runtime and contract checks — now [ADR 0043](../../adr/0043-typescript-ensures-runtime.md)

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

**Evidence:** [Phase 3 and `decide` requirements](../formal-verification.md#L239), [ADR 0019
decision](../../adr/0019-command-changes-and-decisions.md#L41), [ADR 0020 generated expression
checks](../../adr/0020-generated-checks-and-contract-tests.md#L26), [AddItem contract
example](language-revision.md#L182).

## `check`/`verify` boundary, result schema, and exit codes — now [ADR 0041](../../adr/0041-check-verify-boundary-and-results.md)

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
boundary](../formal-verification.md#L105), [TLC transport-code interpretation](spike/results.md#L112).

## Formal classification and positive claims — now [ADR 0044](../../adr/0044-formal-classification-and-claims.md)

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

## TLA+ generator shape and tool execution — now [ADR 0045](../../adr/0045-tla-generator-and-tool-execution.md)

**Phase:** Phase 4 generator and adapters, after the backend and IR decisions.

**Amends or supersedes:** [ADR 0027](../../adr/0027-domain-and-application-boundaries.md#L1) package architecture; adds
a formal-verification capability and Phase 4 profile rules for bounds as scope and finite type encodings.

**Context**

The spike identifies generator syntax constraints, sound classification probes, checker run requirements,
and finite profile decisions.

**Decision:** Use a separate verification file in DSL syntax (for example `sales/order.verify.dt`) with named scopes
such
as `scope default { … }` and `scope deep { … }`, selected by `dt verify --scope`. Resolve it in `dt check` and rename it
with the model in the LSP; do not put it in `domaintrail.jsonc`. Without a verification file, derive defaults from the
model: two values per ID type (at least the maximum list length for IDs of entities in lists); lists up to length two;
numeric ranges from declared bounds; Timestamp/date as small integers preserving only order; Decimal scaled by literal
digits; strings from model literals plus fresh values; `matches` over unbounded strings is Unsupported; verified types
are opaque values satisfying their constraint; events are trace labels, not state. Always print the selected scope with
results. Install pinned versions with sha256 via `dt tools install`, expose `dt tools status`, retain `DT_FV_*`
overrides,
confirm and record licenses. Recursion depth 2 is a profile default. `dt verify` never fetches tools implicitly; if missing,
report `skipped` with a
reason and next command.
Generate one parameterized module per aggregate and mechanically produce constrained actions `A_C(p) ==
A(p) /\ Inv'` and fixed-input probes. Model creation from the absent state and retain parameter identity; never silently
equate parameters with fields. Validate SANY diagnostics, cfg/operator closure, action syntax and Apalache annotation
format; use `DOMAIN` for sequence iteration. Run the per-aggregate unconstrained, constrained, probe, requested
isolation, and existential-witness matrix. Install tools explicitly and skip Java-dependent checks when Java is absent.

**Alternatives considered:** Copy modules per seed; hand-maintain constrained actions; bind same-named arguments to
fields; classify by process exit code; require Java for all CLI use.

**Consequences**

Report defaults, bounds, assumptions and encodings with the selected scope; values outside finite domains are outside
the checked scope.

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

**Evidence:** [Phase 5–7 plan](../formal-verification.md#L291), [mapping result limits](mapping.md#L8), [Phase 7 scope
and symmetry limitation](../formal-verification.md#L306).
