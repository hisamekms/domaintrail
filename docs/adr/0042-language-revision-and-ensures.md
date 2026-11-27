# ADR 0042: Language revision and `ensures`

- Status: proposed
- Date: 2026-11-28
- Amends: [ADR 0016](0016-collection-constraints-and-declared-invariants.md) (equality semantics),
  [ADR 0019](0019-command-changes-and-decisions.md) (command changes, including create commands),
  [ADR 0035](0035-kind-specific-lifecycles.md) and [ADR 0037](0037-aggregate-kinds.md) (outcome syntax and selection)

## Context

The Level 2 spike showed that `changes items` alone cannot detect a missing `requires` on `addItem`: Level 2 permits
unspecified changed values, so that command remains executable. Level 2 means checking satisfiability,
executability, and
creation invariants; Level 3 checks invariant preservation and outcome reachability. Phase 2 therefore proposes
one breaking
language revision. `ensures` expresses relations on successful outcomes while `changes` states where assigned
values come from.

## Decision

Use TS-like syntax with strict null safety: `T?` means `T | null`, narrowed by `x != null`, `?.`, and `??`. Use `?:`
conditional expressions, `!(p) || q` in place of `implies`, the `null` keyword, and exhaustive `match` expressions
over unions and states. The Phase 2 AI trial compares the `match` form and quantifier names; it also confirms
the lambda form `x => …`.

`==` and `!=` use declared-type equality: owned entity values and value objects compare structurally, references by ID,
unions by tag and fields, and lists element by element in order. Reject `===` with a diagnostic suggesting `==`.
Rewrite entity `==`, `unique`, and `contains` to `.id` forms. Values are immutable; reject mutating methods such as
`push`.

Int supports only `+`, `-`, `*`; there is no Int `/`. Decimal supports `+`, `-`, `*`, `/` with declared scale
and half-even rounding. Mixed Int/Decimal arithmetic promotes the Int operand to Decimal and returns Decimal.
Diagnose division by zero unless the divisor is shown non-zero. Domain primitive arithmetic yields its base type; its
constraint is checked again on assignment.

Supervisor decision (2026-11-28): mixed Int/Decimal arithmetic promotes the Int operand to Decimal and returns
Decimal.

Use the decided changes/postcondition model: `changes x` permits an unspecified value; `changes x = expr` determines
the value using the `ensures` scope (parameters bare, fields `before.x`, no `after`). Omitted fields are unchanged.
`ensures { … }` expresses relations. Diagnose a lone equality in `ensures` and move it to value-determining `changes`.
Keep `before.x` and `after.x` qualification, leave parameters unqualified and forbid their names `before` and `after`,
and place optional `ensures` after `emits`. Create commands set fields through `changes`: list every non-optional
field; an unlisted optional field is `null`. The same creation rule applies to fields new in a transition's target
state. Carried fields listed in `changes` follow that clause; dropped fields are not mentioned. Add
`ChangedField: FeatureName ('=' Expression)?` and optional `ensures` after `emits` in outcomes and shorthand
commands.

Adopt list literals, spread, `.map`, `.filter`, `.sum`, and typed expression-bodied predicates and functions without
recursion or call cycles. Equality is deep structural for recursive value objects; optionals compare absent with
absent and present contents with present contents, while one absent is unequal. Optional-to-non-optional `==` is
allowed. TLA+ bounds recursion through the finite profile; the Phase 4 profile default is depth 2. TypeScript
runtime enforcement is specified in
[ADR 0043](0043-typescript-ensures-runtime.md). Exclude side effects, external APIs, and implicit clocks; time is
explicit input. Do not support old/new syntax coexistence. `dt migrate domain` is idempotent, supports `--dry-run`,
exits 0/1/2, preserves comments and layout, and reports manual work.

## Rejected alternatives

- Freeze syntax before the AI trial, which would preempt evidence on the still-open `match` form and quantifier names.
- Use `old(x)` and unqualified post-state fields.
- Add multiple aliases for one operation.
- Compare equality by raw record representation.
- Retain only Level 2 checks.

## Consequences

Migration must preserve comments, layout, and meaning, report manual work, and support the narrowed trial protocol.
`ensures` over event payloads remains open. See [2. Decided surface
syntax](../plans/formal-verification/language-revision.md#2-decided-surface-syntax),
[5. AI syntax trial](../plans/formal-verification/language-revision.md#5-ai-syntax-trial), [`ensures`:
placement, equality and field
lifecycle](../plans/formal-verification/language-revision.md#3-ensures-placement-equality-and-field-lifecycle),
[Maintainer decisions](../plans/formal-verification/language-revision.md#maintainer-decisions-2026-11-27), and
the [AddItem
limitation](../plans/formal-verification/language-revision.md#3-ensures-placement-equality-and-field-lifecycle).
