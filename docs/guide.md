# DomainTrail guide

`dt` checks domain models written in the DomainTrail DSL (`.dt` files) and generates TypeScript types and command
contracts from them. The DSL describes domain **structure and contracts** only — never business logic, which is written
by hand against the generated types.

This guide is what `dt guide` prints. It is written for people and AI agents using `dt` without other documentation.

## Workflow

1. Write or edit `.dt` files (see [DSL](#dsl) and [File layout](#file-layout-recommended)).
2. Run `dt check` and fix every reported problem until it exits 0.
3. Run `dt generate ts` to write the TypeScript (it runs `check` first and writes nothing on errors).
4. Implement the generated contracts in your own code, and type-check that code with your own TypeScript setup
   (e.g. `tsc --noEmit`). `dt` does not run the TypeScript compiler.

`dt view` starts the Live View, a browser page where people watch the model update as files are saved. It is a server
that keeps running and never exits by itself (stop it with Ctrl+C), so do not wait for it to finish: run it in the
background, or use `dt check` for a result.

`dt --help` and `dt <command> --help` list the options with examples.

```bash
dt check                        # every *.dt file below the current directory
dt -r domain check              # below domain/ (or as configured by a domaintrail.jsonc found there or above)
dt generate ts                  # into <root>/generated/domain
dt generate ts --out src/domain/generated
dt view --port 8080             # http://127.0.0.1:8080, until Ctrl+C
```

## Output and exit codes

`check` (and `generate ts`, which checks first) prints one line per problem, sorted by file and position, then a
summary:

```text
sales/order.dt:2:11 - warning L002: Term 'note' ("備考") is not used by any field or parameter in context 'Sales'.
sales/order.dt:8:32 - error M009: count() requires a collection, but got 'Money'.
1 file(s) checked: 1 error(s), 1 warning(s).
```

Paths are relative to the root, lines and columns 1-based. Errors go to stderr, warnings to stdout. Fix errors first;
warnings do not fail the check. Other failures (missing root, invalid config, port in use, …) are one line on stderr.

| Exit code | Meaning |
|---|---|
| 0 | success (`check`: no errors; warnings are allowed) |
| 1 | the model has errors, no `.dt` file was found, generation was refused, or the root / a file could not be read |
| 2 | invalid configuration (`domaintrail.jsonc` / `--config`, including a context name in `generate.ts.contexts` that the model does not have) or an unknown `generate` target |

Commands that use the model look for a config file first; `--root` (`-r`, default `.`) is where that search starts.

## Configuration

`domaintrail.jsonc` (comments and trailing commas allowed) or `domaintrail.json` is looked up in `--root` and its
parents, like `tsconfig.json`; `--config <file>` (`-c`) picks one explicitly. All paths in it are relative to the config
file, and its directory becomes the root. Without a config file, the defaults apply with `--root` as the root.
Every key is optional.

```jsonc
{
  "$schema": "./node_modules/domaintrail/schema/domaintrail.schema.json",
  // globs of DSL files; "!" excludes (node_modules, .git, .domaintrail are never scanned)
  "sources": ["domain/**/*.dt", "!domain/drafts/**"],      // default: ["**/*.dt"]
  "generate": {
    "ts": {
      "out": "src/domain/generated",                        // default: "generated/domain"
      // contexts written elsewhere than "out" (optional)
      "contexts": { "Common": { "out": "packages/shared/src/generated" } }
    }
  },
  "view": { "port": 4321, "host": "127.0.0.1" }             // defaults shown
}
```

CLI options win over the file: `generate ts --out`, `view --port`, `view --host`. `--out` replaces `generate.ts.out`
only; contexts listed in `generate.ts.contexts` keep their own directories. Sources and output directories, `--out`
included, must stay inside the config file's directory (the root without a config file): an absolute path or one with
`..` is a config error, and an output directory reached through a symlink stops generation. A name in `generate.ts.contexts` that is not a context of the model is a config
error, reported by `generate ts` once the model has been checked.

## File layout (recommended)

File names and directories carry no meaning: every matching `.dt` file belongs to the workspace, and a context may be
split across any files. The recommended layout is one directory per context and one file per aggregate:

```text
common/context.dt      shared context Common "共通" { ... }      // a shared context has no aggregates
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

This is a convention, not a rule: `check` neither requires nor warns about any layout.

## DSL

The examples below are the files of one valid workspace (the file name is in the first comment).

### Contexts and aggregates

```dt
// sales/order.dt
context Sales {                          // a bounded context; may be split across files
  id OrderId: UUID                       // ID type with a base primitive type
  id OrderItemId: UUID
  enum CancelReason { Requested Other }  // commas between values are optional
  value Address { city: String street: String }

  aggregate Order {
    id: OrderId                          // identity field of its own ID type (required)
    owns items: OrderItem[0..*]          // owned entity / value inside the aggregate
    references customer: CustomerId -> Customer   // another aggregate, by ID
    owns shipTo: Address?                // ? = optional
    note: String?

    invariant quantitiesPositive {       // applies to every state; sees the common fields
      all(items, item => item.quantity > 0)
    }

    create command place(customer: CustomerId) to Draft emits OrderPlaced   // factory: no `from`

    state Draft
    state Confirmed {
      confirmedAt: Timestamp             // exists only in this state
      invariant hasItems { count(items) > 0 and count(items) <= 100 }   // sees common + Confirmed fields
    }
    state Cancelled {
      reason: CancelReason
      invariant otherNeedsNote { reason == CancelReason.Other implies exists(note) }
    }

    command confirm(at: Timestamp)
      from Draft
      to Confirmed                       // several: `to A | B`
      emits OrderConfirmed               // events that MAY be emitted (0..n)
      errors EmptyOrder                  // errors that MAY be returned

    command cancel(reason: CancelReason) from Draft | Confirmed to Cancelled emits OrderCancelled
  }

  entity OrderItem { id: OrderItemId quantity: Quantity owns unitPrice: Money }

  persistent event OrderPlaced { orderId: OrderId }      // storing it is part of its contract
  persistent event OrderConfirmed { orderId: OrderId confirmedAt: Timestamp }
  event OrderCancelled { orderId: OrderId reason: CancelReason }   // not persisted (default)
  error EmptyOrder                       // payload optional: error E { field: Type }
}
```

```dt
// sales/customer.dt
context Sales {
  id CustomerId: UUID

  aggregate Customer {                   // no states: commands have no `from` / `to`
    id: CustomerId
    email: EmailAddress                  // from the shared context Common
    active: Bool
    owns addresses: Address[0..*]

    invariant activeHasAddress { active == true implies count(addresses) > 0 }
    invariant servedArea { active == false or any(addresses, a => a.city == "Tokyo" or not (a.city == "Osaka")) }

    command changeEmail(email: EmailAddress) errors EmailTaken
  }

  error EmailTaken { email: EmailAddress }
}
```

- Context elements: `id`, `primitive`, `enum`, `value`, `union`, `entity`, `aggregate`, `event`, `error`.
- Fields: `name: Type`, `owns name: Type` (entities and values held by the aggregate),
  `references name: IdType -> Aggregate` (other aggregates, by ID only). Entities are owned by exactly one aggregate.
- Primitive types: `String`, `Int`, `Decimal`, `Bool`, `Timestamp`, `UUID`.
- Multiplicity after the type: `?`, `[0..1]`, `[0..*]`, `[1..*]`, `[n..m]`.
- Aggregate members: fields, `invariant`, `state` (with its own fields and invariants), `command`.
  An aggregate with states needs `to` on every command and `from` on every non-`create` one; without states, neither.
- `create command` makes a new aggregate; other commands take the aggregate in one of their `from` states.
- `value`, `state`, `event` and `error` bodies are optional (`state Draft`, `error EmptyOrder`).
- Other contexts' elements are referenced with qualified names: `Sales.OrderId`, `-> Sales.Order`.
- Comments: `// …` and `/* … */`; `///` is a description (see [Names](#names-labels-and-descriptions)).

### Domain primitives

A single value with domain meaning and constraints, wrapping a primitive type. Values combining several fields are
value objects.

```dt
// sales/primitives.dt
context Sales {
  primitive Quantity "数量": Int { value in 1..999 }     // one anonymous constraint
  primitive Sku: String {                                 // or named invariants
    invariant format "形式" { matches(value, "^[A-Z]{3}-\d{4}$") }
    invariant maxLength { length(value) <= 8 }
  }
  id InvoiceNo: String { matches(value, "^INV-\d{8}$") }  // an ID is a domain primitive used as identity
}
```

- The base is always a primitive type; a domain primitive cannot refine another one or an enum.
- Inside the constraint only `value` (of the base type) is visible; `length(value)`, `matches(value, "regex")` and
  ranges `value in 1..999` (negative literals allowed) are available there.
- Regular expressions are written as in JavaScript: backslashes are not string escapes (`"\d"` means `\d`).
- Elsewhere a domain primitive compares with literals and with the same domain primitive, not with another domain
  primitive or a plain field of its base type (M009).
- Only IDs can be identity fields and reference types. Domain primitives cannot be owned.

### Unions

A value whose shape depends on a kind fixed when it is made (a tagged union). Use a union for a classification that
never changes, and aggregate states for a lifecycle that commands move through.

```dt
// sales/payment.dt
context Sales {
  union Payer "支払者" {                                  // discriminator `kind` by default
    CUSTOMER "顧客" { customerId: CustomerId }
    COMPANY "法人" { name: String  billingEmail: EmailAddress? }
  }
  enum PaymentMethod { CARD TRANSFER }
  union PaymentDetails by method: PaymentMethod {        // `by name`, optionally bound to an enum
    CARD { last4: String }                               // exactly the enum's values (M015)
    TRANSFER { bankCode: String }
  }
}
```

- A union is a value type: usable like a value object (fields, `owns`, parameters, payloads, shared contexts).
  Variants hold value fields and invariants (seeing their own fields); entities and aggregates are not allowed.
- In invariants, `payer.kind` compares with `Payer.COMPANY` (or the bound enum's values); variant fields are not
  accessible from outside the union.

### Shared contexts

```dt
// common/context.dt
shared context Common "共通" {            // shared kernel: usable by simple name from every context
  terms { currency: "通貨" }
  enum Currency { JPY USD }
  value Money { amount: Decimal currency: Currency }
  primitive EmailAddress: String { matches(value, "^[^@\s]+@[^@\s]+$") }
}
```

- `Money` and `Common.Money` both work in other contexts. A context's own element with the same name wins (M014 warning).
- A shared context holds only domain primitives, enums, value objects, unions and terms, and depends only on shared
  contexts. Its `terms` apply to fields of every context that has no term of its own for the name.

### Names (labels and descriptions)

```dt
// billing/context.dt
/// 注文への請求と支払いを扱う。
context Billing "請求" {
  terms {                                  // field / parameter names, defined once per context
    /// 請求書が支払われた日時。
    paidAt: "支払日時"
  }
}
```

```dt
// billing/invoice.dt
context Billing {                          // other files open the context without a name
  id InvoiceId "請求書ID": UUID

  /// 注文1件に対する請求。
  aggregate Invoice "請求書" {             // declarations: a string after the name
    id: InvoiceId
    references order: Sales.OrderId -> Sales.Order "請求対象"   // an inline label on a field
    owns amount: Money "請求金額"
    state Open "未払い"
    state Paid "支払済み" { paidAt: Timestamp }               // → 支払日時 (from terms)
    invariant positive "金額が正" { amount.amount > 0 }
    create command issue(order: Sales.OrderId, amount: Money) "請求書を発行する" to Open
    command pay(at: Timestamp "支払日時") "支払う" from Open to Paid emits InvoicePaid
  }
  enum InvoiceKind "請求区分" { Regular "通常" Refund "返金" }
  event InvoicePaid "支払完了" { invoiceId: InvoiceId paidAt: Timestamp }
}
```

- Declarations (context, id, primitive, enum and its values, value, union and its variants, entity, aggregate, state,
  command, invariant, event, error) take an optional string label after the name.
- A field or parameter is named by, in order: its inline string → the context's `terms` → the name of its type
  (for `references`, the target aggregate) → the English name.
- `///` lines directly above a declaration or term are its description.
- Labels appear in the Live View and as JSDoc in the generated TypeScript; identifiers and generated type names stay
  English.

### Invariant expressions

- Literals: `true`, `false`, `42`, `-1`, `3.14`, `"text"`; enum values `CancelReason.Other`.
- Field paths: `note`, `item.quantity`, `amount.amount`.
- Operators, loosest first: `implies`, `or`, `and`, `== != < <= > >=`, `x in 1..9`, `not`.
- Functions: `exists(x)` (an optional is present; narrows `x` on the right of `and` / `implies`), `count(c)`,
  `all(c, x => …)`, `any(c, x => …)`, and in domain primitives `length(value)`, `matches(value, "regex")`.
- An invariant must be a Bool expression. Only its type is checked, not whether it holds.

## Rules

| Code | Check |
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

Per context a module (`Sales.ts`, …) with ID brands, enums, value objects, entities, unions, a discriminated union per
stateful aggregate (`DraftOrder | ConfirmedOrder | …`), event / error types with a `type` tag, a function type per
command and an `<Aggregate>Commands` interface to implement, plus `index.ts` and `_runtime.ts`. A domain primitive
gets a branded type and a constructor contract `Make<Name>` to implement by hand.

```ts
export type ConfirmOrder = (
    order: DraftOrder,
    at: Timestamp,
) => Result<readonly [ConfirmedOrder, readonly OrderConfirmed[]], EmptyOrder>;
```

### Generated code and your code

The generated files are the **contract**, your code is the **implementation**:

- Generated: types only — the shapes of the model, the command signatures (`ConfirmOrder`, `OrderCommands`) and the
  constructor signatures of domain primitives (`MakeQuantity`). Invariants appear as JSDoc (`@invariant`); nothing in
  the generated code checks them.
- Yours: everything that runs — command implementations, `Make<Name>` constructors, invariant checks — in your own
  files, which import the generated modules (never the other way round) and are type-checked against them.

```ts
// src/primitives.ts — your code
import { err, ok, type Sales } from '../generated/domain/index.js';

export const makeQuantity: Sales.MakeQuantity = (value) =>
    Number.isInteger(value) && value >= 1 && value <= 999 ? ok(value as Sales.Quantity) : err({ type: 'InvalidQuantity', value, invariant: 'valid' });
```

Do not edit generated files: change the `.dt` sources and generate again. Adding properties or methods to generated
types (declaration merging, editing the output) is not supported; write functions that take the generated types.

### Output directories

By default every context goes to `generate.ts.out`. Contexts listed in `generate.ts.contexts` go to their own
directory instead, e.g. a shared context into a package used by several applications. Each directory written to gets
its own `_runtime.ts` and an `index.ts` re-exporting only the contexts in it; a module imports other contexts by
relative path (`import type * as Common from '../../packages/shared/src/generated/Common.js'`). The runtimes are
identical, so values typed with one are accepted where the other is expected.

Each run replaces the files generated before (recognized by their header). The files written are recorded in
`.domaintrail/generated.json` under the root, and generated files of earlier runs that are no longer written (an output
directory moved, a context removed) are deleted, along with a directory left empty. Only recorded paths inside the root
and not reached through a symlink are deleted; other entries in that file are ignored. Other files are never deleted —
neither hand-written files nor generated files you edited — and generation stops instead of overwriting one.
