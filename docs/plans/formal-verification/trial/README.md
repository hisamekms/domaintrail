# Phase 2 AI syntax trial packet

This packet operationalizes section 5 of [language-revision.md](../language-revision.md) and Phase 2 of
[formal-verification.md](../../formal-verification.md). Semantic decisions there remain authoritative. This protocol
restates the trial arms, counts, and decision rule fixed by supervisor decision (2026-11-28).

## Protocol

1. Freeze and record the prototype build hash, `dt guide` template version, task packet versions, hidden acceptance
   matrices, scenario inputs, and scoring rubric. Do not use shop examples as task material.
2. Use exactly four arms per task packet:
   - **A0:** `match (x) { Variant { fields } => e, … }` with `every`/`some`; minimal example:
     `match (shift) { Staffed { hours } => hours, Open { hours } => hours }`.
   - **M2:** TC39 `proposal-pattern-matching` README, current `main` revision as of 2026-11-28, form
     `when <pattern>: <expr>;`; minimal example:
     `match (shift) { when { kind: Shift.Staffed, hours }: hours; when { kind: Shift.Open, hours }: hours; }`.
   - **M3:** ts-pattern-like method form with `every`/`some`; minimal example:
     `match(shift).with({ kind: Shift.Staffed }, s => s.hours).with({ kind: Shift.Open }, s => s.hours).exhaustive()`.
     Each handler parameter is narrowed to its matched variant; handlers do not destructure parameters.
   - **Q2:** `forall`/`exists` with the A0 `match` form (the A0 example above).
   A0's form is the adopted form and the form in language-revision.md §2. M2/M3 vary only match spelling; Q2 varies
   only quantifier names. Every arm holds the other dimension at its A0 default: M2 and M3 use `every`/`some`; Q2
   uses A0 match; A0 uses both defaults. Tags identify the same variants in every arm: A0 uses bare variant
   constructors (`Staffed { … }`), M2 puts the qualified tag value in the `kind` property (`kind: Shift.Staffed`),
   and M3 puts that same qualified tag value in the matched object (`{ kind: Shift.Staffed }`). Lambda syntax
   `x => …` is identical in every arm. Publish these exact spellings and grammar in the run manifest before the pilot.
3. Pin and record the latest Claude and Codex model identifiers available at trial start, including provider version
   or snapshot, date, and inference settings. Use six attempts per family for each arm and task packet; keep the same
   pinned model mix in pilot and main run. Assign each attempt to one model and one task. Use clean independent
   sessions, with no outputs or feedback carried between attempts.
4. Run a three-attempt-per-arm pilot. Check instructions, logging, variant isolation, and scoring operations; do not use
   pilot observations to claim a winner. Version changed protocol/task wording and rerun the pilot before the main run.
5. Run 12 independent attempts per arm per task packet (six Claude and six Codex). Randomize arm and task order within
   model blocks. Each task packet is one attempt. Keep text, budgets, tools, and diagnostic access identical. Record
   exhaustion. For four packets, the main run is 4 arms × 12 attempts × 4 packets = 192 executions; pilot executions
   are 3 attempts × 4 arms × 4 packets = 48.
6. Give the agent only the task's business requirements and that arm's `dt guide`; provide no examples, source models,
   reference solutions, checklists, scenarios, acceptance matrices, other-arm guide, or hints in field or command names.
   Use the same prompt wrapper and archive its exact text. Permit only the documented parser/type-checker repair loop;
   retain every submitted model, diagnostic, and repair.
7. Blindly map each scenario to that attempt's generated TypeScript contract tests, without seeing the arm or model
   identity; record the mapping and outcomes in the result. Measure and record:
   - First syntax-check success and first type-check success as 1/0.
   - Semantic correctness as `pass`, `fail`, or `uncertain`, from normalized Typed Model or Semantic IR facts against
     the hidden checklist and then scenario results; never infer it from syntax or token counts.
   - Repair count: diagnostic-driven edit cycles before passing or exhaustion; one changed submission after one or more
     diagnostics is one cycle.
   - Input/output tokens separately for first submission and repairs; compare only within the same model and task.
   - Repair success from diagnostics as 1/0, or `null` when no repair was needed.
8. Blind two reviewers to arm, model identity, and token counts. Provide randomly labelled normalized dumps, scenario
   outcomes, and hidden checklist. Strip source text, source maps, spans, and comments from normalized dumps. Reviewers
   record verdict and item rationale independently. A third reviewer adjudicates every disagreement; retain all
   verdicts. Report agreement, disagreement count, and adjudicated outcomes.
9. Compare M2 vs A0, M3 vs A0, and Q2 vs A0 pairwise, sharing A0's attempts. Pair within task packet and model where
   available. Report denominators, missing/exhausted runs, paired differences, uncertainty intervals, and model/task
   breakdowns. If no arm meets the decision rule, A0 remains adopted.
10. **Decision rule:** for each task packet, pool both model families for syntax-check and type-check rates (12
    attempts per arm against 12); check each family separately only to confirm the direction is not reversed.
    Compare repair tokens within each family. An improvement is at least +10 percentage points in first syntax-check
    success or first type-check success, or at least 15% fewer repair tokens. A regression is at least
    −10 percentage points on either rate, or at least 15% more repair tokens. An arm beats A0 if it improves at least
    one metric with no regression on any metric, in at least two task packets, and the result does not reverse in either
    model family. An adjudicated semantic pass rate at least 10 percentage points below A0 vetoes the win. No winner
    means A0 stays adopted. Report the pilot/main counts, four packets, attempts per arm, both model families, three
    pairwise comparisons, and total executions.

## Guide template rule

Generate every arm's `dt guide` from one version-controlled template and the same guide generator/build. Parameterize
only the exact spelling productions and examples demonstrating match or quantifier forms. Keep all other guide content
identical. Diff rendered guides before each run; reject differences outside the allowed sections. Record template
version, guide version, generated guide hash, and allowlisted diff for each arm. Only the match reference/example (M2,
M3) and quantifier reference/example (Q2), plus a summary that repeats those spellings, may differ.

## Packet inventory

- [Tasks and scoring packets](tasks.md): four workforce scheduling tasks with requirements, normalized semantic
  checklists, and executable scenario cases.
- [Result record schema](result-schema.json): JSON Schema for one attempt.
- `results.csv`: one-row-per-attempt reporting template; preserve nested reviewer details in JSON records.
