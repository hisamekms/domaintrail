---
status: draft
---

# Release notes in progress (formal verification and language revision)

The repository's changelogs list released versions only. Each change of this work that users see records its entry
here; at release, the entries become the version's CHANGELOG.md and CHANGELOG.ja.md sections.

## Changed

- A command's generated function type is now `<Command><Aggregate>Command` (for example, `DraftRotationCommand`) so a
  command may share a state's or kind's name. Derived names such as `<Command><Aggregate>Params` and
  `<Command><Aggregate>Decision` are unchanged.
- M011 no longer reports a command named like a state or a kind of its aggregate (`command draft` beside `state Draft`,
  `command pilot` beside `kind Pilot`).
- In generated contract tests, the slot for a command's requirements without an expression is keyed by the command type
  name: `declared: { Sales: { FinishOrderCommand: { known: … } } }` (was `FinishOrder`), so it no longer clashes with
  a type of that name. The slots of types keep their names.
- Logical operators are `&&`, `||` and `!`. `and`, `or`, `not` and `implies` are no longer DomainTrail syntax:
  `dt check` reports each one. Write an implication "if A then B" as `!(A) || B`. On the right of `||`, an optional that
  the left side shows present when it does not hold is narrowed, so `!exists(note) || note.length > 0` checks as
  `exists(note) implies …` did.

- Collection and string operations are methods: `xs.length` (lists and strings; in code points for strings),
  `xs.every(x => p)`, `xs.some(x => p)`, `xs.includes(x)`, `xs.unique()`, `xs.unique(x => key, …)`,
  `text.matches("pattern")`. `count`, `length`, `all`, `any`, `contains`, `unique` and `matches` as functions are no
  longer syntax: `dt check` reports each one. `x.length` is always the size of a list or a string: a field named
  `length` is no longer read through `.`.
- An optional value is compared with `null`: `x != null` replaces `exists(x)`, and `x == null` replaces
  `!exists(x)`. `x != null` narrows `x` on the right of `&&`, and `x == null` on the right of `||`. `exists` is no
  longer syntax, and `null` is valid only in such a comparison.
- `x?.f` reads a field of an optional value (absent when the value is), and `a ?? b` gives `a` when it is present, else
  `b` of the same type. Both compile to TypeScript's own `?.` and `??`.
- `test ? a : b` is a value or a condition by case: `days <= (express ? 2 : limit)`. Its branches see what the
  test shows: `note != null ? note.length > 0 : true`.
- Arithmetic: Int `+ - *` and Decimal `+ - * /` (exact; `/` rounds half-even to the larger declared scale). A
  Decimal declares its scale with `Decimal(n)` on fields, parameters and primitives, and `/` needs it. A divisor
  must be shown non-zero where it is divided by. The generated checks compute Decimals exactly with the runtime's
  `decimalAdd`, `decimalSub`, `decimalMul` and `decimalDiv`. `x.round(n)` rounds a Decimal half-even to `n` digits
  after the point. A Decimal of known scale larger than a declared `Decimal(n)` it is placed in (a field in
  `changes x = …`, a function's result or argument, a list element) is an error (M009) until it is rounded; a smaller
  scale widens. Before, `hours * rate` (scale 4) returned as a `Decimal(2)` checked clean.
- Lists: `[a, b]`, `[...xs, x]`, `xs.map(x => e)`, `xs.filter(x => p)`, `xs.sum(x => e)` and `xs.sum()`. A Decimal
  sum is exact.
- Functions: `function name(p: T, …): R { expr }` in a context is a pure, typed function of its parameters (a
  predicate when it returns Bool), called as `name(args)` from its context and, from a shared context, from every
  context. No recursion or call cycles (M032). Each becomes an exported TypeScript function.
- `match (u) { Variant { fields } => value, … }` over a union value: one case per variant, each once (a missing,
  unknown or repeated variant is an error), each case of one type, reading the variant's fields by name. It compiles
  to conditionals on the discriminator.
- Outcome contracts: `changes x = expr` gives a field's value after an outcome (over the parameters and `before.x`),
  and `ensures { … }` states a relation the result satisfies (over `before.x`, `after.x` and the parameters). A create
  outcome may list `id`. The generated `check<Command>Ensures` checks them (see Added).

- An outcome lists in `changes` every non-optional field it makes exist: a create every field of the new aggregate
  (`id` included; its common fields, its kind's and its target state's), a transition the fields new in its target
  state. The value stays optional: `changes f` says the field is set without saying to what, `changes f = expr` gives
  it. An optional field not listed starts as null. `changes` on a create command is no longer an error, and a field
  of the target state may be listed on a transition into it. `dt check` reports a missing field (M021).
- `==` and `!=` compare owned entities by all their fields, as value objects (ADR 0042); before, they compared only
  `id`. `xs.unique()` and `xs.includes(e)` over entities follow the same equality, and so does the generated
  `equal<Entity>`: two entities with the same `id` and another field are no longer equal. The Semantic IR's
  comparison kind for entities is `entityStructural` (was `entityId`). Compare IDs to compare identity: `a.id == b.id`.

## Added

- `dt migrate domain [files...] [--dry-run]` rewrites `.dt` files to the new syntax: `and` → `&&`, `or` → `||`,
  `not x` → `!x`, and `p implies q` → `!(p) || q`, with parentheses only where the meaning needs them. Comments and
  layout stay, and a second run changes nothing. It also rewrites `count(xs)` and `length(s)` to `.length`,
  `all`/`any` to `.every`/`.some`, `contains(xs, x)` to `xs.includes(x)`, `unique(xs, …)` to `xs.unique(…)`, and
  `matches(t, "r")` to `t.matches("r")`, and `exists(x)` / `!exists(x)` to `x != null` / `x == null`.
- `dt migrate domain` also completes `changes`: it adds each field an outcome makes exist and does not list, as
  `f = f` when the command has a parameter of that name and as `f` (value left open) otherwise, and prints each
  outcome it completed. Review the bare entries: write `f = …` where the model decides the value.
- `dt migrate domain` also rewrites each comparison of owned entities to the `id` it compared, so that a model keeps
  its meaning: `a == b` → `a.id == b.id` (and `!=`), `xs.unique()` → `xs.unique(x => x.id)`, an entity key of
  `xs.unique(x => key)` → `key.id`, and `xs.includes(e)` → `xs.some(x => x.id == e.id)`. Value objects, unions and
  IDs are left as they are. A comparison it cannot rewrite is listed as "not rewritten", to rewrite by hand.
- `"language"` in `domaintrail.jsonc`: the DomainTrail language version of the workspace's model (absent: 0).
  `dt migrate domain` runs each step that changes what a model means once, for the versions newer than the recorded
  one, then records the version reached (not with `--dry-run`, with files given, or while a file does not parse).
  Version 1 is the entity comparison rewrite above. `dt init` writes the current version, so a new model has no step
  to run.

- Generated postcondition checks (ADR 0043): `check<Command>Ensures(aggregate?, params?, value)` returns the first
  postcondition a command's success value violates, as a `Postcondition` (`id`, `outcome`, `kind`, `field`, `source`),
  or `undefined`. Per outcome it checks each `changes x = e`, then the frame — a field the outcome does not list in
  `changes` is the input's (`kind: 'unchanged'`), an optional field it makes exist without listing it is absent, and the kind is the input's —
  then each `&&`-conjunct of `ensures`. Values compare as `==` does (Decimals by value, lists element by element,
  value objects, owned entities and unions by their fields, dates and times by their canonical text). A command
  without any postcondition has none. The command and decision types document each `ensures` with an `@ensures` line.
- `decide`, `decideNamed` and `decideByKind` check the postconditions when given `{ ensures: Ctx.check<Command>Ensures }`
  in their last argument, which is now `Verify` (`applicable` and `choices` together or neither, and `ensures`;
  `ChoiceVerifier` stays as its other name): a violated postcondition throws `DomainTrail postcondition violated: <id>: <source>`, with
  the `Postcondition` as `cause`. It is a bug of the decision, not a domain error. The runtime also exports
  `SuccessOf<Command>`, the success value of a command.
- The Semantic IR gives `before` and `after` a `frame` symbol (they have no IR type).

## Upgrading

- No `dt migrate` step is needed for the command type rename: `dt migrate` changes `.dt` syntax, not generated TypeScript
  names. Regenerate TypeScript and update handwritten references to command function types to add the `Command` suffix.
  Rename the requirement keys in `declared` of contract tests the same way (`FinishOrder` → `FinishOrderCommand`).
- Run `dt migrate domain` in each workspace, then `dt check`, then `dt generate ts`. The generated checks keep their
  behaviour; their JSDoc shows the new spelling. Run it on the whole workspace (no files given): it rewrites the
  comparisons of owned entities to `id` and records `"language": 1` in `domaintrail.jsonc` (it creates the file when
  the workspace has none). Commit that change with the sources: later runs then leave a structural `a == b` as
  written. A workspace without the key is taken as version 0, and its entity comparisons are rewritten.
- A context with a type or value named `check<Command>Ensures` (for example `checkConfirmOrderEnsures`) now collides
  with the generated postcondition check (M011): rename it. So does one named `Verify`, `Postcondition` or `SuccessOf`,
  now names of the runtime that every context module may import. Code that implemented `ChoiceVerifier` keeps
  compiling: it gives both `applicable` and `choices`, as a `Verify` must (or neither).
- `dt check` reports more outcome contracts (M021): a `changes x = e` of the shorthand form is checked against `x` in
  every target that has it (before, a value of another type passed when not every target had `x`), and must have one
  target that has `x`; a field of the source of another type in the target is new there and must be listed;
  `before` / `after` cannot name a lambda parameter or a `match` binding in `changes` and `ensures`.
