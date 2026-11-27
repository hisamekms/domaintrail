# Semantic IR: design

Phase 1 adds a resolved semantic representation between model analysis and generation. The IR builder takes both the
SourceModel and Typed Model. It takes semantic facts from Typed Model helpers and joins them to SourceModel spans by
stable ID. That keeps precise source spans while semantic checking runs.
The SourceModel is explicitly built from syntax and retains sites and duplicate declarations
([source-model.ts](../../../contexts/modeling/src/domain/source-model.ts#L1-L18)); each `Site` has a start and end
position ([source-model.ts](../../../contexts/modeling/src/domain/source-model.ts#L19-L24)). The Typed Model is instead
a resolved, serializable view consumed by TypeScript generation and Graph IR
([model.ts](../../../contexts/modeling/src/domain/model.ts#L1-L4)). Publish the IR types in
`contexts/modeling/model/*.dt` with generated types, following the repository's published-language layout
([CONTRIBUTING.md](../../../CONTRIBUTING.md#L70-L85)).

## Current semantic work and duplication

The source rules create visibility scopes for aggregate, state, kind, command, and requirement expressions
([expressions.ts](../../../contexts/modeling/src/domain/rules/expressions.ts#L99-L170),
[expressions.ts](../../../contexts/modeling/src/domain/rules/expressions.ts#L195-L218),
[expressions.ts](../../../contexts/modeling/src/domain/rules/expressions.ts#L235-L249)). The expression checker is
`ExprChecker` ([expressions.ts](../../../contexts/modeling/src/domain/rules/expressions.ts#L334-L657)); name lookup
resolves lambda bindings, fields, declarations, contexts, and hidden names
([expressions.ts](../../../contexts/modeling/src/domain/rules/expressions.ts#L544-L553)). Compatibility is checked
by `comparable`, `equatable`, and `ordered`
([expressions.ts](../../../contexts/modeling/src/domain/rules/expressions.ts#L688-L718)).

The end state makes the checker the IR builder: expression checking, lifecycle rules, and structure rules produce IR
facts and diagnostics in one pass. Remove duplicated semantic work as consumers move:

- The generator's second type system, `Ty`, `fieldTy`, and `baseTy`, independently interpret Typed Model fields
  ([checks.ts](../../../capabilities/generation/src/core/checks.ts#L53-L66),
  [checks.ts](../../../capabilities/generation/src/core/checks.ts#L170-L203)); retire these alongside the generator's
  separate `name` and `member` resolution ([checks.ts](../../../capabilities/generation/src/core/checks.ts#L399-L433),
  [expressions.ts](../../../contexts/modeling/src/domain/rules/expressions.ts#L544-L553)).
- `validStatesOf` computes kind lifecycle reachability from raw AST in infrastructure
  ([build.ts](../../../contexts/modeling/src/infrastructure/syntax/build.ts#L406-L439)); lifecycle rules already
  compute reachability and report M028
([lifecycles.ts](../../../contexts/modeling/src/domain/rules/lifecycles.ts#L150-L191)).
  Delete `validStatesOf` and have lifecycle analysis produce the IR states.
- Contract tests independently find cycle-ending finite values
  ([tests.ts](../../../capabilities/generation/src/core/tests.ts#L170-L185)); structure rules decide finite recursive
  values for M012 ([structure.ts](../../../contexts/modeling/src/domain/rules/structure.ts#L250-L264)). Have those
  rules emit the fact and delete the second cycle-ending computation.
- `build.ts` and `build-source.ts` are two AST-to-model mappings
  ([build-source.ts](../../../contexts/modeling/src/infrastructure/syntax/build-source.ts#L1-L5)); `domain/model.ts`
  and `domain/source-model.ts` expose the Typed Model and SourceModel projections
  ([model.ts](../../../contexts/modeling/src/domain/model.ts#L1-L4),
  [source-model.ts](../../../contexts/modeling/src/domain/source-model.ts#L1-L18)). The IR should be built during the
  SourceModel analysis, not as another downstream interpretation.
- TypeScript name checking runs over SourceModel in `tsnames.ts`
  ([tsnames.ts](../../../capabilities/generation/src/core/tsnames.ts#L1-L20)), while code generation consumes the Typed
  Model. Keep backend spelling helpers such as `naming.ts` and `typescript.ts`'s imports separate from semantic name
  resolution ([typescript.ts](../../../capabilities/generation/src/core/typescript.ts#L1-L34),
  [typescript.ts](../../../capabilities/generation/src/core/typescript.ts#L37-L75)).
- “Fields common to all source states” are computed for expression scopes
  ([expressions.ts](../../../contexts/modeling/src/domain/rules/expressions.ts#L207-L212)) and again while checking
  requirements through `checkRequirements`
  ([expressions.ts](../../../contexts/modeling/src/domain/rules/expressions.ts#L240-L309));
  produce one scope fact and consume it in both places.
- The visualization Graph IR currently consumes the Typed Model
  ([model.ts](../../../contexts/modeling/src/domain/model.ts#L1-L4)). It remains a separate projection and does not move
to the semantic IR in Phase 1; a later migration would need its own consumer decision.

The `typescript.ts` lines above are imports, including shared helpers such as `applicableOutcomes`, `validStatesFor`,
`kindCase`, and `outcomeFields`, defined in the modeling domain
([model.ts](../../../contexts/modeling/src/domain/model.ts#L113-L133),
[model.ts](../../../contexts/modeling/src/domain/model.ts#L236-L236)). Reuse these helpers during transition; do not
re-derive their semantics. Naming and type mapping in the TypeScript backend remain output spelling tasks
([typescript.ts](../../../capabilities/generation/src/core/typescript.ts#L94-L107)).

Optional narrowing today uses `Scope.present`
([expressions.ts](../../../contexts/modeling/src/domain/rules/expressions.ts#L44-L44));
`and` and `implies` add `guards(left)` to the right-hand scope
([expressions.ts](../../../contexts/modeling/src/domain/rules/expressions.ts#L486-L486)), `exists` checks its operand
with an empty presence set ([expressions.ts](../../../contexts/modeling/src/domain/rules/expressions.ts#L379-L379)), and
`narrow` consults the set ([expressions.ts](../../../contexts/modeling/src/domain/rules/expressions.ts#L659-L660)).
`guards` collects only true-edge `exists` conjuncts
([expressions.ts](../../../contexts/modeling/src/domain/rules/expressions.ts#L671-L679)).
Phase 1 reproduces this rule exactly; false-edge facts are not added.

The checker determines compatibility, but the equality kind is chosen by generated equality code: entities compare by
ID, value objects by fields, and unions by discriminator and fields
([checks.ts](../../../capabilities/generation/src/core/checks.ts#L817-L850));
this follows ADR 0016
([ADR 0016](../../../docs/adr/0016-collection-constraints-and-declared-invariants.md#L24-L37)).
The generator's runtime
check path strips optionality at
[checks.ts](../../../capabilities/generation/src/core/checks.ts#L412-L412) and relies on
M009 to reject unguarded optional values. Record this hidden dependency and remove it when checks consume resolved IR.

## IR shape and identities

Stable IDs currently exist for contexts, elements, states, commands, and kinds
([ids.ts](../../../contexts/modeling/src/domain/ids.ts#L1-L30)). Fields, parameters, invariants, requirements, outcomes,
and variants have neither stable IDs nor locations in the published model
([model.dt](../../../contexts/modeling/model/model.dt#L205-L290)); the kernel `Location` records file and line bounds,
not columns ([kernel.dt](../../../shared/kernel/model/kernel.dt#L60-L66)). SourceModel sites provide spans
([source-model.ts](../../../contexts/modeling/src/domain/source-model.ts#L19-L24)). Add stable IDs for fields,
parameters,
invariants, requirements, and outcomes by extending `ids.ts`; preserve variants' source identity in the IR as needed,
with stable IDs to be decided before they become external property identities. This gives every result's `property` a
stable declaration identity.

A resolved expression node carries its source site, resolved symbol (field, parameter, lambda variable, state, kind,
enum value, or type), static type including cardinality and optionality, and checked operation result. Retain original
syntax for diagnostics. Scope facts cover aggregate, state, kind, command/case, source state, target outcome, factory
parameters, and lambda bindings. In particular, command parameters are inputs and are not implicitly bound to fields of
the same name.

Record comparison kind per expression occurrence: entity identity by ID, structural value-object equality, union tag and
fields, or not comparable. Record optional presence facts at edges, with current true-edge behavior. A presence fact's
`path` is the checker's guard path key used to narrow the expression at that edge; it is resolved in the scope of that
expression and holds for everything below it. It is ambiguous when a lambda inside the expression rebinds the path's
first
name — the checker narrows by the same text and has the same gap (an unguarded optional reached through the rebound
name is accepted); fixing it changes what the checker accepts and is a separate checker task. Provenance is keyed per
(outcome,
source), so carried and unspecified facts retain the source state that produced each result. The IR also records
initial and valid states per kind, plus `on` cases; named outcomes from one source remain nondeterministic choices
unless an executable `select` expression constrains them (ADRs 0035/0037). Only natural-language `select` and
`@externalCheck` (M029) are nondeterministic, alongside expression-free `requires`; this follows the per-kind lifecycle
decisions in [ADR 0035](../../../docs/adr/0035-kind-specific-lifecycles.md#L26-L43) and
[ADR 0037](../../../docs/adr/0037-aggregate-kinds.md#L41-L108). Preserve the mapping `requires ... else Error` as a
failed-command result. Record `changes` as a frame: unlisted fields are UNCHANGED. Record these sources of unspecified
values explicitly: create fields with no parameter supplying them, fields present only in the target outcome, and fields
listed in `changes` without an expression. Also record expression-free `requires` and nondeterministic choices. Capture
provenance for parameters, explicit assignments, carried values, unspecified outputs, and selected choices. Include
external obligations and natural language parts without implying they are executable predicates.

## Placement and migration

The TLA+ generator, runner, and trace translator belong in a new formal-verification capability; Java/tool adapters live
under `adapters/`. Update the architecture map at `test/architecture/map.ts`. Keep parsing and syntax-to-SourceModel
mapping in infrastructure, semantic interpretation in Modeling domain, and published IR declarations in
`contexts/modeling/model/*.dt`.

Migration steps and regressions:

1. Step 1 declares IR types, stable IDs, and declaration-level facts. Capture current behavior with existing baselines:
   byte snapshots for every generated `dt generate ts` file for
   `examples/shop` ([generate-contract.test.ts](../../../test/generate-contract.test.ts#L1-L7),
   [snapshot](../../../test/__snapshots__/generate-contract.test.ts.snap#L1-L5)), Live View contract hashes
   ([live-contract.test.ts](../../../test/live-contract.test.ts#L1-L12)), and checker text/JSON snapshots
   ([check-contract.test.ts](../../../test/check-contract.test.ts#L1-L6)). Compare after removing version strings with
   `withoutVersion` ([helpers.ts](../../../test/helpers.ts#L27-L31)); require no diff after that masking. Also
   regenerate
   and diff
   committed self-hosted `src/generated` models. Add fixtures only where existing coverage has a gap.
2. Add optional fact reporting to the checker and have the IR builder run the checker a second time to collect those
   facts. This step delivers resolved symbols and static types, comparison kinds, presence and scope facts, and
   outcome-field provenance from typed frames. The single pass arrives in step 3, when the checker becomes the builder.
   Regression: checker text and JSON snapshots
   stay stable, including source ranges; existing generated snapshots and hashes still match.
3. Make the checker the IR builder in one pass, then port TypeScript generation to consume IR references, types,
   equality, narrowing, applicability, and finite-cycle facts; delete the generator's duplicate logic listed above.
   Regression: generated file set and contents match the
   version-masked baseline, and the self-hosted generated output has no diff.
   Progress (step 3a, done): the generator requires the IR and resolves names and members only from IR symbols (kinds
   `field`, `parameter`, `lambda`, `enumValue`, `type`, `unionTag`, `discriminator`, `context`, `value`; a field
   symbol's ID is the field of the element holding it for that access, including field-set fields, which the IR also
   declares under each using element); Typed Model valid states come from `lifecyclesOf`; recursive value cycles are
   computed once (`valueCycles`, in the IR as `cycles`) for M012 and contract-test arbitraries. Two accepted behaviour
   changes: a union on a cycle ends with a variant that really ends it (the old rule could pick a recursing variant and
   overflow), and M012 reports a non-finite type once, on its own cycle, not on each cycle that reaches it.
   Progress (step 3b, part 1, done): every compiled node's type is the IR's, including its narrowing (type-name and
   context receivers take theirs from the symbol; a union's tag has an IR type `{ name: <union>, tag: true }`).
   Remaining: one checker pass; delete the compiler's own per-case type computation that the IR type now overrides;
   equality from comparison facts; applicability.
4. Port contract-test generation to IR dependencies and recursion facts. Regression: all generated test files match the
   captured baseline and the checker contract remains unchanged.
5. Add the TLA+ capability and adapters, trace metadata, and architecture-map entry (Phase 4; Phase 1 ends at step 4).
   Regression: deterministic module/config snapshots, source-to-trace mapping fixtures, and spike classification
   fixtures for constrained probes, per-action attribution, existential witnesses, and terminal deadlock.

## Verification consumer

The generator consumes only Semantic IR plus a finite verification profile. It emits deterministic TLA+ and config,
source maps, and action metadata. Preserve action and parameter identities, invariant/property IDs, declaration spans,
input domains, and field provenance. For each action `A(p)`, the constrained relation is `A_C(p) == A(p) /\ Inv'`;
the probe preserves each enabled input tuple and asks whether a constrained successor exists. Parameters are never
constrained. Creation starts from the absent state; assigning create parameters to fields is an explicit modeling
assumption. A forced violation must recover the fixed input tuple; an underspecified result must establish that the bad
field came only from an unspecified output. Keep TLA spellings internal to translation and present DomainTrail names
and stable IDs to users. The spike's detailed requirements are in [results.md](spike/results.md#L31-L46) and
[mapping.md](mapping.md#L109-L162).

## Open design points

Choose the compatibility policy for consumers of this new published model, and stable identity policy for variants.
Specify how external choices and natural-language obligations are represented without executable semantics. Define
structural equality for recursive values and tagged optionals. The visualization graph remains on Typed Model for this
phase; revisit only with a dedicated consumer migration.
