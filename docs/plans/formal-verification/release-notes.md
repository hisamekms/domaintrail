---
status: draft
---

# Release notes in progress (formal verification and language revision)

The repository's changelogs list released versions only. Each change of this work that users see records its entry
here; at release, the entries become the version's CHANGELOG.md and CHANGELOG.ja.md sections.

## Changed

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

## Added

- `dt migrate domain [files...] [--dry-run]` rewrites `.dt` files to the new syntax: `and` → `&&`, `or` → `||`,
  `not x` → `!x`, and `p implies q` → `!(p) || q`, with parentheses only where the meaning needs them. Comments and
  layout stay, and a second run changes nothing. It also rewrites `count(xs)` and `length(s)` to `.length`,
  `all`/`any` to `.every`/`.some`, `contains(xs, x)` to `xs.includes(x)`, `unique(xs, …)` to `xs.unique(…)`, and
  `matches(t, "r")` to `t.matches("r")`, and `exists(x)` / `!exists(x)` to `x != null` / `x == null`.

## Upgrading

- Run `dt migrate domain` in each workspace, then `dt check`, then `dt generate ts`. The generated checks keep their
  behaviour; their JSDoc shows the new spelling.
