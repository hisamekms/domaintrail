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
  `decimalAdd`, `decimalSub`, `decimalMul` and `decimalDiv`.
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
  outcome may list `id`. The generated code does not check them yet (Phase 3).

- An outcome lists in `changes` every non-optional field it makes exist: a create every field of the new aggregate
  (`id` included; its common fields, its kind's and its target state's), a transition the fields new in its target
  state. The value stays optional: `changes f` says the field is set without saying to what, `changes f = expr` gives
  it. An optional field not listed starts as null. `changes` on a create command is no longer an error, and a field
  of the target state may be listed on a transition into it. `dt check` reports a missing field (M021).

## Added

- `dt migrate domain [files...] [--dry-run]` rewrites `.dt` files to the new syntax: `and` → `&&`, `or` → `||`,
  `not x` → `!x`, and `p implies q` → `!(p) || q`, with parentheses only where the meaning needs them. Comments and
  layout stay, and a second run changes nothing. It also rewrites `count(xs)` and `length(s)` to `.length`,
  `all`/`any` to `.every`/`.some`, `contains(xs, x)` to `xs.includes(x)`, `unique(xs, …)` to `xs.unique(…)`, and
  `matches(t, "r")` to `t.matches("r")`, and `exists(x)` / `!exists(x)` to `x != null` / `x == null`.
- `dt migrate domain` also completes `changes`: it adds each field an outcome makes exist and does not list, as
  `f = f` when the command has a parameter of that name and as `f` (value left open) otherwise, and prints each
  outcome it completed. Review the bare entries: write `f = …` where the model decides the value.

## Upgrading

- No `dt migrate` step is needed for the command type rename: `dt migrate` changes `.dt` syntax, not generated TypeScript
  names. Regenerate TypeScript and update handwritten references to command function types to add the `Command` suffix.
- Run `dt migrate domain` in each workspace, then `dt check`, then `dt generate ts`. The generated checks keep their
  behaviour; their JSDoc shows the new spelling.
