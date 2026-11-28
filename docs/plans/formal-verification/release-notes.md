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

## Added

- `dt migrate domain [files...] [--dry-run]` rewrites `.dt` files to the new syntax: `and` → `&&`, `or` → `||`,
  `not x` → `!x`, and `p implies q` → `!(p) || q`, with parentheses only where the meaning needs them. Comments and
  layout stay, and a second run changes nothing.

## Upgrading

- Run `dt migrate domain` in each workspace, then `dt check`, then `dt generate ts`. The generated checks keep their
  behaviour; their JSDoc shows the new spelling.
