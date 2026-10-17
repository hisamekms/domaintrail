# ADR 0004: Shared contexts

- Status: accepted
- Date: 2026-10-17

## Context

Domain primitives such as `EmailAddress` or `Money` are used by many bounded contexts. Before this, they had to live in
one context and be referenced as `Sales.Money`, which suggests an ownership that does not exist.

## Decision

- `shared context Name "label" { ... }` declares a shared kernel. All fragments of a context must agree on `shared`.
- Its elements are visible **by simple name** from every context. Resolution: own context → shared contexts →
  qualified names. A context element hiding a shared one is a warning; a simple name defined by two shared contexts is an error.
- It may contain only **value types**: domain primitives, enums, value objects, and `terms`. Aggregates, entities, IDs
  (they belong to an aggregate), events and errors are errors. It may depend only on shared contexts.
- Its `terms` are a fallback for field labels in every context: inline → own terms → shared terms → type.
- All of the above is rule **M014**.
- Generated TypeScript is unchanged in shape: `Common.ts`, imported by other contexts as `import type * as Common`.
- Live View: a **Primitives** view lists domain primitives per context (shared first) with base type, invariants,
  usage count and the contexts that use shared ones. Shared contexts are drawn with a teal frame in the Structure View,
  and their types are shown by simple name in diagrams.
