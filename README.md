# DomainTrail

A type-checkable domain modeling DSL shared by humans and AI.
AI agents edit `.dt` files; humans watch the model update live in the browser and give feedback.
The DSL is the single source of truth for domain **structure and contracts** — it generates TypeScript types and command
contracts, never business logic.

## Setup

Requires Node.js 22.12 or later.

```bash
npm install -D domaintrail   # then: npx dt <command>
npx domaintrail <command>    # or run it without installing
```

## CLI

```bash
dt -r <root> check             # validate syntax, references, types and DDD rules
dt -r <root> generate ts       # generate TypeScript into <root>/generated/domain (--out to change)
dt -r <root> view              # Live View at http://127.0.0.1:4321 (--port, --host)
```

The package installs the same command under two names: `dt` for everyday use and `domaintrail`, its full name, for
when `dt` clashes with another command or a script should spell it out (CI, for example).

`<root>` defaults to the current directory; every `*.dt` file below it (except `node_modules`, `.git`, `.dt`)
belongs to the workspace.

`check` prints diagnostics as `file:line:col - error M00X: message` and exits non-zero on errors.
`generate ts` runs `check` first and generates nothing if there are errors.

Try it with the example in this repository (see [Development](#development)):

```bash
bun run dt -r examples/shop check
bun run dt -r examples/shop generate ts   # then examples/shop/src/order-commands.ts type-checks against it
bun run build && bun run dt -r examples/shop view
```

## Configuration

Put `domaintrail.jsonc` (comments allowed) or `domaintrail.json` at the project root. The CLI looks for it in `--root` (default: the
current directory) and its parents, like `tsconfig.json`; `--config <file>` picks one explicitly. All paths are relative
to the config file. Without a config file, the defaults below apply with `--root` as the base.

```jsonc
{
  "$schema": "./node_modules/domaintrail/schema/domaintrail.schema.json",
  // globs of DSL files; "!" excludes (node_modules, .git, .domaintrail are never scanned)
  "sources": ["domain/**/*.dt", "!domain/drafts/**"],   // default: ["**/*.dt"]
  "generate": { "ts": { "out": "src/domain/generated" } },  // default: generated/domain
  "view": { "port": 4321, "host": "127.0.0.1" }
}
```

CLI options win over the file: `generate ts --out`, `view --port`, `view --host`. Sources must stay inside the config
file's directory. The JSON Schema is `schema/domaintrail.schema.json`.

## DSL

```text
context Sales {                          // a bounded context; may be split across files
  id OrderId: UUID                       // ID type with base primitive (UUID | String | Int)
  enum CancelReason { Requested Other }
  value Money { amount: Decimal currency: String }

  aggregate Order {
    id: OrderId                          // identity field (required)
    owns items: OrderItem[0..*]          // ownership inside the aggregate
    references customer: CustomerId -> Customer   // reference to another aggregate by ID
    note: String?

    invariant quantitiesPositive {       // applies to every state; common fields only
      all(items, item => item.quantity > 0)
    }

    create command place(customer: CustomerId) to Draft emits OrderPlaced   // factory

    state Draft
    state Confirmed {
      confirmedAt: Timestamp             // exists only in this state
      invariant hasItems { count(items) > 0 }   // common + Confirmed fields
    }
    state Cancelled { reason: CancelReason }

    command confirm(at: Timestamp)
      from Draft
      to Confirmed                       // several: `to A | B`
      emits OrderConfirmed               // events that MAY be emitted (0..n)
      errors EmptyOrder

    command cancel(reason: CancelReason) from Draft | Confirmed to Cancelled emits OrderCancelled
  }

  entity OrderItem { id: OrderItemId quantity: Int owns unitPrice: Money }
  persistent event OrderConfirmed { orderId: OrderId confirmedAt: Timestamp }   // persisted by contract
  event OrderViewed { orderId: OrderId }   // not persisted (default)
  error EmptyOrder                       // payload optional: error E { field: Type }
}
```

- Primitives: `String`, `Int`, `Decimal`, `Bool`, `Timestamp`, `UUID`.
- Multiplicity: `?`, `[0..1]`, `[0..*]`, `[1..*]`, `[n..m]`.
- Other contexts are referenced with qualified names: `Sales.OrderId`, `-> Sales.Order`.
- Aggregates without states write commands without `from`/`to`.
- Invariant expressions: literals, field paths (`item.quantity`), `== != < <= > >=`, `and or not implies`,
  `exists(x)` (narrows `x` on the right of `and`/`implies`), `count(c)`, `all(c, x => …)`, `any(c, x => …)`,
  enum values (`CancelReason.Other`). Only the type of an invariant is checked, not whether it holds.
- Comments: `// …` and `/* … */`.
- `persistent event` declares that storing the event is part of its contract; events without it are not persisted.
  How events are stored is out of scope (see [ADR 0008](docs/adr/0008-persistent-events.md)).

### Domain primitives

A domain primitive is an indivisible single value with domain meaning and constraints. Values that combine several
fields are value objects.

```text
primitive Quantity "数量": Int { value in 1..999 }          // one anonymous constraint
primitive EmailAddress: String {                            // or named invariants
  invariant format "形式" { matches(value, "^[^@\s]+@[^@\s]+$") }
  invariant maxLength { length(value) <= 254 }
}
id InvoiceNo: String { matches(value, "^INV-\d{8}$") }      // an ID is a domain primitive used as identity
enum CancelReason { Requested Other }                       // a closed set of literals
```

- The base is always a primitive type; refining another domain primitive or enum is not supported.
- Inside the constraint only `value` (of the base type) is visible. Extra functions: `length(value)`,
  `matches(value, "regex")` and ranges `value in 1..999` (negative literals allowed).
- Regular expressions are written as in JavaScript: backslashes are not string escapes (`"\d"` means `\d`).
- Elsewhere, a domain primitive compares with literals and with the same domain primitive (`quantity > 0`,
  `quantity <= maxQuantity`), but not with another domain primitive or a plain field of its base type (M009).
- Only IDs can be identity fields and reference types. Domain primitives cannot be owned.
- Generated: a branded type, an `Invalid<Name>` error naming the violated invariant, and a constructor contract
  `Make<Name> = (value) => Result<Name, Invalid<Name>>` (just `(value) => Name` without invariants) to implement by hand,
  e.g. `examples/shop/src/primitives.ts`.

### Unions

A union is a value whose shape depends on a kind fixed when it is made: a tagged union of variants. Use a union for a
classification that never changes, and aggregate states for a lifecycle that commands move through
(see [ADR 0005](docs/adr/0005-unions.md)).

```text
union Actor "行為者" {                                      // discriminator `kind` by default
  INTERNAL_USER "社内ユーザー" { userId: UserId }
  EXTERNAL_PARTY "社外" { name: ActorName  contractorId: ContractorId? }
}
union SpecificationDetails by type: ProcessType {          // `by name`, optionally bound to an enum
  DELIVERY { details: DeliverySpecification }              // exactly the enum's values (M015)
  TRANSPORT { details: TransportSpecification }
}
```

- A union is a value type: usable like a value object (fields, `owns`, parameters, payloads, shared contexts).
  Variants hold value fields and invariants (seeing their own fields); entities and aggregates are not allowed.
- In invariants, `actor.kind` compares with `Actor.EXTERNAL_PARTY` (or with the bound enum's values); variant fields
  are not accessible from outside the union.
- Generated: `export type Actor = { readonly kind: 'INTERNAL_USER'; readonly userId: UserId } | { ... }`.
  A variant without a label takes the label of its enum value.

### Shared contexts

```text
shared context Common "共通" {            // shared kernel
  terms { currency: "通貨" }
  enum Currency { JPY USD }
  value Money { amount: Decimal currency: Currency }
  primitive EmailAddress: String { ... }
}
context Sales {
  aggregate Customer { id: CustomerId email: EmailAddress balance: Money }   // simple names
}
```

- Elements of a shared context are usable by simple name from every context (`Common.Money` also works).
  A context's own element with the same name wins, with an M014 warning.
- A shared context holds only domain primitives, enums, value objects, unions and terms, and depends only on shared contexts.
- Its `terms` apply to fields of every context that has no term of its own for the name.

### Japanese names (表示名)

```text
context Sales "販売" {
  terms {                                  // field / parameter names, defined once per context
    /// 顧客が注文を確定した日時。               // `///` = description
    confirmedAt: "確定日時"
  }

  /// 顧客からの購入依頼。
  aggregate Order "注文" {                 // declarations: a string after the name
    owns items: OrderItem[0..*] "明細"     // inline label on a field overrides the term
    state Confirmed "確定済み" { confirmedAt: Timestamp }   // → 確定日時 (from terms)
    invariant hasItems "明細が1件以上" { count(items) > 0 }
    command confirm(at: Timestamp) "注文を確定する" from Draft to Confirmed
  }
  enum CancelReason "取消理由" { Requested "顧客都合" Other "その他" }
}
```

- Declarations (context, id, enum and its values, value, entity, aggregate, state, command, invariant, event, error)
  take an optional string after the name.
- A field or parameter is named by, in order: its inline string → the context's `terms` → the name of its type
  (for `references`, the target aggregate) → the English name.
- `///` lines directly above a declaration or term are its description.
- Names are shown in the Live View (toggle 日本語 / English / 両方), the detail panel, and as JSDoc in generated TypeScript.
  Identifiers, stable IDs and generated type names stay English.

### File layout (recommended)

File names and directories carry no meaning — a context may be split across any files. The recommended layout, used by
`examples/shop`, is one directory per context and one file per aggregate:

```text
common/context.dt      shared context Common "共通" { ... }        // a shared context has no aggregates
sales/context.dt       /// 説明  context Sales "販売" { terms { ... } }
sales/order.dt         context Sales { id OrderId ...  aggregate Order { ... }  entity OrderItem ...  event OrderPlaced ... }
sales/customer.dt      context Sales { id CustomerId ...  aggregate Customer { ... } }
billing/context.dt     /// 説明  context Billing "請求" { terms { ... } }
billing/invoice.dt     context Billing { id InvoiceId ...  aggregate Invoice { ... } }
```

- `<context>/<aggregate>.dt` holds the aggregate and what only it uses: its ID, entities, events, errors, enums,
  primitives and values.
- `<context>/context.dt` holds the context's name (表示名), description and `terms`, and the elements used by several
  of its aggregates or by none. The other files open the context without a name: `context Sales { ... }`.
- An aggregate's ID stays in the aggregate's file even when other aggregates reference it.
- Directory and file names are kebab-case: `PurchaseOrder` → `purchase-order.dt`, `OrderFulfillment` →
  `order-fulfillment/`.

This is a convention, not a rule: `check` neither requires nor warns about any layout (see [ADR 0009](docs/adr/0009-file-layout.md)).

## Rules

| ID | Check |
|---|---|
| SYNTAX | lexer / parser errors |
| M001 | types, aggregates and names in invariants resolve |
| M002 | names are unique in their scope (also across files of one context) |
| M003 | an entity is owned by exactly one aggregate (warning when owned by none) |
| M004 | no ownership across aggregate boundaries (entities need `owns`, aggregates need `references`, …) |
| M005 | a reference's ID type matches the identity of the target aggregate |
| M006 | command input/output states exist and fit the aggregate (factory / stateful / stateless) |
| M007 | `emits` / `errors` refer to existing events / errors |
| M008 | an invariant is a Bool expression |
| M009 | operators and operands have compatible types |
| M010 | state-specific fields are used only in their own state's invariants |
| M011 | generated TypeScript names do not collide |
| M012 | the ownership graph has no cycles |
| M013 | aggregates and entities have an `id` field of their own ID type |
| M014 | shared contexts: only value types, no dependency on other contexts, consistent `shared`, unambiguous names (shadowing is a warning) |
| M015 | unions: at least one variant, variants match the bound enum exactly, no variant field named like the discriminator |
| L001 | (warning) an inline field label disagrees with the term, or context fragments disagree on the context name |
| L002 | (warning) a term is not used by any field or parameter |
| L003 | (warning) different things in one scope share a Japanese name |

## Generated TypeScript

Per context a module with ID brands, enums, value objects, entities, a discriminated union per stateful aggregate
(`DraftOrder | ConfirmedOrder | …`), event/error types with a `type` tag (`@persistent` in the JSDoc of persistent
events, and a `PersistentEvent` union of them when there are any), a function type per command, and an
`<Aggregate>Commands` interface to implement by hand:

```ts
export type ConfirmOrder = (
    order: DraftOrder,
    at: Timestamp,
) => Result<readonly [ConfirmedOrder, readonly OrderConfirmed[]], EmptyOrder>;
```

Do not edit generated files. Each run replaces the files domaintrail generated before (recognized by their header);
other files in the output directory are never deleted, and generation stops instead of overwriting one.

## Live View

`dt view` watches the workspace, re-validates on every save and pushes updates over WebSocket.
The screen is laid out like an IDE; every pane is closed and opened with the icon button at its top (a closed side
pane leaves a narrow rail with the button that opens it) and resized by dragging (remembered per browser).

- **Explorer (left)**: model tree — shared contexts first, then each context grouped by kind; aggregates expand to
  their states and commands — and the `.dt` files with error/warning counts. Click selects (a file too);
  double-click opens the item in the view or inspector tab that suits it.
- **Main (center)**: views of the whole model, in tabs with a view-specific toolbar. Anything about one selected item
  is in the inspector. See [ADR 0007](docs/adr/0007-pane-roles.md).
  - *Context Map*: one node per bounded context and one edge per dependency between contexts, labeled with the
    number of ID references and borrowed types (solid when types are borrowed). Shared contexts and contexts that
    only declare IDs are hidden unless 「共有・外部の BC も表示」 is checked. Selecting a context lists every use in
    the inspector (依存先 / 依存元). See [ADR 0006](docs/adr/0006-context-map.md).
  - *Structure*: contexts, aggregate boundaries, entities, value objects, unions, `owns` / `references`. Pick bounded
    contexts in the toolbar (any number) to draw only them, with the elements they use and the elements that use them
    as stubs; the eye next to each other context hides its stubs and the edges to and from them (the toolbar shows how
    many are hidden). The first row, 「すべての BC」, checks or unchecks every context and shows or hides every stub.
    Three levels work in both, switched by the icons in the toolbar: 詳細 (every field), 概観 (the elements' names
    only) and 集約 (only the aggregates with their descriptions, and one edge per pair of aggregates that depend on
    each other, also through the entities, value objects and IDs they hold; shared contexts are left out, and a
    context without aggregates stays as a frame with its description).
  - *Catalog*: cards to look over the model, one section per kind; for now the domain primitives per context (shared
    first) with base type, invariants and usages.
- **Inspector (right)**: the selected item — name, description, location (copy `file:line-line` for AI feedback),
  diagnostics, back/forward history, and buttons to show it in a view. Sub-tabs: 構造 / 状態遷移 / 振る舞い / 参照 /
  ソース. An event shows 永続化 / 非永続 next to its kind, as it does in an aggregate's 発生させる Event list;
  persistent events have a database icon in the explorer.
  - *状態遷移*: states and command transitions of the aggregate (`new` marks factory commands), for the aggregate
    and its states and commands; it pans and zooms like the main canvas and shows the selected state or command.
  - *ソース*: the whole file, read-only, syntax-coloured, diagnostics in the gutter, scrolled to the declaration;
    clicking a declaration selects it. A selected file shows here the same way.
- **Problems / changes (bottom)**: diagnostics (click to locate) and additions / changes / removals since the previous model.
- Selecting never switches the main view by itself; the item is highlighted when the current view shows it.
- Added / changed elements are highlighted; removed ones appear as ghosts. On a syntax error the last diagram stays.
- The language of the Live View (Japanese or English) follows the browser, or is forced in the settings menu (the gear
  at the right of the header). It covers the screen and the diagrams' own words (集約 / aggregate…); the model's names
  and labels are shown as written, and diagnostics are in English.
- The theme follows the OS (自動), or is forced with ライト / ダーク in the settings menu; both choices are remembered
  per browser.
- Names follow the 名前の表示 toggle in the header: ラベル (the string after a declaration's name, falling back to the
  name), 名前 or 両方. Layouts are cached in `<root>/.domaintrail/layout.json`. The canvas is read-only.

See [docs/adr/0001-mvp-implementation-decisions.md](docs/adr/0001-mvp-implementation-decisions.md) for the design decisions.

## Development

Requires [Bun](https://bun.sh) (version pinned in `mise.toml`). `bun run dt` runs the CLI from source.

```bash
bun install
bun run langium:generate   # after editing src/language/domain.langium
bun run typecheck
bun test
bun run build              # dist/: the CLI bundled for Node and the Live View page (needed by `view` and the tests)
```

### Release

Bump `version` in `package.json`, commit, and push a matching tag (`v0.2.0` for `0.2.0`).
The Release workflow tests, builds and publishes to npm with provenance through npm trusted publishing.

| Path | Contents |
|---|---|
| `src/language` | Langium grammar, generated parser/AST, scoping |
| `src/core` | analyzer, diagnostics, validation rules (`checker/`) |
| `src/model` | Typed Model (serializable, resolved) |
| `src/generator` | TypeScript generator and naming |
| `src/graph`, `src/layout` | Graph IR, diff, ELK layout |
| `src/server`, `web` | Live View server and React + tldraw client |

## License

MIT — see [LICENSE](LICENSE).
