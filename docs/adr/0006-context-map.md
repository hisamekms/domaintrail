# ADR 0006: Context Map and focused Structure View

- Status: accepted
- Date: 2026-10-17

## Context

A model with several bounded contexts and dozens of aggregates (73 nodes and 87 edges in the first real model) is
hard to read in one Structure View. Worse, most dependencies between contexts are not drawn there at all: edges exist
only for owned / embedded entities and value objects and for `references`, while fields typed with another context's
ID, enum or domain primitive are invisible. In that model only 16 of about 200 uses of other contexts were edges.
Simply drawing a subset of contexts would hide even those.

## Decision

- **Dependencies are derived from the model** (`contextDependencies`): every field, state field, variant field,
  command parameter, emitted event / error and union `by` binding that uses an element of another context. Each use is
  `id` (a `references` field or an ID type) or `type` (anything else: value object, union, enum, domain primitive,
  event). Nothing is declared; this is a view of the model as written.
- **Context Map** (new view): one node per context with the count of its elements by kind, one edge per pair of
  contexts from the dependent to its dependency, labeled `ID n · 型 m`. Edges that borrow types are solid, ID-only
  edges dashed. *Supporting contexts* — shared contexts and contexts that only declare IDs (identity, partners,
  external systems) — are hidden by default because nearly everything depends on them. Selecting a context lists
  every use in the inspector, grouped by the other context (依存先 / 依存元).
- **Focused Structure View**: any number of contexts, picked in the toolbar, drawn in detail or as an overview (the
  detail / overview toggle applies as in the full view). Elements of other contexts that they use, and that use them,
  appear as name-only **stubs** inside their context, with one edge per pair of elements labeled with the fields;
  dependencies between two picked contexts join their elements directly. An ID is drawn as the aggregate or entity it
  identifies. Supporting contexts and uses inside events / errors (they repeat the aggregate's fields) are left out.
  An enum or domain primitive that another context uses appears as a stub inside its own context, since those kinds
  are not drawn in the Structure View.
- The server lays out the Context Map (with and without supporting contexts) on every update, like the State View
  graphs. Focused views cannot be precomputed (any combination of contexts can be picked), so the browser asks for
  them at `/api/focus?contexts=A,B&overview=1` (same trust checks as `/api/state`) and again when the model changes;
  the server keeps the 20 most recently used focused layouts. Node IDs of the Context Map (`map:<context>`) differ
  from the context group IDs of the Structure View, because shapes are reused by ID across views.

## Not decided here

Declaring the intended context map in the DSL and reporting dependencies it does not allow (and, later, restricting
what a relationship allows, e.g. IDs only for an anti-corruption layer) is the planned next step. Its syntax will be
chosen from the kinds of dependencies this view shows in real models.
