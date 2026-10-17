# ADR 0003: Domain primitives

- Status: accepted
- Date: 2026-10-17

## Definition

A **domain primitive** is an indivisible single value with domain meaning and constraints. It is immutable, compared by
value, distinguished by type from other concepts with the same base type, and may declare invariants.

```text
Domain Primitive
├─ wrapped type (branded / newtype)   primitive Quantity: Int { value > 0 }
│  └─ ID                              id InvoiceNo: String { matches(value, "^INV-\d{8}$") }
└─ closed set of literals             enum CancelReason { Requested Other }
```

## Decisions

- **Boundary with value objects**: domain primitives are single values; anything with several fields is a value object.
- **ID**: a wrapped domain primitive with the role of identity. It may declare invariants. Only IDs can be the `id` field of
  aggregates/entities and the type of `references` (M005, M013 unchanged).
- **Base type**: a primitive type only. Refinements of other domain primitives or enum subsets are out of scope.
- **Invariants**: `{ expr }` (named `valid`) or named `invariant` blocks. Only `value`, typed as the base primitive, is in
  scope. Added `length(x)`, `matches(x, "regex")` and `x in lo..hi`, plus negative literals. Enums have no invariants.
- **Regular expressions** are taken from the source text without string unescaping, so they read like JavaScript regexes;
  invalid patterns are M009.
- **Use in other invariants**: a domain primitive compares with literals of a compatible base type and with the same
  domain primitive. Comparing different domain primitives, or a domain primitive with a plain field, is M009.
- **Generated TypeScript**: `type Quantity = number & { readonly __domain: 'Sales.Quantity' }`, `InvalidQuantity`
  (`type`, `value`, `invariant` = union of invariant names) and `MakeQuantity = (value: number) => Result<Quantity, InvalidQuantity>`.
  Without invariants the constructor cannot fail: `(value: string) => OrderId`. Constructors are hand-written; the
  generator does not produce run-time validators (out of the MVP scope). The brand key is `__domain` so that it composes
  with `Decimal`'s own `__brand`.
- **Live View**: domain primitives are not drawn in the Structure View; the element list and detail panel show their
  base type, invariants and where they are used.

## Not done

- A hint for "primitive obsession" (plain `String`/`Int` fields in aggregates) — would be noisy on existing models.
