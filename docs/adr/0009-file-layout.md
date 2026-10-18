# ADR 0009: Recommended file layout

- Status: accepted
- Date: 2026-10-18

## Context

A context may be split across any number of `.dt` files, and file names carry no meaning. That freedom left no answer
to "where does this go?": the shop example had one file per context except Sales, split into `customer.dt` and
`order.dt`, with the context's name and description in `order.dt` only. People and AI agents adding an aggregate or
looking for one had to guess, and the context's own name, description and terms ended up in whichever file came first.

## Decision

A recommended ("basic") layout, used by `examples/shop` and described in the README:

```text
common/context.dt
sales/context.dt
sales/order.dt
sales/customer.dt
billing/context.dt
billing/invoice.dt
```

- **One directory per context, one file per aggregate**: `<context>/<aggregate>.dt`. The aggregate's file holds the
  aggregate and what only it uses — its ID, entities, events, errors, enums, primitives and values.
- **`<context>/context.dt`** holds what belongs to the context as a whole: its name (表示名), description and `terms`
  (the glossary is the context's, not an aggregate's), and the elements used by several of its aggregates or by none.
  The other files open the context without a name. A shared context has no aggregates, so it is only `context.dt`.
- **An aggregate's ID stays with the aggregate** even when other aggregates or contexts reference it: a reference by
  ID points at the aggregate, and moving the ID away would separate it from what it identifies.
- **kebab-case** directory and file names: `PurchaseOrder` → `purchase-order.dt`.
- **Recommended, not enforced.** No rule, warning or check looks at file names or directories; any layout keeps
  working, and `sources` in `domaintrail.jsonc` still decides which files belong to the workspace.

## Consequences

- Where to add or find an element follows from the model: its aggregate, or its context's `context.dt`.
- An element that comes to be used by a second aggregate moves to `context.dt`; the model and generated code do not
  change, since file placement has no meaning.
- Reorganizing `examples/shop` changed no element, relation or generated TypeScript, only element locations.
