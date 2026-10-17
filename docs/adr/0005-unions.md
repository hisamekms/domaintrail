# ADR 0005: Unions

- Status: accepted
- Date: 2026-10-17

## Context

Real domain code is full of tagged unions whose shape depends on a kind: an actor is an internal user or an external
party, specification details differ per process type, a cost originates from a work result, an instruction or a manual
entry. Without unions they had to be written as an enum plus optional fields guarded by `implies exists(...)`
invariants, which is verbose and generates a different TypeScript shape than the code it describes.

Aggregates already generate tagged unions from their states. The two must not overlap:

- **State** is a lifecycle. The same thing (same identity) moves between states over time through commands.
- **Union** is a classification. The kind is decided when the value is made and never moves; changing it means
  replacing the value.

The test is "is there a command that changes it?": yes → state, no → union.

## Decision

```text
union Actor "行為者" {                                   // discriminator `kind` by default
  INTERNAL_USER "社内ユーザー" { userId: UserId }
  EXTERNAL_PARTY "社外" { name: ActorName  contractorId: ContractorId? }
}

union SpecificationDetails "工程別の仕様" by type: ProcessType {   // discriminator name, bound to an enum
  DELIVERY { details: DeliverySpecification }
  TRANSPORT { details: TransportSpecification }
  ...
}

union GeographicCoverage by kind {
  DESCRIPTION { description: String }
}
```

- A union is a **value type**: it is usable wherever a value object is (plain fields, `owns`, parameters, event and
  error payloads, other value objects and unions) and may live in a shared context. Aggregates are never unions; an
  aggregate whose shape depends on a fixed kind holds a union-typed field.
- `by name` sets the discriminator property (default `kind`). `by name: Enum` binds the discriminator to an enum:
  the variants must be exactly the enum's values (M015), and a variant without a label uses the enum value's label.
- A variant has a name (the discriminator value), an optional label and `///` description, and an optional body of
  fields and invariants. Variant invariants see the variant's fields. A variant field may not be named like the
  discriminator.
- Variant fields follow the rules of value object fields (M004: no entities, no aggregates; `references` allowed).
- Invariants: `x.kind` (the discriminator) has the bound enum's type, or the union's own tag type; a tag is written
  `Actor.EXTERNAL_PARTY` and compares with `==` / `!=`. Variant fields are not accessible from outside the union
  (there is no narrowing).
- Rules: **M015** — a union has at least one variant; with `by name: Enum`, the variants match the enum's values
  exactly; no variant field is named like the discriminator. Duplicate variants, and duplicate fields or invariants
  within a variant, are M002 as for enums and value objects.
- Generated TypeScript: one type alias, a union of object types tagged with the discriminator
  (`{ readonly kind: 'INTERNAL_USER'; readonly userId: UserId } | ...`), labels and descriptions as JSDoc.
- Live View: unions appear in the Structure View like value objects («union»), with one row per variant followed by
  its fields; value edges go from the union to the types its variants use. The Detail Panel lists variants.

Entity states (a lifecycle of an entity inside an aggregate) are a separate question and not part of this decision.
