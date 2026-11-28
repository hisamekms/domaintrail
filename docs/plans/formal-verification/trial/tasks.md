# Workforce scheduling task packets

Domain: workforce scheduling, distinct from shop. Each attempt receives only its assigned business requirements and
arm's guide. Field and command names provide no hints: names must not disclose the intended variant, state, guard,
postcondition, or operation. Reviewers use the checklist and scenarios below, which are hidden from agents.

Scenario notation uses typed values: `Date(2026-11-02)` is a calendar date; `Timestamp(2026-11-02T09:00:00Z)` is a
UTC instant; `Week(2026-W20)` is an ISO-8601 calendar week and may be modelled as a domain primitive; the scenario
mapping converts it; `Hours(8.00)` is Decimal scale 2. Names in quotes are
strings and IDs such as `TeamId("T1")` are typed identifiers. Every monetary amount is Decimal scale 2, rounded
half-even. Scenario-to-contract-test mappings are made blind for each attempt and recorded with its results.

## WS-01 — Publish a weekly rota

### Business requirements

A new rota belongs to one team and covers a named week. Its revision is 0. It starts as a draft with no shifts or
publication time. Shifts are added to the draft. A shift may be either a staffed shift, which names a worker and role,
or an open shift, which names the role still to be filled; each carries hours. A manager may publish only a draft
containing at least one shift, all with positive hours. Publication records the supplied time and does not change the
revision. When a shift is added, the system assigns the rota some new revision number, which must be greater than the
previous one. A published rota cannot be edited.

### Normalized semantic checklist

- The rota is associated with its team and week, and contains shifts with the stated staffed/open meanings and payloads.
- Creation yields a draft with no shifts and no publication time; adding a shift to a draft retains it and prior shifts.
- Publication is permitted only for a nonempty rota whose shift hours are all positive; it records the supplied time
  and published status. These are publish guards; zero hours need not be forbidden in an unpublished draft.
- On add-shift, revision is permitted to change, its value is not determined, and the postcondition
  `after.revision > before.revision` holds. Create sets revision to 0. Publishing leaves revision unchanged.
- Publication preserves team, week, and shifts. No successful edit is possible after publication.

### Scenario tests

| Input sequence | Expected outcome |
|---|---|
| Create `TeamId("T1")`, `Week(2026-W20)` | Succeeds with revision 0. |
| Create; add one staffed shift | Succeeds with a revision greater than 0. |
| Create `TeamId("T1")`, `Week(2026-W20)`; publish at `Timestamp(2026-11-02T09:00:00Z)` without adding shifts | Rejected; remains draft with no publication time. |
| Create; add staffed shift (`WorkerId("A")`, `"nurse"`, `Hours(8.00)`); publish at that timestamp | Both commands succeed; revision increases on edit; time and shift are retained. |
| Create; add open shift (`"nurse"`, `Hours(8.00)`); publish | Succeeds; open case and role are retained. |
| Create; add staffed shift with `Hours(0.00)`; publish | Add may succeed, but publish is rejected; rota remains draft. |
| Create; add valid shift; publish; attempt another shift | No successful successor from published state. |

## WS-02 — Approve and total a timesheet (task (b))

### Business requirements

A timesheet is opened for one worker and one pay period with no entries and no approval. An entry is either hourly work,
which records a task, Decimal hours (scale 2), and Decimal hourly rate (scale 2), or fixed-fee work, which records a
task and Decimal amount (scale 2). Entries are added to an open timesheet one at a time. Amounts use two decimal places and half-even rounding. A supervisor can approve only
when there is at least one entry, every hourly entry has positive hours and a nonnegative rate, and every fixed fee is
nonnegative. The approved total is the sum of each entry's amount: hourly hours multiplied by rate, or its fixed fee.
Approval records the approving supervisor and calculated total. Entries cannot change after approval.

### Normalized semantic checklist

- Timesheet meaning includes worker, pay period, ordered entries, and approval facts; each entry has one of the two
  stated meanings and its variant-specific fields.
- Creation is open, empty, and unapproved; adding entries preserves order and existing entries.
- Approval requires at least one entry, positive hours/nonnegative rate for hourly entries, and nonnegative fixed fees.
  Invalid values may exist before approval; these are approval guards, not global invariants.
- Approved total equals a sum over entries of a value selected by entry variant, reading that variant's fields; hourly
  work contributes hours multiplied by hourly rate, fixed-fee work contributes its amount. Total is Decimal scale 2.
- Approval records the supplied supervisor and preserves worker, period, and entries. No entry mutation succeeds after
  approval.

### Scenario tests

| Input sequence | Expected outcome |
|---|---|
| Create; approve with no entries | Rejected; remains open and unapproved. |
| Create; add hourly (`"X"`, `Hours(2.00)`, rate `Decimal(10.50)`); add hourly (`"Y"`, `Hours(3.00)`, rate `Decimal(4.00)`); approve by `SupervisorId("S")` | Succeeds; total is `Decimal(33.00)` and both entries remain. |
| Create; add hourly entry with `Hours(0.00)`; approve | Add may succeed, approval rejected; no approved timesheet with that entry. |
| Create; add hourly positive hours and `Decimal(-1.00)` rate; approve | Add may succeed, approval rejected. |
| Create; add fixed fee `Decimal(12.75)`; approve | Succeeds with total `Decimal(12.75)`. |
| Create; add valid entry; approve; attempt another entry | No successful successor from approved state. |

## WS-03 — Close a leave request

### Business requirements

A leave request names a worker, date range, and reason. It begins pending with no decision details. A decision is either
approval with the approver's name or rejection with a rejection reason. A pending request may be decided only if its
start date is no later than its end date. The decision is recorded exactly as supplied. Once decided, it cannot be
re-decided. The worker, dates, and reason never change.

### Normalized semantic checklist

- The request's meaning includes worker, start/end dates, reason, and decision details; pending requests have no
  decision, while terminal requests record the supplied approval or rejection facts.
- A valid pending request can reach either matching terminal meaning; decision payloads are retained without confusion.
- Start date must be no later than end date for a successful decision. This is a decision guard.
- Both decisions preserve worker, dates, and reason. No successful second decision exists.

### Scenario tests

| Input sequence | Expected outcome |
|---|---|
| Create valid range `Date(2026-11-02)` to `Date(2026-11-03)`; approve as `"Ada"` | Succeeds; approval and approver are retained. |
| Create valid range; reject with `"insufficient coverage"` | Succeeds; exact rejection reason is retained. |
| Create reversed dates `Date(2026-11-03)` to `Date(2026-11-02)`; attempt either decision | Rejected; remains pending without decision details. |
| Create valid request; approve; attempt rejection | No successful successor after approval. |
| Create valid request; approve; inspect worker/date/reason | Original facts are unchanged. |

## WS-04 — Assign an on-call rotation

### Business requirements

A rotation has a service and starts as a draft with no assignments. At creation, the coordinator may supply an optional
backup contact. An assignment names an ISO calendar week and is either a named primary responder or a vacant role,
which names the role still to be filled.
Assignments are added to the draft. A week may appear more than once in a draft, but activation is allowed only when
there is at least one assignment and every assignment has a distinct week. A rotation with any vacant week can be
activated only if it has a backup contact. Activation records the supplied start date. The service, assignments, and
backup contact stay as submitted when activated.

### Normalized semantic checklist

- The rotation has service, assignments with their named/vacant meanings, and an optional backup contact.
- Creation starts draft with no assignments and with the supplied backup contact when provided (otherwise absent).
  Adding an assignment appends it to the draft.
- Activation requires a nonempty assignment list, distinct weeks across both assignment meanings, and a non-null
  backup contact whenever any assignment is vacant. Duplicate weeks are allowed in draft; these are activation guards,
  not global invariants.
- Activation records supplied date, preserves service/assignments/backup contact, and no assignment edit succeeds once
  active.

### Scenario tests

| Input sequence | Expected outcome |
|---|---|
| Create without backup; activate empty rotation | Rejected; remains draft. |
| Create with `ContactId("B")`; add named `Week(2026-W01)` responder `ResponderId("Pat")`; add vacant `Week(2026-W02)` role `"engineer"`; activate `Date(2026-11-02)` | Succeeds; both assignments and date remain; backup is unchanged. |
| Create with backup; add named `Week(2026-W01)`; add vacant `Week(2026-W01)`; activate | Both adds may succeed; activation rejected because weeks duplicate across variants. |
| Create without backup; add vacant `Week(2026-W03)`; activate | Rejected because a vacant week requires a backup contact. |
| Create with `ContactId("B")`; add one named assignment; activate | Backup B is unchanged after activation. |
| Create; add one assignment; activate; attempt another assignment | No successful successor from active state. |
