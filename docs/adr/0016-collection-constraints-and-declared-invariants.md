# ADR 0016: Collection constraints and declared invariants

- Status: accepted
- Date: 2026-10-23

## Context

Modeling a "software factory" (tasks, scenarios, reviewers, confirmations) showed constraints that invariant
expressions could not state:

- Distinctness: a confirmation per scenario and reviewer, one line per SKU. Only `count`, `all` and `any` worked on
  collections, and no expression compared two elements of one collection.
- Membership: an approver is one of the policy's approvers; every required scenario is confirmed.
- Constraints beyond the DSL: task dependencies have no cycle, an email address is unique across customers. They
  could only be written as comments, invisible to the Live View and the generated contract.

The equality used by `==` was never stated for value objects, entities and unions, although the checker already
allowed `==` between two values of the same type.

The expression language stays "structure and contracts": Bool-valued, side-effect-free judgments over the element's
own data. This ADR adds the smallest set that covers the cases above, without tuples, user-defined predicates or
constructs that compute values.

## Decision

### Equality

`==`, `!=`, `unique` and `contains` compare by one rule (the checker's `equatable`):

- primitives and domain primitives by value (a domain primitive also with a literal of its base type), enums by value;
- value objects structurally, by all their fields;
- entities by `id`;
- union values by discriminator and fields.

Both sides must have the same type. Collections and optional values are not equatable, as before. This is a contract
for code that checks the invariants; the type rules do not change.

### `unique`

```dt
unique(keys)                                         // the elements are distinct (entities: by id)
unique(lines, l => l.sku)
unique(confirmations, c => c.scenario, c.reviewer)  // the combination is distinct
```

- One function: without a lambda the elements are compared, with a lambda the keys it lists, as a combination.
- M009: the first argument is a collection; without keys its elements, with keys each key, must be equatable.
- A key cannot be optional. There is no `exists` narrowing inside the lambda, and an optional key would need a rule
  for whether two absent values are equal. The message suggests grouping the keys into a value object, which then
  compares structurally, absent fields included.
- The result is Bool.

### `contains`

```dt
contains(policy.approvers, person)
all(required, s => contains(confirmed, s))   // a subset
```

- M009: the first argument is a collection; its element type and `x` must be equatable (`==` between them is
  allowed). An optional `x` gets the hint of `==`: guard it with `exists(...)` first.

### Invariants without an expression

```dt
/// depends を辺とするグラフに閉路がない
invariant acyclicDeps "タスク依存が循環しない"
```

- Grammar: `'invariant' name=ID label=STRING? ('{' expr=Expression '}')?`.
- M018: an invariant without an expression needs a label or a `///` description, so that it says what it requires.
- Allowed wherever invariants are, including the named invariants of domain primitives. There its name joins the
  `invariant` union of `Invalid<Name>`, since the hand-written constructor checks it. The anonymous constraint
  `{ value > 0 }` is unchanged.
- The Typed Model's `InvariantModel.source` is absent for such an invariant. The generated JSDoc reads
  `@invariant acyclicDeps (タスク依存が循環しない): not expressed in the DSL`, and the Live View shows
  「DSL では表現していない」 where an expression would be.
- In ADR 0011's direction for generating invariant checks, these are the invariants that would get a slot to
  implement rather than a generated check. Declaring them now names that slot.

### Function names as field names

`unique` and `contains` are keywords, and a field named like them would no longer parse. They are added to
`FeatureName` (like `by`), so they still name fields, parameters and lambda parameters; followed by `(` they are the
functions. `count`, `exists`, `length`, `matches`, `all` and `any` had the same problem (a field `count: Int` was a
syntax error) and are added in the same way.

### Deferred

- **Command preconditions** (`requires` on commands): a contract on inputs rather than on the element's data; needs
  its own scope rules (parameters, the source state). Decided in [ADR 0017](0017-command-requirements.md).
- **User-defined predicates** (`predicate`): reuse across invariants is wanted, but names, parameters and recursion
  make it a language of its own.
- **`sameSet` / `subsetOf`**: expressible as `all(a, x => contains(b, x))` (and both directions for equality).
- **A dedicated `acyclic`**: graph properties need paths over references; declared as an invariant without an
  expression for now.
- **Uniqueness across aggregates** (an email address unique among customers): an invariant sees only its element's
  own data; declared without an expression.

## Consequences

- Distinctness and membership are checked by type like the other functions, and documented in the generated JSDoc.
- Constraints beyond the DSL appear in the model, the Live View and the generated contract instead of in comments;
  only their wording is checked.
- Code that checks invariants by hand has one equality to follow for `==`, `unique` and `contains`.
- Fields may be named `count`, `unique`, `contains` and the other function names.
- `InvariantModel.source` is optional; consumers of the Typed Model handle its absence.
