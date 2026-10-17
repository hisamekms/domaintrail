# ADR 0002: Japanese (display) names

- Status: accepted
- Date: 2026-10-17

## Context

Domain experts read the model in Japanese, while identifiers must remain valid, stable and suitable for generated
TypeScript. Writing a label at every use of a field (e.g. `orderId` in every event) duplicates definitions and drifts.

## Decision

- **Declarations** get an optional inline label: `aggregate Order "注文"`. They are declared once, so there is no duplication.
- **Fields and parameters** are labeled per name in a context-level glossary, `terms { confirmedAt: "確定日時" }`,
  following the ubiquitous-language rule that one name has one meaning within a bounded context.
  Resolution order: inline label → term → label of the type (or of the referenced aggregate) → English name.
- **Descriptions** are `///` comment lines directly above a declaration or term.
- Identifiers, stable IDs and generated TypeScript names stay English; labels change neither layout nor IDs.
- The Live View offers a 日本語 / English / 両方 toggle (stored per browser). Layout reserves the widest variant,
  counting full-width characters as 1.7 ASCII characters, so switching never relayouts.
- Warnings: L001 (inline label vs. term, conflicting context labels), L002 (unused term), L003 (same label for different
  things in one scope). A term defined twice in a context is an error (M002).

## Alternatives considered

- Labels inline everywhere: simplest, but the same label is repeated in aggregates, events and parameters.
- Japanese identifiers: generated type names become mixed-language and renaming a label changes stable IDs.
- A separate glossary for everything: one place, but declarations and their names drift apart.
