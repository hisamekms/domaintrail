# Plan: formal verification with TLA+

Status: Phases 0 and 3 done; Phases 1–2 and 4–7 proposed. Input: `main` at `4d8a2ed`. Integration branch:
`feat/formal-verification`;
merge each phase into it by PR, then merge to `main` once at the end.

This file replaces the maintainer's Japanese integration plan in the repository. TLA+ is generated directly from
DomainTrail; Quint is not used. TLC is the candidate default. Apalache is optional. Java is optional: without Java,
`dt verify` reports `skipped` and runs only `dt check`. DomainTrail is beta, so breaking changes are allowed. Release
happens after every phase is complete. Intermediate phases need not deliver user value. Amount of code change is not a
decision criterion.

## Background and goal

DomainTrail is a domain modeling DSL written by AI and reviewed by people. It describes domain structure, state
transitions, commands, preconditions, invariants and events; it provides static checks, TypeScript and contract-test
generation, and Live View. Integrating TLC and Apalache should make behavior and contract consistency mechanically
checkable.

The intended cycle is: a person supplies business requirements; an AI writes the model; `dt check` performs static
checks without Java; `dt verify` deterministically generates TLA+ and checks it (or reports skipped); the AI reads
translated diagnostics and counterexamples and improves the DomainTrail model; a person reviews the model,
counterexample and changes. The goal is a domain modeling language that AI can write, people can understand, and formal
methods can verify incrementally.

## References and baseline

Relevant upstreams are [DomainTrail](https://github.com/hisamekms/domaintrail),
[TLA+](https://github.com/tlaplus/tlaplus) and [Apalache](https://github.com/apalache-mc/apalache). The investigation
checked the expression model and checker, tree-sitter grammar, generation capability, `examples/shop`, and ADRs 0014,
0016–0020, 0022–0023, and 0035–0038. (the Japanese plan does not list ADR 0021).

Inspection targets are `contexts/modeling/model/expressions.dt`, `contexts/modeling/src/domain/rules/expressions.ts`,
`tree-sitter-domaintrail/grammar.js`, `capabilities/generation/`, `examples/shop/` (configured by `domaintrail.jsonc`),
and the ADRs above. At the input commit (`origin/main` 4d8a2ed), `ExprModel` is syntax only and readers resolve names.
The expression language has no arithmetic or conditional node; it has logic, comparisons, `range`, `count`, `exists`,
`length`, `matches`, `unique`, `contains` and `all`/`any` quantification. `requires` may omit its expression and keep
only a natural-language label; `changes` identifies permitted fields but not their new values, which come from decision
`set`. Decimal is a branded TypeScript string; time types are in ADR 0038. Node is 22.13 or later. The primitive list
includes UUID and TimeZone. The Japanese plan's “List と Set” has no Set type at this commit; this correction is recorded
here. Code and accepted ADRs take precedence over conflicts with the Japanese plan. Proposed syntax, CLI, settings and
diagnostics are candidates, not current behavior.

## Principles

The four `check`/`verify` principles are:

- Checks move by definition between `check` and `verify`, with their code unchanged.
- Both commands use one result schema.
- Codes name the problem, not the command.
- `verify` includes `check` before formal exploration.

Boundary properties: `check` serves LSP, MCP and Live View; `verify` takes seconds to minutes.

- DomainTrail is the single source of truth. Generate TLA+ deterministically from model and profile, maintain a source
  map, and do not expect people or AI to edit generated TLA+. TLA+ output is a backend artifact; changing surface syntax
  must not require changes to generators.
- Introduce a Semantic IR resolving types, names, equality, optional narrowing and scope. Both TypeScript and TLA+
  generators consume it. Keep backends replaceable behind the IR.
- Generators must not infer or duplicate semantics. Handwritten TLA+ is only for comparison in the PoC.
- Syntax follows TS/JS conventions, not the backend language. Use TS-like syntax with null safety and one canonical
  spelling per meaning.
  No TS look may have a meaning that differs from DomainTrail's (`==` structural by declared type; `===` and mutating
  methods rejected). Evaluate correctness, clarity, repairability and token use with AI trials.
- Preserve “Structure and Contracts”; procedural business logic and a general-purpose programming language are out of
  scope. Formalization depth follows business understanding and risk.
- `dt check`, generation and Live View work without Java. Without Java or a checker, `dt verify` reports skipped, never
  success. CI can fail on skip.
- Never silently omit an untranslatable feature; explain approximation direction and impact.

## Formalization levels

| Level | Content | Properties and scope | Tool |
|---|---|---|---|
| 1 — Structure | Structure, types, states, transitions | Type/reference consistency and transition-graph reachability | `dt check` |
| 2 — Constraints | requires, invariant, changes | Satisfiability, executability, creation violations, violations from unspecified changes | `dt verify` |
| 3 — Behavioral Contracts | Postconditions (`ensures`) | Preconditions/postconditions consistency and invariant preservation by contract-compliant transitions | `dt verify` |
| 4 — System Properties | Multiple aggregates, events, policies and temporal properties | Cross-aggregate consistency, safety, liveness, concurrency and delivery | Later phase |

At Level 2, create commands, `changes`-only fields and target-only fields can introduce values not determined by
parameters or expressions. The spike detected 5 of 5 seeded kinds; missing `addItem` `requires` is the recorded Level 2
limit, not a detection ([seed results](formal-verification/spike/results.md#L52)). Those values are nondeterministic
within their type. A constrained type can make a check vacuous; an unconstrained type can yield a counterexample. The
useful Level 2 checks are mainly satisfiability, executability and creation invariants. Classify traces from unspecified
values as `Underspecified`, distinct from implementation mistakes. For example, `distinctSkus` failing at creation on
nondeterministic `items` is underspecification. Seed the creation-invariant mistake with a violation forced by supplied
creation values, or otherwise label a seeded concrete defect, so it can be distinguished from that case.

Do not require a `level: 3` annotation. Track formalization per aggregate, command and outcome; the displayed level is a
summary of this per-unit breakdown. A few postconditions do not raise the level of the whole aggregate. Distinguish
natural-language-only conditions from expressions. Keep Formalization Level, Verification Coverage, Verification Scope
(bounds, initial states, depth, abstractions and assumptions), and Verification Result separate. `Verified` means
exhaustive TLC checking within the finitized scope, or an Apalache inductive invariant check. Bounded Apalache
exploration is not `Verified`.

## Architecture and command boundary

```text
DomainTrail -> parser/name resolution/type checker -> Semantic IR
  -> TypeScript generator and contract tests
  -> TLA+ generator <- named scopes in .verify.dt or model-derived defaults
  -> backend runner (TLC / optional Apalache; unavailable Java => skipped)
  -> result translator and source map -> CLI / JSON / Live View / AI diagnostics
```

Separate `dt check` (fast, deterministic, no external dependency) from `dt verify` (exploration under bounds and
assumptions). The division is by guarantee and cost. Both commands use one versioned result schema with `static` or
`formal` origin. `verify` runs `check` first and does not explore if errors exist.

Diagnostic codes name the problem, not the command; a check moves between `check` and `verify` according to its
definition. `check` serves LSP, MCP and Live View. `verify` takes seconds to minutes.

AI guidance is “use `check` normally, `verify` to confirm.” Reject `dt check --formal` because it obscures the
guarantee/cost boundary, and reject `dt tla` because it names a checker backend.

Later phases may be reordered based on evidence.

Phase 0 evaluates TLC as the candidate default: exhaustive exploration of a finitized single aggregate, complete within
that scope, with optional random `-simulate`. Apalache is optional for symbolic bounded exploration and inductive
invariant checking. The generator must emit Apalache type annotations.

## Results

Report per property: `Verified` (method and scope attached), `No counterexample found` (bounded or simulated),
`Counterexample found` (a trace from creation, the initial state), `Underspecified` (unspecified
create/target-only/change values or expression-free requires), `Inconclusive` (timeout or resource limit),
`Unsupported`, `Skipped` (`skipReason` is `noJava`, `checkFailed`, or `unsupported`), or `Error`. Raw checker output is
evidence, not the
official interface.

Partial success must never look like full success. **The following exit-code table is added beyond the Japanese plan,
which only requires the four outcomes to be distinguished:**

| Exit code | Meaning | `check` / `verify` interpretation |
|---|---|---|
| 0 | All applicable checks succeeded | No errors, counterexamples or skips; bounded results remain explicitly qualified |
| 1 | Content failure or formal non-success result | Static content errors, or at least one applicable formal check failed, was inconclusive, unsupported, or Underspecified |
| 2 | Skipped | At least one required check was skipped; `--allow-skip` makes skips exit 0 |
| 3 | Error | Parsing, translation, checker or execution error |

This one table is shared by `check` and `verify`; when outcomes are mixed, error takes precedence, then failed check,
then skip. Details and partial outcomes remain in the versioned result schema.

## Translation candidates

See the [Phase 0 mapping](formal-verification/mapping.md#L1), which holds the complete construct and type mapping, its
classification, and translation candidates.

## Phases

Phases are delivery stages; levels are formalization granularity.

### Phase 0 — decision spike (done)

Phase 0 deliverables:

1. [Mapping](formal-verification/mapping.md#L1) from DomainTrail constructs to TLA+.
2. [Handwritten Order specification and checker captures](formal-verification/spike/results.md#L1).
3. [Seeded detection and classification results](formal-verification/spike/results.md#L47).
4. [Trace translation and source-map proposal](formal-verification/spike/results.md#L79).
5. [Tool acquisition, versions, checksums, Java, and timing](formal-verification/spike/results.md#L3).
6. [Backend recommendation and generator requirements](formal-verification/spike/results.md#L119).
7. [Language revision and AI trial proposal](formal-verification/language-revision.md#L1).
8. [Semantic IR design](formal-verification/semantic-ir.md#L1)
   and [shared result schema](formal-verification/results-schema.md#L1).
9. This review and the [ADR drafts](formal-verification/adr-drafts.md#L1).

The numbered stop criteria are met: (1) detect seeded kinds, 5 of 5; (2) complete the correct constrained exhaustive run
within time; (3) map traces to the model manually; and (4) measure total capture runtime (84.86 seconds across 45 timed
entries). The `addItem` seed is the recorded Level 2 limit, not a detection. Completion requires a classified mapping,
detection table, translated counterexample, and checker recommendations. Checker licenses and the no-Java behavior of
`dt verify` were not recorded and carry into Phase 4. See the [stop-criteria
table](formal-verification/spike/results.md#L91).

### Phase 1 — Semantic IR

Build the IR in Modeling's `domain` from `SourceModel`, retaining syntax sites and resolved semantic facts. Publish the
IR declarations through Modeling's `.dt` model and generated types. Add stable IDs for fields, parameters, invariants,
requirements, outcomes, union variants and variant fields, using the same scheme (separator decided in Phase 1). The IR
is
internal during beta, carries a version number, and has no compatibility promise; decide the public semver policy at
1.0. The checker
becomes the IR builder, producing expression, lifecycle, and structure facts with diagnostics. Optional narrowing
reproduces only the true-edge rule. Equality is selected by declared type: owned entity values and value objects
structurally, references by ID, and unions by tag and fields. The visualization Graph IR remains on the Typed Model. See
the [IR design](formal-verification/semantic-ir.md#L3) and [Phase 1 boundary](formal-verification/semantic-ir.md#L160).

Migrate consumers in this order: (1) capture current generated TypeScript, Live View, and checker baselines; compare
with existing snapshots and hashes after `withoutVersion` masking, including self-hosted generated output; (2) move
checker semantics into the IR builder while preserving diagnostics and source ranges; (3) migrate the TypeScript
generator to IR references, types, equality, optional narrowing, applicability, and recursive finite-value facts, then
remove duplicated type/name/member/lifecycle/cycle computation; (4) migrate contract-test generation to IR. Regressions
require baseline-equivalent generated files, stable checker contracts, and no self-hosted generated diff. Phase 1 ends
at step 4. Details are in the [IR migration steps](formal-verification/semantic-ir.md#L128).

### Phase 2 — one breaking language revision

Use TS-like syntax with strict null safety (`T?` means `T | null`, narrowed by `x != null`, `?.`, and `??`) and an
exhaustive `match` expression over unions and states. Use `?:` for conditional expressions and `!(p) || q` in place of
`implies`; use `null` as the null keyword. `==`/`!=` follow declared-type equality; reject `===` with a
diagnostic suggesting `==`. Values are immutable; reject mutating methods such as `push`. The AI trial compares only
match forms and quantifier names (`every`/`some` vs `forall`/`exists`), and confirms the `x => …` lambda form.

Use Int `+`, `-`, `*` (no `/`); Decimal `+`, `-`, `*`, `/` with declared scale and half-even rounding. Diagnose
division by zero unless the divisor is shown non-zero. Arithmetic on domain primitives yields the base type; check its
constraint again on assignment. Adopt method-form collection calls `every`/`some`, `includes`, `.length`, `.matches()`,
list literals, spread, `.map`, `.filter`, and `.sum`. Include typed, expression-bodied predicates and functions without
recursion or call cycles.

Supervisor decision (2026-11-28): recursive values use default verification recursion depth 2. Adopt design D:
`changes x` permits a field change with unspecified value; `changes x = expr` determines its value
using the `ensures` scope (bare parameters, `before.x` fields, no `after`); unlisted fields are unchanged. `ensures`
follows `changes`/`emits`, uses `before.x` and `after.x`, and expresses relations only. Diagnose a lone equality in
`ensures` and move it to `changes x = expr`. Create commands list every non-optional field through `changes`; an
unlisted optional field is `null`; the same rule applies to fields new in a transition's target state. Define named
outcomes, state- and kind-specific fields, optionals, and create
construction. Diagnose kept fields consistently and detect contradictory postconditions. Grammar adds
`ChangedField: FeatureName ('=' Expression)?` and an optional `ensures` block after `emits` in Outcome and shorthand
Command. See [maintainer decisions](formal-verification/language-revision.md#L7).

Equality follows declared type: owned entity values and value objects structurally, references by ID, and unions by tag
and fields; list and optional equality compose their element/payload equality. Migrate entity `==`, `unique`, and
`contains` to `.id` forms. Keep exclusions: no recursion in predicates/functions, side effects, external APIs, or
implicit clock; time is an explicit input. There is no compatibility period or old/new syntax coexistence. `dt migrate
domain` must be idempotent, support `--dry-run`, preserve comments/layout, report manual work and use exit codes 0/1/2.
Update grammar, type checker, self-hosted models, examples, `dt guide`, and ADRs together.

The trial teaches agents only by `dt guide`, using a non-shop domain. First syntax/type-check success is a metric;
parsing success alone is not correctness. Repair success means a diagnostic-led repair passes without changing
requirements. Follow the protocol in ADR 0038 style. Run at least 12 independent attempts per arm over two pinned Claude
and Codex families, pin latest versions at trial start and record them, with a three-attempt pilot per arm. Randomize
syntax order and use blind reviewers with a third-reviewer adjudication for disagreements. Improvement is at least +10
percentage points in first-pass parse or type-check rate, or at least 15% fewer repair tokens; regression is at least
-10 points or 15% more tokens. Record syntax/type-check success, semantic correctness, repair count, token use and
repair success. See the [trial protocol](formal-verification/language-revision.md#L296) and
[Level 2 finding](formal-verification/spike/results.md#L61).
Add in Phase 2 a static `dt check` rule for an error declared but no longer used by any `else`
([spike finding](formal-verification/spike/results.md#L66)).

### Phase 3 — `ensures` in TypeScript (done)

**Done.** `ensures` applies to successful `decide` results in TypeScript runtime checks and contract tests (ADRs 0019/0020).
It is the postcondition of a successful transition; these checks define the semantic reference for Phase 4. Delivered by
[#161](https://github.com/hisamekms/domaintrail/pull/161) (postcondition checks), [#162](https://github.com/hisamekms/domaintrail/pull/162)
(state match), [#163](https://github.com/hisamekms/domaintrail/pull/163) (aggregate function parameters),
[#164](https://github.com/hisamekms/domaintrail/pull/164) (T7), and the reference corpus (`test/fixtures/ensures`).

### Phase 4 — TLA+ generator and `dt verify`

Generate deterministic TLA+ and TLC configuration from Semantic IR, plus Apalache annotations. Put the code in a new
formal-verification capability, Java/tool adapters under `adapters/`, and update `test/architecture/map.ts`
([placement](formal-verification/semantic-ir.md#L132)). Profile input ranges, collection maximum, aggregate count,
time values, depth (recursive values default to 2),
timeout, backend, abstractions, assumptions and properties. Supervisor decision (2026-11-28): recursive values use
default depth 2. Bounds are verification scope, not business
constraints; record simulation seeds. Use one parameterized module per aggregate; generate `A_C(p) == A(p) /\ Inv'`
and fixed-input probes. Order definitions by dependency, with `Inv'` last; close every cfg operator reference. Create is
an action from absent state; never bind arguments to fields. Emit aligned bullets, parenthesized quantifiers and `IF`,
`DOMAIN` rather than `1..Len`, Apalache's `keyword`, `\* @type:`, `name` annotation, valid cfg keywords, and judge SANY
by diagnostics. Raw checker exit codes are transport signals, not result classes.

For each fixed input, classify a violation forced across all unspecified output choices as `Counterexample found`; a
violation possible only in the unconstrained run is `Underspecified`, with attribution. Positive existential claims need
a witness in the correct model. A pass of a negated property establishes the result only within scope; report
reachability on the positive claim as specified in
[results-schema.md](formal-verification/results-schema.md#L143-L147), distinguishing "proven unreachable" (no witness
within an exhaustive scope) from "not reached within bound" (a bounded search). Use TLC `-continue` for joint
attribution; every
`U_all` violation must be explained by at least one `only_A` run. Capture output provenance (parameter, assignment,
carry,
unspecified choice) and recover fixed input for forced failures.

Use a separate DSL verification file (for example `sales/order.verify.dt`) with named scopes, selected by
`dt verify --scope`, resolved by `dt check`, and renamed with its model by the LSP. Do not put it in
`domaintrail.jsonc`.
Without a file, defaults are two values per ID type (at least the maximum list length for IDs of entities in lists),
lists up to length two, numeric ranges from declared bounds, Timestamp/date as small integers preserving order,
Decimal scaled by literal digits, strings from literals plus fresh values, unbounded `matches` Unsupported,
verified types as opaque constraint-satisfying values, and events as trace labels rather than state. Always print the
selected scope with results. `dt verify` never fetches tools implicitly. Install pinned versions with sha256 via
`dt tools install` and report status with `dt tools status`; absent tools produce `skipped` with the reason and next
command. Retain `DT_FV_*` overrides; licenses are confirmed and recorded.
Provide `dt verify`, `--aggregate`, `--format json`, `--backend tlc|apalache`, and `--allow-skip`. Check invariants,
`requires` satisfiability, executability, state/outcome reachability, contradictory contracts, unintended deadlock with
intended terminal states excluded, coverage, and vacuity (when `ensures` restricts transitions, a satisfying successor
exists for allowed inputs). When Java is absent, skip Java-dependent checks explicitly. Mark every applicable item
skipped. Use the common versioned
output schema. Exit 0 includes `noCounterexample`; `--allow-skip` makes skips exit 0 only when no other failure exists.
Exit 1 is static content errors or formal counterexample/underspecified/inconclusive/unsupported; 2 is verification
skipped; 3 is SYNTAX, unreadable files, usage/configuration/I/O/translation/checker errors, or any result class `error`.
See [schema exit codes](formal-verification/results-schema.md#L295). Add F001–F008; the corrected code pattern admits K
and G as well as F ([code rule](formal-verification/results-schema.md#L123)).

### Phase 5 — AI diagnostics and source map

Translate output into model names, locations, arguments, before/after states, history from creation, assumptions,
bounds, unformalized contracts and candidate causes with uncertainty labels. Preserve raw output for investigation. Keep
a source map from generated declarations to DomainTrail declarations so AI edits DomainTrail, not TLA+. Detect
invariants removed or relaxed; `requires` made too strong; commands or outcomes made unexecutable; scope reduced,
abstractions or assumptions added, or items excluded; formal constraints turned into natural-language constraints; and
lower level or coverage. Show the diff and impact even when judgment is uncertain.

### Phase 6 — Live View

Show level, per-property results, coverage, traces, state diffs, bounds, assumptions and revision diffs. Bind results to
model revision and profile; never show stale results as current. Include skipped results. Make traces readable without
TLA+ knowledge and explain them as business problems.

### Phase 7 — Level 4

After single-aggregate verification stabilizes, model multiple aggregates, events, ADR 0022 policies, eventual
consistency, duplicate/reordered messages, concurrency, failures, safety, liveness and fairness. State delivery and
failure assumptions outside the domain model in the profile/environment model. Use TLA+ temporal logic and fairness, and
preserve existing single-aggregate semantics. Symmetry sets are unsound for liveness and Apalache has no symmetry
support. Record this limitation for Phase 7.

### Release

Release after all phases. Changelog includes breaking changes and migration map.

## Test strategy

Check deterministic generation, SANY syntax, source correspondence and Unsupported diagnostics. Compare TypeScript and
TLC on entities, value objects, unions, optionals, lists, unique, quantifiers, Decimal and date/time; use property-based
tests where useful. Cover seeded Phase 0 mistakes, contradictory ensures/vacuity, underspecification and valid
contracts. Test no-Java behavior in a CI job, with `--allow-skip` making skips exit 0. Keep unformalized, unsupported,
unverified and skipped distinct; test mixed levels and profile/revision freshness. AI repairs must preserve
requirements, avoid unnecessary invariant weakening, keep commands executable and scope intact, and never edit generated
files.

## Non-goals

Quint; all TLA+ features; general-purpose programming or business logic generation; a custom model checker (TLA+
translation and result translation are in scope); formal verification without Java (report skipped); requiring full
formalization or proving all implementation code; TLAPS (consider separately).

## Initial coding-agent deliverables — Phase 0 brief (historical)

Phase 0 only, syntax and generated code unchanged: mapping; handwritten spec and checker results; seeded-error table and
translated trace; source-map proposal; acquisition/version/license/checksum/Java/timing/no-Java behavior; backend
recommendation; Semantic IR proposal; Phase 2 syntax/AI trial plan; proposal for the common schema, diagnostic codes and
exit codes; later-phase review and ADR drafts. Any semantic proposal states need, alternatives and impact. The final
criterion is whether AI and people can build more accurate, trustworthy domain models, formalized step by step at the
granularity needed.

## Decisions for the maintainer

Recommendations are Phase 0 judgments; the final column records decisions, with dates stated in each decision where
relevant.

| Decision | Recommendation | Confidence | Decision |
|---|---|---|---|
| Formal backend/tools | TLA+, default TLC, optional Apalache, Java optional. | high | Adopted as recommended. |
| Published IR compatibility | Set compatibility policy before external use; publish through Modeling `.dt`. | medium | Internal during the beta, no compatibility promise; the IR carries a version number; semver policy decided at 1.0. |
| Stable IDs for variants | Preserve source identity in IR; decide stable IDs before variants are external property identities. | medium | Stable IDs for union variants and their fields in Phase 1, same scheme as the new IDs; separator decided in Phase 1. |
| External and natural-language obligations | Represent explicitly as non-executable obligations. | high | Adopted as recommended. |
| Recursive values and tagged optionals equality | Structural equality by declared type; define recursive-value and tagged-optional details before implementation. | medium | Deep structural equality for recursive value objects; optionals: both absent equal, both present compare contents, one absent unequal; optional vs non-optional `==` allowed; TLA+ depth bounded by the profile (default 2, supervisor decision). |
| Profile shape and type encodings | Decide Timestamp unit/range, date/time encoding, Decimal scale, string domains, `matches` on unbounded domains, verified-type slot semantics, and event treatment under ADR 0018 ([mapping](formal-verification/mapping.md#L65), [unbounded `matches`](formal-verification/mapping.md#L48), [verified types](formal-verification/mapping.md#L104), [events](formal-verification/mapping.md#L99)). | no recommendation yet; low | A separate verification file in DSL syntax (e.g. `sales/order.verify.dt`) with named scopes (`dt verify --scope`), resolved by `dt check` and renamed with the model; without it, defaults derived from the model; the scope used is printed with every result; encodings as in Phase 4. |
| Checker distribution/licensing | Decide distribution and license policy; Phase 0 did not record checker licenses. | no recommendation yet; low | Explicit `dt tools install` / `dt tools status` with pinned versions and sha256; no npm postinstall and no implicit fetch in `dt verify` (missing tools: `skipped` with the next command); `DT_FV_*` overrides; licenses confirmed and recorded in Phase 4. |
| AI trial size | At least 12 attempts per arm across two pinned model families; confirm model versions and feasibility. | medium | At least 12 attempts per arm; Claude and Codex families pinned to the latest versions at the trial start and recorded; a 3-attempt pilot per arm first. |
| Trial arms and run count (supervisor decision, 2026-11-28) | Compare match forms and quantifier names against the adopted defaults. | medium | Four arms per task packet: A0 adopted match with `every`/`some`; M2 TC39 match with `every`/`some`; M3 ts-pattern-like match with `every`/`some`; Q2 `forall`/`exists` with A0 match. M2/M3/Q2 each compare pairwise with A0 and share A0 attempts; 12 attempts per arm per packet, six Claude and six Codex; main run 4 × 12 × packets (192 for four packets). |
| Trial decision rule (supervisor decision, 2026-11-28) | Compare success rates, repair tokens and semantic correctness. | medium | Improvement: +10 points on first syntax/type-check success or −15% repair tokens; regression: −10 points on either rate or +15% repair tokens. Beat A0 only with an improvement, no regression, at least two packets, and no reversal in either model family; semantic pass rate ≥10 points below A0 vetoes; no winner keeps A0. |
| Mixed Int/Decimal arithmetic (supervisor decision, 2026-11-28) | Define mixed numeric operations before freeze. | medium | Promote Int to Decimal; result is Decimal. |
| F-code assignment | Assign F001–F008 in the schema rule-code row. | high | Adopted as recommended. |
| Integration | `feat/formal-verification`, each phase merged by PR, then one merge to `main`. | high | Adopted as recommended. |
| Language surface forms | Adopt JS-oriented forms after the paired trial; selected forms are `every`/`some`, `includes`, `.length`, `.matches()`. | medium | TS-like syntax with TS strict null safety (`T?`, `?.`, `??`, narrowing by `!= null`) and an exhaustive `match`; `==` by declared type, `===` and mutating methods rejected; the trial compares only the `match` form, quantifier names and lambda. |
| Int/Decimal arithmetic and division | Start with Int `+`, `-`, `*`, no Int `/`; define `div` rounding, division by zero, Decimal scale/rounding, and domain-primitive result rules before freeze. | low | Int `+ - *` (no Int `/`); Decimal `+ - * /` with declared scale and half-even rounding; division-by-zero diagnostic; domain-primitive results re-validated where assigned. |
| `ensures` grammar, scope, diagnostics, creation | Put after `changes`/`emits`; scope creation to parameters and `after`; define kept-field diagnostics and create construction. | medium | Design D: `changes x` (unspecified) or `changes x = expr` (determined; right-hand side in the `ensures` scope); unlisted fields unchanged; `ensures` only for relations, a lone equality diagnosed; create and new target fields set by `changes x = expr` (non-optional listed, unlisted optional `null`; amends ADR 0019). |
| List literals, append, `sum`, trial task (b) | Trial list literals/append or concatenation and `sum`; remove task (b) if `sum` is not adopted. | low | Literals `[]` `[a, b]`, spread `[...xs, x]`, `.map`, `.filter`, `.sum`; task (b) kept as a `.sum` task in the trial domain. |
| Pure predicates | Defer user-defined pure predicates unless trial evidence supports including them. | low | Adopted in this revision: typed, expression-bodied predicates and functions, no recursion or call cycles. |
| `dt migrate domain` reporting | Preserve comments/layout, be idempotent, support `--dry-run`, report manual work, and use exit codes 0/1/2. | high | Adopted as recommended. |
| Trial model versions | Use two pinned model families; exact versions and pilot size remain maintainer choices. | low | Claude and Codex, pinned to the latest at the trial start and recorded; 3-attempt pilot per arm. |
| Schema v2 acceptance | Adopt the shared v2 schema proposal. | high | Adopted as recommended. |
| Breaking exit-code acceptance | Adopt shared codes, including breaking `dt check` changes. | high | Adopted as recommended. |
| Verification classification and claims | Forced vs unconstrained-only underspecification; positive claims need a correct-model witness; negated passes hold only within scope. | high | Adopted as recommended. |
| Tool paths and run budget | Pin checksums, support `DT_FV_*`, use per-aggregate matrix, keep Java optional; runtime scales by profile. | high | Adopted as recommended. |
| Null safety and `match` (new) | — | — | Adopted with the surface syntax (see Language surface forms). |
| `===` and mutating methods (new) | — | — | Rejected with diagnostics; all values immutable. |
| Verification file and named scopes (new) | — | — | See Profile shape and type encodings. |

## Open questions

**Added beyond the Japanese plan:** the spike settled seeded detection and stop criteria. Phase 4 implements profile
defaults, scopes, tool installation, licenses, and no-Java evidence. Phase 2 trials match/quantifier spellings and
confirms lambda syntax. Mapping edge cases, detailed level rules, and
`ensures` over event payloads remain open. Later phases may be reordered based on evidence.

Checker bug found in Phase 1 step 2 (separate task, outside Phase 1 because it changes what the checker accepts): a
lambda that rebinds a name keeps the guarded paths that start with that name, so
`all(vs, x => exists(x.o) implies all(vs, x => x.o > 0))` reports no M009 for the inner, unguarded `x.o`. The fix drops
the guarded paths of a name when a lambda rebinds it.
