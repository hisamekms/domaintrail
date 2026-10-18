# ADR 0013: Field sets, domain and technical fields, and technical metadata

- Status: accepted
- Date: 2026-10-18

## Context

Models repeat fields: a tenant on every aggregate of a multi-tenant system, the performer an audit regulation requires
on events. Written out each time, they drift apart (names, labels, types), and nothing says that they belong together.

Other fields are asked for again and again but do not belong in the domain model at all: event IDs, record times,
optimistic-lock versions, correlation IDs, the system account that ran a command. Users and AI agents need a rule to
tell the two apart, and a way to attach the technical ones to the generated types without editing them (ADR 0011).

## Decision

### Domain or technical

The question to ask of a field: **do domain experts talk about it, or does a business rule (an invariant, a
transition, a command's decision) refer to it?** If either, it is a domain field and is written in the DSL; if
neither, it is technical.

- Fields that **every element of a kind** has (the ID of an aggregate or entity) are enforced by the language (M013),
  not expressed with `with`.
- Domain fields that are **chosen for some elements** are written once as a field set and taken on with `with`.
- **Technical fields** — event ID, the time the system recorded something, optimistic-lock version,
  `createdAt` / `updatedAt`, correlation / causation IDs, the system's acting account, schema versions — are in neither
  the DSL nor the generated code. Users' code wraps the generated types with them.

The guide spells out the two cases that look alike: the business time of an event (domain, named by its meaning:
`confirmedAt`; or `fields Occurred { occurredAt }` when every event is to carry it) versus the time the system recorded
it (technical), and a business role (domain, named by the role: `approvedBy`; or `fields Performed { performedBy }` when
regulations require it everywhere) versus the login or service account (technical). They differ with late entry,
offline work, imports, proxy entry and batches.

### Field sets

```text
shared context Common {
  fields Tenanted "テナント所属" { tenant: TenantId "テナント" }
}
context Sales {
  aggregate Order "注文" with Common.Tenanted { ... }
  event OrderPlaced with Tenanted, Audited { orderId: OrderId }
}
```

- `fields Name "label" { ... }` is a context element (label and `///` description as usual). It holds **plain fields
  only**, written like other fields. `owns`, `references`, invariants, `with` and a field named `id` are errors
  (M016): ownership and references belong to an aggregate's own structure, and identity is per kind (M013).
- `with A, B` goes after the name and label of an **aggregate, entity or event**. On a value object, an error or a
  field set it is an M016 error (the grammar accepts it there so that the message can say why); elsewhere it is a
  syntax error.
- Field sets are referenced like types: by name in their own context and from shared contexts, `Context.Name`
  otherwise. Shared contexts may hold field sets; M014's rule that a shared context depends only on shared contexts
  applies to their field types (so a tenant ID in a shared context is a domain primitive, not an `id`).
- The fields of field sets come **first**, in the order of `with`, and are the element's fields from then on:
  invariants see them, the states of an aggregate share them, labels resolve as they do in the field set. A name comes
  from one place only — the element or one of its field sets — else M016; repeating a field set in `with` is a
  warning.
- Typed Model: a field set is an element of kind `fieldSet`. Elements list their field sets in `fieldSets` and carry
  the expanded fields in `fields`, each marked with the `fieldSet` it comes from. Uses of other contexts by a field
  set's fields count once, for the field set; an element's `with` is a type dependency on the field set.

### Events carry the ID of their aggregate (M017)

An event emitted by a command of an aggregate should say which aggregate it is about: it needs a field whose type is
the aggregate's ID type, its own or from a field set; optional and repeated fields count. An event emitted by commands
of several aggregates needs the ID type of **each** of them: each emission belongs to one aggregate's history, and a
consumer must be able to find that aggregate whichever emitted it. "Any one of them" was rejected, as it would let an
event lose track of the aggregate it came from. M017 is a warning, reported once per aggregate and event at the first
command that emits it.

### Generated TypeScript

- A field set → `export interface Tenanted { readonly tenant: TenantId }` in its context's module, with the label and
  description as JSDoc.
- An element with `with` → `extends` the field sets (`interface Order extends Common.Tenanted`, other contexts through
  the existing namespace imports); for a stateful aggregate, `OrderCommon` extends them. The fields are not repeated.
- Unions of what the DSL lists, like `PersistentEvent` (ADR 0008), each generated only when it would have a member:
  `DomainEvent` (every event of the context), `Aggregate` (every aggregate of the context) and `<Aggregate>Event` (the
  events the aggregate's commands may emit, also of other contexts). Their names are checked by M011.

### Technical metadata

The guide shows how to attach it; nothing is generated.

- An **envelope** `{ readonly event: E; readonly meta: M }` is recommended over an intersection `E & Meta`: no name
  clashes between domain and technical fields, and the two stay apart in code. No `Envelope` type is generated:
  what goes in it is the user's choice.
- Examples in the guide, type-checked by a test against the code generated for `examples/shop`: an `EventMeta`
  interface extended per context (`SalesEventMeta`) with `Stored<E, M extends EventMeta = EventMeta>`; metadata per
  kind of event keyed by `type` (`MetaByEvent`, `MetaOf<E>`); and `Versioned<A, M extends AggregateMeta>` for
  aggregates.

### Rejected

- **Declaring metadata in the config file** so that the generator adds it: the generated code would then hold what does
  not follow from the DSL, against ADR 0011.
- **Generated code importing users' metadata types**: the dependency would point from the generated code to users'
  code, the wrong way (ADR 0011).
- **Field sets for identity** (`with Identified`): identity is required of every aggregate and entity and checked by
  M013; making it optional would weaken that.

## Consequences

- Repeated domain fields are declared once; the Live View shows them at the top of each element's fields with the field
  set they come from, and lists the elements using a field set.
- `fields` and `with` are new keywords; they stay usable as field and parameter names.
- Models whose events do not carry the ID of the aggregate emitting them now get M017 warnings.
- Generated modules gain `DomainEvent`, `Aggregate` and `<Aggregate>Event`; a model with an element of one of those
  names now gets M011.
