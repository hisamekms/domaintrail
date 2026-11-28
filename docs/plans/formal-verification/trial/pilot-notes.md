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
