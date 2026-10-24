# ADR 0021: Event and error fields named after their source

- Status: accepted
- Date: 2026-10-24

## Context

ADR 0018 and 0019 made a command's events, errors and changed fields an exact contract, but not the **values** in the
fields of its events and errors. An AI agent implementing `pay(at: Timestamp)` that returns
`AlreadyPaid { paidAt: Timestamp }` has to guess that `paidAt` comes from `at`. When the names line up (`paidAt`
parameter → `paidAt` field), there is nothing to guess.

## Decision

A naming convention: **name the fields of events and errors after their source** — a parameter of the command, a field
of such a parameter, or a field of the aggregate. A value computed in the implementation (a total, the number of days
overdue) needs no source.

M022 (warning) reports the likely mix-ups. For each command, each event it emits (every entry, any `when`) and each
error it may return (`errors` and `else`), each payload field (its own and those of its field sets) is checked against
the **sources**:

- the command's parameters, and the fields one level inside a single (or optional) parameter of a value object or
  entity type (`item.sku` for `item: OrderItem`);
- the aggregate's common fields (also from field sets) and the fields of the relevant states: for an event, the target
  states of the outcomes its entries apply to (the aggregate after the command); for an error, the source states (the
  aggregate before; a `create command` has none, so its errors see its parameters only).

A field is fine when a source has the same name and type. A field of the aggregate's ID type is exempt (it carries the
aggregate's identity, M017). Otherwise the field is reported if some source has its type, with up to three such
sources, the closest names first, and a hint to rename one of the two. Without a source of its type the value is
computed, and nothing is reported.

- **Same type**: the same base type (the same declaration, or the same built-in type). Optionality does not matter:
  an optional source may give a required field (after a check) and the other way round. A collection matches only a
  collection of the same element type.
- **Int, Decimal and Bool** fields are never reported: counts, sums and flags are computed so often that a source of
  the same built-in type says nothing about where the value comes from. Domain primitives on them (`Quantity`) are
  checked like any other type.
- An event emitted by several entries of one command is checked once, against the target states of all its entries,
  and reported at its first entry; an error is reported at its first `else` or `errors` reference.

### Deferred: a declarative mapping

`emits OrderConfirmed { confirmedAt = at }` would state each value in the model, and the generated contract could
then fill or check it. It was deferred: it adds syntax and generated code for what a name already says in most cases,
and the warning covers the cases where the names disagree. It can be added later if names do not suffice.

## Consequences

- Models whose event or error fields take their value from a differently named source of the same type get M022
  warnings; renaming the parameter (or the field) removes them.
- The shop example's `pay` takes `paidAt`, and the guide's `submit` takes the performer (`performedBy`) as a parameter.
