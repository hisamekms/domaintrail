# ADR 0001: MVP implementation decisions

- Status: accepted
- Date: 2026-10-17
- Context: resolves the open items of the MVP spec v0.1 (§11) and records implementation choices.

## Decisions

### Runtime and tooling

Bun (pinned via `mise.toml`) is the package manager, script runner, test runner (`bun test`) and HTTP/WebSocket server (`Bun.serve`).
Type checking runs `tsc --noEmit` through `bun run typecheck`. The CLI runs TypeScript directly; there is no build step.

### TypeScript representations (§11)

| DSL | TypeScript |
|---|---|
| `Timestamp` | `Date` (alias `Timestamp` exported from `_runtime.ts`) |
| `Decimal` | `string & { readonly __brand: 'Decimal' }` — no precision loss |
| `UUID`, `String` | `string` |
| `Int` | `number` |
| `id X: UUID` | `string & { readonly __domain: 'Ctx.X' }` (see ADR 0003) |
| `?`, `[0..1]` | optional property / `T \| undefined` parameter |
| `[0..*]` | `readonly T[]` |
| `[1..*]` | `readonly [T, ...T[]]` |

A command without `emits` returns `readonly never[]` as its event list; without `errors` its error type is `never`.

### Command syntax (§11)

> Superseded by [ADR 0014](0014-command-transitions.md): `from` / `to` were replaced by transitions (`Draft -> Confirmed`,
> `create command place(...) -> Draft`).

- Factory commands: `create command place(...) to Draft`. They have no `from` and no aggregate parameter.
- Multiple output states: `to A | B`; the success value is the union `AAgg | BAgg`.
- Aggregates without states: commands have neither `from` nor `to`; input and output are the aggregate type.

### Stable IDs and layout state (§11)

Stable IDs are fully qualified names: `Sales.Order`, `Sales.Order#Confirmed` (state), `Sales.Order:confirm` (command).
Renaming an element therefore changes its ID. Layouts are stored in `<root>/.domaintrail/layout.json`, separate from the DSL,
keyed by graph and validated by a graph signature (node IDs, sizes, nesting, edges). A layout is recomputed only when
the signature changes.

### Layout engine (§7, §11)

D2 is not installed in the target environment and TALA requires a license, so the MVP uses **ELK (elkjs, layered)**
behind a `LayoutEngine` interface (`src/layout/engine.ts`). A D2/TALA adapter can implement the same interface later.
Under Bun, `elk.bundled.js` misdetects the environment, so ELK runs in a Bun `Worker` via `elk-api`.

Verification result for mapping layout output to tldraw: node coordinates map directly to custom box shapes.
Edge routes do **not** map well to tldraw's bound arrows (an elbow arrow supports a single midpoint, so multi-bend routes and
self-loops are lost and edges cross nodes). Edges are therefore drawn with a custom `domain-edge` shape that follows the
layout route and label position exactly. Future GUI editing will need either relayout on change or bound arrows for
simple routes.

### Validation scope

- "Valid model" for the Live View means *parseable*: models with semantic errors are still drawn, with error markers on
  the affected nodes. Only lexer/parser errors freeze the diagram at the last parseable model.
- The diff baseline is the previously shown model; diagnostics-only updates do not reset highlights.
- Rule **M013** was added: aggregates and entities need an `id` field of their own ID type (required to check M005).
- M003 also warns about entities owned by no aggregate.
- M004 covers: plain fields of entity/aggregate type, `owns` of non-entity/VO types, owning another aggregate,
  value objects owning entities, owning entities of another context, aggregates used as event/error/param types.

### Generated code

One module per context (`Sales.ts`), a shared `_runtime.ts` (`Result`, `ok`, `err`, `Decimal`, `Timestamp`) and `index.ts`
re-exporting contexts as namespaces. Cross-context types are referenced as `import type * as Other`. Names:
`<State><Aggregate>` (state type), `<Aggregate>Common`, `<Command><Aggregate>` (command function type),
`<Aggregate>Commands` (interface to implement). Events and errors carry a `type` discriminant; aggregate states a `state`
discriminant. M011 checks collisions among these names, runtime names, context imports and reserved words.
