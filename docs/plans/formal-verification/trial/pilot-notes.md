---
status: draft
---

# Pilot notes

Pilot observations check the protocol; they claim no winner (README protocol 4).

## Pilot 1 (`pilot-2026-11-28-52328d86`, build 8cd4d4d, packet version 1)

48 attempts (24 Claude `claude-sonnet-5-5`, 24 Codex `gpt-6.2-sol`), all finished: no timeout, no failed turn, no
exhausted repair loop. Every arm's models used that arm's spelling only. No Codex command read outside its directory;
Claude's 19 permission denials were compound shell commands (loops over `dt guide`, `sed`/`perl` edits) that it redid
with the allowed tools. Scoring: no arm spelling left in any review input, every verdict parsed, reviewer agreement
46/48 (2 adjudicated).

Findings that change the protocol:

- WS-04: 11 of the 17 semantic fails read "a vacant role" as a vacancy without data, while the checklist and scenarios
  keep the role (`"engineer"`). The requirements now say the vacant role "names the role still to be filled", as WS-01
  says of an open shift.
- WS-02: 4 models replaced the entry list instead of adding entries; the requirements did not say entries are added.
  They now say "Entries are added to an open timesheet one at a time", as WS-01 says of shifts.

Packet version 2 carries both changes; the pilot is rerun on it before the main run.

Kept as is: Claude's tools (file tools and `dt guide`) and Codex's shell differ by CLI; comparisons are within family.

## Pilot 2 (build 0f918e3, packet version 2)

48 attempts, all finished: no exhausted repair loop, no failed turn. Reviewer agreement 48/48. The WS-04 and WS-02
wording fails of pilot 1 are gone; the 3 remaining fails (WS-02) leave the approved total unspecified, a model fault
with the packet as written. The main run uses this build and packet.

# Main run

`main-2026-11-28-80791eee`: build 0f918e3, packet version 2, seed 20261130, Claude `claude-sonnet-5-5` and Codex
`gpt-6.2-sol`. 192 attempts, all finished; none exhausted; every final model checks clean. Reviewer agreement 192/192,
none adjudicated. Per-attempt rows are in `results.csv`, the comparisons and the decision in `main-analysis.md`.

**Decision: no arm meets the decision rule; A0 stays adopted.** M2, M3 and Q2 each improve no packet and regress
the first type check in some packet (M2 WS-02 and WS-03; M3 WS-01; Q2 WS-01, WS-02 and WS-04). M3 and Q2 also hit
the semantic veto in WS-02. The mean first type-check difference over packets is −4% (M2), −2% (M3) and −6% (Q2)
points.

Arm-independent findings for the language and guide (not a reason to change the trial result):

- **First type check.** Nearly all first-check errors are two codes, in every arm. M011 (78 messages): a command
  named after a state, `draft` beside `Draft`, collides with its generated TypeScript name; it fails Claude's first
  check in all 24 WS-04 attempts. M028 (99 messages): lifecycle states without an initial state, create outcomes not
  ending at one, and unreachable source states (WS-01, WS-02, WS-04).
- **Rounding.** All 13 semantic fails (10 Claude, 3 Codex, all arms) are WS-02 attempts that leave the approved total
  unspecified, stating that the language cannot round a product to two decimals. The passing attempts wrote
  `hours * rate / 1.00`, but that did not round either: `*` adds the scales and `/` keeps the larger one, so the value
  had scale 4, and nothing checked a scale against the declared `Decimal(2)`. The reviewers passed those attempts on
  the total's formula. The language had no way to round; `x.round(n)` and the scale-fit check (M009) now give one and
  enforce it. This affects every arm alike, so the decision stands.
