# Phase 0 deliverable 7: one language revision

Status: proposal for maintainer decision. The revision is intentionally breaking: DomainTrail is beta and the plan
calls for one canonical syntax, with legacy syntax handled by migration. The current-language claims below link to the
checked-in grammar, implementation, examples or ADRs. Proposed syntax is not current behavior.

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

`changes` grants permission to set fields and determines framing; it does not supply output values. A field carried
between source and target can be listed; create commands set every field and cannot declare `changes`
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
In `ensures`, fields will therefore always be qualified `before.x` or `after.x`; parameters remain unqualified.
`ensures`, `null`, `before` and `after` receive the same keyword and `FeatureName` treatment as `changes` (ADR 0019
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

## 2. Recommended surface syntax

The plan's principle is syntax that follows TS/JS for authors. Use one spelling per meaning; keep formally useful
constructs only where JS has no direct form.

| Construct | Recommended form | Trial variants |
|---|---|---|
| Quantifiers | `items.every(i => p)` / `items.some(i => p)` | `all`/`any`; `forall`/`exists` |
| Membership | `items.includes(x)` | `items.contains(x)` |
| Size | `items.length`, `text.length` | `items.length()`; retain `length(x)` |
| Uniqueness | `items.unique()` / `items.unique(x => a, b)` | prefix `unique(items, ...)` |
| Regex | `text.matches("pattern")` | prefix `matches(text, "pattern")` |
| Logical operators | `&&`, `||`, `!` | `and`, `or`, `not` |
| Implication | `!(p) || q` | keyword `implies` |
| Optional presence | `x != null` | prefix `isPresent(x)` |
| Conditional | `test ? a : b` | `if test then a else b`; `ifThenElse(...)` |
| Arithmetic | `+`, `-`, `*` | function forms; none |
| Old/new state | `before.x`, `after.x` | `old(x)` and unqualified target fields |

The JS logical operators replace `implies` with equivalent `!(p) || q`; this preserves short-circuit semantics and keeps
one canonical implication spelling. If the trial retains `isPresent`, it remains a prefix call because invoking a
method on a possibly absent receiver is misleading and unsafe; unlike collection and string methods, presence tests
the optional wrapper itself. `matches` should be a method because it is a string operation. Current forms and their
current grammar are documented above
([grammar, primary forms](../../../contexts/modeling/src/infrastructure/syntax/domain.langium#L210)).

Use `.length` for both lists and strings, with one meaning per type; do not have a second size spelling. `unique()`
checks element uniqueness, and `unique(x => a, b)` checks key tuples, matching current one- and multi-key forms
([grammar, unique](../../../contexts/modeling/src/infrastructure/syntax/domain.langium#L216),
[ADR 0016, unique](../../adr/0016-collection-constraints-and-declared-invariants.md#L38)).
List concatenation/append, list literals, and `sum` are additional trial candidates because postconditions and task (b)
need them. Prefer `[...before.items, item]` and `items.sum(i => i.quantity * i.unitPrice.amount)`; test `append` or
concatenation against the literal form rather than making all forms canonical. If no `sum` is adopted, remove task (b).

For arithmetic, recommend Int `+`, `-`, `*` only initially and no `/` on Int: TS `/` produces floating-point values,
while an Int expression must stay integral. If integer division is needed, propose a distinct `div` operator with
specified rounding; decimal division also requires explicit scale/rounding for TS/TLA+ parity. Domain primitives such
as `Quantity` inherit arithmetic only if their base is numeric and the result is range-checked as that primitive;
IDs get no arithmetic. Conditional has lower precedence than implication/its replacement, and inside `x in a..b`
the range bounds are conditional expressions only when parenthesized; alternatively keep conditional out of range
bounds. Define these rules in grammar and type-checker tests before freezing syntax.

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
    emits OrderPlaced
    ensures { after.id == id && after.customer == customer && after.items.length == 0 }
}

command addItem(item: OrderItem) {
  requires newSku "同じ商品コードの明細がない" {
    items.every(i => i.sku != item.sku)
  } else DuplicateSku
  requires sameCurrency "既存の明細と同じ通貨" {
    items.every(i => i.unitPrice.currency == item.unitPrice.currency)
  } else CurrencyMismatch
  outcome added: Draft -> Draft
    changes items
    ensures { after.items == [...before.items, item] }
}

command changeNote(note: String?) {
  outcome changedDraft: Draft -> Draft
    changes note
    emits NoteChanged?
    ensures { after.note == note }
  outcome changedConfirmed: Confirmed -> Confirmed
    changes note
    emits NoteChanged?
    ensures { after.note == note }
}

command confirm(at: Timestamp) {
  requires hasItems "明細が1件以上" { items.length > 0 } else EmptyOrder
  outcome confirmed: Draft -> Confirmed
    emits OrderConfirmed
    ensures { after.confirmedAt == at && after.items == before.items }
}

command cancel(reason: CancelReason) {
  requires noteForOther "その他の取消には備考が必要" {
    reason != CancelReason.Other || note != null
  } else NoteRequired
  outcome cancelledDraft: Draft -> Cancelled
    emits OrderCancelled
    ensures { after.reason == reason && after.note == before.note }
  outcome cancelledConfirmed: Confirmed -> Cancelled
    emits OrderCancelled, RefundRequested
    ensures {
      after.reason == reason && after.note == before.note && after.items == before.items
    }
}
```

The selector belongs before outcome `changes`/`emits` and therefore before `ensures`; it narrows the pre-state/parameter
condition for that named outcome, while `ensures` describes its post-state. Command-level `requires` declarations appear
once before the block outcomes; outcomes cannot contain requirements (the proposed grammar retains this scope).
Requirement names remain command-unique under M002
([ADR 0017, name scope](../../adr/0017-command-requirements.md#L37)). Create has no `before` aggregate fields: each
target field must be set by the create decision (ADR 0019 says create sets every field
([ADR 0019, create](../../adr/0019-command-changes-and-decisions.md#L50))). `place` therefore needs a list literal or
some equivalent constructor to assert empty `items`; `.length == 0` is the candidate shown above.

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

- Carried field listed in effective `changes`: output may vary, then `ensures` constrains its value.
- Carried field not listed: it is framed to `before.x`; an `ensures` contradicting that fact is a diagnostic.
- New target field: set by the decision; absent a constraining `ensures`, it is unspecified. For example,
  `Cancelled.reason` is new and `ensures { after.reason == reason }` constrains it.
- Dropped source-only field: inaccessible through `after`; it is not carried into the target.

A field not possible for the selected outcome is a type error. Constraining a kept field inconsistently is a diagnostic,
not a hidden `requires`. For multiple source states, `before.x` is available only for fields every source state has
with the same name and type, matching the `requires` scope rule
([ADR 0017, source-state fields](../../adr/0017-command-requirements.md#L53)).
Outcome-specific `select` chooses the applicable transition; its `ensures` is checked against that outcome's source and
target fields. Create commands expose parameters and `after` fields only, and create decisions set every field
([ADR 0019, create](../../adr/0019-command-changes-and-decisions.md#L50)).

## 4. Rewrite and coordinated files

Add `dt migrate domain` alongside existing `.dtes` migration. Rewrite constructs with explicit meaning-preserving
rules: `and`/`or`/`not` to `&&`/`||`/`!`; `p implies q` to `!(p) || q` (including required parentheses);
`matches(t, "r")` to `t.matches("r")`; `exists(x)` to `x != null` (or `isPresent(x)` if that variant wins);
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
0016, 0020, 0037 plus the new revision decision. Drop “TLA+ consumers” from Phase 2 unless that implementation is
actually in scope.

## 5. AI syntax trial

Build each variant as a prototype branch or parser/checker variant flag. The language maintainer implements the grammar
and checker variants; one guide template generates variant-specific syntax examples so all non-syntax instructions
stay identical. Use current syntax as baseline only for constructs being renamed; compare genuinely new constructs
variant against variant. Run tasks in a domain other than shop so the existing example does not leak answers. Include
arithmetic, conditional expressions, optional tests, collection methods, `ensures`, equality, and the needed list
construction/`sum` operations.

Teach agents only with `dt guide`, as in Phase 2 of the plan and ADR 0038. Stage the trial to isolate constructs: first
compare each bundled syntax family (logic/implication/optional tests; collections/size/regex;
conditional/arithmetic/list construction and `sum`; command contracts/equality), then run one integrated
recommended-syntax comparison against the current-syntax baseline for renamed constructs. Each task packet is one
attempt. For each paired comparison, use at least 12 independent attempts per arm, balanced across two pinned model
families. Set improvement as
at least +10 percentage points in first-pass parse or type-check rate, or at least 15% fewer repair tokens; set
regression as at least -10 percentage points or at least 15% more repair tokens. Aggregate all staged comparisons and
report uncertainty; do not declare a winner from one task. Compare token counts only within one model and one
requirement packet. Semantic correctness is a gate: reviewers blind to syntax variant judge normalized Typed Model
or Semantic IR dumps against a hidden acceptance matrix, then check scenario outcomes. Do not judge correctness from
source syntax or token count.

Record all six plan metrics: first syntax-check success, first type-check success, semantic correctness, repair count,
token use and repair success from diagnostics. Define repair count as diagnostic-driven edit cycles before passing or
exhaustion; repair success is whether those diagnostics lead to a passing check without changing the requirements. Also
record prompt, guide version, model/version, outputs, every diagnostic and repair, normalized model and scenario
results.
Report attempts per arm, paired comparisons, task packets, model families, and total runs as attempts per arm × 2 arms
× comparisons × tasks. For example, 12 attempts per arm × 2 arms × 5 staged comparisons (four families plus
integrated) × 3 task packets = 360 model runs; state the chosen task packet count and any bundling. Use at least two
reviewers blind to variant; adjudicate any disagreement with a third reviewer and report agreement and adjudication.
Keep the task packet and model budgets identical and randomize variant order. The exact model versions and pilot size
remain maintainer choices; ADR 0038 reports six Sonnet agents taught from `dt guide` only
([ADR 0038, six-agent trial](../../adr/0038-date-and-time.md#L11)).

## 6. Decisions still needed

1. Confirm the recommended surface forms and trial alternatives described above.
2. Confirm equality by declared type and its list/optional extensions, including Semantic IR equality kinds.
3. Set Int/Decimal arithmetic, `/` or `div`, division-by-zero, Decimal precision/rounding, and domain-primitive result
   rules.
4. Confirm `ensures` grammar position, `before`/`after` scope, diagnostics for kept fields, and create construction.
5. Decide whether to include list literals, concatenation/append, and `sum`; task (b) depends on `sum`.
6. Decide whether pure user-defined predicates remain deferred; no trial evidence is included here.
7. Confirm `dt migrate domain` reporting details and prototype implementation approach.
8. Confirm trial model versions and whether 12 attempts per variant are feasible.

## Report

Equality recommendation: distinguish owned entities from references, with structural list/optional comparison built from
the element/payload equality kinds. Semantic IR must preserve every kind through lowering. The `addItem` argument is:

1. Shop's real `requires newSku` says every existing item's SKU differs from `item.sku`
   ([shop command](../../../examples/shop/sales/order.dt#L43),
   [new-SKU requirement](../../../examples/shop/sales/order.dt#L45)).
2. Remove that requirement while keeping `changes items`; Level 2 leaves `items'` unconstrained, so the duplicate-SKU
   invariant can be violated without the removed input guard ([spike Level 2 result](spike/results.md#L61)).
3. Add `ensures { after.items == [...before.items, item] }`. With ordered structural list equality and owned
   `OrderItem` equality, the post-state must contain the exact prior list plus the parameter; choosing an existing
   SKU parameter now forces duplicate SKUs. The Level 3 no-successor probe must report `Counterexample found`,
   attributed to `addItem`, against `distinctSkus`.
4. Restore `requires newSku`. The duplicate input is disabled, all admitted appends preserve `distinctSkus`, and the
   correct AddItem-only run (`NextOnly_AddItem`) passes the Level 3 probe. This assumes append/list-literal and equality
   lowering are implemented consistently in Semantic IR and both checker backends, TLC and Apalache.

Still unconfirmed: exact arithmetic precision and exceptional behavior; final method/operator spellings; whether
`sum`, list literals and concatenation ship in this revision; equality's implementation details and verifier support;
prototype/model budget and trial sample feasibility. The migration behavior is confirmed by the current CLI help
([migration behavior](../../../apps/dt/src/cli/main.ts#L547)).
