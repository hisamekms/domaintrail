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

## Looking up one element

To understand one element of a large model, run `dt show <name>` instead of reading the `.dt` files: it prints the
element resolved, close to the DSL — the fields of field sets inline (`// with Common.Tenanted`), each field's label
with where it comes from (`(from term)`, `(from type)`; none when written inline), multiplicities, `owns` /
`references -> X`, invariants with their expressions (or `(not expressed in the DSL)`), states with their own fields
and invariants, commands with their transitions, `requires … else`, `changes`, the events of each outcome (`when`
resolved), the full error union, a `// file:line` location per declaration (relative to the root), and who uses it
(owns, references, its type or ID, emits, returns, `with`).

```bash
dt show                         # the contexts and their elements
dt show Sales                   # a context: terms and one line per element
dt show Sales.Order             # an element (Order alone is enough when no other context has one)
dt show Sales.Order.confirm     # a command: its contract, the fields each outcome sets / carries / drops, payloads
dt show Sales.Order.Confirmed   # a state: its fields, invariants, the commands that enter and leave it
```

A name may leave out leading parts (`Order`, `Order.confirm`) when it names one thing only; when it names several, they
are listed (exit 1); an unknown name gets `did you mean …?` (exit 1). It works on a model with semantic errors as far
as it resolves (unresolved types are marked `(unresolved)`, and a note on stderr gives the number of errors): the exit
code is 0 whenever the name was found, whatever the diagnostics. A model with syntax errors cannot be shown (exit 1).

`--format json` prints one JSON document, the Typed Model of what was found, keyed by `show`:

- `{"show": "element", "element": {...}, "usedBy": {...}}`: the element (`id`, `kind`, `fields` with `label`,
  `labelSource`, `multiplicity`, `fieldSet`, …, `invariants`, `states`, `commands`, `location`); each command has
  `outcomes`: `[{"from", "to", "emits": [{"event", "multiplicity", "lower", "upper"}], "sets", "carries", "drops"}]`.
  `usedBy` has the lists `takenOnBy`, `ownedBy`, `typeOf`, `referencedBy`, `idUsedBy`, `emittedBy`, `returnedBy` and
  `discriminatorOf`, as dotted paths (`Billing.Invoice.order`, `Sales.Order.addItem(item)`).
- `{"show": "command", "aggregate", "command"}` (with `outcomes`), `{"show": "state", "aggregate", "state", "enteredBy",
  "leftBy"}`, `{"show": "context", "context"}` and `{"show": "overview", "contexts"}` (name, label, doc, shared, terms
  and the elements with their location).
- `"modelErrors": n` when the model has errors; `{"error": "...", "candidates": [...]}` when the name is unknown
  (the suggestions) or ambiguous (the matches).

## Output and exit codes

`check` (and `generate ts`, which checks first) prints one line per problem, sorted by file and position, then a
summary. When the message does not say how to fix the problem, an indented `hint:` line follows: what to change, or
`did you mean …?` with the closest names of the right kind visible there (at most 3) for a name that does not resolve.

```text
sales/order.dt:2:11 - warning L002: Term 'notes' ("備考") is not used by any field or parameter in context 'Sales'.
  hint: did you mean 'note'?
sales/order.dt:8:32 - error M009: count() requires a collection, but got 'Money'.
sales/order.dt:12:30 - error M006: Cannot resolve state 'Confirmd' in this aggregate.
  hint: did you mean 'Confirmed'?
1 file(s) checked: 2 error(s), 1 warning(s).
```

Paths are relative to the root, lines and columns 1-based. Errors (and their hints) go to stderr, warnings to stdout.
Fix errors first; warnings do not fail the check. Other failures (missing root, invalid config, port in use, …) are one
line on stderr.

With `--format json` (`check` and `generate ts`), the output is one JSON document on stdout instead, with the same
order and exit codes (JSON Schema: `schema/diagnostics.schema.json` in the package):

```json
{
  "diagnostics": [
    { "file": "sales/order.dt", "line": 12, "column": 30, "endLine": 12, "endColumn": 38, "severity": "error",
      "code": "M006", "message": "Cannot resolve state 'Confirmd' in this aggregate.", "hint": "did you mean 'Confirmed'?" }
  ],
  "summary": { "files": 6, "errors": 1, "warnings": 0 }
}
```

`endLine` / `endColumn` point just past the problem; `hint` is present only when there is one. `generate ts` adds
`written` (the output directories). A failure other than the diagnostics (missing root, invalid config, no `.dt` file,
generation refused) is an `error` message in the document, e.g. `{ "error": "Root directory not found: domain" }`;
`diagnostics` and `summary` are there whenever the check ran.

| Exit code | Meaning |
|---|---|
| 0 | success (`check`: no errors; warnings are allowed) |
| 1 | the model has errors, no `.dt` file was found, generation was refused, `show` did not find the name (or it is ambiguous), or the root / a file could not be read |
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

## Language server

`dt lsp` is a language server (LSP) for `.dt` files, speaking over stdin/stdout. Editors and AI agents start it; it
runs until the client shuts it down. It offers:

- **Diagnostics equal to `dt check`**: the same rules, severities, codes (the rule ID, e.g. `M009`) and messages,
  computed over the whole workspace (the config's `sources`) with the unsaved text of open files, after every change.
  A hint follows the message on a second line (`hint: did you mean 'Confirmed'?`) and is also in the diagnostic's
  `data.hint`.
- **Go to definition** and **find references** for types, states, events, errors and field sets, across files and
  contexts (`Sales.Order` included).
- **Hover**: kind, name, Japanese name, `///` description, the expression of an invariant or requirement, and the
  `emits` entries of a command.
- **Outline** (document symbols), **completion** of names, and **rename** of context elements and states, which updates
  every reference (a qualified `Sales.Order` keeps its context). Contexts, fields and parameters are not renamed, since
  their names also appear outside references (in qualified names, expressions and terms).

The workspace is the config found from `--root` or `--config` when given, else from the client's (first) workspace
folder, else from the current directory, exactly as `dt check` would find it there.

A client needs only: command `dt lsp` (with `dt` on the `PATH`, or e.g. `npx dt lsp`), transport stdio, file
extension `.dt`. For Claude Code, a plugin declares it in an `.lsp.json` at the plugin root (load it with
`claude --plugin-dir <plugin directory>`); Claude then sees the diagnostics after each edit of a `.dt` file:

```json
{
  "domaintrail": {
    "command": "dt",
    "args": ["lsp"],
    "extensionToLanguage": { ".dt": "domaintrail" }
  }
}
```

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
  of its aggregates or by none (field sets, for example). The other files open the context without a name: `context Sales { ... }`.
- An aggregate's ID stays in the aggregate's file even when other aggregates reference it.
- Directory and file names are kebab-case: `PurchaseOrder` → `purchase-order.dt`, `OrderFulfillment` →
  `order-fulfillment/`.

This is a convention, not a rule: `check` neither requires nor warns about any layout.

## DSL

The examples below are the files of one valid workspace (the file name is in the first comment).

### Contexts and aggregates

```dt
// sales/order.dt
context Sales { // a bounded context; may be split across files
  id OrderId: UUID // ID type with a base primitive type
  id OrderItemId: UUID
  enum CancelReason { Requested Other } // commas between values are optional
  value Address {
    city: String
    street: String
  }

  aggregate Order {
    id: OrderId // identity field of its own ID type (required)
    owns items: OrderItem[0..*] // owned entity / value inside the aggregate
    references customer: CustomerId -> Customer // another aggregate, by ID
    owns shipTo: Address? // ? = optional
    note: String?

    invariant quantitiesPositive { // applies to every state; sees the common fields
      all(items, item => item.quantity > 0)
    }

    create command place(id: OrderId, customer: CustomerId)
      -> Draft
      emits OrderPlaced // factory: `-> State`, no source

    state Draft
    state Confirmed {
      confirmedAt: Timestamp // exists only in this state
      invariant hasItems { count(items) > 0 and count(items) <= 100 } // sees common + Confirmed fields
    }
    state Cancelled {
      reason: CancelReason
      invariant otherNeedsNote { reason == CancelReason.Other implies exists(note) }
    }

    command confirm(at: Timestamp)
      Draft -> Confirmed // a transition: source state(s) -> target state(s)
      requires hasItems { count(items) > 0 } else EmptyOrder // accepted only if; otherwise returns EmptyOrder
      emits OrderConfirmed // exactly one OrderConfirmed whenever it succeeds

    command cancel(reason: CancelReason)
      Draft | Confirmed -> Cancelled // from either
      emits OrderCancelled,
            RefundRequested when Confirmed -> // only when it comes from Confirmed

    command changeNote(note: String?) // one transition per input state: the output depends on the input
      Draft -> Draft
      Confirmed -> Confirmed // also on one line: `Draft -> Draft, Confirmed -> Confirmed`
      changes note // the fields it may change; without `changes`, no common field
  }

  entity OrderItem {
    id: OrderItemId
    quantity: Quantity
    owns unitPrice: Money
  }

  persistent event OrderPlaced { // storing it is part of its contract
    orderId: OrderId
  }
  persistent event OrderConfirmed {
    orderId: OrderId
    confirmedAt: Timestamp
  }
  event OrderCancelled { // not persisted (default)
    orderId: OrderId
    reason: CancelReason
  }
  event RefundRequested {
    orderId: OrderId
  }
  error EmptyOrder // payload optional: error E { field: Type }
}
```

```dt
// sales/customer.dt
context Sales {
  id CustomerId: UUID

  aggregate Customer { // no states: commands have no transitions
    id: CustomerId
    email: EmailAddress // from the shared context Common
    active: Bool
    owns addresses: Address[0..*]
    owns shipping: Address?

    invariant activeHasAddress { active == true implies count(addresses) > 0 }
    invariant servedArea { active == false or any(addresses, a => a.city == "Tokyo" or not (a.city == "Osaka")) }
    invariant distinctAddresses { unique(addresses, a => a.city, a.street) } // the combination is distinct
    invariant shippingListed { exists(shipping) implies contains(addresses, shipping) }

    /// No other customer has the same email address (spans aggregates, so not expressed in the DSL).
    invariant uniqueEmail "メールアドレスは顧客ごとに一意"

    command changeEmail(email: EmailAddress)
      changes email
      errors EmailTaken // errors that MAY be returned
  }

  error EmailTaken {
    email: EmailAddress
  }
}
```

- Context elements: `id`, `primitive`, `enum`, `value`, `union`, `entity`, `aggregate`, `event`, `error`, and `fields`
  (see [Field sets](#field-sets)).
- Fields: `name: Type`, `owns name: Type` (entities and values held by the aggregate),
  `references name: IdType -> Aggregate` (other aggregates, by ID only). Entities are owned by exactly one aggregate.
- Primitive types: `String`, `Int`, `Decimal`, `Bool`, `Timestamp`, `UUID`.
- Multiplicity after the type: `?`, `[0..1]`, `[0..*]`, `[1..*]`, `[n..m]`.
- Aggregate members: fields, `invariant`, `state` (with its own fields and invariants), `command`.
- A command is written in this order: parameters and label, transitions, `requires` (see
  [Command requirements](#command-requirements)), `changes` (see [Command changes](#command-changes)), `emits` (see
  [Command events](#command-events)), `errors`.
- Command transitions follow the parameters (and label), before `emits` / `errors`: `A | B -> C | D` means "in `A` or
  `B`, the command ends in `C` or `D`". Separate several transitions by line breaks or commas. A state may be the
  source of one transition of a command only, so the input state decides the possible outputs; for several possible
  outcomes, list them on the right: `InProgress -> InProgress | Completed`.
- In an aggregate with states, a `create command` makes a new aggregate and has exactly one transition without
  sources (`-> Draft`, or `-> A | B`); every other command has one or more transitions, each with sources. Without
  states, commands have no transitions. A command that keeps the state writes it out: `Draft -> Draft`.
- `value`, `state`, `event` and `error` bodies are optional (`state Draft`, `error EmptyOrder`).
- Other contexts' elements are referenced with qualified names: `Sales.OrderId`, `-> Sales.Order`.
- Comments: `// …` and `/* … */`; `///` is a description (see [Names](#names-labels-and-descriptions)).

### Domain primitives

A single value with domain meaning and constraints, wrapping a primitive type. Values combining several fields are
value objects.

```dt
// sales/primitives.dt
context Sales {
  primitive Quantity "数量": Int { value in 1..999 } // one anonymous constraint
  primitive Sku: String { // or named invariants
    invariant format "形式" { matches(value, "^[A-Z]{3}-\d{4}$") }
    invariant maxLength { length(value) <= 8 }
  }
  id InvoiceNo: String { matches(value, "^INV-\d{8}$") } // an ID is a domain primitive used as identity
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
  union Payer "支払者" { // discriminator `kind` by default
    CUSTOMER "顧客" {
      customerId: CustomerId
    }
    COMPANY "法人" {
      name: String
      billingEmail: EmailAddress?
    }
  }
  enum PaymentMethod { CARD TRANSFER }
  union PaymentDetails by method: PaymentMethod { // `by name`, optionally bound to an enum
    CARD { // exactly the enum's values (M015)
      last4: String
    }
    TRANSFER {
      bankCode: String
    }
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
shared context Common "共通" { // shared kernel: usable by simple name from every context
  terms {
    currency: "通貨"
  }
  enum Currency { JPY USD }
  value Money {
    amount: Decimal
    currency: Currency
  }
  primitive EmailAddress: String { matches(value, "^[^@\s]+@[^@\s]+$") }
}
```

- `Money` and `Common.Money` both work in other contexts. A context's own element with the same name wins (M014 warning).
- A shared context holds only domain primitives, enums, value objects, unions, field sets and terms, and depends only on
  shared contexts. Its `terms` apply to fields of every context that has no term of its own for the name.

### Field sets

Fields that several aggregates, entities or events have for the same domain reason are written once as a field set
and taken on with `with`.

```dt
// common/tenancy.dt
shared context Common {
  /// 契約者（テナント）。業務データはテナントごとに分かれる。
  primitive TenantId "テナントID": UUID
  fields Tenanted "テナント所属" { // a field set: plain fields only
    tenant: TenantId "テナント"
  }
}
```

```dt
// expenses/expense.dt
context Expenses "経費" {
  id ExpenseId "経費申請ID": UUID
  id StaffId "職員ID": UUID

  /// 規程により、申請の受付には実施者を記録する。
  fields Performed "実施記録" {
    performedBy: StaffId "実施者"
  }

  aggregate Expense "経費申請" with Tenanted { // tenant first, then its own fields
    id: ExpenseId
    applicant: StaffId "申請者"
    approver: StaffId? "承認者"
    invariant notSelfApproved "申請者は承認できない" { exists(approver) implies approver != applicant }

    create command submit(id: ExpenseId, applicant: StaffId "申請者") "申請する" emits ExpenseSubmitted
    command approve(approver: StaffId "承認者", approvedAt: Timestamp "承認日時") "承認する" emits ExpenseApproved
  }

  event ExpenseSubmitted "申請受付" with Tenanted, Performed {
    expenseId: ExpenseId
  }
  event ExpenseApproved "承認" with Tenanted {
    expenseId: ExpenseId
    approver: StaffId "承認者" // a business role, named by the role
    approvedAt: Timestamp "承認日時" // when it happened in business terms
  }
}
```

- `fields Name "label" { ... }` holds plain fields, written like any other field (type, multiplicity, label, `///`).
  No `owns`, `references`, invariants, `with` or `id` inside (M016).
- `with A, B` after the name and label of an `aggregate`, `entity` or `event` (only those, M016). A field set is
  referenced like a type: by name in its own context and from shared contexts, as `Context.Name` otherwise.
- The fields come first, in the order of `with`, and then count as the element's own: invariants see them, and an
  aggregate's states share them. A name may come from one place only, the element or one of its field sets (M016).
- The identity of aggregates and entities is never a field set: every aggregate and entity declares `id` itself (M013).
- A command's event should say which aggregate it is about: it needs a field of the aggregate's ID type, its own or
  from a field set (M017 warning). An event emitted by several aggregates needs the ID type of each (optional fields
  count).

### Domain fields and technical fields

Write a field in the DSL when **domain experts talk about it, or a business rule (an invariant, a transition, a
command's decision) refers to it**. A field that is neither is technical: leave it out of the DSL and of the generated
code, and add it in your own code around the generated types (see [Technical metadata](#technical-metadata)).

- **Required by the kind of element** (the ID of an aggregate or entity): enforced by the language (M013), not a field
  set.
- **Chosen for some elements** (a tenant, a recorded performer): a field set and `with`.
- **Technical**: event ID, the time the system recorded something (`recordedAt`), optimistic-lock `version`,
  `createdAt` / `updatedAt`, correlation / causation IDs, the system's acting account, schema versions.

Two cases look alike but are not:

- **When**: the time something happened in business terms is domain — rules refer to it ("within 30 days of
  confirmation"). Name it by its meaning (`confirmedAt: Timestamp "確定日時"`). If every event is to carry its business
  time, say so with a field set: `fields Occurred { occurredAt: Timestamp "発生日時" }`. The time the system recorded it
  is technical. The two differ with late entry, offline work and imports.
- **Who**: a business role (approver, person in charge) is domain — rules refer to it ("the applicant cannot
  approve"). Name it by the role (`approvedBy: StaffId "承認者"`), usually passed from the command's parameters to the
  event. If regulations require recording the performer of every operation,
  `fields Performed { performedBy: StaffId "実施者" }`. The login account, service account or IP address is technical; it differs with proxy entry and batches.

### Names (labels and descriptions)

```dt
// billing/context.dt
/// 注文への請求と支払いを扱う。
context Billing "請求" {
  terms { // field / parameter names, defined once per context
    /// 請求書が支払われた日時。
    paidAt: "支払日時"
  }
}
```

```dt
// billing/invoice.dt
context Billing { // other files open the context without a name
  id InvoiceId "請求書ID": UUID

  /// 注文1件に対する請求。
  aggregate Invoice "請求書" { // declarations: a string after the name
    id: InvoiceId
    references order: Sales.OrderId -> Sales.Order "請求対象" // an inline label on a field
    owns amount: Money "請求金額"
    state Open "未払い"
    state Paid "支払済み" {
      paidAt: Timestamp // → 支払日時 (from terms)
    }
    invariant positive "金額が正" { amount.amount > 0 }
    create command issue(id: InvoiceId, order: Sales.OrderId, amount: Money) "請求書を発行する" -> Open
    command pay(at: Timestamp "支払日時") "支払う"
      Open -> Paid
      emits InvoicePaid
  }
  enum InvoiceKind "請求区分" { Regular "通常" Refund "返金" }
  event InvoicePaid "支払完了" {
    invoiceId: InvoiceId
    paidAt: Timestamp
  }
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
  `all(c, x => …)`, `any(c, x => …)`, `unique(c)`, `unique(c, x => key, …)`, `contains(c, x)`, and in domain
  primitives `length(value)`, `matches(value, "regex")`.
- `unique(c)`: the elements of a collection are distinct. With keys, `unique(lines, l => l.sku)` means no two
  elements have the same key, and `unique(confirmations, c => c.scenario, c.reviewer)` that no two have the same
  combination of keys. A key cannot be optional (M009); to include an optional field, group the keys into a value
  object and use it as the key.
- `contains(c, x)`: `x` is an element of `c`. A subset is written with `all`: `all(required, s => contains(confirmed, s))`.
- Equality — `==`, `!=`, `unique` and `contains` compare alike: primitives and domain primitives by value, enum
  values by name, value objects by all their fields, entities by `id`, union values by discriminator and fields.
  Both sides must be of the same type (domain primitives also compare with literals); collections and optional values
  cannot be compared (guard an optional with `exists(...)` first).
- An invariant must be a Bool expression. Only its type is checked, not whether it holds.
- A constraint the DSL cannot express is declared without an expression, with a label or a `///` description that
  states it (M018): `invariant uniqueEmail "メールアドレスは顧客ごとに一意"`. It is documented like any invariant (in
  the Live View and as `@invariant uniqueEmail (…): not expressed in the DSL` in the generated TypeScript) and is
  checked by your code only. In a domain primitive, its name joins the invariants of `Invalid<Name>`.
- `count`, `exists`, `length`, `matches`, `all`, `any`, `unique` and `contains` are also usable as field and parameter
  names; followed by `(` they are the functions.

### Command requirements

`requires` states when a command is accepted. Like an invariant it is a Bool expression, written after the
transitions, any number per command; `else` names the error the command returns when it does not hold:

```dt
// review/review.dt
context Review {
  id ReviewId: UUID
  id PersonId: UUID
  value ApprovalPolicy {
    approvers: PersonId[1..*]
  }

  aggregate Review "レビュー" {
    id: ReviewId
    policy: ApprovalPolicy
    state Reviewing {
      openBlockers: Int
    }
    state Escalated {
      openBlockers: Int
    }
    state Accepted {
      acceptedBy: PersonId
      /// All the scenarios the policy requires are confirmed.
      invariant fullyConfirmed "必要な確認がそろっている" // holds whenever the review is Accepted
    }

    command accept(person: PersonId) "受入"
      Reviewing | Escalated -> Accepted
      requires authorizedApprover "承認者である" { // depends on the parameters and the current state
        contains(policy.approvers, person)
      } else NotApprover
      requires noOpenBlocker "未解決の阻害がない" { openBlockers == 0 } else Blocked
      /// The reviewer's own sign-off is recorded outside this model.
      requires signedOff "本人の承認が記録済み" else NotSignedOff // not expressed in the DSL
      errors Conflict
  }

  error NotApprover
  error Blocked
  error NotSignedOff
  error Conflict
}
```

- **Invariant or requirement?** An invariant holds whenever the aggregate is in a state: it describes the state
  after a transition (an accepted review has all required confirmations). A requirement decides whether the command
  is accepted, from its parameters and the aggregate's current data (the person is among the approvers). If a
  condition reads "after the command, …", it is an invariant of the target state; if it reads "the command may run
  only when …", it is a requirement.
- **Not for application-level authorization.** Whether the logged-in user has a role is checked by the application,
  not the model. Only when the policy is part of the aggregate's state (its approvers) is it a domain precondition.
- **Scope**: the parameters; the aggregate's common fields (including those of field sets); and the fields that every
  source state of the command has, with the same name and type (with one source state, all its fields). A
  `create command` sees its parameters only, a command of an aggregate without states all its fields. Using another
  field is M010. Other aggregates cannot be referenced; pass what is needed as parameters.
- A parameter may not be named like a field its command's requirements see (M019), so that a name in `requires` has
  one meaning. Commands without `requires` are not affected.
- `else Error` is required. The error joins the command's errors: it need not be listed in `errors` (listing it
  again is allowed), and several requirements may share one. An unknown error is M007.
- Requirement names are unique within the command (M002). Without an expression, a requirement needs a label or a
  `///` description (M018), like an invariant.
- Nothing checks them at run time: they appear in the Live View (振る舞い tab) and as `@requires` JSDoc on the
  generated command type (see [Generated TypeScript](#generated-typescript)); your command implementation returns
  the error.
- Not supported: requirements for some source states only (split the command instead), and a generic
  `<Command>Rejected` error.
- `requires` and `else` are also usable as field and parameter names.

### Command changes

`changes` lists the fields a command may change, after `requires` and before `emits`. What a command does to the
other fields follows from its transition:

```dt
// tickets/ticket.dt
context Tickets {
  id TicketId: UUID
  id PersonId: UUID

  aggregate Ticket {
    id: TicketId
    title: String
    note: String?
    state Open {
      assignee: PersonId?
    }
    state InProgress {
      assignee: PersonId
      startedAt: Timestamp
    }
    state Closed {
      closedAt: Timestamp
    }

    create command report(id: TicketId, title: String) -> Open // a factory sets every field
    command retitle(title: String, note: String?)
      Open -> Open
      InProgress -> InProgress
      changes title, note // common fields
    command assign(assignee: PersonId?)
      Open -> Open
      changes assignee // carried over from Open to Open, so listed to be changed
    command start(assignee: PersonId, at: Timestamp) Open -> InProgress // no `changes`: sets InProgress's assignee and startedAt, keeps the rest
    command close(at: Timestamp) Open | InProgress -> Closed // sets closedAt; assignee and startedAt are dropped
  }
}
```

1. Without `changes`, a command changes **no** common field (strict, like `emits`).
2. A state-specific field that both the source and the target state have, with the same name and type, is **carried
   over**: it keeps its value, unless it is listed in `changes`. `assignee` is carried over by `assign`
   (`Open -> Open`), not by `start`: it is `PersonId?` in Open and `PersonId` in InProgress.
3. The target state's other own fields are new, and the command always sets them, without `changes` (`startedAt`,
   and `assignee` in `start`). The source state's own fields that the target does not carry over are dropped.
4. A `create command` sets every field; `changes` on it is an error.
5. Without states, a command changes only the fields in `changes`.
6. A field in `changes` is **given every time**: there is no "absent = keep". An optional field is cleared by giving
   `undefined`. A command that changes a field only in some cases gives the old value in the others.
7. The unit is a top-level field: `changes items` for adding, removing or editing elements of `items`.

The generated decision of each command enforces these rules (see [Decisions and `decide`](#decisions-and-decide)).

- M021: the names are fields of the aggregate — common fields (also from field sets) or fields of its states — other
  than its identity; not on a `create command`. A state-specific field must be carried over by at least one outcome of
  the command (from a state that has it to one that has it, with the same type): in the other outcomes it is new in
  the target and set anyway, or not in the target and dropped, so listing a field that no outcome carries over would
  change nothing. `retitle` above may list `assignee` (`Open -> Open` carries it over); `start` may not.
- A field is listed once (M002).
- `changes` is also usable as a field and parameter name.

### Command events

`emits` is the exact list of the events a command emits **when it succeeds**; on failure (an error) it emits none.
Each entry is read like a field:

```dt
// work/work.dt
context Work {
  id WorkId: UUID
  id StepId: UUID

  aggregate Work {
    id: WorkId
    state Draft
    state InProgress
    state Completed {
      completedAt: Timestamp
    }

    create command open(id: WorkId)
      -> Draft
      emits WorkOpened // the new ID is a parameter
    command plan(steps: StepId[1..*])
      Draft -> Draft
      emits StepPlanned[1..*] // one per step
    command rename(title: String)
      Draft -> Draft
      emits Renamed? // not when the title is the same
    command start() Draft -> InProgress
    command progress(step: StepId, at: Timestamp)
      InProgress -> InProgress | Completed
      emits StepRecorded,
            WorkCompleted when -> Completed // only when it ends in Completed
  }

  event WorkOpened {
    workId: WorkId
  }
  event StepPlanned {
    workId: WorkId
    step: StepId
  }
  event Renamed {
    workId: WorkId
    title: String
  }
  event StepRecorded {
    workId: WorkId
    step: StepId
  }
  event WorkCompleted {
    workId: WorkId
    completedAt: Timestamp
  }
}
```

- `emits X`: **exactly one** `X`. `X?`: at most one. `X[0..*]`: any number. `X[1..*]`: one or more. `X[n..m]`:
  between `n` and `m` (the generated types check the cases before; other bounds are documented only).
- `X when Sources -> Targets`: the entry applies only to the outcomes that match — the command starts in one of the
  sources and ends in one of the targets. Either side may be left out (`when Confirmed ->`, `when -> Completed`), not
  both; each side may list states with `|`. A multiplicity comes before `when`: `ItemAdded[1..*] when -> Draft`.
- The states of `when` must be sources (left) or targets (right) of the command's transitions, and the pattern must
  match at least one of its outcomes (M006). A `create command` has no source: only `when -> X`. Commands of an
  aggregate without states take no `when`.
- An event is listed once per command (M011): its events are keyed by name in the generated result, so two events of
  different contexts with the same name cannot be emitted by one command.
- The events of one command have **no order**: they are facts of one decision. With event sourcing, applying the
  events of one command must not depend on their order.
- **When the contract and the implementation disagree**, follow `@see` on the generated type to the declaration,
  and change the DSL, not the implementation. If following the contract would make the implementation do something
  wrong in business terms — emitting `Renamed` although the title did not change — the contract is what is wrong:
  write `emits Renamed?`. Never emit an event only to satisfy the types, and never leave out one the contract requires.
- `when` is also usable as a field and parameter name.

### Pure commands

A command is a **pure function** of the aggregate and its parameters: no I/O, no clock, no randomness, no generated
IDs. Whatever the decision needs comes in as a parameter — the new aggregate's ID (`open(id: WorkId)`), the time
(`at: Timestamp`), data of other aggregates. Loading, saving, publishing and calling other services happen around the
command, in your application code. This makes every command reproducible: the same inputs give the same aggregate
and events, so commands are tested without mocks.

A `create command` without a parameter of the aggregate's ID type is a warning (M020): it would have to make the ID
itself.

## Rules

Each diagnostic names its rule. A `hint` says what to change when the message does not; unresolved names get
`did you mean …?` instead.

| Code | Check |
|---|---|
| SYNTAX | lexer / parser errors |
| M001 | types, aggregates and names in invariants and requirements resolve |
| M002 | names are unique in their scope (also across files of one context) |
| M003 | an entity is owned by exactly one aggregate (warning when owned by none) |
| M004 | no ownership across aggregate boundaries (entities need `owns`, aggregates need `references`, …) |
| M005 | a reference's ID type matches the identity of the target aggregate |
| M006 | command transitions: states exist; stateful: `create` has one `-> X`, others one or more `A -> B` with sources; a state is the source of one transition per command; stateless: none. `emits … when`: its states are sources / targets of the command, it matches an outcome, a factory selects by target only, stateless: no `when` |
| M007 | `emits` / `errors` / `else` refer to existing events / errors |
| M008 | an invariant or requirement is a Bool expression |
| M009 | operators and operands have compatible types |
| M010 | state-specific fields are used only in their own state's invariants, and in requirements of commands whose every source state has them |
| M011 | generated TypeScript names do not collide, including the events of one command (keyed by name) |
| M012 | the ownership graph has no cycles |
| M013 | aggregates and entities have an `id` field of their own ID type |
| M014 | shared contexts: only value types, no dependency on other contexts, consistent `shared`, unambiguous names (shadowing is a warning) |
| M015 | unions: at least one variant, variants match the bound enum exactly, no variant field named like the discriminator |
| M016 | field sets: plain fields only (no `id`), `with` only on aggregates, entities and events, each field name from one place |
| M017 | (warning) an event emitted by an aggregate's command has a field of that aggregate's ID type |
| M018 | an invariant or requirement without an expression has a label or a `///` description |
| M019 | a parameter of a command with `requires` is not named like a field its requirements see |
| M020 | (warning) a `create command` has a parameter of the aggregate's ID type (commands are pure: the ID is passed in) |
| M021 | `changes` names fields the command can change: fields of the aggregate other than its identity, a state-specific one carried over by an outcome; none on a `create command` |
| L001 | (warning) an inline field label disagrees with the term, or context fragments disagree on the context name |
| L002 | (warning) a term is not used by any field or parameter |
| L003 | (warning) different things in one scope share a Japanese name |

## Generated TypeScript

Per context a module (`Sales.ts`, …) with ID brands, enums, value objects, entities, unions, a discriminated union per
stateful aggregate (`DraftOrder | ConfirmedOrder | …`), event / error types with a `type` tag, a function type per
command and an `<Aggregate>Commands` interface to implement, plus `index.ts` and `_runtime.ts`. A domain primitive
gets a branded type and a constructor contract `Make<Name>` to implement by hand. A field set is an interface that the
elements using it extend (`interface Expense extends Common.Tenanted`; for a stateful aggregate, its `…Common`).
The JSDoc of every declaration that comes from the DSL ends with `@see <file>:<line>`, the declaration's place as
`dt check` prints it (relative to the config root, e.g. `@see sales/order.dt:46`); editing the `.dt` sources moves
these lines, and generating again rewrites them.

Unions to name groups of them, each generated only when it has a member:

| Type | Members |
|---|---|
| `DomainEvent` | every event of the context |
| `PersistentEvent` | the events declared `persistent` |
| `Aggregate` | every aggregate of the context |
| `<Aggregate>Event` (`OrderEvent`) | the events the aggregate's commands may emit (also of other contexts) |

```ts
/**
 * Order.confirm (Draft -> Confirmed)
 * 注文を確定する
 * @param at 日時
 * @requires hasItems (明細が1件以上) else EmptyOrder: count(items) > 0
 * @changes none — the command changes no common field
 * @emits OrderConfirmed — exactly once when the command succeeds
 * @see sales/order.dt:46
 */
export type ConfirmOrder = (
    order: DraftOrder,
    at: Timestamp,
) => Result<{
    readonly Confirmed: {
        readonly aggregate: ConfirmedOrder;
        readonly events: { readonly OrderConfirmed: OrderConfirmed };
    };
}, EmptyOrder>;
```

The success value is **keyed by the outcome**: the target state's name (an aggregate without states: the aggregate's
name, `{ Customer: { aggregate, events } }`), holding the aggregate in that state and its `events`. Every command has
this shape, also with one target. With several targets the value is a union, and each branch rules out the other keys,
so a value holds exactly one outcome:

```ts
export type ProgressWork = (
    work: InProgressWork,
    step: StepId,
    at: Timestamp,
) => Result<
    | {
          readonly InProgress: {
              readonly aggregate: InProgressWork;
              readonly events: { readonly StepRecorded: StepRecorded };
          };
          readonly Completed?: never;
      }
    | {
          readonly Completed: {
              readonly aggregate: CompletedWork;
              readonly events: { readonly StepRecorded: StepRecorded; readonly WorkCompleted: WorkCompleted };
          };
          readonly InProgress?: never;
      },
    never
>;
```

`events` is always there, one property per event of that outcome, keyed by the event's name (its `type`; an event of
another context by its simple name) and typed by its multiplicity:

| `emits` | property of `events` |
|---|---|
| `X` | `X: X` |
| `X?` | `X?: X` |
| `X[0..*]` | `X: readonly X[]` (also when empty) |
| `X[1..*]` | `X: readonly [X, ...X[]]` |
| `X[n..m]` (others) | `X: readonly X[]`, the bounds in JSDoc (not checked by the types) |
| none | `NoEvents` (only `{}` is assignable) |

The JSDoc says the same in words, one `@emits` line per entry (`@emits WorkCompleted — exactly once when it ends in
Completed`). Return the value with `ok`, which takes its type from the contract, so that the compiler checks the
object exactly: a missing event is reported as `Property 'WorkCompleted' is missing …`, an event the outcome does not
emit as `… 'WorkCompleted' does not exist in type …`:

```ts
return ok({ Confirmed: { aggregate: confirmed, events: { OrderConfirmed: { type: 'OrderConfirmed', orderId: order.id, confirmedAt: at } } } });
```

A command takes the aggregate in any source state of its transitions. When every source state has the same outputs
(`Draft | Confirmed -> Cancelled`), it is a plain function, as above. When the outputs differ by source state — the
targets differ by transition, or the events do (`emits RefundRequested when Confirmed ->`) — the command is generic
over the input state, and its result is the one of that state, looked up in an object keyed by the source states. A
caller with a `DraftOrder` gets a `DraftOrder` back, never a `ConfirmedOrder`; a caller with
`DraftOrder | ConfirmedOrder` gets either:

```ts
export type ChangeNoteOrder = <S extends DraftOrder | ConfirmedOrder>(
    order: S,
    note: string | undefined,
) => {
    /** @emits NoteChanged? — at most once when the command succeeds */
    readonly Draft: Result<{
        readonly Draft: {
            readonly aggregate: DraftOrder;
            readonly events: { readonly NoteChanged?: NoteChanged };
        };
    }, never>;
    /** @emits NoteChanged? — at most once when the command succeeds */
    readonly Confirmed: Result<{
        readonly Confirmed: {
            readonly aggregate: ConfirmedOrder;
            readonly events: { readonly NoteChanged?: NoteChanged };
        };
    }, never>;
}[S['state']];
```

### Decisions and `decide`

A command is implemented as a **decision**: for its outcome, the fields to `set` and the `events`. `decide` from the
runtime turns a decision into the command, making the aggregate. Every command has a `<Command><Aggregate>Decision`
type with **one handler per source state**, keyed by the state's name — also with a single source state, so that every
command is written the same way. A `create command` and a command of an aggregate without states have one function
instead.

```ts
/**
 * Order.confirm, decided per source state; implement it with `decide(OrderShape, …)` from the runtime.
 * Each outcome gives the fields of `set`, and `decide` makes the aggregate, taking the other fields from the input.
 * @requires hasItems (明細が1件以上) else EmptyOrder: count(items) > 0
 * @changes none — the command changes no common field
 * Draft -> Confirmed — set: confirmedAt (new in Confirmed); carried over: id, items, customer, note
 * @see sales/order.dt:46
 */
export type ConfirmOrderDecision = {
    /** @emits OrderConfirmed — exactly once when the command succeeds */
    readonly Draft: (order: DraftOrder, at: Timestamp) => Result<{
        readonly Confirmed: {
            readonly set: { readonly confirmedAt: Timestamp };
            readonly events: { readonly OrderConfirmed: OrderConfirmed };
        };
    }, EmptyOrder>;
};
```

`set` holds exactly what the command decides, by the rules of [Command changes](#command-changes): the target state's
new fields and the fields in `changes`. Every one is required; an optional field is typed `T | undefined`, and an
outcome with nothing to set has `NoChanges` (only `{}` is assignable). Anything else is a compile error that names the
field: `items` in the `set` of `confirm` is reported as
`'items' does not exist in type '{ readonly confirmedAt: Timestamp; }'`, a missing `confirmedAt` as
`Property 'confirmedAt' is missing in type '{}' …`. The JSDoc lists `@changes` and, per outcome, what is set, carried
over and dropped.

`decide(shape, decision)` calls the handler of the aggregate's `state` with the command's arguments. For the outcome
it returns, it makes the aggregate from the fields of `set`, the other fields of the target state taken from the input
(the common fields and the carried-over state-specific fields) and the target `state`; the input's other fields are
dropped. A factory's aggregate is its `state` and `set`. Events and errors pass through unchanged. The shape is the
data `decide` needs, a constant generated per aggregate:

```ts
/**
 * The fields of Order as data for `decide`: the common fields, and the fields of each state on top of them.
 * @see sales/order.dt:13
 */
export const OrderShape: Shape = {
    fields: ['id', 'items', 'customer', 'note'],
    states: { Draft: [], Confirmed: ['confirmedAt'], Cancelled: ['reason'] },
};
```

Pass the decision type as the type argument, so that the handlers are typed from it. The result is assignable to the
command's contract without a type assertion, and each handler is checked against its own transition — deciding the
Confirmed outcome in the `Draft` handler of `changeNote`, or leaving a handler out, is a compile error:

```ts
// src/note.ts — your code
import { Sales, decide, err, ok } from '../generated/domain/index.js';

const noteChanged = (order: Sales.Order, note: string | undefined) =>
    note === order.note ? {} : { NoteChanged: { type: 'NoteChanged', orderId: order.id, note } as const };

export const changeNote: Sales.OrderCommands['changeNote'] = decide<Sales.ChangeNoteOrderDecision>(Sales.OrderShape, {
    Draft: (order, note) => ok({ Draft: { set: { note }, events: noteChanged(order, note) } }),
    Confirmed: (order, note) => ok({ Confirmed: { set: { note }, events: noteChanged(order, note) } }),
});

export const confirm: Sales.OrderCommands['confirm'] = decide<Sales.ConfirmOrderDecision>(Sales.OrderShape, {
    Draft: (order, at) => {
        if (order.items.length === 0) return err({ type: 'EmptyOrder' });
        return ok({ Confirmed: { set: { confirmedAt: at }, events: { OrderConfirmed: { type: 'OrderConfirmed', orderId: order.id, confirmedAt: at } } } });
    },
});
```

The contract can still be implemented directly, returning the aggregate itself; then nothing keeps the command from
changing a field it does not list, and a generic contract needs a type assertion on its result (TypeScript does not
narrow `S` inside the implementation).

Code that handles any command — saving the aggregate, publishing the events — uses `outcome` and `eventList` from the
runtime. `outcome(value)` gives `{ to, aggregate, events }` (`to` is the key: the target state). `eventList(events)`
gives the events as one list: arrays flattened, absent optional events skipped, sorted by event type (an order of
convenience: the contract has none).

```ts
// src/confirm.ts — your code: the application around a command
import { eventList, outcome, type Sales } from '../generated/domain/index.js';

export interface OrderStore {
    save(order: Sales.Order, events: readonly Sales.OrderEvent[]): Promise<void>;
}

export async function confirm(commands: Sales.OrderCommands, store: OrderStore, order: Sales.DraftOrder, at: Date): Promise<Sales.EmptyOrder | undefined> {
    const r = commands.confirm(order, at); // the time is a parameter: the command is pure
    if (!r.ok) return r.error;
    const { aggregate, events } = outcome(r.value);
    await store.save(aggregate, eventList(events));
    return undefined;
}
```

A command's requirements are documented on its type and on its decision, one `@requires` line each, and the
errors of their `else` are part of its error type (after those of `errors`, each once):

```ts
/**
 * Review.accept (Reviewing | Escalated -> Accepted)
 * 受入
 * @requires authorizedApprover (承認者である) else NotApprover: contains(policy.approvers, person)
 * @requires noOpenBlocker (未解決の阻害がない) else Blocked: openBlockers == 0
 * @requires signedOff (本人の承認が記録済み) else NotSignedOff: not expressed in the DSL
 * @changes none — the command changes no common field
 * @emits nothing
 * @see review/review.dt:18
 */
export type AcceptReview = (
    review: ReviewingReview | EscalatedReview,
    person: PersonId,
) => Result<{
    readonly Accepted: {
        readonly aggregate: AcceptedReview;
        readonly events: NoEvents;
    };
}, Conflict | NotApprover | Blocked | NotSignedOff>;
```

### Generated code and your code

The generated files are the **contract**, your code is the **implementation**:

- Generated: types — the shapes of the model, the command signatures (`ConfirmOrder`, `OrderCommands`) and their
  decisions (`ConfirmOrderDecision`), and the constructor signatures of domain primitives (`MakeQuantity`) — plus
  data without logic: one shape constant per aggregate (`OrderShape`), the field names `decide` needs. Invariants and
  command requirements appear as JSDoc (`@invariant`, `@requires`); nothing in the generated code checks them. The
  one exception is `_runtime.ts`, whose few helpers (`ok`, `err`, `decide`, `outcome`, `eventList`) are the same for
  every model.
- Yours: everything that runs — command implementations (including their requirements; pure functions, see
  [Pure commands](#pure-commands)), `Make<Name>` constructors,
  invariant checks — in your own files, which import the generated modules (never the other way round) and are
  type-checked against them.

```ts
// src/primitives.ts — your code
import { err, ok, type Sales } from '../generated/domain/index.js';

export const makeQuantity: Sales.MakeQuantity = (value) =>
    Number.isInteger(value) && value >= 1 && value <= 999 ? ok(value as Sales.Quantity) : err({ type: 'InvalidQuantity', value, invariant: 'valid' });
```

Do not edit generated files: change the `.dt` sources and generate again. Adding properties or methods to generated
types (declaration merging, editing the output) is not supported; write functions that take the generated types.

### Technical metadata

Technical fields (see [Domain fields and technical fields](#domain-fields-and-technical-fields)) are added by your code,
around the generated types. Keep the two apart in an envelope, `{ event, meta }`, rather than an intersection
(`E & Meta`): names cannot clash, and domain and technical fields stay separate. `dt` generates no envelope type.

```ts
// src/stored.ts — your code: metadata of stored events and aggregates
import type { Sales } from '../generated/domain/index.js';

export interface EventMeta {
    readonly eventId: string;
    readonly recordedAt: Date;
    readonly correlationId?: string;
    readonly causationId?: string;
}

/** What Sales records in addition. */
export interface SalesEventMeta extends EventMeta {
    readonly accountId: string;
}

export type Stored<E, M extends EventMeta = EventMeta> = { readonly event: E; readonly meta: M };

export type StoredSalesEvent = Stored<Sales.PersistentEvent, SalesEventMeta>;

export interface AggregateMeta {
    readonly version: number;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

export type Versioned<A, M extends AggregateMeta = AggregateMeta> = { readonly aggregate: A; readonly meta: M };

export interface OrderRepository {
    load(id: Sales.OrderId): Promise<Versioned<Sales.Order> | undefined>;
    save(order: Versioned<Sales.Order>, events: readonly Sales.OrderEvent[]): Promise<void>;
}
```

Metadata that only some kinds of event carry can be keyed by the event's `type`:

```ts
// src/meta-by-event.ts — your code
import type { Sales } from '../generated/domain/index.js';
import type { EventMeta } from './stored.js';

interface MetaByEvent {
    OrderPlaced: { readonly channel: 'web' | 'store' };
}

export type MetaOf<E extends { type: string }> = EventMeta & (E['type'] extends keyof MetaByEvent ? MetaByEvent[E['type']] : {});

/** One envelope per kind of event, so that a union of events gives a union of envelopes. */
export type StoredEvent<E extends { type: string }> = E extends unknown ? { readonly event: E; readonly meta: MetaOf<E> } : never;

export const channelOf = (s: StoredEvent<Sales.OrderPlaced>): 'web' | 'store' => s.meta.channel;
export type StoredSalesEvents = StoredEvent<Sales.DomainEvent>;
```

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
