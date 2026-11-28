# Phase 0 mapping: DomainTrail to TLA+

This initial map is based on source and accepted ADRs at `main` `4d8a2ed`. “Candidate” is not an implementation
commitment. **Direct** preserves the modeled meaning. **Lowering** uses an equivalent encoding in TLA+ constructs.
**Abstracted** changes the behavior set. **Unsupported** has no safe encoding under the stated profile. A profile bound
is a scope restriction and must always be reported.

For an **over-approximation**, every concrete behavior is present in the model. For universal properties such as
invariants, a pass is sound for the concrete system, while a counterexample may be spurious. For existential claims
such as command executability, state reachability, or satisfiable `requires`, the direction flips: a positive result
may be spurious, while a negative result rules out the corresponding concrete behavior. An **under-approximation**
contains only some concrete behaviors: existential witnesses are concrete, but a universal-property pass can miss a
counterexample. These directions describe abstractions only; finitizing an input domain is a scope restriction, not a
claim about behavior outside the selected scope.

Every reported result must include the finite domains and collection bounds used. A violation of an invariant during
creation can be a concrete checker trace yet still classify as `Underspecified` when the source leaves those create
fields nondeterministic. For an existential question encoded by checking the negated invariant, invert the checker
result: a counterexample to the negation is a positive witness; an exhaustive pass of the negation establishes
non-reachability only within the stated profile. A deadlock report is a separate outcome, not an invariant result.
For executability, disable deadlock checking for that run or check each command's `Enabled` predicate separately.
The trace translator must use generated source/action metadata to map checker states, action arguments, outcomes,
and changed fields back to `.dt`; a TLC source span alone does not provide that mapping.

References point to the current source. The code has been inspected for the settled details below. ADRs supply semantic
decisions. **Unconfirmed** marks a proposed encoding detail that the source and ADRs do not settle.

## Expression model

`ExprModel` is declared in [`expressions.dt`](../../../contexts/modeling/model/expressions.dt#L8). Names are
syntax-only;
readers resolve them. The current union has no arithmetic, conditional, function-call, or explicit old-state node.

| Node / feature | TLA+ candidate | Class and result impact | Source |
|---|---|---|---|
| `bool(value)` | `TRUE` / `FALSE` | Direct. | [`expressions.dt:12-14`](../../../contexts/modeling/model/expressions.dt#L12) |
| `int(value)` | Integer literal in a profile-bounded domain | Lowering. Bounds restrict scope. | [`expressions.dt:15-17`](../../../contexts/modeling/model/expressions.dt#L15) |
| `decimal(value)` | Scaled integer | Lowering when scale is at least the maximum literal precision. With no arithmetic, literals and comparisons are exact. Finer literals must be rejected or diagnosed. | [`expressions.dt:18-21`](../../../contexts/modeling/model/expressions.dt#L18); [ADR 0035](../../adr/0035-kind-specific-lifecycles.md#L123) |
| `string(value)` | String literal/value | Direct for equality. A finite profile domain restricts scope. | [`expressions.dt:22-24`](../../../contexts/modeling/model/expressions.dt#L22) |
| `name(name)` | Resolve to variable/constant via Semantic IR | Lowering. Unresolved names must be rejected by `dt check`. | [`expressions.dt:25-27`](../../../contexts/modeling/model/expressions.dt#L25) |
| `member(receiver, member)` | Record field selection | Lowering after field and type resolution. | [`expressions.dt:28-31`](../../../contexts/modeling/model/expressions.dt#L28) |
| `not(operand)` | `~operand` | Direct for Bool operands. | [`expressions.dt:32-34`](../../../contexts/modeling/model/expressions.dt#L32) |
| `binary(op,left,right)`; `BinaryOp` | `=>`, `\/`, `/\`, `=`, `#` (or `/=`), `<`, `=<`, `>`, `>=` | Lowering requires source type and equality semantics. Owned-entity and value-object equality is structural, by all fields (ADR 0042; entities compared by ID before it); references (IDs) compare by value; union equality uses tag and fields. Lists and optionals are not comparable. Int and Decimal compare with each other, so Int must be scaled for Decimal comparisons. String ordering uses JavaScript code-unit order; TLC has no string order, so use Unsupported or rank values over a finite domain. A string literal compared with date/time is a value of that temporal type. ZonedDateTime ordering is by instant. | [`expressions.dt:2-3,35-39`](../../../contexts/modeling/model/expressions.dt#L2); [ADR 0016](../../adr/0016-collection-constraints-and-declared-invariants.md#L41); [ADR 0042](../../adr/0042-language-revision-and-ensures.md#L26); [`expressions.ts`](../../../contexts/modeling/src/domain/rules/expressions.ts#L500); [`checks.ts`](../../../capabilities/generation/src/core/checks.ts#L229) |
| `range(operand,lower,upper)` | `operand >= lower /\ operand =< upper` | Lowering. Bounds are inclusive. Ordering follows `binary`; profile values restrict scope. | [`expressions.dt:40-45`](../../../contexts/modeling/model/expressions.dt#L40); [`checks.ts`](../../../capabilities/generation/src/core/checks.ts#L344) |
| `count(collection)` | `Len(sequence)` | Lowering for lists, with finite profile maximum. There is no Set type. | [`expressions.dt:46-48`](../../../contexts/modeling/model/expressions.dt#L46); [`model.dt:196`](../../../contexts/modeling/model/model.dt#L196) |
| `exists(operand)` | Optional-present predicate | Lowering with an exact absent tag/value. Under `and`, an optional member needs an `exists` guard. | [`expressions.dt:49-51`](../../../contexts/modeling/model/expressions.dt#L49); [`expressions.ts`](../../../contexts/modeling/src/domain/rules/expressions.ts#L674) |
| `length(operand)` | Precomputed integer for each value | Lowering only when the profile supplies a finite String or UUID domain; values are precomputed at generation time. Otherwise Unsupported with a diagnostic. It accepts String/UUID, not collections. String length counts Unicode scalar values. | [`expressions.dt:52-54`](../../../contexts/modeling/model/expressions.dt#L52); [ADR 0035](../../adr/0035-kind-specific-lifecycles.md#L123); [`checks.ts`](../../../capabilities/generation/src/core/checks.ts#L336) |
| `matches(operand,pattern)` | Precomputed Boolean for each value | Lowering only when the profile supplies a finite String or UUID domain; values are precomputed at generation time. Otherwise Unsupported with a diagnostic. An ADR amendment could allow an Abstracted encoding, but that is only an option, not a decision. | [`expressions.dt:55-58`](../../../contexts/modeling/model/expressions.dt#L55); [ADR 0035](../../adr/0035-kind-specific-lifecycles.md#L123) |
| `unique(collection,param?,keys)` | Pairwise inequality over elements or selected keys | Lowering. Without a key it compares whole elements. Equality follows `binary`. | [`expressions.dt:59-64`](../../../contexts/modeling/model/expressions.dt#L59); [`expressions.ts`](../../../contexts/modeling/src/domain/rules/expressions.ts#L437) |
| `contains(collection,element)` | Membership or existential sequence membership | Lowering. Equality follows `binary`. | [`expressions.dt:65-68`](../../../contexts/modeling/model/expressions.dt#L65) |
| `quantifier` with `all` / `any` | `\A` / `\E` over a bounded list | Logical lowering with scoped parameter. The finite collection bound is a scope restriction. | [`expressions.dt:5-6,69-74`](../../../contexts/modeling/model/expressions.dt#L5) |
| Expression-free `requires` | Nondeterministic guard | Abstracted over-approximation when both enabled and disabled choices are admitted. Universal passes remain sound; an existential positive may be spurious. Any resulting trace may be `Underspecified`; it cannot establish natural-language intent. | [ADR 0017](../../adr/0017-command-requirements.md#L25) |
| Outcome `select` expression | Boolean outcome guard | Lowering for expression rules. The check that exactly one applicable choice rule holds for every valid input is a property to verify. | [`model.dt:292-307`](../../../contexts/modeling/model/model.dt#L292); [ADR 0035, Choice rules](../../adr/0035-kind-specific-lifecycles.md#L42); [Validation and generation](../../adr/0035-kind-specific-lifecycles.md#L117) |
| Outcome `select` external or declared | Nondeterministic choice among applicable outcomes | Abstracted over-approximation. Universal passes remain sound; existential claims may be spurious. Check ADR 0035's exactly-one-applicable-rule condition. | [`model.dt:292-307`](../../../contexts/modeling/model/model.dt#L292); [ADR 0035, Choice rules](../../adr/0035-kind-specific-lifecycles.md#L42); [Validation and generation](../../adr/0035-kind-specific-lifecycles.md#L117) |
| Invariant without expression | No predicate exists to check | Unsupported as a property. Preserve it as an external/unexpressed obligation; do not silently treat it as true. | [`model.dt:223-227`](../../../contexts/modeling/model/model.dt#L223); [ADR 0016](../../adr/0016-collection-constraints-and-declared-invariants.md#L70) |
| `externalReason` on requires, invariant, or select | Explicit external obligation | Unsupported as a machine predicate; report the obligation. | [`model.dt:227,255,302`](../../../contexts/modeling/model/model.dt#L227); [ADR 0035](../../adr/0035-kind-specific-lifecycles.md#L117) |

## Types and values

`PrimitiveName` is defined in [`model.dt`](../../../contexts/modeling/model/model.dt#L31). ADR 0038's date/time types
are
included. This commit has cardinalities `one`, `optional`, `many`, and `nonEmpty`; the Japanese plan's “List と Set”
mentions a Set type that does not exist in this commit. This is a recorded correction, not a design decision.

| DomainTrail type / feature | TLA+ candidate | Class and result impact | Source |
|---|---|---|---|
| Bool | `BOOLEAN` | Direct. | [`model.dt:31`](../../../contexts/modeling/model/model.dt#L31) |
| Int | Profile finite integer set | Lowering. Bounds restrict scope. | [`model.dt:31`](../../../contexts/modeling/model/model.dt#L31) |
| Decimal | Scaled integers, scale at least maximum literal digits | Lowering; no arithmetic means literal comparisons are exact. Profile values restrict scope, as for Int. | [`model.dt:31`](../../../contexts/modeling/model/model.dt#L31); [ADR 0035](../../adr/0035-kind-specific-lifecycles.md#L123) |
| String | Finite strings from profile | Lowering for selected values. Finite profile domain restricts scope. | [`model.dt:31`](../../../contexts/modeling/model/model.dt#L31) |
| Timestamp | Integer instant units | Abstracted until unit/range selected. Finite values restrict scope; order/equality can be exact inside it. | [ADR 0038](../../adr/0038-date-and-time.md#L26); [`model.dt:29-31`](../../../contexts/modeling/model/model.dt#L29) |
| UUID | Finite symbolic atoms | Lowering. A finite ID pool restricts scope and may omit traces requiring more IDs. Plain model UUID values cannot evaluate `length` or `matches`; those operations require precomputation over the finite UUID profile domain. | [`model.dt:31`](../../../contexts/modeling/model/model.dt#L31); [`expressions.ts`](../../../contexts/modeling/src/domain/rules/expressions.ts#L719) |
| Date, Time, YearMonth, DateTime | Canonical integer/rank representation | Abstracted until valid-domain encoding is selected. Profile values restrict scope; invalid calendar values must be excluded. | [ADR 0038](../../adr/0038-date-and-time.md#L41); [`model.dt:29-31`](../../../contexts/modeling/model/model.dt#L29) |
| ZonedDateTime | Canonical instant with necessary zone data | Abstracted; finite values restrict scope. Offset/zone validity needs checking. Ordering is by instant. | [ADR 0038](../../adr/0038-date-and-time.md#L32); [`checks.ts`](../../../capabilities/generation/src/core/checks.ts#L229) |
| TimeZone | Finite set of IANA identifiers | Abstracted; finite list restricts scope. Zone-dependent validity may be omitted. | [ADR 0038](../../adr/0038-date-and-time.md#L35); [`model.dt:31`](../../../contexts/modeling/model/model.dt#L31) |
| Enum | Finite set of named atoms | Direct / Lowering to declared values. `PrimitiveName` is at line 31; enum elements are at lines 67–75. | [`model.dt:67-75`](../../../contexts/modeling/model/model.dt#L67) |
| ID declarations | Wrapped base primitive with identity equality | Lowering. Profile domain bounds the IDs. | [`model.dt:33-45`](../../../contexts/modeling/model/model.dt#L33) |
| References / `TypeExpr.ref` | Referential atom or record key into aggregate set | Lowering. Dangling-reference exclusion must match validation/runtime semantics. | [`model.dt:181-193,204-218`](../../../contexts/modeling/model/model.dt#L181) |
| Domain primitive / value object | Wrapper or record with invariant predicate | Lowering. Domain primitive constraints may be generation assumptions; target invariants must remain checked properties. | [`model.dt:46-56,76-86`](../../../contexts/modeling/model/model.dt#L46); [ADR 0016](../../adr/0016-collection-constraints-and-declared-invariants.md#L70) |
| Tagged union | Tagged record with valid tag and fields | Lowering; preserve structural equality. | [`model.dt:88-99`](../../../contexts/modeling/model/model.dt#L88) |
| Optional (`?`) | Tagged optional or dedicated `None` value | Lowering with exact absence representation and no sentinel collision. | [`model.dt:195-218`](../../../contexts/modeling/model/model.dt#L195) |
| Lists / multiplicity | TLA+ sequence | Lowering; finite maximum restricts scope. Preserve order and duplicates. | [`model.dt:195-196,204-218`](../../../contexts/modeling/model/model.dt#L195) |
| Set type | None in this commit | Correction to the Japanese plan's “List と Set”: the model declares only cardinalities, and the checker accepts only lists as collections. No Set mapping is applicable. | [`model.dt:196`](../../../contexts/modeling/model/model.dt#L196); list checks: [`count`:372](../../../contexts/modeling/src/domain/rules/expressions.ts#L372), [quantifier:418](../../../contexts/modeling/src/domain/rules/expressions.ts#L418), [`unique`:434](../../../contexts/modeling/src/domain/rules/expressions.ts#L434), [`contains`:468](../../../contexts/modeling/src/domain/rules/expressions.ts#L468) |
| Field sets (`with`) | Inline record fields | Lowering; exact typing should follow the resolved model. | [`model.dt:83-86,107-109`](../../../contexts/modeling/model/model.dt#L83) |

## Commands, aggregates and properties

| Feature | TLA+ candidate | Class and result impact | Source |
|---|---|---|---|
| Aggregate/entity state and fields | State variables and records | Lowering. Finite values and aggregate count restrict scope. | [`model.dt:100-129`](../../../contexts/modeling/model/model.dt#L100) |
| Create commands | Initial-state/action relation | Abstracted: a create command sets every field, but its parameters do not determine every field. Unspecified values are nondeterministic within their type, an over-approximation. Universal invariant passes remain sound; existential claims may be spurious. This can cause `Underspecified`, for example `distinctSkus` failing on nondeterministic `items` at creation. For an aggregate with no create command, generate initial states directly from its applicable declared initial state(s), selecting field values from the profile domains; do not invent a create action. Classification constrains only unspecified values for each fixed command parameter tuple. Create inputs such as `place(id, customer, items)` remain fixed; if no invariant-satisfying unspecified choices exist for an enabled input, classify that input as a forced `Counterexample found`. | [ADR 0019](../../adr/0019-command-changes-and-decisions.md#L50); [ADR 0035](../../adr/0035-kind-specific-lifecycles.md#L24); [shop Order](../../../examples/shop/sales/order.dt#L26) |
| States, outcomes, kind-specific lifecycles | Action per outcome with kind/state validity predicate | Lowering; preserve initial states and selected kind guards. Profile bounds restrict scope. | [ADR 0035](../../adr/0035-kind-specific-lifecycles.md#L59); [ADR 0037](../../adr/0037-aggregate-kinds.md#L1); [`model.dt:122-129`](../../../contexts/modeling/model/model.dt#L122) |
| Commands declared for any state | Same source-state guarded action | Lowering: generated wrapper supports the any-state call, but the command still checks declared source states. Calling it in another state is a `CommandUnavailable` rejection with no state change. | [ADR 0036](../../adr/0036-commands-in-any-state.md#L1) |
| `requires` with expression | Action guard | Lowering with expression semantics above. | [ADR 0017](../../adr/0017-command-requirements.md#L33) |
| `requires` without expression | Nondeterministic guard | Abstracted over-approximation. A universal pass remains sound; existential positives may be spurious. Report as an external obligation / possible `Underspecified`. | [ADR 0017](../../adr/0017-command-requirements.md#L25) |
| `changes`, carried fields and target-only fields | Next-state record | Abstracted: listed changed values without an expression and fields present only in the target state are nondeterministic within type. This over-approximates implementation choices and can cause `Underspecified`. | [ADR 0019](../../adr/0019-command-changes-and-decisions.md#L41); [`model.dt:290,353-355`](../../../contexts/modeling/model/model.dt#L290); [ADR 0019 target fields](../../adr/0019-command-changes-and-decisions.md#L57); [shop Order](../../../examples/shop/sales/order.dt#L49) |
| Legacy command form and per-kind `on command` cases | Outcome actions with selectors | Lowering after translating legacy transitions and cases to the shared outcome model. | [`model.dt:276-284,348`](../../../contexts/modeling/model/model.dt#L276) |
| Errors/outcomes | Successful action branch; rejection has no state change | Lowering. Errors are not successful transitions. | [ADR 0018](../../adr/0018-command-events-contract.md#L25); [ADR 0019](../../adr/0019-command-changes-and-decisions.md#L78) |
| `emits` and `when` | Outcome-associated event count/predicate | Lowering for single-aggregate event facts. Delivery is outside this phase; exact representation must match ADR 0018. The legacy `when` form maps its matching outcomes. | [ADR 0018](../../adr/0018-command-events-contract.md#L25); [ADR 0019](../../adr/0019-command-changes-and-decisions.md#L78); [shop Order](../../../examples/shop/sales/order.dt#L61) |
| `emits ... ?` | Optional event count | Abstracted, nondeterministic choice: whether the optional event is emitted is not determined by the model. | [shop Order](../../../examples/shop/sales/order.dt#L70) |
| Aggregate invariants | State predicates checked initially and after actions | Direct / Lowering. Never insert checked invariants into guards. Scope bounds restrict coverage. | [ADR 0016](../../adr/0016-collection-constraints-and-declared-invariants.md#L67); [shop Order](../../../examples/shop/sales/order.dt#L19) |
| Domain primitive invariants | Value-domain predicate | Lowering as a generation precondition only when it is a type constraint. Do not assume a target invariant. | [ADR 0016](../../adr/0016-collection-constraints-and-declared-invariants.md#L70); [shop Amount](../../../examples/shop/common/context.dt#L11) |
| Policies | Later environment/event reaction action | Unsupported in the single-aggregate phase. Phase 7 must declare delivery assumptions. | [ADR 0022](../../adr/0022-policy-declarations.md#L1); [`model.dt:163-171`](../../../contexts/modeling/model/model.dt#L163) |
| Verified types | Predicate/factory evidence | Abstracted: allowing every value of the `of` type admits more inputs than the factory makes, an over-approximation. Universal passes are sound; existential positives may be spurious. Exact slot semantics need a spike. | [ADR 0023](../../adr/0023-verified-types.md#L1); [`model.dt:57-66`](../../../contexts/modeling/model/model.dt#L57) |
| `unique` collection constraint | Pairwise distinctness over elements/keys | Lowering; whole-element equality without a key follows expression equality rules. | [ADR 0016](../../adr/0016-collection-constraints-and-declared-invariants.md#L51); [`expressions.dt:59-64`](../../../contexts/modeling/model/expressions.dt#L59) |
| Reachability / deadlock | TLC state graph and terminal-state predicate | Lowering, complete only within finite profile scope. Distinguish intended terminal states. | [ADR 0014](../../adr/0014-command-transitions.md#L25) |
| Source locations / trace mapping | Symbol-to-source map and action metadata | Lowering candidate. Map commands, arguments, before/after states, and source `Location`. | [`model.dt:42`](../../../contexts/modeling/model/model.dt#L42); [`build.ts:95`](../../../contexts/modeling/src/infrastructure/syntax/build.ts#L95) |

### Phase 0 spike clarification — capture B17b

Finite bounds on item count and profile values are verification scope, not inferred business constraints. The
single-module Order spike's constrained-action rule is mechanical: `A_C(p) == A(p) /\ Inv'`. Its no-successor probe is
`\A p: ENABLED A(p) => ENABLED A_C(p)`. For each input tuple enabled by `A`, the same parameters are preserved;
parameters are never constrained. Only unspecified outputs are restricted by `Inv'`. No constrained successor for an
enabled input is a forced `Counterexample found`; a violation caused only by unspecified outputs is `Underspecified`.
Attribute a transition finding with `NextOnly_A`, leaving only A unconstrained and constraining other declarations.

Creation is represented by `Place` from `Absent`. The seed models creation as `place(id, customer, items)`; the real
command is `place(id, customer)` (`order.dt:26`). The probe fixes each seed input tuple and checks whether any
invariant-satisfying unspecified output exists. The `its` parameter exists only in the
`creation_items_param` seed; in `none` it is quantified but unused. TLC can report the state violation but does not
print the quantified input witness; a translator must recover it by matching the generated input domain and action
relation against the trace. In the spike, binding create ID/customer parameters to fields is an explicit modeling
assumption. Command arguments generally do not bind to fields: ChangeNote's argument is retained but `note'` is
nondeterministic; Confirm's timestamp argument is retained but the selected timestamp is nondeterministic; Cancel's
reason argument is retained but `reason'` is nondeterministic. Source-only fields are dropped.

Capture B17b detects 5 of 5 seeded kinds: missing `hasItems` is detected via `Confirm` (`C_probes` fails while
`none__C_probes` passes; `only_Confirm` fails while `none__only_Confirm` passes). At Level 2, missing `requires` is
detectable when it protects fields a command does not change or specify, not when it protects only unspecified
outputs. The missing AddItem requirement is not detected: the correct model also admits duplicate SKUs, and
`none__only_AddItem` violates `DistinctSkus`. A postcondition such as `items' = Append(items, it)` is needed at Level 3.
Full detection and stop criteria are in
[`spike/results.md`](spike/results.md).

TLC 1.8.0 JSON records state/action values, action name, TLA source location, context, and formal parameters. It does
not identify DomainTrail declarations, field provenance, or a quantified input hidden by a state-only invariant
failure. Generator metadata must map actions, arguments, fields, invariants, and source spans, and indicate whether
each target field came from a parameter, explicit assignment, unchanged state, or an unspecified choice. For a forced
creation violation, it must recover the fixed input tuple from the relation and state witness.

Checker exit codes are transport signals, not result classes. A completed exhaustive pass is verified only within
the finite profile. Interpret violations using the source classification above; interpret existential checks
encoded as negated invariants against a correct-model witness. A counterexample to the negation is a positive
witness; an exhaustive pass establishes absence only within scope. `none__deadlock_U` passed with Cancelled
terminal-aware. In capture B19, the Apalache `none__C_all` run is a compatibility smoke test that shows only that `Inv`
holds under `NextC` to length 4, and the `missing_requires_confirm__only_Confirm` run finds an `Inv` violation at state
2; under `NextC`, `Inv` holds by construction, and Apalache cannot evaluate the `ENABLED` probes. The accepted
annotation form is a keyword, a `\* @type:` line comment, then the name; sequence iteration uses `DOMAIN items`
rather than `1..Len(items)`. Add both requirements to the generator; bounded passes are not exhaustive.

Phase 4 generator requirements include treating SANY semantic diagnostics as errors even on exit 0; aligned
bulleted lists; parenthesized quantifiers and `IF` expressions; dependency-ordered definitions; `Inv'` last in
constrained actions; valid cfg keywords such as `CHECK_DEADLOCK`; and defining every operator referenced by every
cfg. Prefer one seed-parameterized module over copied modules. Generate fixed-parameter constrained forms and probes
mechanically, and validate config/operator closure. Java 27 works for TLC. TLC is the recommended exhaustive
finite-state checker; Apalache's bounded runs (capture B19) are compatible with the spec and find the confirm seed, but
are not exhaustive. Per aggregate, the basic matrix is unconstrained and
constrained invariant runs plus a probe run, with one additional run per action for full attribution and one per
existential witness. Capture B17b took 84.86 seconds across 45 timed invocations. See the
[detection table and stop criteria](spike/results.md#stop-criteria).

## Phase 0 tool and runtime notes

TLC 1.7.4 (latest stable): [tla2tools.jar](https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar),
SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`. TLC 1.8.0 (pre-release,
2026-11-26): [tla2tools.jar](https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar), SHA-256
`67f9575c3b9ef7a0787b1bded34812862ffe79d711298e5a75b1a77720b19928`. Apalache 0.63.0:
[apalache-0.63.0.tgz](https://github.com/apalache-mc/apalache/releases/download/v0.63.0/apalache-0.63.0.tgz),
SHA-256 `a756e96af249bf33cd7629667a49472cb26ac8227c48583da139b414834d59df` (matches the release's
`sha256sum.txt`). Capture B17b ran TLC and bounded Apalache on Temurin 27.0.1.1+4; Java 27 works for TLC in this
toolchain.
The measured single-module results and observed exit codes are recorded in [capture B17b results](spike/results.md).

### Argument and violation attribution decisions (B17b)

Command parameters are not bound to state fields: ADR 0019 obtains values from the decision's `set`. Changed and
target-only fields are nondeterministic within type: `ChangeNote` chooses `note' \in Notes`, `Confirm` chooses
`confirmedAt' \in Times`, and `Cancel` chooses `reason' \in Reasons` and sets `confirmedAt' = None`;
source-only fields are dropped. Create ID/customer bindings are an explicit assumption. The `its` argument exists only
for `creation_items_param`; in `none` it is quantified but unused. The `U_all` runs stop at their first violation, so
joint attribution was not checked. Phase 4 should use `-continue` and explain every violation through some `only_A`.
TLC 1.7.4 logs show states and action names, not arguments. Use parameters printed in TLC 1.8.0 JSON; mark other
values as inferred from the state/action relation. The Place trace has two `(i1,s1,1,JPY)` items; `its` is unused
and `items'` is unspecified.
