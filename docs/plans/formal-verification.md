# Plan: formal verification with TLA+

Status: Phase 0 done; Phases 1–7 proposed. Input: `main` at `4d8a2ed`. Integration branch: `feat/formal-verification`;
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
- Keep syntax familiar to TS/JS developers, with one canonical spelling per meaning. Syntax follows TS/JS conventions,
  not the backend language. Evaluate correctness, clarity, repairability and token use with AI trials.
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
  -> TLA+ generator <- verification profile (domaintrail.jsonc)
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
requirements, and outcomes; decide variant identity before using variants as external property identities. The checker
becomes the IR builder, producing expression, lifecycle, and structure facts with diagnostics. Optional narrowing
reproduces only the true-edge rule. Equality is selected by declared type: owned entity values and value objects
structurally, references by ID, and unions by tag and fields. The visualization Graph IR remains on the Typed Model. See
the [IR design](formal-verification/semantic-ir.md#L3) and [Phase 1 boundary](formal-verification/semantic-ir.md#L146).

Migrate consumers in this order: (1) capture current generated TypeScript, Live View, and checker baselines; compare
with existing snapshots and hashes after `withoutVersion` masking, including self-hosted generated output; (2) move
checker semantics into the IR builder while preserving diagnostics and source ranges; (3) migrate the TypeScript
generator to IR references, types, equality, optional narrowing, applicability, and recursive finite-value facts, then
remove duplicated type/name/member/lifecycle/cycle computation; (4) migrate contract-test generation to IR. Regressions
require baseline-equivalent generated files, stable checker contracts, and no self-hosted generated diff. Phase 1 ends
at step 4. Details are in the [IR migration steps](formal-verification/semantic-ir.md#L128).

### Phase 2 — one breaking language revision

Adopt arithmetic `+`, `-`, `*` and conditional `?:`; use `x != null` for optional presence and `!(p) || q` instead of
`implies`, and the `null` keyword. Adopt method-form collection calls and selected names `every`/`some`, `includes`,
`.length`, and `.matches()` ([recommended surface forms](formal-verification/language-revision.md#L78-L90)). Put
`ensures`
after `changes`/`emits`, using `before.x` and `after.x`. Its scope includes parameters and `after` fields only for
creation; define named outcomes, state- and kind-specific fields, optionals, and how create constructs
values. Diagnose kept fields consistently. Detect contradictory postconditions. Pure user-defined predicates remain
deferred if needed; see the corresponding decision row.

Equality follows declared type: owned entity values and value objects structurally, references by ID, and unions by tag
and fields; list and optional equality compose their element/payload equality. Migrate entity `==`, `unique`, and
`contains` to `.id` forms. Align `ensures` with `changes` using carried/kept/new/dropped diagnostics. Keep exclusions:
no recursion, side effects, external APIs, or implicit clock; time is an explicit input. There is no compatibility
period
or old/new syntax coexistence. `dt migrate domain` must be idempotent, support `--dry-run`, preserve comments/layout,
report manual work and use exit codes 0/1/2. Update grammar, type checker, self-hosted models, examples, `dt guide`, and
ADRs together. The trial teaches agents only by `dt guide`, in ADR 0038 style, using a domain other than shop. Run at
least 12 independent attempts per arm over two pinned model families, randomize syntax order, and use blind reviewers
with a third-reviewer adjudication for disagreements. Improvement is at least +10 percentage points in first-pass parse
or type-check rate, or at least 15% fewer repair tokens; regression is at least -10 points or 15% more tokens. Record
first syntax-check success, first type-check success, semantic correctness, repair count, token use, and repair success
from diagnostics. Parsing success alone is not correctness. See the [recommended
revision](formal-verification/language-revision.md#L73),
[trial protocol](formal-verification/language-revision.md#L250), and [Level 2
finding](formal-verification/spike/results.md#L61).
Add in Phase 2 a static `dt check` rule for an error declared but no longer used by any `else`
([spike finding](formal-verification/spike/results.md#L66)).

### Phase 3 — `ensures` in TypeScript

Apply `ensures` to successful `decide` results in TypeScript runtime checks and contract tests (ADRs 0019/0020).
`ensures` is the postcondition of a successful transition. These checks define the semantic reference for Phase 4;
cross-backend examples must agree.

### Phase 4 — TLA+ generator and `dt verify`

Generate deterministic TLA+ and TLC configuration from Semantic IR, plus Apalache annotations. Put the code in a new
formal-verification capability, Java/tool adapters under `adapters/`, and update `test/architecture/map.ts`
([placement](formal-verification/semantic-ir.md#L123)). Profile input ranges, collection maximum, aggregate count,
time values, depth, timeout, backend, abstractions, assumptions and properties. Bounds are verification scope, not
business
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

Acquire tools with pinned checksums, expose `DT_FV_*` overrides, and account for checker licenses and no-Java behavior.
Provide `dt verify`, `--aggregate`, `--format json`, `--backend tlc|apalache`, and `--allow-skip`. Check invariants,
`requires` satisfiability, executability, state/outcome reachability, contradictory contracts, unintended deadlock with
intended terminal states excluded, coverage, and vacuity (when `ensures` restricts transitions, a satisfying successor
exists for allowed inputs). Without Java, mark every item skipped. Use the common versioned
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

Recommendations are Phase 0 judgments, not accepted decisions.

| Decision | Recommendation | Confidence |
|---|---|---|
| Formal backend/tools | TLA+, default TLC, optional Apalache, Java optional. | high |
| Published IR compatibility | Set compatibility policy before external use; publish through Modeling `.dt`. | medium |
| Stable IDs for variants | Preserve source identity in IR; decide stable IDs before variants are external property identities. | medium |
| External and natural-language obligations | Represent explicitly as non-executable obligations. | high |
| Recursive values and tagged optionals equality | Structural equality by declared type; define recursive-value and tagged-optional details before implementation. | medium |
| Profile shape and type encodings | Decide Timestamp unit/range, date/time encoding, Decimal scale, string domains, `matches` on unbounded domains, verified-type slot semantics, and event treatment under ADR 0018 ([mapping](formal-verification/mapping.md#L65), [unbounded `matches`](formal-verification/mapping.md#L48), [verified types](formal-verification/mapping.md#L104), [events](formal-verification/mapping.md#L99)). | no recommendation yet; low |
| Checker distribution/licensing | Decide distribution and license policy; Phase 0 did not record checker licenses. | no recommendation yet; low |
| AI trial size | At least 12 attempts per arm across two pinned model families; confirm model versions and feasibility. | medium |
| F-code assignment | Assign F001–F008 in the schema rule-code row. | high |
| Integration | `feat/formal-verification`, each phase merged by PR, then one merge to `main`. | high |
| Language surface forms | Adopt JS-oriented forms after the paired trial; selected forms are `every`/`some`, `includes`, `.length`, `.matches()`. | medium |
| Int/Decimal arithmetic and division | Start with Int `+`, `-`, `*`, no Int `/`; define `div` rounding, division by zero, Decimal scale/rounding, and domain-primitive result rules before freeze. | low |
| `ensures` grammar, scope, diagnostics, creation | Put after `changes`/`emits`; scope creation to parameters and `after`; define kept-field diagnostics and create construction. | medium |
| List literals, append, `sum`, trial task (b) | Trial list literals/append or concatenation and `sum`; remove task (b) if `sum` is not adopted. | low |
| Pure predicates | Defer user-defined pure predicates unless trial evidence supports including them. | low |
| `dt migrate domain` reporting | Preserve comments/layout, be idempotent, support `--dry-run`, report manual work, and use exit codes 0/1/2. | high |
| Trial model versions | Use two pinned model families; exact versions and pilot size remain maintainer choices. | low |
| Schema v2 acceptance | Adopt the shared v2 schema proposal. | high |
| Breaking exit-code acceptance | Adopt shared codes, including breaking `dt check` changes. | high |
| Verification classification and claims | Forced vs unconstrained-only underspecification; positive claims need a correct-model witness; negated passes hold only within scope. | high |
| Tool paths and run budget | Pin checksums, support `DT_FV_*`, use per-aggregate matrix, keep Java optional; runtime scales by profile. | high |

## Open questions

**Added beyond the Japanese plan:** the spike settled seeded detection and stop criteria. Phase 4 still needs checker
licenses, no-Java behavior evidence, profile shape and type encodings, and checker distribution. Phase 2 selects
canonical
syntax by AI trials. Mapping edge cases and detailed level rules remain open because Phase 0 did not settle them.
`ensures` over event payloads remains open. Later phases may be reordered based on evidence.
