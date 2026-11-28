# Phase 0 deliverable 7: one language revision

Status: decision recorded; implementation proposal. The revision is intentionally breaking: DomainTrail is beta and the
plan calls for one canonical syntax, with legacy syntax handled by migration. Current-language claims link to the
checked-in grammar, implementation, examples or ADRs. Proposed syntax is not current behavior.

## Maintainer decisions (2026-11-27)

The maintainer decided the following after considering changeability and how easily AI writes the language. Decision 1
fixes arithmetic: Int supports `+`, `-`, `*` only; Decimal supports `+`, `-`, `*`, `/` with declared scale and
half-even rounding; diagnose division by zero unless the divisor is shown non-zero. Domain primitive arithmetic returns
the base type, whose constraint is checked again on assignment. This confirms the recommended operators and supersedes
the unresolved arithmetic/rounding candidates below.

Decision 2 adopts TS-like syntax with strict null safety (`T?` means `T | null`, narrowing by `x != null`, `?.`, and
`??`) and exhaustive `match` over unions and states. Declared-type equality is structural for owned entities and value
objects and by ID for references; `===` is rejected with a diagnostic suggesting `==`. Values are immutable and
mutating methods are rejected. Only the `match` spelling alternatives and `every`/`some` versus `forall`/`exists` are
compared in the AI trial; the lambda form `x => …` is confirmed, not compared. This supersedes the broader syntax
trial proposed below.

Decision 3 adopts design D for `changes`: each field may use `changes x` (permitted, unspecified value) or
`changes x = expr` (value determined); omitted fields are unchanged. The right-hand side uses the `ensures` scope:
parameters are bare, fields use `before.x`, and `after` is unavailable. `ensures { … }` expresses relations only. A
lone equality such as `after.x == e` is diagnosed and moved to `changes x = e`. Keep parameter restrictions and
placement after `emits`.

Decision 3a (maintainer, 2026-11-28) completes design D: an outcome lists in `changes` every non-optional field it
makes exist, and the value stays optional. A create lists every field of the new aggregate (`id` included; the
common fields, its kind's and its target state's), a transition the fields new in its target state; an optional field
not listed starts as `null`. A bare `changes f` keeps meaning "set, value left open". The listing favours a reader
(human or AI) who sees on the outcome every field it gives, and a change that adds a field is reported at each outcome
that must now give it. `dt migrate domain` writes `f = f` where the command has a parameter of that name and `f`
otherwise. `changes` on a create and a target state's field on a transition into it are therefore allowed.

Decision 4 adopts list literals `[]` and `[a, b]`, spread `[...xs, x]`, and `.map(f)`, `.filter(p)`, and `.sum(f)`;
trial task (b) is a task in the trial domain (not shop) that needs `.sum`, such as a total over line items. Decision 5
includes pure user-defined typed, expression-bodied predicates and functions, with no
recursion or call cycles. These supersede the open list-operation and predicate recommendations below. Decision 11
confirms deep structural equality for recursive value objects, optional equality by absent/present contents, permits
optional-to-non-optional `==`, and bounds recursion depth in TLA+ through the profile.

## Supervisor decisions (2026-11-28)

The right-hand side of `changes x = expr` uses the `ensures` scope: parameters are bare, fields use `before.x`, and
`after` is unavailable. Create commands list every non-optional target field through `changes`; an unlisted optional
field is `null`. The same rule applies to fields new in a transition's target state, such as `confirmedAt` and
`reason`. Grammar adds `ChangedField: FeatureName ('=' Expression)?` and optional `ensures` after `emits` in Outcome
and shorthand Command. The default recursion depth for recursive values in the verification profile is 2. Mixed
Int/Decimal arithmetic promotes the Int operand to Decimal and returns Decimal. `x.round(n)` rounds a Decimal
half-even to `n` digits after the point; a Decimal of known scale larger than the `Decimal(n)` it is placed in is an
error until it is rounded.

Implementation order (Phase 2). The revision goes in by construct group:
1. logical operators;
2. method-form collection and string calls;
3. null safety;
4. conditional;
5. arithmetic;
6. lists;
7. predicates and functions;
8. `match`;
9. `changes`/`ensures`.

For each group, the parser reads the new spelling, and `dt migrate domain` (`migrateDomain` in Modeling) rewrites the
old one. `scripts/migrate-sources.ts` then migrates every model in the repository: `.dt` files, Markdown `dt` blocks,
and models in TypeScript template literals. After that, `dt check` reports each old spelling as an error, with its
replacement and the migration as hint. The parser keeps reading old spellings only so that the migration can rewrite
them; the language has one spelling. Because `implies` is gone, narrowing also takes the false edge: the right of `||`
is checked under what the left shows when it does not hold (`!exists(x) || x.f > 0`). User-facing entries collect in
[release-notes.md](release-notes.md) until the release, since the changelogs list released versions only. The AI trial
starts once A0 `match` and quantifiers are in.

## 1. Current language and command contract

### Expressions

Current expression grammar has logical `implies`/`or`/`and`, comparisons, ranges, unary `not`, member access,
prefix functions, literals and names; the productions show the full precedence and primary forms
([grammar, expressions](../../../contexts/modeling/src/infrastructure/syntax/domain.langium#L184)). It has no
arithmetic or conditional-expression production: integer and decimal literals are primaries, but there is no arithmetic
operator ([grammar, operators and range](../../../contexts/modeling/src/infrastructure/syntax/domain.langium#L198)).

The current prefix forms are `count(xs)`, `exists(x)`, `length(text)`, `matches(text, "regex")`, `unique(xs)` or
`unique(xs, x => key1, key2)`, `contains(xs, x)`, and `all(xs, x => p)`/`any(...)`
([grammar, primary forms](../../../contexts/modeling/src/infrastructure/syntax/domain.langium#L210)). `length` accepts
String/UUID today, not lists ([expression checker](../../../contexts/modeling/src/domain/rules/expressions.ts#L385));
ADR 0016 records the current collection forms, equality basis, and `unique` key rules
([ADR 0016, equality and unique](../../adr/0016-collection-constraints-and-declared-invariants.md#L26)).
Optional `exists` narrows guarded paths; short-circuit `and`/`implies` carry guards
([expression checker, exists](../../../contexts/modeling/src/domain/rules/expressions.ts#L377)).

### Command contract

`requires` sees parameters, common fields, and fields shared by every source state; a create command sees parameters
only ([ADR 0017, scope](../../adr/0017-command-requirements.md#L51)). Grammar supports two command shapes: shorthand
transitions followed by requirements, command-level `changes`, emits and errors; or a block containing requirements
and named outcomes, with no command-level `changes` or emits
([grammar, Command and Outcome](../../../contexts/modeling/src/infrastructure/syntax/domain.langium#L111)). Named
outcomes have a single target, optional source set, optional selector, their own `changes` and `emits`
([grammar, Outcome](../../../contexts/modeling/src/infrastructure/syntax/domain.langium#L121)). ADR 0035 established
named outcomes, choice rules and outcome-level changes; ADR 0037 retains those while changing kind selection
([ADR 0035, outcomes](../../adr/0035-kind-specific-lifecycles.md#L35),
[ADR 0037, superseded and retained](../../adr/0037-aggregate-kinds.md#L5)).
`select { expr }` is an outcome choice rule, not a postcondition
([ADR 0035, choice rules](../../adr/0035-kind-specific-lifecycles.md#L38)).

`changes` grants permission to set fields and determines framing. A bare `changes x` leaves its value unspecified;
`changes x = expr` determines its value using the `ensures` scope: parameters are bare, fields use `before.x`, and
`after` is unavailable. Create commands set every non-optional field through `changes`; an unlisted optional field is
`null`
([ADR 0019, changes and carry-over](../../adr/0019-command-changes-and-decisions.md#L41)). Target-only fields are
new and set, source-only fields are dropped, and other common fields are kept
([ADR 0019, transition field rules](../../adr/0019-command-changes-and-decisions.md#L57)). With no postcondition,
changed outputs can be nondeterministic. The Order spike confirms that `missing_requires_additem` is not detected at
Level 2 because `items'` is unspecified; it says a postcondition tying it to the input is needed
([spike, Level 2 finding](spike/results.md#L61)).

The shop source uses `place(id, customer)`, `addItem(item)`, `changeNote(note)`, `confirm(at)`, and
`cancel(reason)` ([shop commands](../../../examples/shop/sales/order.dt#L26)). These parameter names overlap fields,
including `id`, `customer`, `note`, and `reason`
([shop fields](../../../examples/shop/sales/order.dt#L14),
[customer and note](../../../examples/shop/sales/order.dt#L16)).
In `ensures`, fields are qualified `before.x` or `after.x`; parameters remain unqualified. The same scope applies to
right-hand sides of `changes x = expr`: parameters are bare, fields use `before.x`, and `after` is not allowed.
`ensures`, `null`, `before`, `after`, and `match` receive the same keyword and `FeatureName` treatment as
`changes` (ADR 0019
records that treatment at [ADR 0019, changes](../../adr/0019-command-changes-and-decisions.md#L72)): they are keywords
in their grammatical positions and remain usable as field names. A parameter may not be named `before` or `after`
(a new check): otherwise `before.x` would be ambiguous when the parameter is a value object with a field `x`.
`dt migrate` renames such a parameter within its command (e.g. `before` to `beforeValue`, choosing a name not already
in scope) and reports it; the generated TypeScript parameter name changes with it, a breaking change the beta allows.

### Existing `dt migrate`

`dt migrate dtes` currently migrates earlier `.dtes` syntax, supports `--dry-run`, preserves comments/layout, is
idempotent, reports what it leaves, and documents exit codes 0/1/2
([CLI migration command](../../../apps/dt/src/cli/main.ts#L536),
[dry-run](../../../apps/dt/src/cli/main.ts#L543),
[rewrite/report/exit behavior](../../../apps/dt/src/cli/main.ts#L550)). It does not migrate domain `.dt` models. The
new domain rewrite must carry the same contract: comments and layout preserved, idempotent output, `--dry-run` kept,
exit codes 0/1/2, and a report of constructs left for manual work.

## 2. Decided surface syntax

The maintainer decided the surface policy in “Maintainer decisions (2026-11-27)”. Adopted forms follow; only the
`match` spelling and quantifier names remain trial comparisons, and the lambda form is confirmed.

| Construct | Adopted form | Decision / trial status |
|---|---|---|
| Quantifiers | `items.every(i => p)` / `items.some(i => p)` | Trial: `every`/`some` vs `forall`/`exists` |
| Membership | `items.includes(x)` | Decided |
| Size | `items.length`, `text.length` | Decided |
| Uniqueness | `items.unique()` / `items.unique(x => a, b)` | Decided |
| Regex | `text.matches("pattern")` | Decided |
| Logical operators | `&&`, `||`, `!` | Decided |
| Implication | `!(p) || q` | Decided |
| Optional presence | `x != null`; `?.`; `??` | Decided with strict null safety |
| Conditional | `test ? a : b` | Decided TS-like form |
| Arithmetic | Int `+ - *`; Decimal `+ - * /`; mixed Int/Decimal promotes Int to Decimal | Decided; see maintainer decisions |
| Old/new state | `before.x`, `after.x` | Decided |
| Match | `match (x) { variant { fields } => e, … }` | Adopted as A0; trial arms M2 TC39, M3 ts-pattern |
| Lists | `[]`, `[a, b]`, `[...xs, x]`, `.map`, `.filter`, `.sum` | Decided |
| User functions | Typed expression-bodied predicates/functions | Decided; no recursion/cycles |

The JS logical operators replace `implies` with equivalent `!(p) || q`; this preserves short-circuit semantics and keeps
one canonical implication spelling. `matches` is a method because it is a string operation. These forms are decided;
only
the `match` spelling and quantifier names remain trial choices. Current forms and their
current grammar are documented above
([grammar, primary forms](../../../contexts/modeling/src/infrastructure/syntax/domain.langium#L210)).

Use `.length` for both lists and strings, with one meaning per type; do not have a second size spelling. `unique()`
checks element uniqueness, and `unique(x => a, b)` checks key tuples, matching current one- and multi-key forms
([grammar, unique](../../../contexts/modeling/src/infrastructure/syntax/domain.langium#L216),
[ADR 0016, unique](../../adr/0016-collection-constraints-and-declared-invariants.md#L38)).
List literals, spread and `.sum` are decided; see “Maintainer decisions (2026-11-27)”. Use
`[...before.items, item]` and
`items.sum(i => i.quantity * i.unitPrice.amount)`.

Arithmetic is decided; see “Maintainer decisions (2026-11-27)”. Domain primitive constraints are checked when a
result
is assigned; IDs have no arithmetic. Conditional has lower precedence than implication/its replacement. Inside
`x in a..b`, range bounds are conditional expressions only when parenthesized; alternatively keep conditional out of
range bounds. Define these rules in grammar and type-checker tests before freezing syntax.

## 3. `ensures`: placement, equality and field lifecycle

### Placement and shop contracts

Add `ensures { expr }` after each outcome's `changes` and `emits` in block form. In shorthand, add it after
command-level `changes` and `emits`. This follows the command order of requires, changes, then report; block form has
no command-level `changes`
([grammar, Command](../../../contexts/modeling/src/infrastructure/syntax/domain.langium#L111),
[grammar, Outcome](../../../contexts/modeling/src/infrastructure/syntax/domain.langium#L121)).
ADR 0035 assigns changes and emits to named outcomes, and ADR 0037 retains named outcomes/selectors
([ADR 0035](../../adr/0035-kind-specific-lifecycles.md#L35), [ADR 0037](../../adr/0037-aggregate-kinds.md#L5)).
`select` chooses which outcome applies; `ensures` constrains the post-state after that outcome succeeds. They are
separate predicates, not substitutes.

The examples below use shop's actual command names and parameters
([shop command declarations](../../../examples/shop/sales/order.dt#L26)).
Each block-form command lists its outcomes explicitly; outcome bodies are inside braces, as the grammar requires
([grammar, Command](../../../contexts/modeling/src/infrastructure/syntax/domain.langium#L112)).

```dt
create command place(id: OrderId, customer: CustomerId) {
  outcome placed: -> Draft
    changes id = id, customer = customer, items = []
    emits OrderPlaced
}

command addItem(item: OrderItem) {
  requires newSku "同じ商品コードの明細がない" {
    items.every(i => i.sku != item.sku)
  } else DuplicateSku
  requires sameCurrency "既存の明細と同じ通貨" {
    items.every(i => i.unitPrice.currency == item.unitPrice.currency)
  } else CurrencyMismatch
  outcome added: Draft -> Draft
    changes items = [...before.items, item]
}

command changeNote(note: String?) {
  outcome changedDraft: Draft -> Draft
    changes note = note
    emits NoteChanged?
  outcome changedConfirmed: Confirmed -> Confirmed
    changes note = note
    emits NoteChanged?
}

command confirm(at: Timestamp) {
  requires hasItems "明細が1件以上" { items.length > 0 } else EmptyOrder
  outcome confirmed: Draft -> Confirmed
    changes confirmedAt = at
    emits OrderConfirmed
}

command cancel(reason: CancelReason) {
  requires noteForOther "その他の取消には備考が必要" {
    reason != CancelReason.Other || note != null
  } else NoteRequired
  outcome cancelledDraft: Draft -> Cancelled
    changes reason = reason
    emits OrderCancelled
  outcome cancelledConfirmed: Confirmed -> Cancelled
    changes reason = reason
    emits OrderCancelled, RefundRequested
}
```

`changeNote`'s `changes note = note` uses its bare parameter. The `confirm` and `cancel` outcomes need no equality
clauses for unlisted fields: under design D, those fields are unchanged. `place` lists `id`, `customer`, and
`items = []`; `note` is omitted and therefore defaults to `null`. All non-optional create fields must be listed.
Relational postconditions remain in `ensures`; hypothetically, if Order had a `total` field, one could write
`ensures { after.total >= before.total }`.

The selector belongs before outcome `changes`/`emits` and therefore before `ensures`; it narrows the pre-state/parameter
condition for that named outcome, while `ensures` describes its post-state. Command-level `requires` declarations appear
once before the block outcomes; outcomes cannot contain requirements (the proposed grammar retains this scope).
Requirement names remain command-unique under M002
([ADR 0017, name scope](../../adr/0017-command-requirements.md#L37)). Create has no `before` aggregate fields. Every
non-optional target field must be listed in `changes`; an unlisted optional field is `null`. `place` explicitly sets
`id`, `customer`, and empty `items`, while `note` defaults to `null`.

### Equality choices

Equality follows the declared type of the compared values. Owned aggregate entity values, including a parameter such as
`item: OrderItem`, compare structurally; `references` compare by ID; value objects compare structurally; unions compare
by tag and fields; lists compare element-wise in order; optionals compare by presence and then value. Semantic IR
carries these equality kinds so code generators cannot silently choose a different rule. Existing ADR 0016 excludes
list/optional equality and uses entity ID equality
([ADR 0016, equality](../../adr/0016-collection-constraints-and-declared-invariants.md#L28)); the revision would amend
this. Semantic IR must also retain primitive/domain primitive and enum equality kinds, and ownership/reference context.

### `changes` alignment

`ensures` is a constraint on a successful outcome, not an implicit precondition. For each outcome, classify fields as
follows, using ADR 0019's carried/kept/new/dropped rules
([ADR 0019, transition field rules](../../adr/0019-command-changes-and-decisions.md#L57)):

- Carried field listed as `changes x`: its output is permitted to vary but unspecified; `ensures` may add relations.
- Carried field listed as `changes x = e`: its output is determined by `e`; `ensures` may add relations.
- Carried field not listed: it is framed to `before.x`; an `ensures` contradicting that fact is a diagnostic.
- New target field: listed through `changes` and determined by an assignment; create commands list each non-optional
  field, while an unlisted optional field is `null`.
- Dropped source-only field: inaccessible through `after`; it is not carried into the target.

A field not possible for the selected outcome is a type error. Constraining a kept field inconsistently is a diagnostic,
not a hidden `requires`. For multiple source states, `before.x` is available only for fields every source state has
with the same name and type, matching the `requires` scope rule
([ADR 0017, source-state fields](../../adr/0017-command-requirements.md#L53)).
Outcome-specific `select` chooses the applicable transition; its `ensures` is checked against that outcome's source and
target fields. Create commands expose parameters and target fields only. They list every non-optional field through
`changes`; an unlisted optional field is `null`
([ADR 0019, create](../../adr/0019-command-changes-and-decisions.md#L50)).

## 4. Rewrite and coordinated files

Add `dt migrate domain` alongside existing `.dtes` migration. Rewrite constructs with explicit meaning-preserving
rules: `and`/`or`/`not` to `&&`/`||`/`!`; `p implies q` to `!(p) || q` (including required parentheses);
`matches(t, "r")` to `t.matches("r")`; `exists(x)` to `x != null`;
`count(xs)` to `xs.length`; and prefix collection calls to receiver calls. For entity values, `unique(items)` and
`contains(items, x)` currently compare by ID (ADR 0016); rewrite these as `items.unique(x => x.id)` and
`items.some(e => e.id == x.id)`, and include both rewrites in the migration report. For entity values, rewrite
`a == b` and `a != b` to `a.id == b.id` and `a.id != b.id`, choosing a lambda parameter name not already in scope;
include these rewrites in the migration report. Also rewrite unambiguous string/list size forms to `.length`.
Mechanically rewrite `unique(xs)` to `xs.unique()` only when elements are not entities, and
`unique(xs, x => a, b)` to `xs.unique(x => a, b)`, retaining every key expression. Do not infer `ensures` from names:
leave contracts requiring new knowledge unchanged and report them. Preserve comments/layout, make migration idempotent,
retain `--dry-run`, use exit codes 0/1/2, and report each construct left. These behaviors are the current migration
contract ([CLI migration help](../../../apps/dt/src/cli/main.ts#L543)).

Coordinated changes: `contexts/modeling/src/infrastructure/syntax/domain.langium`, generated sources under
`contexts/*/src/generated`, `contexts/modeling/src/domain/rules/expressions.ts`,
`capabilities/generation/src/core/checks.ts`, and `capabilities/generation/src/core/typescript.ts` (ADR 0020's generated
checks and contract tests, [ADR 0020](../../adr/0020-generated-checks-and-contract-tests.md#L26)); Semantic IR and
all consumers; `apps/dt/src/cli/guide.ts`, `docs/guide.md`, `docs/getting-started.md`,
`docs/getting-started.ja.md`; `tree-sitter-domaintrail/test/corpus`; `CHANGELOG.md` and `CHANGELOG.ja.md`; and ADRs
0016, 0019, 0020, 0037 plus the new revision decision. Drop “TLA+ consumers” from Phase 2 unless that implementation is
actually in scope.

Grammar additions are `ChangedField: FeatureName ('=' Expression)?`, and an optional `ensures` block after `emits` in
Outcome and in the shorthand Command.

## 5. AI syntax trial

Build the remaining `match` forms as a prototype branch or parser/checker variant flag. Use one guide template to keep
non-syntax instructions identical. Compare only the listed `match` forms and quantifier names; confirm `x => …`. Run
tasks in a domain other than shop so the existing example does not leak answers. Four arms are used per task packet:
A0 is `match (x) { Variant { fields } => e, … }` with `every`/`some`; M2 is the TC39 proposal form with
`every`/`some`; M3 is a ts-pattern-like method form with `every`/`some`; Q2 is `forall`/`exists` with the A0 match
form. M2, M3 and Q2 are each compared with A0; A0 attempts are shared.

Teach agents only with `dt guide`, as in Phase 2 of the plan and ADR 0038. Each task packet is one attempt. Run 12
independent attempts per arm per task packet, six Claude and six Codex, with latest versions pinned at trial start. Run
a three-attempt-per-arm pilot first. The four-arm main-run count is 4 arms × 12 attempts × task packets (192 for four
packets); add 3 attempts × 4 arms × task packets for the pilot. Set improvement as at least +10 percentage points in
first syntax-check or first type-check success, or at least 15% fewer repair tokens. Set regression as at least −10
percentage points on either rate, or at least 15% more repair tokens. An arm beats A0 if it improves at least one metric
with no regression on any, in at least two task packets, and the result does not reverse in either model family. An
adjudicated semantic pass rate at least 10 percentage points below A0 vetoes the win; no winner keeps A0. Report
uncertainty. Compare token counts only within one model and one requirement packet. Semantic correctness is a gate:
reviewers blind to syntax variant judge normalized Typed Model or Semantic IR dumps against a hidden acceptance matrix,
then check scenario outcomes. Do not judge correctness from source syntax or token count.

Record all six plan metrics: first syntax-check success, first type-check success, semantic correctness, repair count,
token use and repair success from diagnostics. Define repair count as diagnostic-driven edit cycles before passing or
exhaustion; repair success is whether those diagnostics lead to a passing check without changing the requirements. Also
record prompt, guide/template version and allowed diff, model/version, outputs, every diagnostic and repair, normalized
model and scenario results. Use at least two reviewers blind to variant; adjudicate disagreement with a third reviewer
and report agreement and adjudication.
Keep task-packet and model budgets identical and randomize variant order. ADR 0038 reports six Sonnet agents taught from
`dt guide` only ([ADR 0038, six-agent trial](../../adr/0038-date-and-time.md#L11)).

## 6. Decision status

The arithmetic, surface syntax, design D, list operations, pure functions, and recursive equality decisions are recorded
in “Maintainer decisions (2026-11-27)”. The trial protocol remains useful, with comparisons narrowed as stated there.
Verification profile, tool distribution, IR
compatibility, and variant IDs are in [the plan decision table](../formal-verification.md#L343).

## Report

Equality follows declared type and composes through lists and optionals; see “Maintainer decisions (2026-11-27)”.
Semantic IR must preserve every kind through lowering. Under design D the `addItem` argument is:

1. Shop's real `requires newSku` says every existing item's SKU differs from `item.sku`
   ([shop command](../../../examples/shop/sales/order.dt#L43),
   [new-SKU requirement](../../../examples/shop/sales/order.dt#L45)).
2. Remove that requirement while keeping `changes items`; Level 2 leaves `items'` unconstrained, so the duplicate-SKU
   invariant can be violated without the removed input guard ([spike Level 2 result](spike/results.md#L61)).
3. `after.items` is determined by the assignment `changes items = [...before.items, item]`. Choosing an existing SKU
   parameter forces duplicate SKUs. The Level 3
   no-successor probe must report `Counterexample found`, attributed to `addItem`, against `distinctSkus`.
4. Restore `requires newSku`. The duplicate input is disabled, all admitted appends preserve `distinctSkus`, and the
   correct AddItem-only run (`NextOnly_AddItem`) passes the Level 3 probe. This assumes append/list-literal and equality
   lowering are implemented consistently in Semantic IR and both checker backends, TLC and Apalache.

The remaining trial choices are the `match` spelling and quantifier names. Recursive bound depth is specified by the
verification profile; verifier implementation remains an implementation task. Migration behavior is confirmed
by the current CLI help
([migration behavior](../../../apps/dt/src/cli/main.ts#L547)).
