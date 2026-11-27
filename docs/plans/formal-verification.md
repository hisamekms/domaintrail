# Plan: formal verification with TLA+

Status: proposed; Phase 0 is the current work. Input: `main` at `4d8a2ed`.

This file replaces the maintainer's Japanese integration plan in the repository. TLA+ is generated directly from
DomainTrail; Quint is not used. TLC is the candidate default. Apalache is optional. Java is optional: without Java,
`dt verify` reports `skipped` and runs only `dt check`. DomainTrail is beta, so breaking changes are allowed.
Release happens after every phase is complete. Intermediate phases need not deliver user value. Amount of code change is
not a decision criterion.

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
checked the expression model and checker,
tree-sitter grammar, generation capability, `examples/shop`, and ADRs 0014, 0016–0020, 0022–0023, and 0035–0038.
(the Japanese plan does not list ADR 0021).

Inspection targets are `contexts/modeling/model/expressions.dt`,
`contexts/modeling/src/domain/rules/expressions.ts`, `tree-sitter-domaintrail/grammar.js`, `capabilities/generation/`,
`examples/shop/` (configured by `domaintrail.jsonc`), and the ADRs above. At the input commit (`origin/main` 4d8a2ed),
`ExprModel` is syntax only and readers resolve names. The expression language has no arithmetic or conditional node;
it has logic, comparisons, `range`, `count`, `exists`, `length`, `matches`, `unique`, `contains` and `all`/`any`
quantification. `requires` may omit its expression and keep only a natural-language label; `changes` identifies
permitted fields but not their new values, which come from decision `set`. Decimal is a branded TypeScript string; time
types are in ADR 0038.
Node is 22.13 or later. The primitive list includes UUID and TimeZone. The Japanese plan's “List と Set” has no Set
type at this commit; this correction is recorded here. Code and accepted ADRs take precedence over conflicts with the
Japanese plan. Proposed syntax, CLI, settings and diagnostics are candidates, not current behavior.

## Principles

- DomainTrail is the single source of truth. Generate TLA+ deterministically from model and profile, maintain a source
  map, and do not expect people or AI to edit generated TLA+. TLA+ output is a backend artifact; changing surface syntax
  must not require changes to generators.
- Introduce a Semantic IR resolving types, names, equality, optional narrowing and scope. Both TypeScript and TLA+
  generators consume it. Keep backends replaceable behind the IR.
- Generators must not infer or duplicate semantics. Handwritten TLA+ is only for comparison in the PoC.
- Keep syntax familiar to TS/JS developers, with one canonical spelling per meaning. Syntax follows TS/JS conventions,
  not the backend language. Evaluate correctness, clarity, repairability and token use with AI trials.
- Preserve “Structure and Contracts”; procedural business logic and a general-purpose programming language are out
  of scope. Formalization depth follows business understanding and risk.
- `dt check`, generation and Live View work without Java. Without Java or a checker, `dt verify` reports skipped,
  never success. CI can fail on skip.
- Never silently omit an untranslatable feature; explain approximation direction and impact.

## Formalization levels

| Level | Content | Properties and scope | Tool |
|---|---|---|---|
| 1 — Structure | Structure, types, states, transitions | Type/reference consistency and transition-graph reachability | `dt check` |
| 2 — Constraints | requires, invariant, changes | Satisfiability, executability, creation violations, violations from unspecified changes | `dt verify` |
| 3 — Behavioral Contracts | Postconditions (`ensures`) | Preconditions/postconditions consistency and invariant preservation by contract-compliant transitions | `dt verify` |
| 4 — System Properties | Multiple aggregates, events, policies and temporal properties | Cross-aggregate consistency, safety, liveness, concurrency and delivery | Later phase |

At Level 2, create commands, `changes`-only fields and target-only fields can introduce values not determined by
parameters or expressions. Those values are nondeterministic within their type. A constrained type can make a check
vacuous; an unconstrained type can yield a counterexample. The useful Level 2 checks are mainly satisfiability,
executability and creation invariants. Classify traces from unspecified values as `Underspecified`, distinct from
implementation mistakes. For example, `distinctSkus` failing at creation on nondeterministic `items` is
underspecification. Seed the
creation-invariant mistake with a violation forced by supplied creation values, or otherwise label a seeded concrete
defect, so it can be distinguished from that case.

Do not require a `level: 3` annotation. Track formalization per aggregate, command and outcome; the displayed level is
a summary of this per-unit breakdown. A few postconditions do not raise the level of the whole aggregate. Distinguish
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

Phase 0 evaluates TLC as the candidate default: exhaustive exploration of a finitized single aggregate, complete
within that scope, with optional random `-simulate`. Apalache is optional for symbolic bounded exploration and
inductive invariant checking. The generator must emit Apalache type annotations.

## Results

Report per property: `Verified` (method and scope attached), `No counterexample found` (bounded or simulated),
`Counterexample found` (a trace from creation, the initial state), `Underspecified` (unspecified
create/target-only/change
values or expression-free requires), `Inconclusive` (timeout or resource limit), `Unsupported`, `Skipped` (Java or
checker
absent; reason “backend unavailable”), or `Error`. Raw checker output is evidence, not the official interface.

Partial success must never look like full success. **The following exit-code table is added beyond the Japanese plan,
which only requires the four outcomes to be distinguished:**

| Exit code | Meaning | `check` / `verify` interpretation |
|---|---|---|
| 0 | All applicable checks succeeded | No errors, counterexamples or skips; bounded results remain explicitly qualified |
| 1 | Counterexample found or non-success result | At least one applicable check failed, was inconclusive, unsupported, or Underspecified |
| 2 | Skipped | At least one required check was skipped; `--allow-skip` makes skips exit 0 |
| 3 | Error | Parsing, translation, checker or execution error |

This one table is shared by `check` and `verify`; when outcomes are mixed, error takes precedence, then failed check,
then skip. Details and partial outcomes remain in the versioned result schema.

## Translation candidates

See the [Phase 0 mapping](formal-verification/mapping.md). Int and Decimal use profile-finite domains; choose Decimal
scale at least as large as maximum literal precision. Strings and UUIDs use finite profile domains; `length` and
`matches` are precomputed there, otherwise Unsupported. Temporal types use finite integer/rank domains. Value objects
and unions are records; optionals are tagged values; lists are sequences. There is no Set type in this commit, which
corrects “List と Set” in the Japanese plan. Expression-free requires, external/declared outcome selection, create
values and target-only fields are nondeterministic abstractions. Checked invariants are not guards.

## Phases

Phases are delivery stages; levels are formalization granularity.

### Phase 0 — decision spike

Using current syntax: (1) complete the mapping; (2) hand-write TLA+ for `examples/shop` Order and check with TLC and
optionally Apalache; (3) seed five mistakes: missing requires, creation invariant violation, transition invariant
violation, unexecutable command, unreachable state; (4) map traces to commands, arguments and before/after states; name
the formats as TLC trace output and
Apalache ITF JSON;
(5) record acquisition, version, license, checksums, Java, startup/check duration and no-Java behavior; (6) recommend
checker roles. The creation seed must be distinguishable from an `Underspecified` trace such as `distinctSkus` failing
on nondeterministic `items`.

Tools started for version/help output only on Temurin 27.0.1.1+4. Java is provisionally pinned, subject to Phase 0
confirmation; compatibility beyond that is unconfirmed:

| Tool | Artifact | SHA-256 |
|---|---|---|
| TLC 1.7.4 (latest stable) | [tla2tools.jar](https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar) | `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88` |
| TLC 1.8.0 (pre-release, 2026-11-26) | [tla2tools.jar](https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar) | `67f9575c3b9ef7a0787b1bded34812862ffe79d711298e5a75b1a77720b19928` |
| Apalache 0.63.0 | [apalache-0.63.0.tgz](https://github.com/apalache-mc/apalache/releases/download/v0.63.0/apalache-0.63.0.tgz) | `a756e96af249bf33cd7629667a49472cb26ac8227c48583da139b414834d59df` (matches release `sha256sum.txt`) |

Completion requires a classified mapping, detection table, translated counterexample and checker recommendations.
**Added stop criteria (beyond the Japanese plan):** review if TLC detects fewer than four seeded mistake kinds. Also
review if checking the handwritten Order spec exceeds one minute. Exclude JVM startup; record it separately, and record
the profile values used (number of IDs, maximum items and input ranges) with the timing. Review source mapping if traces
cannot be mapped to commands, arguments and before/after states.

### Phase 1 — Semantic IR

Add resolved names/types, equality (entity by ID, value object structurally, union by tag and fields), optional
narrowing, and state/kind/command scope. Port TypeScript and contract-test generators. Require generated output to
match pre-port regression output.

### Phase 2 — one breaking language revision

Add arithmetic (`+ - * /`) and conditional expressions; method-form collection calls; rename optional existence
checking because `exists(value)` is confused with collection quantification; add `ensures` and compare `before.x` with
`old(x)`; add pure predicates if needed. Compare `forall`/`exists` with `every`/`some` for quantifier names. Define
`ensures` reference scope and types for creation, outcomes, state/kind-specific fields, arguments, event payloads and
optionals; align it with `changes` and detect contradictory postconditions. Exclude recursion, side effects, external
APIs and implicit clocks; time is an explicit input. Implement syntax rewriting as a `dt migrate` rewrite, without
compatibility period or old/new syntax coexistence. Update grammar, type checker, self-hosted models, examples,
`dt guide` and ADRs together. Compare AI trials using the ADR 0038-style trial (an agent taught only by `dt guide`);
measure first syntax-check success, first type-check success, semantic correctness, repair count, token use and repair
success from diagnostics. Parsing success alone is not correctness: independently test/review fit to business
requirements.

### Phase 3 — `ensures` in TypeScript

Apply ensures to decision results in runtime checks and contract tests (ADRs 0019/0020). `ensures` is the postcondition
of a successful transition. Compare TLA+ evaluation in Phase 4.

### Phase 4 — TLA+ generator and `dt verify`

Generate deterministic TLA+ and TLC configuration from Semantic IR, plus Apalache annotations. Profile input ranges,
collection maximum, aggregate count, time values, depth, timeout, backend, abstractions, assumptions and properties.
Bounds are not business constraints; record simulation seeds. Provide `dt verify`, `--aggregate`, `--format json`,
`--backend tlc|apalache`, and `--allow-skip`. Check invariants, requires satisfiability, executability, state/outcome
reachability,
contradictory contracts, unintended deadlock and coverage. Distinguish “proven unreachable” from “not reached within
scope.” When ensures restrict transitions, check that a next state satisfying `ensures` exists for allowed inputs to
prevent vacuity. Exclude intended terminal states from
deadlock findings. Without Java, mark every item skipped. Use the common versioned output schema.

### Phase 5 — AI diagnostics and source map

Translate output into model names, locations, arguments, before/after states, history from creation, assumptions,
bounds, unformalized contracts and candidate causes with uncertainty labels. Preserve raw output for investigation.
Keep a source map from generated declarations to DomainTrail declarations so AI edits DomainTrail, not TLA+. Detect
invariants removed or relaxed; `requires` made too strong; commands or outcomes made unexecutable; scope reduced,
abstractions or assumptions added, or items excluded; formal constraints turned into natural-language constraints;
and lower level or coverage. Show the diff and impact even when judgment is uncertain.

### Phase 6 — Live View

Show level, per-property results, coverage, traces, state diffs, bounds, assumptions and revision diffs. Bind results to
model revision and profile; never show stale results as current. Include skipped results. Make traces readable without
TLA+ knowledge and explain them as business problems.

### Phase 7 — Level 4

After single-aggregate verification stabilizes, model multiple aggregates, events, ADR 0022 policies, eventual
consistency, duplicate/reordered messages, concurrency, failures, safety, liveness and fairness. State delivery and
failure assumptions outside the domain model in the profile/environment model. Use TLA+ temporal logic and fairness,
and preserve existing single-aggregate semantics. Symmetry sets are unsound for liveness and Apalache has no symmetry
support. Record this limitation for Phase 7.

### Release

Release after all phases. Changelog includes breaking changes and migration map.

## Test strategy

Check deterministic generation, SANY syntax, source correspondence and Unsupported diagnostics. Compare TypeScript and
TLC on entities, value objects, unions, optionals, lists, unique, quantifiers, Decimal and date/time; use property-based
tests where useful. Cover seeded Phase 0 mistakes, contradictory ensures/vacuity, underspecification and valid
contracts.
Test no-Java behavior in a CI job, with `--allow-skip` making skips exit 0. Keep unformalized, unsupported,
unverified and skipped distinct; test mixed levels and profile/revision freshness. AI repairs must preserve
requirements,
avoid unnecessary invariant weakening, keep commands executable and scope intact, and never edit generated files.

## Non-goals

Quint; all TLA+ features; general-purpose programming or business logic generation; a custom model checker (TLA+
translation and result translation are in scope); formal verification without Java (report skipped); requiring full
formalization or proving all implementation code; TLAPS
(consider separately).

## Initial coding-agent deliverables

Phase 0 only, syntax and generated code unchanged: mapping; handwritten spec and checker results; seeded-error table and
translated trace; source-map proposal; acquisition/version/license/checksum/Java/timing/no-Java behavior; backend
recommendation; Semantic IR proposal; Phase 2 syntax/AI trial plan; proposal for the common schema, diagnostic codes and
exit codes; later-phase review and ADR drafts. Any semantic proposal states need, alternatives and impact. The final
criterion is whether AI and people can build more accurate, trustworthy domain models, formalized step by step at the
granularity needed.

## Open questions

**Added beyond the Japanese plan:** the spike must settle mapping edge cases, detailed level rules, profile shape,
result schema, checker distribution and TLC/Apalache split. Phase 2 selects canonical syntax by AI trials. Later phases
may be reordered based on evidence.
