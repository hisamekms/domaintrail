# DomainTrail guide

`dt` checks domain models written in the DomainTrail DSL (`.dt` files) and generates TypeScript types and command
contracts from them. The DSL describes domain **structure and contracts** only — never business logic, which is written
by hand against the generated types.

This guide is written for people and AI agents using `dt` without other documentation. `dt guide` prints the quick
reference below and the list of topics, `dt guide <topic>` one section (the name in the `<!-- topic: … -->` line above
its heading, e.g. `dt guide requires`), `dt guide <rule>` one rule (`dt guide M010`), and `dt guide --all` all of it.

<!-- topic: quick -->
## Quick reference

**The loop.** Edit `.dt` files → `dt fmt` → `dt check` until it exits 0 → `dt generate ts` → implement each command
with `decide` against its generated `<Command><Aggregate>Decision` type → type-check your code (`tsc --noEmit` or
`bun check`) → run the generated contract tests. Never edit generated files; change the `.dt` sources and generate
again.

**The DSL at a glance** (one file of a valid workspace):

```dt
// library/loan.dt
context Library "図書館" { // a bounded context; "…" is a label (表示名)
  id LoanId: UUID // an ID type
  id BookId: UUID
  value Period { // a value object
    days: Int
  }
  aggregate Loan "貸出" {
    id: LoanId // identity (required)
    book: BookId
    owns period: Period
    renewals: Int
    note: String? // ? = optional
    invariant renewalsLimited { renewals >= 0 and renewals <= 2 } // holds in every state
    state Lent
    state Overdue
    state Returned {
      returnedAt: Timestamp // only in this state
    }
    create command lend(id: LoanId, book: BookId, period: Period) "貸し出す"
      -> Lent
      emits BookLent
    command renew(extension: Period)
      Lent -> Lent
      requires underLimit { renewals < 2 } else RenewalLimitReached
      changes period, renewals
      emits LoanRenewed
    command markOverdue() Lent -> Overdue
    command giveBack(at: Timestamp)
      Lent | Overdue -> Returned
      emits BookReturned,
            FeeCharged? when Overdue ->
      errors BookDamaged
  }
  event BookLent {
    loanId: LoanId
    book: BookId
  }
  event LoanRenewed {
    loanId: LoanId
    period: Period
  }
  event BookReturned {
    loanId: LoanId
    returnedAt: Timestamp
  }
  event FeeCharged {
    loanId: LoanId
    days: Int
  }
  error RenewalLimitReached
  error BookDamaged
}
```

**The contract keywords:**

- `owns x: T` — an entity or value held by the aggregate; `references x: XId -> X` — another aggregate, by ID only.
- `invariant name { expr }` — holds whenever the aggregate (or, inside a `state`, that state) exists.
- `state S { … }` — a lifecycle state with its own fields; without states, commands have no transitions.
- `create command c(…) -> S` — makes a new aggregate; it takes the new ID as a parameter (commands are pure).
- `A | B -> C | D` — the command runs in `A` or `B` and ends in `C` or `D`; one transition per source state.
- `requires name { expr } else E` — the command is accepted only if; otherwise it returns `E` (the first one failing).
- A rule over a changeable policy: an invariant over a policy kept on the aggregate, or `requires` (`dt guide policies`).
- `changes a, b` — the fields it may change; without `changes`, no common field (a target state's new fields are set).
- `emits X` — exactly one `X` on success; `X?` at most one, `X[1..*]` one or more; `X when A -> B` only then.
- `errors E` — errors it may return besides those of `else`; on an error it emits no event.
- `verified V of T for C? errors E` — evidence of a check outside the aggregate, as a parameter (`dt guide verified`).
- `policy P when E -> A.c` — when event `E` happens, command `A.c` eventually runs (`dt guide reactions`).

**The commands:**

- `dt guide [topic]` — this reference, one section, or `--all`.
- `dt fmt` — format the `.dt` and `.dtes` files in place (`--check` for CI).
- `dt migrate dtes` — rewrite `.dtes` files of earlier versions (v0.1: `actor`, `target` in a command → `by`,
  `handledBy`; 0.8: the `reads` of a command a policy issues → that policy's `reads`).
- `dt check` — check the model and its stormings (`.dtes`); exit 0 when there are no errors (`--format json` for JSON).
- `dt generate ts` — check, then write the TypeScript (and the contract tests, if configured).
- `dt show <name>` — one element, command or state resolved, with who uses it; read it instead of the `.dt` files.
- `dt lsp` — language server over stdio: the diagnostics of `dt check`, definitions, references, hover, rename.
- `dt mcp` — MCP server over stdio: the project's knowledge, read-only (`dt guide mcp`; knowledge: `dt guide knowledge`).
- `dt publish` — the stormings to the knowledge store's Worker, for its read-only page; run by CI (`dt guide publish`).
- `dt open` — the Live View in the browser, with a chat to the AI; it runs until Ctrl+C, so run it in the background.
- `dt export sources` / `svg` — the sources as one ZIP, for someone without the repository; a diagram as an SVG file.

**When the contract and the implementation disagree**, follow `@see` on the generated type to the declaration and
change the DSL, not the implementation: never emit an event or set a field only to satisfy the types.

**Never cast to a domain type** (`as X`): make it with `make<Name>`, `parseDecimal` or a factory (`dt guide lint`).

**After upgrading domaintrail**, follow the Upgrading steps in `node_modules/domaintrail/CHANGELOG.md`.

<!-- topic: workflow -->
## Workflow

1. Write or edit `.dt` files (see [DSL](#dsl) and [File layout](#file-layout-recommended)).
2. Run `dt fmt` to put them in the canonical layout (see [Formatting](#formatting)).
3. Run `dt check` and fix every reported problem until it exits 0.
4. Run `dt generate ts` to write the TypeScript (it runs `check` first and writes nothing on errors).
5. Implement the generated contracts in your own code — each command as a decision with `decide` (see
   [Decisions and `decide`](#decisions-and-decide)) — and type-check that code with your own TypeScript setup
   (e.g. `tsc --noEmit`, or `bun check` with Bun). `dt` does not run the TypeScript compiler.
6. With `generate.ts.tests` configured, run the generated contract tests against your implementation with your test
   runner (see [Generated tests](#generated-tests)).

`dt open` starts the Live View, a browser page where people watch the model update as files are saved (with a chat to
the AI for the person who started it; see [Collaboration sessions](#collaboration-sessions)). It is a server that keeps
running and never exits by itself (stop it with Ctrl+C), so do not wait for it to finish: run it in the
background, or use `dt check` for a result.

Event Storming files (`.dtes`) go through the same loop: `dt fmt`, then `dt check` until it exits 0 (see [Event
Storming](#event-storming-dtes)). They are not generated: `dt generate ts` writes the `.dt` model only.

How to work, beyond the rules of the languages: `dt guide storming-practice` for running a storming (Big Picture, then
Design Level) and `dt guide modeling-practice` for growing the `.dt` model (terms, aggregates by their invariants,
the DSL's types rather than strings, commands as contracts, small steps); `dt guide dsl-quick` shows the `.dt` syntax
in one example, `dt guide dtes-quick` the `.dtes` syntax.

`dt --help` and `dt <command> --help` list the options with examples.

```bash
dt fmt                          # format every *.dt and *.dtes file below the current directory in place
dt check                        # every *.dt and *.dtes file below the current directory
dt -r domain check              # below domain/ (or as configured by a domaintrail.jsonc found there or above)
dt generate ts                  # into <root>/generated/domain
dt generate ts --out src/domain/generated
dt open --port 8080             # http://127.0.0.1:8080, until Ctrl+C
```

<!-- topic: layout -->
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
stormings/order-to-cash.dtes   storming OrderToCash "注文から入金まで" { ... }   // one storming per file
```

- `<context>/<aggregate>.dt` holds the aggregate and what only it uses: its ID, entities, events, errors, enums,
  primitives and values.
- `<context>/context.dt` holds the context's name (表示名), description and `terms`, and the elements used by several of
  its aggregates or by none (field sets, for example). The other files open the context without a name or `///`:
  `context Sales { ... }`. A context's description is written once, in one of its files (M025).
- An aggregate's ID stays in the aggregate's file even when other aggregates reference it.
- A storming goes to `stormings/<storming>.dtes`, apart from the contexts: it may span several of them.
- Directory and file names are kebab-case: `PurchaseOrder` → `purchase-order.dt`, `OrderFulfillment` →
  `order-fulfillment/`.

This is a convention, not a rule: `check` neither requires nor warns about any layout.

<!-- topic: dsl -->
## DSL

The examples below are the files of one valid workspace (the file name is in the first comment).

<!-- topic: dsl-quick -->
### The syntax by example

One file with each kind of declaration; the topics below explain each. Write in this style.

```dt
// rental/lease.dt
context Rental "レンタル" { // a bounded context; "…" is a label (表示名)
  id MemberId: UUID // an ID type: each aggregate and entity has its own
  id LeaseId: UUID
  enum Plan { Basic Premium } // a closed set of values
  value Fee { // a value object
    amount: Int
  }
  union Discount { // variants that carry different fields (none do: an enum)
    Coupon {
      code: String
    }
    Points {
      points: Int
    }
  }

  aggregate Member "会員" {
    id: MemberId // its identity, of its own ID type
    plan: Plan
    command upgrade() // no states: no transitions
      changes plan
      emits MemberUpgraded
  }

  aggregate Lease "貸出" {
    id: LeaseId
    references member: MemberId -> Member // another aggregate, by its ID type
    owns fee: Fee // a value or entity held by the aggregate
    discount: Discount? // ? = optional, [0..*] = a list
    invariant feePositive { fee.amount > 0 }
    state Active
    state Closed {
      closedAt: Timestamp // only in this state
    }
    create command start(id: LeaseId, member: MemberId, fee: Fee) // takes the new ID
      -> Active
      emits LeaseStarted
    command close(closedAt: Timestamp)
      Active -> Closed
      requires settled { not exists(discount) } else DiscountPending
      emits LeaseClosed
  }

  event LeaseStarted {
    leaseId: LeaseId
    member: MemberId
  }
  event LeaseClosed {
    leaseId: LeaseId
    closedAt: Timestamp
  }
  event MemberUpgraded {
    memberId: MemberId
  }
  error DiscountPending
  policy UpgradeAfterLease when LeaseClosed -> Member.upgrade // when the event happens, the command runs
}
```

<!-- topic: aggregates -->
### Contexts and aggregates

```dt
// sales/order.dt
context Sales { // a bounded context; may be split across files
  id OrderId: UUID // ID type with a base primitive type
  id OrderItemId: UUID
  enum CancelReason { Requested Other } // values separated by spaces (commas are allowed; `dt fmt` drops them)
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
      Confirmed -> Confirmed // one transition per line (`Draft -> Draft, Confirmed -> Confirmed` is allowed too)
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
  /// 他の顧客に使われていないことを、登録・変更のときに確かめたメールアドレス。
  verified AvailableEmail "未使用のメールアドレス" of EmailAddress for CustomerId? errors EmailTaken // dt guide verified

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

    /// No other customer has the same email address: checked when one is given (AvailableEmail), kept by the store.
    invariant uniqueEmail "メールアドレスは顧客ごとに一意"

    command changeEmail(email: AvailableEmail) // the check was made before: its error is the factory's
      changes email
  }

  error EmailTaken {
    email: EmailAddress
  }
}
```

- Context elements: `id`, `primitive`, `enum`, `value`, `union`, `entity`, `aggregate`, `event`, `error`, `fields`
  (see [Field sets](#field-sets)), `verified` (see [Verified types](#verified-types)) and `policy` (see
  [Reactions to events](#reactions-to-events-policies)).
- Fields: `name: Type`, `owns name: Type` (entities and values held by the aggregate),
  `references name: IdType -> Aggregate` (other aggregates, by ID only). Entities are owned by exactly one aggregate.
  An ID is held by its ID type: a `customerId: String` (or `UUID`) while `CustomerId` or `Customer` exists is a warning
  (M027).
- Primitive types: `String`, `Int`, `Decimal`, `Bool`, `Timestamp`, `UUID`.
- Multiplicity after the type: `?` (also `[0..1]`, which `dt fmt` writes as `?`), `[0..*]`, `[1..*]`, `[n..m]`.
- Aggregate members: fields, `invariant`, `state` (with its own fields and invariants), `command`.
- A command is written in this order: parameters and label, transitions, `requires` (see
  [Command requirements](#command-requirements)), `changes` (see [Command changes](#command-changes)), `emits` (see
  [Command events](#command-events)), `errors`.
- Transitions: `A | B -> C | D` means "in `A` or `B`, the command ends in `C` or `D`". Separate several transitions by
  line breaks or commas (`dt fmt` writes one per line). A state may be the source of one transition of a command only,
  so the input state decides the possible outputs; for several possible outcomes, list them on the right: `InProgress ->
  InProgress | Completed`.
- In an aggregate with states, a `create command` makes a new aggregate and has exactly one transition without
  sources (`-> Draft`, or `-> A | B`); every other command has one or more transitions, each with sources. Without
  states, commands have no transitions. A command that keeps the state writes it out: `Draft -> Draft`.
- `value`, `state`, `event` and `error` bodies are optional (`state Draft`, `error EmptyOrder`).
- Other contexts' elements are referenced with qualified names: `Sales.OrderId`, `-> Sales.Order`.
- Keywords as names: a field, parameter, term, command, discriminator or lambda parameter may be named with a
  declaration keyword (`event: EventName`, `state: Status`, `errors: Reason[0..*]`, `command emits(…)`): a name is
  followed by `:` (or `(` for a command), a declaration by its name. The words of expressions (`not`, `in`, `and`,
  `or`, `implies`, `true`, `false`) and the primitive types are not field names. Enum values and union variants may be
  any word, those included (`enum Op { and or not }`, written `Op.and` in an expression). Elements and contexts are
  named with identifiers only.
- Comments: `// …` and `/* … */`; `///` is a description (see [Names](#names-labels-and-descriptions)).

<!-- topic: primitives -->
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
- Elsewhere a domain primitive compares with literals, with the same domain primitive and, over `Int` or `Decimal`,
  with the numbers `count(…)` and `length(…)` compute (`count(approvedBy) >= policy.requiredApprovals`); not with
  another domain primitive or a plain field or parameter of its base type (M009).
- Only IDs can be identity fields and reference types. Domain primitives cannot be owned.
- An ID or domain primitive on `UUID` holds a UUID: 8-4-4-4-12 hexadecimal digits (RFC 9562), in either case, of any
  version. Its constructor checks it as the invariant `uuid`, before those declared, so `makeOrderId('order-1')` is an
  `InvalidOrderId`; an invariant of its own cannot be named `uuid` (M002). A plain field or parameter of type `UUID` is
  a `string`, unchecked.
- The generated code includes the constructor: `makeQuantity` checks the invariants and returns the first one
  violated (`makeSkuWith(checks)` when an invariant has no expression); see [Generated checks](#generated-checks).

<!-- topic: unions -->
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
- A union whose variants hold no fields is a closed set of values: write an `enum` (M026, a warning; with `by name:
  Enum`, use the enum itself).
- In invariants, `payer.kind` compares with `Payer.COMPANY` (or the bound enum's values); variant fields are not
  accessible from outside the union.
- Value objects and unions may be recursive (a tree, an expression) when every value has a finite form: the cycle
  passes through an optional field (`?`), a list that may be empty (`[0..*]`), or a union with a variant out of it
  (`union Expr { lit { value: Int } not { operand: Expr } }`). Otherwise, and for any cycle through an entity or an
  aggregate, it is M012. The generated types, equality and checks handle nesting, and the contract tests draw nested
  values up to a maximum depth (see [Generated tests](#generated-tests)).

<!-- topic: shared -->
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

<!-- topic: field-sets -->
### Field sets

Fields that several aggregates, entities, value objects or events have for the same domain reason are written once as
a field set and taken on with `with`.

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

    create command submit(id: ExpenseId, applicant: StaffId "申請者", performedBy: StaffId "実施者") "申請する" // by proxy, too
      emits ExpenseSubmitted
    command approve(approver: StaffId "承認者", approvedAt: Timestamp "承認日時") "承認する"
      changes approver
      emits ExpenseApproved
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
- `with A, B` after the name and label of an `aggregate`, `entity`, `value` or `event` (only those, M016). A field set is
  referenced like a type: by name in its own context and from shared contexts, as `Context.Name` otherwise.
- The fields come first, in the order of `with`, and then count as the element's own: invariants see them, and an
  aggregate's states share them. A name may come from one place only, the element or one of its field sets (M016).
- The identity of aggregates and entities is never a field set: every aggregate and entity declares `id` itself (M013).
- A command's event should say which aggregate it is about: it needs a field of the aggregate's ID type, its own or
  from a field set (M017 warning). An event emitted by several aggregates needs the ID type of each (optional fields
  count).

<!-- topic: fields -->
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
  `fields Performed { performedBy: StaffId "実施者" }`. The login account, service account or IP address is
  technical; it differs with proxy entry and batches.

<!-- topic: names -->
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

- Declarations (context, id, primitive, verified, enum and its values, value, union and its variants, entity,
  aggregate, state, command, invariant, event, error) take an optional string label after the name.
- A field or parameter is named by, in order: its inline string → the context's `terms` → the name of its type
  (for `references`, the target aggregate) → the English name.
- `///` lines directly above a declaration or term are its description: a short statement of what the element is.
- A context's description is written once. When a context is split across files, a `///` above `context X` in a second
  file is an error (M025) that names the first; merge the two into one.
- Labels appear in the Live View and as JSDoc in the generated TypeScript; identifiers and generated type names stay
  English.

<!-- topic: expressions -->
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
  Both sides must be of the same type (domain primitives also compare with literals, and over `Int` or `Decimal` with
  `count(…)` and `length(…)`, also in `<`, `<=`, `>`, `>=` and ranges); collections and optional values cannot be
  compared (guard an optional with `exists(...)` first).
- An invariant must be a Bool expression. `dt check` checks only its type; whether a value holds it is checked by the
  generated check functions (`checkConfirmedOrder`, see [Generated checks](#generated-checks)), with exactly these
  semantics.
- A constraint the DSL cannot express is declared without an expression, with a label or a `///` description that
  states it (M018): `invariant uniqueEmail "メールアドレスは顧客ごとに一意"`. It is documented like any invariant (in
  the Live View and as `@invariant uniqueEmail (…): not expressed in the DSL` in the generated TypeScript) and is
  checked by your code only: the generated checks take it as a function you pass in (a slot). In a domain primitive,
  its name joins the invariants of `Invalid<Name>`.
- `count`, `exists`, `length`, `matches`, `all`, `any`, `unique` and `contains` are also usable as field and parameter
  names; followed by `(` they are the functions.

<!-- topic: requires -->
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
- Name the fields of errors after their source, as for events ([naming payload fields](#command-events), M022): the
  parameters and the aggregate before the command.
- `else Error` is required. The error joins the command's errors: it need not be listed in `errors` (listing it
  again is allowed), and several requirements may share one. An unknown error is M007.
- Requirement names are unique within the command (M002). Without an expression, a requirement needs a label or a
  `///` description (M018), like an invariant.
- They appear in the Live View (振る舞い tab) and as `@requires` JSDoc on the generated command type (see
  [Generated TypeScript](#generated-typescript)); your command implementation returns the error. The generated
  `check<Command>Requires` (e.g. `checkConfirmOrderRequires`) evaluates them, and the generated tests compare your
  implementation with it.
- **When several requirements do not hold, the command returns the error of the first one in declaration order.**
  Order the requirements accordingly (the cheapest or most basic first); the generated tests expect exactly that
  error.
- Not supported: requirements for some source states only (split the command instead), and a generic
  `<Command>Rejected` error.
- `requires` and `else` are also usable as field and parameter names.

<!-- topic: policies -->
### Rules that depend on a policy

A policy is a rule the business may change: how many approvals a purchase needs, who may approve, how a credit score
is computed. There is no policy element; one question decides how to write a rule that depends on one:

**Must the rule keep holding after the policy changes?** An invariant holds at all times, so an invariant over a
policy kept outside the aggregate would make existing aggregates invalid as soon as the policy changes. If the rule
must hold for this aggregate from now on, fix the policy on the aggregate and write an invariant (1). If the policy
decides only whether a command runs, under the policy current at that moment, write a requirement (2). The choice
states whether a policy change affects existing data.

**1. Policy fixed on the aggregate**: keep the policy as a value object in the aggregate, taken when the aggregate is
created, and write invariants over it. A later change of the policy applies to new aggregates only.

```dt
// purchasing/purchase-request.dt
context Purchasing {
  id RequestId: UUID
  primitive Count: Int { value in 0..100 }
  value ApprovalPolicy {
    requiredApprovals: Count
  }

  aggregate PurchaseRequest "購買申請" {
    id: RequestId
    policy: ApprovalPolicy // the policy when the request was submitted
    approvedBy: PersonId[0..*]
    state Pending
    state Approved {
      invariant enoughApprovals { count(approvedBy) >= policy.requiredApprovals }
    }

    create command submit(id: RequestId, policy: ApprovalPolicy) -> Pending
    command approve(person: PersonId)
      Pending -> Pending | Approved
      changes approvedBy
  }
}
```

`requiredApprovals` may be an `Int` or, as here, a domain primitive over `Int` or `Decimal`: a domain primitive
compares with the numbers `count(…)` and `length(…)` compute.

**2. The current policy decides only whether a command runs**: pass the policy as a parameter of the command and
state the condition with `requires`. Existing aggregates stay valid whatever the policy becomes.

```dt
// purchasing/supplier.dt
context Purchasing {
  id SupplierId: UUID
  id PersonId: UUID
  value ApproverList {
    approvers: PersonId[1..*]
  }

  aggregate Supplier "取引先" {
    id: SupplierId
    state Candidate
    state Listed

    command list(person: PersonId, current: ApproverList)
      Candidate -> Listed
      requires authorized { contains(current.approvers, person) } else NotApprover
  }

  error NotApprover
}
```

**3. The policy picks a kind of rule**: an enum (or a union, when the kinds carry data) in the aggregate, and one
invariant or requirement per kind with `implies`.

```dt
// purchasing/contract.dt
context Purchasing {
  id ContractId: UUID
  enum SignOff { Single Dual }

  aggregate Contract "契約" {
    id: ContractId
    signOff: SignOff
    signedBy: PersonId[0..*]
    invariant dualSignOff { signOff == SignOff.Dual implies count(signedBy) >= 2 }
  }
}
```

**4. The policy is code** (scores, rule engines, pluggable strategies): declare the invariant or requirement without
an expression, with a label or `///` description. Your code passes its check to the generated `…With(checks)`
(`dt guide checks`), which can apply the policy.

```dt
// purchasing/credit-line.dt
context Purchasing {
  id CreditLineId: UUID

  aggregate CreditLine "与信枠" {
    id: CreditLineId
    state Open

    command extend(amount: Decimal)
      Open -> Open
      requires creditworthy "与信スコアが基準以上" else NotCreditworthy // scored by your code
  }

  error NotCreditworthy
}
```

- Not supported: arithmetic in expressions (`limit * 2`, sums over a collection). Use (4) when a rule needs it.
- Other aggregates cannot be read from an expression: the policy is a value passed in or kept, never looked up.
- **A rule across aggregates** is written as one of: the values it needs passed as parameters and checked with
  `requires` (2); the evidence of a check made outside the aggregate, a verified type (`dt guide verified`); a reaction
  to another aggregate's events, a policy (`dt guide reactions`); or a boundary drawn so that the data is in one
  aggregate.

<!-- topic: changes -->
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

<!-- topic: events -->
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

**Naming payload fields.** Name the fields of events (and errors) after their source, so that the implementation does
not have to guess where a value comes from: a parameter (`step` above), a field of a parameter (`sku` from
`item: OrderItem`), or a field of the aggregate after the command (`completedAt` of `Completed`). A value computed in
the implementation (a total, the days overdue) needs no source. A field that has no source of the same name and type,
while some source has its type, is a warning (M022): `progress(step: StepId, at: Timestamp)` emitting
`StepRecorded { recordedAt: Timestamp }` would be one — name the parameter `recordedAt`. Exempt are fields of the
aggregate's ID type (M017) and of type Int, Decimal or Bool (counts, sums and flags are mostly computed). Types match
by base type, optionality aside; a collection only a collection of the same element type. An error's sources are the
parameters and the aggregate **before** the command (its source states; none for a `create command`). A declarative
mapping (`emits X { a = b }`) is deferred (see ADR 0021).

<!-- topic: pure -->
### Pure commands

A command is a **pure function** of the aggregate and its parameters: no I/O, no clock, no randomness, no generated
IDs. Whatever the decision needs comes in as a parameter — the new aggregate's ID (`open(id: WorkId)`), the time
(`at: Timestamp`), data of other aggregates. Loading, saving, publishing and calling other services happen around the
command, in your application code. This makes every command reproducible: the same inputs give the same aggregate
and events, so commands are tested without mocks.

A `create command` without a parameter of the aggregate's ID type is a warning (M020): it would have to make the ID
itself.

A check that needs more than the aggregate and the parameters — no other customer uses the email address — is made
before the command, and the command takes its evidence as a parameter: a verified type (see
[Verified types](#verified-types)).

<!-- topic: verified -->
### Verified types

Commands are pure, so they cannot check what lies outside their aggregate: an email address no other customer uses, an
address an outside service confirmed, a budget approved, stock reserved. A verified type is the **evidence that such a
check was made**: a value of a base type that only its factory makes. A command that takes it as a parameter cannot be
called without the check; skipping it is a compile error.

```dt
// purchasing/purchase-order.dt
context Purchasing {
  id PurchaseOrderId: UUID
  id BudgetId: UUID
  value Spend {
    budget: BudgetId
    amount: Money
  }
  /// 予算の残高で賄えると、発注のときに確かめた支出。
  verified CoveredSpend "予算内の支出" of Spend errors OverBudget
  /// 予算内と確かめたうえで、承認者の決裁上限以内と確かめた支出（両方の確認を持つ）。
  verified ApprovedSpend "承認済みの支出" of CoveredSpend for PersonId errors OverApprovalLimit, NotApprover

  aggregate PurchaseOrder "発注" {
    id: PurchaseOrderId
    spend: Spend // stored as the base type
    state Draft
    state Placed

    create command open(id: PurchaseOrderId, spend: Spend) -> Draft
    command place(spend: ApprovedSpend) // both checks were made
      Draft -> Placed
      changes spend
  }

  error OverBudget
  error OverApprovalLimit
}
```

- `verified Name "label" of Base for Context? errors E1, E2`. The base is a value type: a primitive type, a domain
  primitive, an ID, an enum, a value object, a union, or another verified type — then the value carries both checks.
  Not an entity or an aggregate (M024).
- `for` names what the check needs besides the value: the customer to leave out (`for CustomerId?`: absent when a
  customer registers), a tenant, the approver. `?` makes it optional. It is a value type, not a verified one (M024).
  Without `for`, the check needs the value only.
- `errors` are the errors of the factory, not of the commands that take the value: `changeEmail` above returns no
  `EmailTaken`; the factory did, before the command.
- A verified type types **command parameters** (and the base of another verified type) only. It is the evidence of a
  check at one moment, so a field of an aggregate, entity, value object, union, field set, event or error stores the
  base type instead (M024, with the hint `store the base type 'Spend'`). A command stores a verified parameter in a
  field of the base type as it is.
- In invariants and requirements a verified value is a value of its base type (`requires` can compare
  `spend.amount`), and an event or error field of the base type takes its value from a verified parameter of the same
  name (M022).
- **Use it only for facts that need the outside world**: other aggregates, outside services, the state of the world
  at that moment. A rule over the command's parameters and the aggregate is an invariant or a `requires` (see
  [Command requirements](#command-requirements)); a rule over a policy, see [Rules that depend on a
  policy](#rules-that-depend-on-a-policy).
- **Evidence of the moment, not a guarantee when the aggregate is saved.** Two customers registering the same address
  at once may both pass the check. Keep enforcing the rule where the data is stored (a unique index), and document it
  on the aggregate as an invariant without an expression (`uniqueEmail` above, in `dt guide aggregates`).
- `verified`, `of` and `for` are also usable as field and parameter names.

The generated code (`examples/shop`):

```ts
/**
 * 未使用のメールアドレス
 * 他の顧客に使われていないことを、登録・変更のときに確かめたメールアドレス。
 * A value of Common.EmailAddress for which MakeAvailableEmail made a check outside the aggregate. Evidence of a check made at that moment, not a guarantee when the aggregate is saved — keep enforcing it where it is stored (e.g. a unique index).
 * Make it with your `MakeAvailableEmail` factory; never `as AvailableEmail` outside it (see dt guide lint).
 * @see sales/customer.dt:5
 */
export type AvailableEmail = Common.EmailAddress & { readonly 'verified:Sales.AvailableEmail': true };

export type MakeAvailableEmail = (value: Common.EmailAddress, context: CustomerId | undefined) => Promise<Result<AvailableEmail, EmailTaken>>;
```

- The type is the base with a property of its own, one per verified type: a value of the base is not one
  (`Argument of type 'EmailAddress' is not assignable to parameter of type 'AvailableEmail'`), a value with another
  check is not one either, and a value with two checks has both properties. It is assignable to its base, so it is
  stored in a field of the base type without a conversion.
- The factory `Make<Name>` is async (the check reads repositories and services) and returns a `Result`: the value, or
  one of `errors` (`never` without `errors`, still a `Result`, so every factory is called the same way). Its second
  parameter is the context of `for`: required with `for X`, `X | undefined` with `for X?`, absent without `for`.
  With `for X?` the parameter is still required, and a call with no context passes `undefined` explicitly: were it
  optional, a call that forgot the context would compile, and the check would then not leave out the one it should —
  `changeEmail` would report a customer's own address as taken. The factory's JSDoc says so.
- **Two kinds of failure.** The errors of the `Result` are the domain's answers, those named in `errors`: the use case
  returns them, and its callers branch on them. A **rejected promise** means the check could not be made — the
  repository is down, the outside service timed out: not an answer of the domain, of open-ended kinds, and what to do
  with it (fail the request, retry) belongs to the application's edge, the HTTP handler or the job runner (below). Do
  not turn it into a domain error inside the factory or the use case. The same holds for policy handlers (see
  [Reactions to events](#reactions-to-events-policies)).
- **You write the factory**, with your repositories and services. It is the only code that may assert the type
  (`email as Sales.AvailableEmail`); a cast anywhere else defeats the purpose — the same weakness as the constructors
  of domain primitives.

```ts
// examples/shop/src/app/verifications.ts
export function verifications(customers: CustomerRepository): Verifications {
    return {
        // `customer` is the one whose email changes, so that keeping one's own address is not "taken"; none on register.
        async makeAvailableEmail(email, customer) {
            const holder = await customers.find((c) => c.email === email && c.id !== customer);
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory of the verified type: the check above is the evidence
            return holder ? err({ type: 'EmailTaken', email }) : ok(email as Sales.AvailableEmail);
        },
    };
}
```

A use case returns the domain's answers in its `Result` and lets a rejection pass; the edge that called it handles
the rejection:

```ts
// the edge of the application: an HTTP handler around the use case (a job runner would retry it instead)
async function postCustomer(request: Request): Promise<Response> {
    const { name, email } = await request.json();
    try {
        const r = await shop.app.registerCustomer(name, email); // shop = createShop(…), as in examples/shop
        // the domain's answers (InvalidEmailAddress, EmailTaken, …): the client can act on them
        if (!r.ok) return Response.json(r.error, { status: 422 });
        return Response.json(r.value, { status: 201 });
    } catch (e) {
        // the check could not be made (MakeAvailableEmail's repository failed): not an answer, so no domain error
        console.error(e);
        return new Response('temporarily unavailable', { status: 503, headers: { 'Retry-After': '5' } });
    }
}
```

The generated contract tests do not test the factories (see [Generated tests](#generated-tests)).

<!-- topic: reactions -->
### Reactions to events (policies)

A policy states a business rule of the form **"when event X happens, command Y is eventually run"** — Event
Storming's policy (the lilac sticky between an event and a command). It is declared in the context that reacts:

```dt
// billing/policies.dt
context Billing {
  /// 確定した注文は、その合計で請求する。
  policy BillConfirmedOrder "確定した注文に請求する" when Sales.OrderConfirmed -> Invoice.issue
}
```

- `policy Name "label" when Event -> Aggregate.command`. The aggregate is one of the policy's own context, named
  without its context; the event may be of any context (`Sales.OrderConfirmed`). A shared context has no policies.
- **Only the reaction.** How the command's arguments come from the event, conditions, compensation and ordering are not
  part of the DSL; your code computes the arguments (below).
- **"Eventually", by any mechanism.** The rule holds whether the command runs in the same use case, through an event
  bus, from a queue or by a nightly batch. Nothing in the generated code chooses or forces a mechanism.
- Declaring a reaction is optional. Declare the ones across contexts at least: they are the dependencies of the
  context map (a policy counts as an **event** dependency of the reacting context on the event's context), and
  `dt show`, the Live View and the language server show them on the command ("triggered by") and on the event.
- M023: the event exists, the aggregate is one of the policy's context (a policy naming an aggregate of another
  context is declared in the wrong context: the hint names the one), the command is one of the aggregate; two
  policies of a context that state the same reaction are a warning. Names are unique in the context (M002).
- `policy` is also usable as a field and parameter name.

For each policy, `dt generate ts` writes the type of its **handler**, from the event to what the application needs to
run the command, the command's **input**: its parameters by name, after the ID of the aggregate to run it on (named
like the aggregate) unless it is a `create command`. An input is written once per command, also when several policies
run it.

```ts
/**
 * What the application needs to run Invoice.issue (a factory): its parameters, by name.
 * Given by the handlers of the policies that run it.
 * @see billing/invoice.dt:14
 */
export interface IssueInvoiceInput {
    /** 請求書ID */
    readonly id: InvoiceId;
    /** 注文ID */
    readonly order: Sales.OrderId;
    /** 請求金額 */
    readonly billedAmount: Common.Money;
}

/**
 * Policy BillConfirmedOrder: when Sales.OrderConfirmed happens, Invoice.issue is run — eventually.
 * …
 */
export type BillConfirmedOrderPolicy = (event: Sales.OrderConfirmed) => Promise<IssueInvoiceInput>;
```

The handler computes the input: data from elsewhere (the order to bill) and new IDs come in through closures your code
builds, and a handler that cannot compute the input rejects. Your application then runs the command with it, by
whatever mechanism.

**Whether handlers are required** is a choice of the configuration (see [Configuration](#configuration)):
`generate.ts.policies`, overridden per context by `generate.ts.contexts.<Context>.policies`:

- `optional` (default): only the types above; nobody has to use them.
- `required`: also `<Context>PolicyHandlers`, one handler per policy of the context, and the generated contract tests
  of that context require them (`contract({ …, policies })`; a missing handler is a compile error). They feed each
  handler generated events and check that it resolves to an input the command accepts (see
  [Generated tests](#generated-tests)).

```ts
// examples/shop/src/app/policies.ts
export function billingPolicies({ loadOrder, newInvoiceId }: PolicyDeps): Billing.BillingPolicyHandlers {
    return {
        // a confirmed order is billed for its total
        BillConfirmedOrder: async (event) => {
            const order = await loadOrder(event.orderId);
            if (order?.state !== 'Confirmed') throw new Error(`order ${event.orderId} is ${order ? order.state : 'not found'}, not Confirmed`);
            return { id: newInvoiceId(), order: order.id, billedAmount: orderTotal(order) };
        },
    };
}
```

<!-- topic: modeling-practice -->
### Modeling with DomainTrail

How to grow the `.dt` model, for people and AI agents. The rules of the language are in [DSL](#dsl); this is the way
of working.

**Start from the brief.** The `///` description above a `context` says its purpose, scope, what the generated code is
for and how far to go (`/model:start` in the chat writes it). Keep to that context; ask before changing another one.

**`///` says what the element is, once.** A description is short: what the element is, not its history or a to-do.
Write it once: a context split across files has its `///` in one file only (M025). Keep a split context's
description, `terms` and context-wide types (those used by several aggregates or by none) in `<context>/context.dt`,
and open the context without a `///` in the other files. This is advice, not a rule: `check` reports only a second
description.

**One context at a time, terms first.**
- Agree on the words before the structure: the context's `terms` with their labels, and a `///` for any term people
  could read two ways.
- Name things in the business's words. A label is what people say; the ID is its stable English name.

**Aggregates by their invariants.**
- An aggregate is what must stay consistent in one decision. Draw its boundary around an invariant you can state,
  not around a screen, a table or a noun.
- Write the invariants as expressions where the DSL can (see [Invariant expressions](#invariant-expressions)), and as
  a label or `///` where it cannot. Keep aggregates small; refer to another aggregate by its ID.
- States (a union of states) when the allowed commands depend on where the thing is in its life.

**The DSL's types, not strings.** `dt check` warns about the first two (M026, M027).
- A closed set of values is an `enum` (`enum Plan { Basic Premium }`): not a `union` whose variants have no fields,
  and not a `String` with the values in a comment. A `union` is for variants that carry different fields.
- Refer to another aggregate by its ID type: `references member: MemberId -> Member`. Never copy its fields, and never
  keep its ID as a `String` or `UUID` (`memberId: String`).
- Each aggregate and entity has an ID type of its own (`id LeaseId: UUID`, and `id: LeaseId` in it).

**Commands as contracts.**
- A command says what it needs (`requires`), what it changes, and exactly which events it emits (`emits` is exhaustive:
  see [Command events](#command-events)). A failure is a named error, and it emits nothing.
- Reactions between aggregates or contexts are `policy`s on events, not commands calling commands.
- The DSL holds structure and contracts only. Business logic is written by hand in `decide` against the generated
  types; do not try to encode it in the model.

**From a storming.** When a storming feeds the context (its brief says so), take the Design Level's commands,
aggregates and events as the starting point, not as the answer: the model has to state invariants the storming did
not. Then add `ref`s in the `.dtes` to the new `.dt` symbols that resolve. Open hotspots are questions to ask, not
gaps to fill by guessing.

**Small steps.** Change a little, run `dt fmt` and `dt check` until it exits 0, and keep the model valid between
steps. Do not rename or remove what the people did not ask to change: other files, generated code, the chat and the
[journey file](#the-journey-file) refer to the IDs (a rename asked for: update the journey's keys too). The journey the
session works on says why and how far: keep to it. Unsure what to do next? `/guide` (the composer's ガイド button) shows where you are on the way to your goal and
what the files show at once, then has the AI coach you, in the modeling as in the storming.

<!-- topic: generated -->
## Generated TypeScript

Per context a module (`Sales.ts`, …) with ID brands, enums, value objects, entities, unions, a discriminated union per
stateful aggregate (`DraftOrder | ConfirmedOrder | …`), event / error types with a `type` tag, a function type per
command and an `<Aggregate>Commands` interface to implement, a decision type per command and a shape constant per
aggregate for `decide` (see [Decisions and `decide`](#decisions-and-decide)), plus `index.ts` and `_runtime.ts`. A
domain primitive gets a branded type, a constructor contract `Make<Name>` and a generated constructor `make<Name>`;
a verified type its base with a property of its own and the contract of its factory `Make<Name>`, which you write (see
[Verified types](#verified-types)); invariants and requirements get check functions (see
[Generated checks](#generated-checks)); a policy the type of its handler and the input of its command (see
[Reactions to events](#reactions-to-events-policies)). A field set is an interface that the elements using it extend (`interface Expense extends Common.Tenanted`; for a stateful aggregate, its
`…Common`). The JSDoc of every declaration that comes from the DSL ends with `@see <file>:<line>`, the declaration's
place as `dt check` prints it (relative to the config root, e.g. `@see sales/order.dt:51`); editing the `.dt` sources
moves these lines, and generating again rewrites them. The JSDoc of a `references` field links its target by the name
the module uses for it (`@see {@link Customer}`, `@see {@link Sales.Order}` from another context), so that hover and
go-to-definition reach the aggregate; a context named only by such a link is imported for its types
(`import type * as Sales from './Sales.js'`, with a comment that tells linters the import is used).

The examples in this section are generated from `examples/shop` in the repository, a fuller version of the Sales
context of the DSL examples (with labels, and `emits NoteChanged?` on `changeNote`).

Unions to name groups of them, each generated only when it has a member:

| Type | Members |
|---|---|
| `DomainEvent` | every event of the context |
| `PersistentEvent` | the events declared `persistent` |
| `Aggregate` | every aggregate of the context |
| `<Aggregate>Event` (`OrderEvent`) | the events the aggregate's commands may emit (also of other contexts) |

A command takes its parameters as **one object** after the aggregate, typed `<Command><Aggregate>Params`
(`ConfirmOrderParams`): a call names each parameter (`commands.confirm(order, { at })`), so two parameters of one type
cannot be swapped unnoticed, and reordering them in `.dt` breaks no caller. An optional parameter is an optional
property (`note?: string`), left out when not given; a misspelt name is an excess property, a compile error. A command
without parameters takes none (`commands.start(work)`); a factory takes only the object
(`commands.place({ id, customer })`). The labels of the parameters are on the properties:

```ts
/**
 * The parameters of Order.confirm, by name.
 * @see sales/order.dt:51
 */
export interface ConfirmOrderParams {
    /** 日時 */
    readonly at: Timestamp;
}

/**
 * Order.confirm (Draft -> Confirmed)
 * 注文を確定する
 * @requires hasItems (明細が1件以上) else EmptyOrder: count(items) > 0
 * @changes none — the command changes no common field
 * @emits OrderConfirmed — exactly once when the command succeeds
 * @see sales/order.dt:51
 */
export type ConfirmOrder = (
    order: DraftOrder,
    params: ConfirmOrderParams,
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
    params: ProgressWorkParams,
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
    params: ChangeNoteOrderParams,
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

<!-- topic: decide -->
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
 * @see sales/order.dt:51
 */
export type ConfirmOrderDecision = {
    /** @emits OrderConfirmed — exactly once when the command succeeds */
    readonly Draft: (order: DraftOrder, params: ConfirmOrderParams) => Result<{
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

`decide(shape, decision)` calls the handler of the aggregate's `state` with the command's arguments (the aggregate and
the parameters object; destructure it where that reads better, `(order, { at }) => …`). For the outcome
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
    Draft: (order, { note }) => ok({ Draft: { set: { note }, events: noteChanged(order, note) } }),
    Confirmed: (order, { note }) => ok({ Confirmed: { set: { note }, events: noteChanged(order, note) } }),
});

export const confirm: Sales.OrderCommands['confirm'] = decide<Sales.ConfirmOrderDecision>(Sales.OrderShape, {
    Draft: (order, { at }) => {
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
    const r = commands.confirm(order, { at }); // the time is a parameter: the command is pure
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
 * @see review/review.dt:24
 */
export type AcceptReview = (
    review: ReviewingReview | EscalatedReview,
    params: AcceptReviewParams,
) => Result<{
    readonly Accepted: {
        readonly aggregate: AcceptedReview;
        readonly events: NoEvents;
    };
}, Conflict | NotApprover | Blocked | NotSignedOff>;
```

<!-- topic: your-code -->
### Generated code and your code

The generated files are the **contract**, your code is the **implementation**:

- Generated: types — the shapes of the model, the command signatures (`ConfirmOrder`, `OrderCommands`) and their
  decisions (`ConfirmOrderDecision`), and the constructor signatures of domain primitives (`MakeQuantity`) — plus
  data without logic: one shape constant per aggregate (`OrderShape`), the field names `decide` needs — plus logic
  derived 1:1 from DSL expressions: the checks of invariants and requirements, the equality of value types and the
  constructors of domain primitives (see [Generated checks](#generated-checks)). Invariants and requirements also
  appear as JSDoc (`@invariant`, `@requires`). `_runtime.ts` holds a few helpers (`ok`, `err`, `decide`, `outcome`,
  `eventList`, `parseDecimal`, and those of the checks) that are the same for every model.
- Yours: the behaviour — command implementations (returning the error of the first requirement that does not hold;
  pure functions, see [Pure commands](#pure-commands)), the factories of verified types (the checks outside the
  aggregate, see [Verified types](#verified-types)) and the constraints the DSL does not express, which you pass to
  the generated checks — in your own files, which import the generated modules (never the other way round) and are
  type-checked against them. Your code may call the generated checks, or implement its own (a hand-written
  `Make<Name>` like the one below); the generated tests use the generated checks as the oracle either way.

```ts
// src/primitives.ts — your code
import { err, ok, type Sales } from '../generated/domain/index.js';

export const makeQuantity: Sales.MakeQuantity = (value) =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory: the check is on this line
    Number.isInteger(value) && value >= 1 && value <= 999 ? ok(value as Sales.Quantity) : err({ type: 'InvalidQuantity', value, invariant: 'valid' });
```

Do not edit generated files: change the `.dt` sources and generate again. Adding properties or methods to generated
types (declaration merging, editing the output) is not supported; write functions that take the generated types.

A complete example is [`examples/shop`](https://github.com/hisamekms/domaintrail/tree/main/examples/shop) in the
repository: the model, what `dt generate ts` writes from it, and the code written against it — the command
implementations and a small application layer around them (repositories, an event store, policies across contexts),
with the contract tests and a demo.

<!-- topic: lint -->
### Linting your code

A domain type is a brand: `Sales.OrderId` is a `string` the compiler tells apart, `Common.Amount` a `Decimal` that holds
its invariants, `Sales.AvailableEmail` the evidence of a check. A cast (`'x' as Sales.OrderId`, `amount as
Common.Amount`) makes one without its constructor, so nothing checks the invariants or makes the check: never cast to
a domain type, a verified type or `Decimal`. Make them instead:

| Type | Make it with |
|---|---|
| ID, domain primitive | `make<Name>` (generated; or your own `Make<Name>`), e.g. `Sales.makeOrderId(crypto.randomUUID())` |
| verified type | its factory `Make<Name>`, which you write (see [Verified types](#verified-types)) |
| `Decimal` | `parseDecimal(text)` from the runtime: digits with an optional `-` and fraction, else `undefined` |

A value that cannot fail to be valid (a sum of non-negative amounts is an `Amount`) still goes through its constructor;
a failure there is a bug, so throw. In tests, make the values the same way and assert the result rather than cast a
fallback. The generated JSDoc of every branded type says how to make it (`Make it with makeAmount; never as Amount`).

Let the linter enforce it with the type-aware rule that reports narrowing casts (it allows `as const` and widening):
oxlint's `typescript/no-unsafe-type-assertion` (with `--type-aware`, which needs `oxlint-tsgolint`) or typescript-eslint's
`@typescript-eslint/no-unsafe-type-assertion`. Leave the generated directories out: they make the domain types, so they
cast.

```jsonc
// .oxlintrc.json — run `oxlint --type-aware`
{
  "plugins": ["typescript"],
  "rules": { "typescript/no-unsafe-type-assertion": "error" },
  "ignorePatterns": ["generated/**"]
}
```

```js
// eslint.config.js — typescript-eslint with type information
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['generated/**'] },
    {
        files: ['**/*.ts'],
        extends: [tseslint.configs.base],
        languageOptions: { parserOptions: { projectService: true } },
        rules: { '@typescript-eslint/no-unsafe-type-assertion': 'error' },
    },
);
```

The legitimate casts are in factories only — your `Make<Name>`, a verified type's factory — each with a disable
comment that says why: `// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory: …` (ESLint:
`// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- …`).

`dt generate ts` prints `hint: no lint rule against casts to domain types found (no-unsafe-type-assertion); see dt guide
lint` (in `--format json`, in `hints`) when no lint config mentions the rule: it looks for `.oxlintrc.json`,
`.oxlintrc.jsonc`, `oxlint.config.*` and `eslint.config.*` in the config's directory and the directories above it up to
the top of the git repository (only the config's directory without one). It is a heuristic — the files are searched as
text for `no-unsafe-type-assertion`, not evaluated — so a rule shared from a package is not found: set
`"lintHint": false` in `domaintrail.jsonc` then.

<!-- topic: checks -->
### Generated checks

Every invariant and requirement with an expression becomes a pure function in the context's module, translated 1:1
with the semantics of [Invariant expressions](#invariant-expressions): equality by value / all fields / `id` / tag and
fields, `exists` and `implies` as written, regular expressions as JavaScript (`matches` is `RegExp.test`), `length` as
the string's `length`, Decimals (carried as strings) and Ints compared as numbers, Timestamps by time.

| Generated | For | Returns |
|---|---|---|
| `check<Name>(value)` | a domain primitive with invariants or on `UUID` | the violated invariants, in declaration order after `uuid` (empty: valid) |
| `make<Name>` | every domain primitive and ID | implements `Make<Name>`: `Invalid<Name>` with the **first** violated invariant (on `UUID`, `uuid` when the value is not a UUID) |
| `check<Name>(x)` | a value object, entity or union with invariants (a union: those of its variant) | the violated invariants |
| `check<State><Aggregate>(x)`, `check<Aggregate>(x)` | an aggregate with invariants | per state, the aggregate's and the state's violated invariants; `check<Aggregate>` for any state |
| `check<Aggregate>Common(x)` | every aggregate with states, also without invariants | the aggregate's own violated invariants, once (the check of each state reports them first) |
| `check<Command>Requires(aggregate, params)` | a command with requirements (a factory: `(params)`) | the name of the first requirement that does not hold, or `undefined`; it takes the command's parameters object as it is |
| `equal<Name>(a, b)` | every value object, entity and union | the equality of `==`, `unique` and `contains` |

```ts
/** The first requirement of Order.confirm that does not hold, in declaration order; `undefined` when all hold. */
export function checkConfirmOrderRequires(order: DraftOrder, _params: ConfirmOrderParams): 'hasItems' | undefined {
    if (!(order.items.length > 0)) return 'hasItems';
    return undefined;
}
```

The translation reads like the `.dt` it comes from: a violated `A implies B` is tested as `A && !B`
(`if (order.reason === 'Other' && !(order.note !== undefined))`), lambda variables keep their names
(`(item) => item.quantity > 0`; the second element of `unique(items, item => item.sku)` is `item2`), and strings are in
single quotes. A parameter of the command is read from the parameters object (`params.reason`). A lambda variable gets
a number (`item2`) only when its name would clash with another variable in scope, the check's parameters, a reserved word of TypeScript or a name the module imports; the generator's own temporaries
start with `$` (`$0`), which a `.dt` name cannot.

A constraint without an expression cannot be generated. Instead the check gets a **slot**: a type naming the
function your code provides, and a `…With` variant that takes it and combines it with the generated parts, in
declaration order. Generated code never imports your code; you pass the function in:

```ts
// generated (Sales.ts), for `invariant reserved "予約語でない"` in `primitive Sku`
export type SkuDeclaredChecks = { readonly reserved: (value: string) => boolean };
export function checkSkuWith(checks: SkuDeclaredChecks): (value: string) => readonly InvalidSku['invariant'][];
export const makeSkuWith: (checks: SkuDeclaredChecks) => MakeSku;

// your code
export const makeSku = Sales.makeSkuWith({ reserved: (value) => !RESERVED.has(value) });
```

The same holds for the other checks: `<Type>DeclaredChecks` and `check<Type>With(checks)` for value types and
aggregates (one object per aggregate, keyed by invariant name, for all its states), and
`<Command>DeclaredRequires` and `check<Command>RequiresWith(checks)` for requirements (a requirement's slot takes the
aggregate and the parameters object, as the check). A type without such a
constraint has only the plain function. The slot of an aggregate's own invariant takes `<Aggregate>Common` (an
invariant of the aggregate holds in every state, so it reads only the common fields), the slot of a state's invariant
that state's type; `check<Aggregate>CommonWith` exists when the aggregate's own invariants have a slot.

<!-- topic: tests -->
### Generated tests

With `generate.ts.tests` in the config, `dt generate ts` also writes **contract tests** into `<out>/tests` (or
`generate.ts.tests.out`). They check what the types cannot — the values — and use the generated checks as the oracle:

| | Checks |
|---|---|
| T1 | `make<Name>` accepts exactly the values that hold the invariants, with values at and next to each bound of ranges and lengths, strings for regular expressions, and on `UUID` UUIDs and strings next to one, and reports the first one violated |
| T2 | when a requirement does not hold, the command returns the `else` error of the first such requirement; when all hold, none of the `else` errors |
| T3 | after a successful command, the aggregate holds the invariants of its state (the aggregate's and the state's) |
| T4 | events whose bounds the types do not express (`X[2..5]`) are emitted that many times |
| T5 | purity: the same input twice gives deep-equal results, and the input is not changed |
| T6 | with `required` policies: for every event, the handler of a policy resolves to an input the command accepts — every argument present unless optional, of its type (the fields of value objects and entities in turn), holding the invariants of its type, a list within its multiplicity |

Inputs are generated with [fast-check](https://fast-check.dev) from the types: IDs, ranges, lengths and regular
expressions of domain primitives, enums, value objects, entities, unions, collections with their multiplicities, and
aggregates per state. A parameter of a verified type gets values of its base type, taken as verified (the check
passed); `arbitraries` overrides it like any other type (`{ Sales: { AvailableEmail: … } }`). **Inputs are always valid**: only values that hold their invariants are used, and parameters
are values of their types; what a command does with invalid input is outside its contract. Values of one type are
drawn often from a small pool, so that duplicates, `contains` and `!=` are decided both ways. Runs are deterministic
(fixed seed, configurable), and a failure shows the shrunk counterexample and the seed.

The generic helpers of the tests are **`domaintrail/testing`**, a subpath of the domaintrail package, which your
project already has as a dev dependency to run `dt`. Install fast-check as a dev dependency too (an optional peer
dependency of domaintrail); generated product code uses neither. Each test module states the version of domaintrail
that generated it and, when it is loaded, fails unless `domaintrail/testing` is compatible with it (as with
`^<version>`: at least as new, of the same minor version while the major is 0): after upgrading domaintrail, run
`dt generate ts` again. `tests/index.ts` exports the suites of the contexts and `register`; the helpers themselves
(`cases`, `suite`, the types `Suite` and `TestCase`) are imported from `domaintrail/testing`.

Per context, `tests/<Context>.ts` exports `contract(impl, options?)`, returning a suite of named test cases
(`{ name, children }` of `{ name, run, todo? }`) for any runner, and `arbitraries(options?)`. `impl` lists what to
test, each optional: the constructors (`make: { Quantity: makeQuantity }`) and the commands per aggregate
(`Order: orderCommands`); for a context whose policies are `required`, also `policies` (its `<Context>PolicyHandlers`),
which is not optional. The handlers run as your code wires them, with whatever data they read: give them what the
generated events need (below, a confirmed order for any ID). With `generate.ts.tests.runner` (`bun`, `vitest`, `jest`, `node`), `tests/_register.ts`
registers a suite with that runner, and the test file is a few lines:

```ts
// examples/shop/src/contract.test.ts
import { parseDecimal, type Sales as SalesTypes } from '../generated/domain/index.js';
import { Billing, Common, Sales, register } from '../generated/domain/tests/index.js';
import { billingPolicies } from './app/policies.js';
import { customerCommands } from './domain/customer-commands.js';
import { invoiceCommands } from './domain/invoice-commands.js';
import { orderCommands } from './domain/order-commands.js';
import { makeAmount, makeCustomerId, makeEmailAddress, makeInvoiceId, makeOrderId, makeOrderItemId, makeQuantity, makeSku } from './domain/primitives.js';

register(
    Sales.contract({
        make: { Quantity: makeQuantity, Sku: makeSku, CustomerId: makeCustomerId, OrderId: makeOrderId, OrderItemId: makeOrderItemId },
        Order: orderCommands,
        Customer: customerCommands,
    }),
);
const ok = <T>(r: { ok: true; value: T } | { ok: false }): T => {
    if (!r.ok) throw new Error('invalid example');
    return r.value;
};

// The policy cases feed Billing's handlers generated `OrderConfirmed` events, so the order a handler reads comes from
// here: a confirmed order with that ID. The tests run the handlers with whatever they are wired to.
const confirmed = (id: SalesTypes.OrderId): SalesTypes.ConfirmedOrder => ({
    state: 'Confirmed',
    id,
    customer: ok(makeCustomerId('5f0c3a2e-8d41-4b7a-9e6f-1c2d3e4f5a6b')),
    items: [
        {
            id: ok(makeOrderItemId('0b9d7c6e-2f13-4a85-b1c4-7e8f9a0b1c2d')),
            sku: ok(makeSku('ABC-0001')),
            quantity: ok(makeQuantity(3)),
            unitPrice: { amount: ok(makeAmount(parseDecimal('12.50')!)), currency: 'USD' },
        },
    ],
    confirmedAt: new Date('2026-10-24T09:00:00Z'),
});
let invoices = 0;
const invoiceId = (): string => `00000000-0000-4000-8000-${String(++invoices).padStart(12, '0')}`;
const policies = billingPolicies({ loadOrder: async (id) => confirmed(id), newInvoiceId: () => ok(makeInvoiceId(invoiceId())) });

register(Billing.contract({ make: { InvoiceId: makeInvoiceId }, Invoice: invoiceCommands, policies }));
register(Common.contract({ make: { EmailAddress: makeEmailAddress, Amount: makeAmount } }));
```

Options, all optional:

- `seed`, `runs`: fast-check's seed (default 42) and the number of generated inputs per case (default 100).
- `arbitraries: { Sales: { Sku: fc.stringMatching(/^ABC-\d{4}$/) } }`: replaces the arbitrary of a type, by context
  and type name (aggregates per state, e.g. `DraftOrder`). Its values are still filtered by the invariants. When
  filtering rejects 1000 values in a row, the case fails with a message naming the type to override.
- `declared: { Sales: { Sku: { reserved: … }, Order: { … }, AcceptReview: { signedOff: … } } }`: the checks of the
  constraints without an expression, by context and type or command type; the same functions your code passes to the
  `…With` checks. A constraint whose check is not passed is listed as a **todo** case ("not expressed in the DSL and
  not checked"), and the tests accept either outcome where it would decide.
- `examples: { Order: { states: { Draft: [order] }, commands: { confirm: [[order, { at }]] } } }`: valid aggregates per
  state (mixed into the generated ones) and arguments per command, as the command takes them: the aggregate and the
  parameters object (run first, before the generated ones). Examples must hold their invariants; one that does not
  fails the case.

A failing case says what was expected, e.g. `Order.cancel(…) made an aggregate that violates 'otherNeedsNote'`. Change
the implementation — or, if the implementation is right, the DSL (here a missing `requires` on `cancel`).

**Recursive value types** (a tree, an expression) are drawn like the others, built with `fc.letrec`: the types on one
cycle (`Expr` and `Call`, each holding the other, even in different contexts) are defined together. Values are biased
towards shallow ones, which keeps runs fast and counterexamples small, and go at most `maxRecursionDepth` deep: how
many times a value nests through its cycle, counted where the cycle could end — a union's variant (a variant out of the
cycle, such as `lit`, is the only one drawn once the depth is reached), an optional field (then absent), a list that may
be empty (then empty). A value of depth 1 holds no other; a binary tree of depth 4 has at most 15 nodes. The depth is
set in the config, overall and per type by qualified name; the types of one cycle use the greatest depth among them:

```jsonc
"tests": {
  "maxRecursionDepth": 4, // the default
  "types": { "Modeling.Expr": { "maxRecursionDepth": 3 } }
}
```

Raise the depth when the rules only show in deeper values; lower it when runs are slow. A recursive type whose
invariants reject most drawn values (a tree that must be balanced, an expression that must type-check) stops with the
message naming the type, as any other: pass its arbitrary in `arbitraries`. Inside a cycle, the arbitrary passed is used
for the nested values too, so it may build its values itself, with `fc.letrec` or from smaller valid ones:

```ts
// balanced trees: built by height, so every value holds the invariant
const tree = fc.letrec<{ t: Tree }>((tie) => ({ t: fc.oneof({ depthSize: 'small', maxDepth: 3 }, fc.constant({ children: [] }), tie('t').map((c) => ({ children: [c, c] }))) })).t;
register(M.contract(impl, { arbitraries: { M: { Tree: tree } } }));
```

**Outside the generated tests** is what happens around the commands, which your own tests cover (as
`examples/shop/src/app.test.ts` does): the factories of verified types (`MakeAvailableEmail`, with your repositories and
services), the constraints without an expression where you pass no check, and the application — loading, saving,
publishing events.

<!-- topic: metadata -->
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

<!-- topic: output-dirs -->
### Output directories

By default every context goes to `generate.ts.out`. Contexts listed in `generate.ts.contexts` go to their own
directory instead, e.g. a shared context into a package used by several applications. Each directory written to gets
its own `_runtime.ts` and an `index.ts` re-exporting only the contexts in it; a module imports other contexts by
relative path (`import type * as Common from '../../packages/shared/src/generated/Common.js'`). The runtimes are
identical, so values typed with one are accepted where the other is expected.

When those directories are packages of a monorepo, a relative path crosses from one package into another. Give the
context the module through which its package exports its generated code, next to its `out`:

```jsonc
{
  "generate": {
    "ts": {
      "contexts": { "Common": { "out": "packages/shared/src/generated", "module": "@acme/shared" } },
      "tests": {},
    },
  },
}
```

- Generated code in another output directory imports the context from the module (`import type * as Common from
  '@acme/shared'`; a value import when a generated check calls one of its functions); code in the same directory keeps
  the relative path. The package exports the context's generated module under that name (an entry pointing at
  `Common.ts`, or an index that exports all of it).
- With contract tests, the context's tests are written into its package, `<out>/tests` (with their own `index.ts`,
  and `_register.ts` with a runner; the package needs domaintrail and fast-check as dev dependencies), and the tests of other directories take its arbitraries from `<module>/tests`: the
  package exports its `tests/Common.ts` under that name. The options of a context's tests name the contexts whose tests
  are next to them and those of other packages they draw values from, so a package's tests import only the packages
  it depends on.
- `module` needs `out`. Keep one configuration for the whole repository: every context is still read, checked and
  generated together, and the Live View shows them all.

Each run replaces the files generated before (recognized by their header). The files written are recorded in
`generated.json` in the workspace's state directory, outside the workspace (see `dt guide config`, Where dt keeps its
files), and generated files of earlier runs that are no longer written (an output directory moved, a context removed)
are deleted, along with a directory left empty. Only recorded paths inside the root
and not reached through a symlink are deleted; other entries in that file are ignored. Other files are never deleted —
neither hand-written files nor generated files you edited — and generation stops instead of overwriting one.
<!-- topic: storming -->
## Event Storming (`.dtes`)

`.dtes` files hold **stormings**: Event Storming as text, next to the `.dt` files of the same workspace. A storming is
exploration, not a contract: which events happen and in which partial orders, then — at Design Level — who issues which
command, looking at which information, which aggregate or external system handles it and emits its events, and which
policy reacts to which event. The relations are Event Storming's grammar itself (ADR 0032): a command's body is its whole
row, read model → issuer → command → handler → events. Nothing is generated from
it, and no tool changes a `.dt` file because of it, or a `.dtes` file because of the model.

- **From a storming to a model (UC1).** Write events, timelines and hotspots only (Big Picture), and ask about what is
  unclear. Add actors, external systems, read models, commands, policies and aggregates as they are agreed (Design
  Level). Then propose the `.dt` model ([From a storming to `.dt`](#references-to-the-model-ref)), and add to the
  storming only the `ref`s that resolve. Never change existing `.dt` files without confirmation.
- **From a model to a storming (UC2).** Write a storming of the existing model, with `ref`s to its events, aggregates
  and commands, and walk concrete scenarios as timelines: the normal one, exceptions, retries, other contexts. Record
  what is unclear as hotspots. Report the diagnostics (mechanical inconsistencies between the two files) apart from the
  business findings (improvements of the model, made only when people decide them).

`dt check`, `dt fmt`, `dt open`, `dt collab` and `dt lsp` take the `.dtes` files with the `.dt` files: the default `sources` find
both, and a config that sets `sources` lists a `.dtes` glob itself (see [Configuration](#configuration)). `dt check`
fails on a `.dtes` error as on a `.dt` one. `dt generate ts` reads the `.dt` files only, and `.dtes` errors do not block
it. `dt show` shows the `.dt` model only. Keep the stormings in a directory of their own, `stormings/<name>.dtes`.

```dtes
// stormings/order-to-cash.dtes
/// From an order to its payment, across Sales and Billing.
storming OrderToCash "注文から入金まで" { // an ID, unique in the workspace, and an optional label
  event OrderPlaced "注文を受け付けた" {
    ref Sales.OrderPlaced // the .dt event it is (optional, fully qualified)
  }
  event OrderConfirmed "注文が確定した" {
    ref Sales.OrderConfirmed
  }
  event OrderCancelled "注文が取り消された" {
    ref Sales.OrderCancelled
  }
  event RefundRequested "返金が依頼された" {
    ref Sales.RefundRequested
  }
  event InvoiceIssued "請求書が発行された" // no counterpart in the model: no ref
  event InvoicePaid "請求書が支払われた" {
    ref Billing.InvoicePaid
  }
  event PaymentFailed "支払に失敗した"
  event PaymentAuthorized "与信が通った" {
    from PaymentService // a fact the payment service decided: we only record it
    level design // a detail of the mechanism: shown at Design Level only
  }

  actor Customer "顧客"
  external PaymentService "決済サービス" // issues a command (by), handles one (handledBy) or sends an event (from)
  readmodel OrderTotal "注文金額" {
    from OrderConfirmed // the events it is fed from
  }

  aggregate Order "注文" {
    ref Sales.Order
  }
  aggregate Invoice "請求書" {
    ref Billing.Invoice
  }

  command PlaceOrder "注文する" {
    by Customer
    handledBy Order
    emits OrderPlaced
  }
  command CancelOrder "注文を取り消す" {
    by Customer
    handledBy Order
    emits OrderCancelled
  }
  command ConfirmOrder "注文を確定する" {
    ref Sales.Order.confirm // Context.Aggregate.command
    by Customer // who issues it: an actor or an external system
    handledBy Order // who handles it: exactly one aggregate or external system (or an open hotspot asking)
    emits OrderConfirmed // what comes of it, produced by its handler
  }
  command IssueInvoice "請求書を発行する" { // issued by the policy below: no `by`, no `reads`
    ref Billing.Invoice.issue
    handledBy Invoice
    emits InvoiceIssued
  }
  command RecordPayment "入金を記録する" { // on what the payment service sends, our invoice decides
    ref Billing.Invoice.pay
    by PaymentService
    handledBy Invoice
    emits InvoicePaid, PaymentFailed // possible outcomes: neither all of them nor exclusive
  }
  command RefundOrder "返金する" {
    by Customer
    emits RefundRequested
  }

  policy BillConfirmedOrder "確定した注文に請求する" { // from Sales to Billing: a policy may cross contexts
    on OrderConfirmed // when this happens,
    reads OrderTotal // looking at this (the policy decides),
    issues IssueInvoice // it issues this one command
  }

  timeline Normal "通常の注文" {
    OrderPlaced
    OrderConfirmed
    InvoiceIssued
    PaymentAuthorized // hidden at Big Picture: InvoiceIssued is then followed by InvoicePaid
    InvoicePaid
  }
  timeline PaymentRetry "支払の再試行" {
    OrderPlaced
    OrderConfirmed
    InvoiceIssued
    PaymentFailed
    PaymentFailed // again: another occurrence
    InvoicePaid
  }
  timeline CancelAfterConfirm "確定後の取消" {
    OrderPlaced
    OrderConfirmed
    group Cancelled "取消の結果" { // one step, no order inside
      OrderCancelled
      RefundRequested
    }
  }

  hotspot RetryLimit "支払は何回まで再試行する？" {
    on PaymentFailed
  }
  hotspot WhoRefunds "返金は誰が処理する？" { // not decided: asked, never guessed (S024 is off while it is open)
    on RefundOrder
  }
  hotspot IssuedEvent "請求書の発行をイベントにする？" {
    on InvoiceIssued
    status resolved
    resolution "する。Billing に InvoiceIssued を追加する"
  }
}
```

| Element | What it is | Its clauses |
|---|---|---|
| `event` | something that happened in the business, a fact in the past tense | `ref Context.Event`, `from <external>`, `level design` |
| `actor` | a person or role that may issue commands | none |
| `external` | an external system that may issue commands, handle them, or send events | none |
| `command` | an operation someone attempts | `ref Context.Aggregate.command`, `by`, `reads`, `handledBy` (exactly one, or an open hotspot), `emits` |
| `policy` | a business rule: when one of its events happens, it may issue its command | `on` (one or more), `reads` (what it looks at to decide), `issues` (exactly one command); `by <actor>` when a person applies it |
| `aggregate` | a candidate consistency boundary that handles commands | `ref Context.Aggregate` |
| `readmodel` | information that whoever decides (a command's issuer, or a policy) looks at | `from <event>` |
| `hotspot` | a question or an important point, open or resolved | `on` (one sticky at most), `status`, `resolution` |
| `timeline` | a partial time order of events | event IDs and groups |
| `group` | events of one step of a timeline, without an order among them | event IDs, each once |
| `exception` | an exception from the main flows: a timeline that branches off one | event IDs and groups, then `then <Event>` (optional) |
| `stage` | a time section of the flow: its main flows and exceptions | `after <Stage>` (at most one), then `timeline`s and `exception`s |

- `kind ID "label"`, with a `{ … }` body for clauses, one per line. `///` lines above a declaration are its
  description. The IDs of a storming are one namespace across kinds, timelines and groups included; a clause or a
  timeline names an element of the same storming by its ID (never one of another storming).
- **The relations are Event Storming's grammar** (ADR 0032), and the only keywords: a command is issued `by` an actor
  or external system (several are alternatives), who `reads` read models to decide it; it is `handledBy` an aggregate
  or an external system, which `emits` its events; a policy is `on` events, `reads` read models and `issues` one
  command (S031; a command a policy issues has no `by` and no `reads`: the policy is its issuer and decides, S025,
  S030); a read model is fed `from` events; an event that arrives
  without a command of ours comes `from` an external system; a hotspot is `on` any sticky. A list is one clause,
  `emits A, B`. Only a policy connects two commands. A command is a whole row: without its issuer, `handledBy` or
  `emits` it is an error (S024), and so is an actor, external system, aggregate or read model that no relation names
  (S027) — unless an open hotspot is `on` it. **Never fill a relation by guessing**: what is not decided is a hotspot
  `on` the element, asking it. `dt guide dtes-quick` is the syntax on one screen.
- **From outside, and on a schedule.** `event E { from Ext }` when we only record a fact the outside system decided; a
  command `by Ext` when our aggregate decides something on what it sends. A schedule is a time event
  (「毎晩2時になった」) and a policy `on` it, not an external system called "batch". A policy may be `by` an actor: a
  rule a person applies by hand.
- **Relations are possibilities**, never execution: several `by`s are alternatives; `emits` lists outcomes that may
  happen, neither required, exclusive nor complete; a policy is evaluated when any of its `on` events happens and may
  issue its command, with no guarantee that it runs. A policy issues one command (S031): several commands are several
  policies, each with what it looks at. A policy needs no context of its own and may cross contexts. `reads` says that
  the information is used to decide, by whoever decides (the issuer of a command, or a policy), not how it is read.
- **Timelines** hold event IDs and groups only. A timeline is partial and proves no causality; an event may appear in
  several timelines and several times in one, each an occurrence of its own; timelines are never merged into one global
  order. A group is a set: its order and ID carry no meaning. An event in no timeline is fine.
- **Stages, main flows and exceptions.** A flow in several phases is a `stage` per phase, in time order, each
  `after` the one before it. In a stage, a `timeline` is a main flow and an `exception` an exception: written so,
  never guessed from the order. The first `timeline` is the *trunk*, drawn as one straight row through every stage.
  Every other timeline starts with the step it branches off at, written again: a step of the trunk (its first, to share
  the start), or of another timeline that branches off itself. An exception may end with `then <Event>`: it returns to
  that step of a main flow, of its own stage first, or of a later or earlier one. Another normal path is another
  `timeline` from its branch event. Events stay declared in the storming, and may appear in several stages. Once a
  storming has stages, every timeline is in one (S020); without stages, `exception`s and `then` work the same at the
  top level, and a storming with neither keeps its timelines as before.
- **Design Level only.** An event with `level design` is a detail of the mechanism (a reservation, an authorisation,
  an internal failure or retry) rather than a business fact: Big Picture leaves it out, and Design Level shows it.
  Without the clause, an event is shown at both levels; `level design` is the only level (S016), on events only, and
  its place is the last clause, after the `ref`. To show such an event at Big Picture too, remove the clause.
- **Hotspots** are `open` unless `status resolved`, which needs a `resolution "…"`. Resolved means the business agreed,
  not that the `.dt` model has it. Keep the resolved hotspots that matter (an exception, a boundary, an invariant) and
  delete the trivial ones: git keeps the history.
- Not in the DSL: positions and layout, conditions, guards, compensation, ordering or transactions. Not diagnosed:
  Big Picture completeness (events in no timeline or not referenced, read models without `from`, elements without
  `ref`), timeline order against the causal relations, and policies across contexts.
- `dt fmt` formats a storming: 2 spaces per level, each element, clause, timeline step (`then` included), group event
  and timeline of a stage on its own line, an element without clauses on one line, comments kept. It puts the clauses
  of a body in one order, each with its comments: `ref`, `by`, `reads`, `handledBy`, `emits`, `on`, `issues`, `from`,
  `status`, `resolution`, `level`; in a policy `on`, `reads`, `issues`, `by` (「〜が起きたら、〜を見て、〜を出す」).
- Files written for v0.1 (`actor X`, `target X` in a command) are errors (S023), and so are the `reads` of a command a
  policy issues written for 0.8 (S030): `dt migrate dtes` rewrites them.

A storming in stages:

```dtes
// stormings/certificate.dtes
/// A resident certificate from a convenience store: what is prepared, then issued, then handed in.
storming CertificateIssuance "住民票のコンビニ交付" {
  event CertificateAsked "住民票を頼まれた"
  event MethodResearched "取り方を調べた"
  event LeftWithCard "カードを持って出た"
  event StoreVisited "コンビニに行った"
  event CardRead "カードを読み取った"
  event PinEntered "暗証番号を入力した"
  event PinLocked "暗証番号がロックされた"
  event PinReset "暗証番号を再設定した"
  event FeePaid "手数料を払った"
  event CertificateIssued "証明書が発行された"
  event CertificateHandedIn "証明書を提出した"

  hotspot ResetWhere "再設定は市役所だけ？" {
    on PinReset
  }

  stage Preparation "準備" {
    timeline PrepareFlow "通常" { // the first timeline: the trunk
      CertificateAsked
      LeftWithCard
    }
    timeline ResearchFirst "調べてから" { // another normal path, from the step it shares
      CertificateAsked
      MethodResearched
      LeftWithCard
    }
  }
  stage Issuance "コンビニでの発行" after Preparation {
    timeline IssueFlow "通常" {
      StoreVisited
      CardRead
      PinEntered
      FeePaid
      CertificateIssued
    }
    exception Locked "暗証番号のロック" { // branches off at CardRead, written again
      CardRead
      PinLocked
      PinReset
      then PinEntered // back to the main flow
    }
  }
  stage Submission "提出" after Issuance {
    timeline SubmitFlow "通常" {
      CertificateHandedIn
    }
  }
}
```

<!-- topic: dtes-quick -->
### The `.dtes` syntax on one screen

A storming's relations are Event Storming's grammar (ADR 0032): each command's body is its whole row, read model →
issuer → command → handler → events; a policy's body is its row, event → read model → policy → command. `reads` is on
the row of whoever decides: the issuer's command, or the policy. Write in this style, clauses in this order (`dt fmt`
keeps it).

```dtes
// stormings/dispatch.dtes
storming Dispatch "配車" {
  event RequestReceived "依頼を受け付けた" {
    from OrderSystem // a fact the outside system decided: we only record it
  }
  event NightlyCutoff "毎晩2時になった" // a time event: a schedule is an event and a policy, not an external "batch"
  event CarAllocated "配車を組んだ"
  event AllocationFailed "配車できなかった"
  event DriverNotified "ドライバーに知らせた"
  event RequestCancelled "依頼が取り消された"
  event RequestHeld "依頼を保留した"

  actor Dispatcher "配車担当"
  external OrderSystem "受注システム"
  external Messenger "通知サービス"
  readmodel UnassignedRequests "未割当の依頼" {
    from RequestReceived // the events it is fed from
  }
  aggregate AllocationPlan "配車計画"

  command BuildAllocation "配車を組む" { // issued by a policy: no `by`, and no `reads` (the policy has them)
    handledBy AllocationPlan // who handles it: an aggregate or an external system, exactly one
    emits CarAllocated, AllocationFailed // its outcomes, produced by the handler
  }
  command NotifyDriver "ドライバーに知らせる" {
    handledBy Messenger
    emits DriverNotified
  }
  command CancelRequest "依頼を取り消す" {
    by OrderSystem // who issues it: an actor, or an external system when our aggregate decides on what it sends
    handledBy AllocationPlan
    emits RequestCancelled
  }
  command HoldRequest "依頼を保留する" {
    by Dispatcher
    reads UnassignedRequests // what the issuer looks at to decide
    handledBy AllocationPlan
    emits RequestHeld
  }
  command ReassignByHand "手で配車し直す" {
    emits CarAllocated
  }

  policy AllocateAtCutoff "2時になったら配車する" { // the only link from an event to a command
    on NightlyCutoff
    reads UnassignedRequests // what the policy looks at to decide
    issues BuildAllocation // one command per policy
  }
  policy NotifyWhenAllocated "配車したら知らせる" {
    on CarAllocated
    issues NotifyDriver
  }
  policy CallBack "失敗したら組み直す" {
    on AllocationFailed
    reads UnassignedRequests // what the person applying it looks at
    issues ReassignByHand
    by Dispatcher // a rule a person applies by hand: the policy issues the command, without `by` in it
  }

  hotspot WhoReassigns "手配車は何が処理する？" { // not decided: asked, never guessed
    on ReassignByHand
  }

  timeline Normal "通常" {
    RequestReceived
    NightlyCutoff
    CarAllocated
    DriverNotified
  }
}
```

| In | Relation | Names | Means |
|---|---|---|---|
| `command` | `by` | actor, external | who issues it (none when a policy `issues` it) |
| `command` | `reads` | read model | what the issuer looks at to decide (none when a policy `issues` it) |
| `command` | `handledBy` | aggregate, external | who handles it and produces its events (exactly one, or an open hotspot) |
| `command` | `emits` | event | its possible outcomes |
| `policy` | `on` | event | when the event happens, … |
| `policy` | `reads` | read model | … looking at the read model, … (what the policy decides with) |
| `policy` | `issues` | command | … it issues the command (exactly one) |
| `policy` | `by` | actor | the person who applies the rule by hand (optional) |
| `readmodel` | `from` | event | the events it is fed from (optional) |
| `event` | `from` | external | it arrives from outside, without a command |
| `hotspot` | `on` | any sticky | the question is about it (one) |

- Only these keywords; a list is one clause, `emits A, B` (`dt fmt` merges `by A` and `by B` into `by A, B`).
  `actor` and `target` inside a body are v0.1 (S023), and `reads` on a command a policy issues is 0.8 (S030):
  `dt migrate dtes` rewrites them.
- **From outside.** `event E { from Ext }` when we only record a fact the outside system decided (an order arrived, a
  payment was authorised); a command `by Ext` when, on what it sends, our aggregate decides something (accepts or
  rejects it).
- **On a schedule.** A time event (「毎晩2時になった」) and a policy `on` it, not an external system called "batch".
- Errors, each with a fix in its hint: a target of the wrong kind (S003: `by` an aggregate is `handledBy` it, `reads`
  an event is a read model fed `from` it, `emits` a command is a policy between them); a relation the element does not
  take (S006: a command never `issues`); a second `handledBy` (S004); a command without its issuer, `handledBy` or
  `emits` (S024); `by` on a command a policy issues (S025); a relation twice (S026); an actor, external system,
  aggregate or read model that takes part in no relation, at Design Level (S027); an event both emitted and `from` an
  external system (S028); `reads` on a command a policy issues, which belongs in the policy (S030); a policy issuing
  more than one command, to split (S031). An info (S029) points at an event nothing produces at Design Level (a time event a policy
  reacts to aside).
- **Not decided yet? Never guess.** Do not invent an actor, an aggregate or an event to make S024, S027 or S008 go
  away: put a `hotspot` `on` the command, policy or element, asking what is missing. While it is open, that element's
  incompleteness is not an error, but `dt check` lists it and the Live View draws its empty slot dashed; when it is
  resolved, write the relation.
- Big Picture (events, timelines, hotspots on events, and no command or policy) needs none of this.

<!-- topic: storming-refs -->
### References to the model (`ref`)

An event, an aggregate or a command may have one `ref`: the `.dt` symbol it is (the same concept, not a loose
relation). It is always fully qualified, and never resolved by a simple name or a guessed context:

| Element | `ref` | Names |
|---|---|---|
| `event` | `Context.Event` | an event of the model |
| `aggregate` | `Context.Aggregate` | an aggregate |
| `command` | `Context.Aggregate.command` | a command of that aggregate |

- A `ref` is optional: leave it out while the model has no such symbol, and nothing warns about an element without one,
  or about a model element that no storming mentions. Policies, actors, externals, read models, hotspots, timelines
  and groups have no `ref`: a `.dt` policy is not the counterpart of a storming's policy (below).
- S010 / S011 report a `ref` that is not fully qualified, names nothing or names another kind. When the `.dt` files do
  not parse, the `ref`s are not checked.
- **Contract warnings**, only for what is provable: S012 when a command's `ref` is a command of another aggregate than
  the `ref` of the aggregate it is `handledBy`; S013 when a command `emits` an event whose `ref` the `.dt` command never emits (a `.dt`
  command emits exactly the events of its `emits`, and none on an error). An event that the `.dt` command emits but the
  storming does not list, an `emits` of an event without `ref`, and a different multiplicity are not diagnosed.
- No tool rewrites either side: after a change of the model, the broken `ref`s are reported and fixed by hand (the
  language server goes to the `.dt` declaration of each part of a `ref`).

**From a storming to `.dt`.** An event becomes an event of the context that owns it, an aggregate an aggregate, a
command a command of the aggregate it is `handledBy` (lower camel case: `ConfirmOrder` → `Order.confirm`), with its `emits`
decided as a contract (exact, unlike the storming's). A storming's policy becomes, where it is a reaction the business
relies on, one `.dt` policy per event and command, `policy P when Event -> Aggregate.command` in the context of the
command ([Reactions to events](#reactions-to-events-policies)): deciding which pairs those are is modeling, not an
expansion of its `on` and `issues`. Actors, external systems and read models have no `.dt` counterpart; a resolved
hotspot is a decision to model (an error, a requirement, an invariant). Then add the `ref`s that resolve.

<!-- topic: storming-views -->
### Views of a storming

A storming is viewed along two independent axes, neither of which changes the `.dtes`:

- **Level.** *Big Picture* shows the events, the timelines' order, groups and hotspots. *Design Level* adds actors,
  external systems, commands, policies, aggregates, read models and the relations, and the events marked
  `level design`. Big Picture hides the details of the same file; it is not an earlier version, and every event
  without `level design` is there. A timeline's order there skips the hidden events (their neighbours are joined),
  a group of hidden events only is not drawn, timelines that differ only in hidden events share their start, a
  hotspot on a hidden event is shown without its line, and a hotspot on a sticky of Design Level (a command, a policy,
  …) is not shown.
- **Scope.** The *integrated canvas* shows every timeline, the events in no timeline and every element. A storming
  with stages also has a view of each *stage* (its main flows and exceptions, drawn as on the integrated canvas). *One timeline*
  shows its events, plus each one-hop path event → policy → command → event whose two events are both in that timeline,
  the commands that emit one of its events (their cause, as on the integrated canvas), the issuers, read models and
  handlers of those commands, the events of the view that feed those read models, the external systems its events come
  from, and the hotspots on its events and on those elements. A stage's view picks them the same way over the stage's
  events. Longer chains are not followed (a command's policy is shown only on such a path), and a hotspot without `on`
  is shown on the integrated canvas only.

The integrated canvas draws each event once, without group frames: the time order is one dashed arrow per pair of
consecutive events, naming the timelines it belongs to when not all of them do, and an event that repeats loops back
to its note. One timeline draws each occurrence of an event, and a group as a frame. Drawing an event once does not
make two occurrences the same happening, so read a path along one timeline's name. The lines have three looks: a thin
solid arrow (流れ) for every relation between stickies, a dashed arrow (時間) for the time order where the placement
cannot show it, and a quiet line without a head (問い) from a hotspot to its sticky. Relations are possibilities, not
"happened". Hovering or selecting a line says what it means in plain words (「配車を組む は 配車組 が処理する」), and
selecting it keeps its two stickies in full view.
Design Level reads left to right as Event Storming does (ADR 0032): read model → issuer (an actor or external system,
stuck on top of its command when no read model leads to it) → command → handler (an aggregate or external system) →
event → policy → the command it issues → … A read model goes to whoever looks at it to decide: a command's issuer, or a
policy (read model → policy, the read model just before the policy). A command goes to its handler, which decides and emits
the command's events, so the `emits` arrows start at the handler; a command without `handledBy` emits them itself.
At Design Level no line joins two events in time order where the placement shows it (the steps left to right): only an
exception's branch and its `then` are drawn (Big Picture draws the time order). An issuer or handler an open hotspot
leaves undecided is an empty dashed note where it would stand («未決定» 誰が処理する？), so a silenced gap stays in view;
`dt check` lists them too. An
event that arrives `from` an external system has that system before it. A hotspot is stuck on top of the sticky it is
`on` (an event, a command, a policy, …), not a step of the flow.
A hotspot with `status resolved` is drawn paler, with a green check in its corner and a fainter `on` (hovering it shows
its `resolution`), so the open ones stand out; to settle one, ask the AI in the chat.
At Design Level an issuer, a read model and a handler are drawn next to each command that uses them, one note per
command — except that commands converging on the same event note through the same handler share one handler note
before it (its arrow to the event stands for all their `emits`; hovering it names them), and an external system an event comes from next to each note of that event, so their lines stay short (one
that nothing uses is drawn once). Where one view draws an event at several steps (a timeline's view, a stage, a
storming with stages), a command is drawn before each step of its events, with its own issuer, read model and handler,
a policy after each step of the events it is `on`, and a hotspot on each note of its sticky, so every chain reads left to right into its own event. Selecting any of these notes
selects the element and marks its other notes with a fainter dashed ring.
Every note is a square of the same size: a long label is drawn smaller, and one too long even then is cut short with
«…» (hovering it shows the whole label; S015 warns about it), so keep labels short (about 12 Japanese characters).
The layout is automatic, left to right; positions are kept in the workspace's cache directory, outside the workspace
(`layout.json`; `dt guide config`), never in the `.dtes`.
詰めて表示 in the canvas's controls closes up the gaps between the notes (every diagram, remembered per browser), and
印刷 in the view bar's 書き出し menu prints the diagram alone, fitted to one landscape page (Ctrl+P too), and its PNG
and SVG save it as a file (`dt export svg` draws the same SVG without a browser; `dt guide export`). In
`dt open`, the イベントストーミング world shows one storming at a time, with the storming and the timeline picked as
its view bar's subject (a breadcrumb at the left) and the level next to them; selecting a note shows the element, its `ref` and relations, and the timelines an event appears in (and
デザインレベルのみ for an event marked `level design`).
Selecting notes shows a toolbar above them, and 「…」 or a right-click the menu of every action on them: add them to the
chat (`Enter`), edit the label and the name (`F2`, or a double-click), see the `.dt` element of a `ref` or a timeline
the event is in, put a hotspot on any sticky but a hotspot (its question only: written at once, the AI names it afterwards), write a hotspot's resolution, copy a link to the note (`⌘⇧C`); `⌘K` finds
actions and notes by name. Editing is in a session only (below). After a jump to the domain model or another
timeline, the detail's back button (and the browser's Back) returns to the storming as it was shown.

A storming with stages or exceptions is drawn in time order instead: the stages left to right, each a labelled frame,
one column per step, the trunks as one straight row through every frame (the `after` arrow joins one trunk's end to
the next one's start). Every other timeline hangs below the step it branches off at, on a row of its own flowing right
and named by its label: the other main flows first, then the exceptions. The step an exception branches off at is one
note for both; a dashed arrow goes from an exception's last step back to the step of its `then`. At Design Level each step is a group of columns — read models (on the row of the issuer that looks
at them), commands (their issuers on top, a hotspot on the command above them), handlers (aggregates and external
systems, and the external system an event comes from), the event (its hotspots on top), policies (their hotspots on
top) — and the elements stand in a band above the row of the event
they belong to, an exception's on its own lane: the chain reads left to right into each event. The timeline picker lists the
stages (「コンビニでの発行（例外を含む）」) between すべて（統合） and the timelines; clicking a stage's frame selects
it (its main flows, its exceptions and 「この段階を表示」). 「例外を表示」 in the view bar's 絞り込み (a storming with
exceptions only) hides the exceptions of the integrated canvas and of a stage: their steps, the events only they have, the
hotspots on those events and their `then` arrows; an exception's own view is unchanged.

<!-- topic: storming-rules -->
### Diagnostics of a storming

S001–S009 and S014–S031 need only the storming, S010–S013 check its `ref`s against the model. Each example below is a whole
file with that one problem. Syntax errors are `SYNTAX`: an unknown keyword or clause, a `ref` or clause in a timeline or
group, a declaration outside a storming or inside a body, a nested group, an empty group, a keyword used as an ID
(`by`, `handledBy` and `from` included), a list with a comma too many (`emits A,`).

**S001**: two declarations with one ID, of any kinds; also two stormings with one ID in the workspace. Rename one, and
the references to it.

```dtes
// S001
storming Checkout {
  event OrderPlaced
  hotspot OrderPlaced
}
```

**S002**: a relation or a timeline step names no declaration of the storming. Declare it, or correct the name (the hint
gives the closest one).

```dtes
// S002
storming Checkout {
  event OrderConfirmed
  actor Customer
  aggregate Order
  command ConfirmOrder {
    by Customer
    handledBy Order
    emits OrderConfirmd
  }
}
```

**S003**: a reference to a declaration of the wrong kind: `by` names an actor or external, `reads` a read model,
`handledBy` an aggregate or external, `emits`, a policy's `on` and timeline steps an event, `issues` a command, a read
model's `from` an event, an event's `from` an external, a hotspot's `on` any sticky but a hotspot. The hint names the
relation that says what was meant: `by` an aggregate is `handledBy` it, `reads` an event is a read model fed `from` it,
`emits` a command is a policy between them (only a policy connects commands). A command is never a step: put its
events in the timeline.

```dtes
// S003
storming Checkout {
  event OrderConfirmed
  actor Customer
  aggregate Order
  command ConfirmOrder {
    by Customer
    handledBy Order
    emits OrderConfirmed
  }
  timeline Main {
    ConfirmOrder
    OrderConfirmed
  }
}
```

**S004**: more than one `handledBy`, `ref`, hotspot `on`, `status`, `resolution` or `level`. Keep one; a command with two
handlers is two commands, or a hotspot.

```dtes
// S004
storming Checkout {
  event OrderConfirmed
  actor Customer
  aggregate Order
  aggregate Invoice
  command ConfirmOrder {
    by Customer
    handledBy Order
    handledBy Invoice
    emits OrderConfirmed
  }
}
```

**S005**: a `ref` on a policy, actor, external, read model or hotspot. Remove it: only events, aggregates and commands
correspond to `.dt` symbols.

```dtes
// S005
storming Checkout {
  event OrderConfirmed
  event InvoiceIssued
  aggregate Invoice
  command IssueInvoice {
    handledBy Invoice
    emits InvoiceIssued
  }
  policy BillConfirmedOrder {
    ref Billing.BillConfirmedOrder
    on OrderConfirmed
    issues IssueInvoice
  }
}
```

**S006**: a clause the element does not take: relations belong to commands (`by`, `reads`, `handledBy`, `emits`),
policies (`on`, `reads`, `issues`, `by`), read models and events (`from`) and hotspots (`on`), `status` and `resolution` to hotspots,
`level` to events. Move it to the element it belongs to (an event's outcome is the command's `emits`); a command's
`issues` is a policy between two commands.

```dtes
// S006
storming Checkout {
  event OrderConfirmed {
    emits OrderPlaced
  }
  event OrderPlaced
}
```

**S007**: an event twice in one group. Remove one: a group is a set; to show the event again, put it in another step.

```dtes
// S007
storming Checkout {
  event OrderCancelled
  timeline Main {
    group Cancelled {
      OrderCancelled
      OrderCancelled
    }
  }
}
```

**S008**: a policy without `on` or without `issues`. Add the missing one when it is decided; while it is unknown, do not
guess one: put an open hotspot `on` the policy, which asks the question and turns S008 off.

```dtes
// S008
storming Checkout {
  event OrderConfirmed
  policy BillConfirmedOrder {
    on OrderConfirmed
  }
}
```

**S009**: a `status` other than `open` or `resolved`, `resolved` without `resolution`, or a `resolution` while open.
Write what was agreed in `resolution`, or keep it open without one.

```dtes
// S009
storming Checkout {
  hotspot RetryLimit "支払は何回まで再試行する？" {
    status resolved
  }
}
```

**S010**: a `ref` that is not fully qualified, or names nothing in the model. Write the whole path (the hint gives the
closest one); while the model has no such symbol, leave the `ref` out.

```dtes
// S010
storming Checkout {
  event OrderConfirmed {
    ref OrderConfirmed
  }
}
```

**S011**: a `ref` to a symbol of another kind, or to a command the aggregate does not have. Name a symbol of the
element's kind.

```dtes
// S011
storming Checkout {
  event OrderConfirmed {
    ref Sales.Order
  }
}
```

**S012** (warning): a command's `ref` is a command of another aggregate than the `ref` of the aggregate it is
`handledBy`. Correct one of the `ref`s or the `handledBy`.

```dtes
// S012
storming Checkout {
  event OrderConfirmed
  actor Customer
  aggregate Invoice {
    ref Billing.Invoice
  }
  command ConfirmOrder {
    ref Sales.Order.confirm
    by Customer
    handledBy Invoice
    emits OrderConfirmed
  }
}
```

**S013** (warning): a command `emits` an event whose `ref` its `.dt` command never emits. If it can happen, add it to
the `.dt` command's `emits` (or, for a failure, an error of it); otherwise correct the `ref` or the `emits`.

```dtes
// S013
storming Checkout {
  event OrderCancelled {
    ref Sales.OrderCancelled
  }
  actor Customer
  aggregate Order {
    ref Sales.Order
  }
  command ConfirmOrder {
    ref Sales.Order.confirm
    by Customer
    handledBy Order
    emits OrderCancelled
  }
}
```

**S014** (warning): policies, commands and events form a cycle (policy → command → event → policy). It is a cycle of
possibilities, not an infinite loop: nothing to change when the repetition is intended (a retry); otherwise check the
relations along it, or record the stop condition in a hotspot.

```dtes
// S014
storming Checkout {
  event PaymentFailed
  aggregate Payment
  command RetryPayment {
    handledBy Payment
    emits PaymentFailed
  }
  policy RetryFailedPayment {
    on PaymentFailed
    issues RetryPayment
  }
}
```

**S015** (warning): a label too long for its sticky note. Every note is the same size; its label is drawn smaller to
fit, down to a floor, and one that does not fit even then is cut short with «…» (the whole label shows on hover and in
the inspector). Shorten it, to about 12 Japanese characters (an event in the past tense), and put the details in a
`///` comment. An element without a label shows its ID, which is checked the same way.

```dtes
// S015
storming Errands {
  event CertificateReissued "マイナンバーカードの暗証番号を三回間違えてロックされたので市役所の窓口で再設定の手続きをしてから改めてコンビニのマルチコピー機で住民票の写しを発行し直した"
}
```

**S016**: a `level` other than `design`. `level big-picture` is not written: an event without `level` is already shown
at both levels. Remove it, or write `level design` for an event to show at Design Level only.

```dtes
// S016
storming Checkout {
  event PaymentAuthorized {
    level big-picture
  }
}
```

**S017**: a stage `after` itself, or stages whose `after`s go round in a circle. Stages are in time order: remove the
`after` of the stage that comes first. (An `after` naming nothing is S002, naming something else than a stage S003, a
second `after` S004.)

```dtes
// S017
storming Errands {
  event Requested
  stage First after First {
    timeline Main {
      Requested
    }
  }
}
```

**S018**: a `then` on a main flow (a `timeline`), or naming an event of no main flow. Only an `exception` returns,
and to a step of a `timeline`: write the timeline as an `exception`, name an event of a main flow, or remove `then`.

```dtes
// S018
storming Errands {
  event Visited
  event Read
  stage Issuance {
    timeline Main {
      Visited
      Read
      then Visited
    }
  }
}
```

**S019** (warning): a timeline of a stage (or, with exceptions, of a storming without stages) whose first step is in
neither the trunk nor another timeline that branches off: it is drawn apart. Start it with the step it branches off
at, written again.

```dtes
// S019
storming Errands {
  event Visited
  event Read
  event Closed
  stage Issuance {
    timeline Main {
      Visited
      Read
    }
    exception OutOfHours {
      Closed
    }
  }
}
```

**S020**: a timeline or exception outside the stages of a storming that has stages. Move it into the stage it happens
in.

```dtes
// S020
storming Errands {
  event Visited
  timeline Outside {
    Visited
  }
  stage Issuance {
    timeline Main {
      Visited
    }
  }
}
```

**S021** (warning): a second stage without `after`. It is drawn as a separate start after the stages written before
it, with no arrow from them: add `after` with the stage it follows.

```dtes
// S021
storming Errands {
  event Requested
  event Visited
  stage Preparation {
    timeline Prepare {
      Requested
    }
  }
  stage Issuance {
    timeline Issue {
      Visited
    }
  }
}
```

**S022** (warning): a stage without a main flow (a `timeline`; an `exception` is not one). Add its main flow, or
remove the stage.

```dtes
// S022
storming Errands {
  stage Issuance {}
}
```

**S023**: `actor` or `target` in a body: the relations of v0.1, replaced by `by` (who issues a command) and `handledBy`
(who handles it, an aggregate or an external system). `dt migrate dtes` rewrites them in every command; elsewhere,
move the relation into the command it belongs to.

```dtes
// S023
storming Checkout {
  event OrderConfirmed
  actor Customer
  aggregate Order
  command ConfirmOrder {
    actor Customer
    handledBy Order
    emits OrderConfirmed
  }
}
```

**S024**: a command that does not say who issues it (`by`, or a policy that `issues` it), who handles it (`handledBy`)
or what comes of it (`emits`): at Design Level a command is a whole row, read model → issuer → command → handler →
event. Add what is decided. What is not decided is never guessed: put an open hotspot `on` the command, asking it
(`hotspot WhoHandles "誰が処理する？" { on ConfirmOrder }`); while it is open, S024 is off for that command. Resolving the
hotspot turns it on again, until the relation is written.

```dtes
// S024
storming Checkout {
  event OrderConfirmed
  actor Customer
  command ConfirmOrder {
    by Customer
    emits OrderConfirmed
  }
}
```

**S025**: a command a policy `issues` that also has `by`. The policy is its issuer; a person who also issues it by hand
is another command, `by` that person.

```dtes
// S025
storming Checkout {
  event OrderConfirmed
  event InvoiceIssued
  actor Clerk
  aggregate Invoice
  command IssueInvoice {
    by Clerk
    handledBy Invoice
    emits InvoiceIssued
  }
  policy BillConfirmedOrder {
    on OrderConfirmed
    issues IssueInvoice
  }
}
```

**S026**: one relation written twice in an element (`emits A` twice, or `emits A, A`). Remove the second.

```dtes
// S026
storming Checkout {
  event OrderConfirmed
  actor Customer
  aggregate Order
  command ConfirmOrder {
    by Customer
    handledBy Order
    emits OrderConfirmed, OrderConfirmed
  }
}
```

**S027**: at Design Level (the storming has a command or a policy), an actor, external system, aggregate or read model
that takes part in no relation: no relation names it, and it has none of its own (a read model fed `from` events that
people only look at takes part). Name it where it takes part (`by`, `handledBy`, `reads`, an event's `from`), or remove
it; while that is not known, an open hotspot `on` it asks where it is used and turns S027 off.

```dtes
// S027
storming Checkout {
  event OrderConfirmed
  actor Customer
  aggregate Order
  aggregate Invoice
  command ConfirmOrder {
    by Customer
    handledBy Order
    emits OrderConfirmed
  }
}
```

**S028**: an event that a command `emits` and that also arrives `from` an external system. An event comes from one
place: if the external system handles that command, write `handledBy` it in the command; if they are two happenings,
declare two events.

```dtes
// S028
storming Checkout {
  event PaymentConfirmed {
    from PaymentService
  }
  external PaymentService
  aggregate Payment
  command ConfirmPayment {
    by PaymentService
    handledBy Payment
    emits PaymentConfirmed
  }
}
```

**S029** (info): at Design Level (the storming has a command or a policy), an event that no command emits and that
comes `from` no external system. Nothing to fix while that part of the storming is at Big Picture; otherwise write the
command that `emits` it, `from` the external system it arrives from, or — for a schedule — leave it a time event that
a policy reacts to (those are not reported).

```dtes
// S029
storming Checkout {
  event OrderPlaced
  event OrderConfirmed
  actor Customer
  aggregate Order
  command ConfirmOrder {
    by Customer
    handledBy Order
    emits OrderConfirmed
  }
}
```

**S030**: `reads` on a command a policy `issues` (and that has no `by`). `reads` is written on the row of whoever
decides (ADR 0032 §9): the policy decides, so the read model it looks at is the policy's `reads`. Move it to the
policy that issues the command (`dt migrate dtes` moves it when exactly one policy does; when several do, write it in
the one that looks at it).

```dtes
// S030
storming Checkout {
  event OrderConfirmed
  event InvoiceIssued
  readmodel OrderTotal
  aggregate Invoice
  command IssueInvoice {
    reads OrderTotal
    handledBy Invoice
    emits InvoiceIssued
  }
  policy BillConfirmedOrder {
    on OrderConfirmed
    issues IssueInvoice
  }
}
```

**S031**: a policy that `issues` more than one command. Split it, one policy per command, each `on` the events it
reacts to and with the `reads` it looks at for that command. Several policies may issue one command.

```dtes
// S031
storming Checkout {
  event OrderConfirmed
  event InvoiceIssued
  event StockReserved
  aggregate Invoice
  aggregate Stock
  command IssueInvoice {
    handledBy Invoice
    emits InvoiceIssued
  }
  command ReserveStock {
    handledBy Stock
    emits StockReserved
  }
  policy AfterConfirmation {
    on OrderConfirmed
    issues IssueInvoice, ReserveStock
  }
}
```

<!-- topic: storming-practice -->
### Event Storming with DomainTrail

How to run a storming in `.dtes` files, for people and AI agents. The rules of the language are in [Event
Storming](#event-storming-dtes); this is the way of working.

**Start from the brief.** The storming's journey in [the journey file](#the-journey-file) says its purpose, scope, who
takes part, what the result is for and how far to go (`/es:start` in the chat writes it). Keep to that scope; ask
before going beyond it. With no journey, ask for the purpose and the first and last events before writing much. The
`///` above `storming` is only a short description of what the storming is, never the brief.

**Big Picture first.**
- Events first, and mostly events: what happened in the business, in the past tense, in the words the business uses
  (「注文を受け付けた」, not 「注文受付処理」 or 「OrderService が保存した」). One fact per event.
- Short labels: about 12 Japanese characters or 4–5 English words. A long label is usually two events or a
  description; put the detail in `///`.
- Order them in `timeline`s, the usual flow first; events that happen together go in a `group`. A flow in phases
  (preparation, the main act, follow-up) gets a `stage` per phase, each `after` the one before.
- Each failure or detour is an `exception` that starts with the event where it branches off, written again, and ends
  with `then <Event>` when it returns to the flow (in this stage or another); without `then`, the flow ends there. A
  second normal path is another `timeline` from where it splits off. The usual flow should read as one straight row.
- Anything unclear, disputed or risky becomes a `hotspot` on the events it concerns, worded as a question. Do not
  settle it by guessing; an open hotspot is a good result.
- No commands, policies, aggregates or read models yet, and no `ref`s.

In the chat, `/es:exceptions`, `/es:gaps` (events missing between two of a flow), `/es:levels` (which events show at Big
Picture) and `/es:names` (labels not in the past tense, inconsistent, too long or technical) list candidate changes to
check. Unsure what to do next? `/guide` (the composer's ガイド button) shows the map from the brief to your goal and
what the files show at once, then has the AI coach you: why the step you are at is next and one to three steps, with
the command that does a step, the places to look at and the questions to ask the people.

**Design Level next**, once the flow is agreed (the brief says how far to go):
- Write each command as its whole row (`dt guide dtes-quick`): who issues it, `by` an `actor` or `external` system —
  or the `policy` that `issues` it, reacting to an earlier event (「〜したら〜する」), and then no `by`; the
  `readmodel` the issuer `reads` to decide (for a policy's command, the policy `reads` it: 「〜が起きたら、〜を見て、〜を出す」,
  one command per policy); what handles it, `handledBy` an `aggregate` or an `external` system; and what it `emits`. An event that arrives from outside without a command of ours is `from` the external system.
- **Never fill a relation by guessing.** When nobody knows who issues or handles a command, or what a policy reacts to,
  do not invent an actor or an aggregate to silence the error: put a `hotspot` `on` that command or policy, asking it.
  The open hotspot is the honest result, and it turns the incompleteness error (S024, S008, S027) off.
- Fine-grained events found here (reservations, authorisations, internal failures, retries) get `level design`, so
  that Big Picture keeps the flow people agreed on. An event the people want to see at Big Picture loses it.
- Keep hotspots for what is still open; set `status resolved` with its `resolution "…"` only when the people settle
  one.

**Model references.** Add `ref` only to an element that has a counterpart in the `.dt` model and resolves; never
invent a `.dt` symbol to make a `ref` work. A storming does not change the `.dt` files: moving from a storming to the
model is modeling (see [Modeling with DomainTrail](#modeling-with-domaintrail)).

**Keep it a storming.** It records what people found, including the doubts: do not tidy it into a design document,
do not delete hotspots or events because they look redundant, and keep the IDs stable (people and the chat refer to
them).

<!-- topic: rules -->
## Rules

Each diagnostic names its rule. A `hint` says what to change when the message does not; unresolved names get
`did you mean …?` instead. The S rules check `.dtes` files, with an example and a fix each in [Diagnostics of a
storming](#diagnostics-of-a-storming).

| Code | Check |
|---|---|
| SYNTAX | lexer / parser errors (in `.dt` and `.dtes` files) |
| M001 | types, aggregates and names in invariants and requirements resolve |
| M002 | names are unique in their scope (also across files of one context); a type on `UUID` declares no invariant named `uuid`, the generated one |
| M003 | an entity is owned by exactly one aggregate (warning when owned by none) |
| M004 | no ownership across aggregate boundaries (entities need `owns`, aggregates need `references`, …) |
| M005 | a reference's ID type matches the identity of the target aggregate |
| M006 | command transitions: states exist; stateful: `create` has one `-> X`, others one or more `A -> B` with sources; a state is the source of one transition per command; stateless: none. `emits … when`: its states are sources / targets of the command, it matches an outcome, a factory selects by target only, stateless: no `when` |
| M007 | `emits` / `errors` / `else` refer to existing events / errors |
| M008 | an invariant or requirement is a Bool expression |
| M009 | operators and operands have compatible types; a domain primitive compares with the same one, literals, and (over `Int` / `Decimal`) `count(…)` / `length(…)` |
| M010 | state-specific fields are used only in their own state's invariants, and in requirements of commands whose every source state has them |
| M011 | generated TypeScript names do not collide, including the events of one command (keyed by name) |
| M012 | the ownership graph has no cycle through an entity or an aggregate; a recursive value object or union has a finite value |
| M013 | aggregates and entities have an `id` field of their own ID type |
| M014 | shared contexts: only value types, no dependency on other contexts, consistent `shared`, unambiguous names (shadowing is a warning) |
| M015 | unions: at least one variant, variants match the bound enum exactly, no variant field named like the discriminator |
| M016 | field sets: plain fields only (no `id`), `with` only on aggregates, entities, value objects and events, each field name from one place |
| M017 | (warning) an event emitted by an aggregate's command has a field of that aggregate's ID type |
| M018 | an invariant or requirement without an expression has a label or a `///` description |
| M019 | a parameter of a command with `requires` is not named like a field its requirements see |
| M020 | (warning) a `create command` has a parameter of the aggregate's ID type (commands are pure: the ID is passed in) |
| M021 | `changes` names fields the command can change: fields of the aggregate other than its identity, a state-specific one carried over by an outcome; none on a `create command` |
| M022 | (warning) a field of an event or error a command emits or returns, with no source of the same name and type (parameters, their fields, the aggregate's fields), while some source has its type; ID-typed, Int, Decimal and Bool fields are exempt |
| M023 | policies: the event exists, the aggregate is one of the policy's own context, the command is one of the aggregate, the event is not of a shared context; (warning) two policies of a context state the same reaction |
| M024 | verified types: the base and the context of `for` are value types (`for` not a verified type), no cycle; a verified type types command parameters and other verified types only, no field |
| M025 | a context's description (`///` above `context X`) is written once across the files of the context; each later one names the first |
| M026 | (warning) a union has a variant with fields; one whose variants have none is an `enum` |
| M027 | (warning) a field or parameter named `<stem>Id` (`ID`; `Ids` / `IDs` for several) is not typed `String`, `UUID` or the base of the ID type when `<Stem>Id` (`<Stem>ID`) is an ID type or `<Stem>` an aggregate or entity: of its context or a shared one, else of exactly one other context (none for a field of a shared context); it takes the ID type |
| L001 | (warning) an inline field label disagrees with the term, or context fragments disagree on the context name |
| L002 | (warning) a term is not used by any field or parameter |
| L003 | (warning) different things in one scope share a Japanese name |
| S001 | `.dtes`: the IDs of a storming's declarations are unique across kinds (groups and timelines included), and storming IDs are unique in the workspace |
| S002 | `.dtes`: a relation target or timeline step names a declaration of its storming |
| S003 | `.dtes`: a reference names a declaration of the right kind (`by` an actor or external, a command's or policy's `reads` a read model, `handledBy` an aggregate or external, `emits` / a policy's `on` and timeline steps an event, `issues` a command, a read model's `from` an event, an event's `from` an external, a hotspot's `on` a sticky) |
| S004 | `.dtes`: at most one `handledBy`, `ref`, hotspot `on`, `status`, `resolution` and `level` per element |
| S005 | `.dtes`: only events, aggregates and commands have a `ref` |
| S006 | `.dtes`: an element has only the clauses of its kind: relations in commands, policies, read models and events (`from`) and hotspots, `status` / `resolution` in hotspots, `level` in events; a command never `issues` |
| S007 | `.dtes`: an event appears at most once in a group |
| S008 | `.dtes`: a policy has at least one `on` and one `issues`, unless an open hotspot is `on` it |
| S009 | `.dtes`: a hotspot's `status` is `open` or `resolved`; `resolved` needs a `resolution`, `open` has none |
| S010 | `.dtes`: a `ref` is fully qualified (`Context.Event`, `Context.Aggregate`, `Context.Aggregate.command`) and resolves in the `.dt` model |
| S011 | `.dtes`: a `ref` names a `.dt` symbol of its element's kind (a command `ref`, a command the aggregate has) |
| S012 | (warning) `.dtes`: a command's `ref` is a command of the aggregate that the `ref` of its `handledBy` names |
| S013 | (warning) `.dtes`: a command `emits` no event whose `ref` its `.dt` command never emits (`.dt` `emits` is exhaustive) |
| S014 | (warning) `.dtes`: a type-level cycle policy → command → event → policy (possible, not an infinite loop) |
| S015 | (warning) `.dtes`: a label fits its sticky note (one too long even at the smallest font is cut short with «…») |
| S016 | `.dtes`: an event's `level` is `design` (Design Level only); without `level`, it is shown at both levels |
| S017 | `.dtes`: a stage comes `after` another stage, never itself or round a circle |
| S018 | `.dtes`: only an `exception` has `then`, naming an event of a main flow (a `timeline`) |
| S019 | (warning) `.dtes`: a timeline other than the trunk starts at a step it branches off from (of the trunk or of another timeline branching off) |
| S020 | `.dtes`: in a storming with stages, every timeline and exception is in a stage |
| S021 | (warning) `.dtes`: only the first stage comes after no stage |
| S022 | (warning) `.dtes`: a stage has a main flow (a `timeline`) |
| S023 | `.dtes`: no `actor` or `target` in a body (v0.1): a command's issuer is `by`, its handler `handledBy` (`dt migrate dtes`) |
| S024 | `.dtes`: a command has its issuer (`by`, or a policy that `issues` it), `handledBy` and `emits`, unless an open hotspot is `on` it |
| S025 | `.dtes`: a command a policy `issues` has no `by` |
| S026 | `.dtes`: a relation is written once in an element |
| S027 | `.dtes`: every actor, external system, aggregate and read model is named by a relation, unless an open hotspot is `on` it |
| S028 | `.dtes`: an event is emitted by a command or arrives `from` an external system, not both |
| S029 | (info) `.dtes`: at Design Level, an event has a source: a command emits it, it comes `from` an external system, or a policy reacts to it as a time event |
| S030 | `.dtes`: a command a policy `issues` has no `reads`: the policy decides, so the read model it looks at is the policy's `reads` |
| S031 | `.dtes`: a policy `issues` one command |
| J001 | `domaintrail.journey.json` reads against its schema (`schema/journey.schema.json`): JSON, the keys and enums it allows, the goals and marks of each pattern, unique journey IDs |
| J002 | (warning) a journey names a storming that does not exist (an ES journey's key, a `FromStorming` journey's `from.stormings`) |
| J003 | (warning) a journey names a context that does not exist (a `OneContext` journey's `from.context`) |
| K001 | a knowledge item's file (`knowledge/kn_*.md`) reads: its front matter, the fields and values it allows, the file named by the item's ID (the store skips a file that does not) |
| K002 | (warning) a knowledge item is `about` a sticky (`<Storming>.<LocalId>`) that no `.dtes` of the workspace has |

<!-- topic: journey -->
## The journey file

`domaintrail.journey.json`, at the workspace root next to `domaintrail.jsonc` (the directory `dt -r` names), says
what the work in the workspace is for, how far it goes and how far it has come. It is tracked by git. It is neither the
model nor configuration: a change to it never asks for trust again. Its schema is `schema/journey.schema.json` in the
package.

- `stormings`: one event storming journey per storming, keyed by the storming's ID: `purpose`, `scope`,
  `participants` (roles, never names), `use` (`align` | `modeling`), `level` (`BigPicture` | `DesignLevel`), `state`
  (`active` | `done` | `archived`), `marks` (the steps people marked done: `exceptions`, `questions`).
- `modeling`: named journeys, several allowed: `id` (a slug), `name`, `purpose`, `scope`, `constraints`,
  `participants`, `pattern` (`Whole` | `FromStorming` | `OneContext` | `Review`), `from` (`{ stormings }` for
  `FromStorming`, `{ context }` for `OneContext`), `goal` (a step the pattern ends at), `state`, `marks`
  (`{ steps, contexts: { <Context>: [<rows step>] } }`).

Only dt writes it, with a stable key order and two-space indent: a brief confirmed in `/es:start` or `/model:start`, a
goal changed, a journey marked done or archived, a step marked done in the session (a participant's acts are requests
the facilitator approves). An AI agent reads it and never edits it. **When you rename a storming or a context, rename
it in the journey file too** (an ES journey's key, a journey's `from`): `dt check` warns of a journey naming one that
does not exist (J002, J003), and the guide shows that journey as missing. A file that does not read is an error (J001),
and dt writes nothing over it until it is fixed.

<!-- topic: show -->
## Looking up one element

To understand one element of a large model, run `dt show <name>` instead of reading the `.dt` files: it prints the
element resolved, close to the DSL — the fields of field sets inline (`// with Common.Tenanted`), each field's label
with where it comes from (`(from term)`, `(from type)`; none when written inline), multiplicities, `owns` /
`references -> X`, invariants with their expressions (or `(not expressed in the DSL)`), states with their own fields
and invariants, commands with their transitions, `requires … else`, `changes`, the events of each outcome (`when`
resolved), the full error union, a verified type's `of`, `for` and `errors`, a `// file:line` location per declaration
(relative to the root), and who uses it (owns, references, its type or ID, emits, returns, `with`, verified types).

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
  A verified type has `verified`: `{"of", "for": {"type", "optional"}, "errors"}`; a policy has `policy`:
  `{"event", "aggregate", "command"}`. `usedBy` has the lists `takenOnBy`, `ownedBy`, `typeOf`, `referencedBy`,
  `idUsedBy`, `emittedBy`, `returnedBy` (commands, and verified types whose factory returns the error), `verifiedAs`
  (verified types of it), `contextOf` (verified types whose `for` it is), `discriminatorOf` and `reactedToBy` (the
  policies that react to the event), as dotted paths (`Billing.Invoice.order`, `Sales.Order.addItem(item)`). Each
  command has `triggeredBy`: the policies that run it.
- `{"show": "command", "aggregate", "command"}` (with `outcomes` and `triggeredBy`), `{"show": "state", "aggregate", "state", "enteredBy",
  "leftBy"}`, `{"show": "context", "context"}` and `{"show": "overview", "contexts"}` (name, label, doc, shared, terms
  and the elements with their location).
- `"modelErrors": n` when the model has errors; `{"error": "...", "candidates": [...]}` when the name is unknown
  (the suggestions) or ambiguous (the matches).

<!-- topic: fmt -->
## Formatting

`dt fmt` rewrites every file of the workspace (the config's `sources`, like `check`) in the one canonical layout;
`dt fmt <files…>` formats only those files (paths relative to the current directory). Run it after every edit, so that
the same model is always written the same way and a diff shows only what changed. `dt fmt --check` writes nothing,
lists the files that are not formatted and exits 1 if there is one (for CI). A file with syntax errors is reported
like `dt check` does and left untouched (exit 1). The language server formats a document the same way.

Formatting changes only whitespace and three spellings: `[0..1]` becomes `?`, `[1..1]` is removed, and the commas
between enum values or between transitions are dropped. The model never changes, strings (regular expressions
included) are untouched, and every comment stays in its place: on the line of the code before it, or on a line of its
own. The layout:

- 2 spaces of indentation per level. Every member of a block (`context`, `aggregate`, `state`, `value`, `event`, `terms`,
  …) is on its own line; a block without members is `{}`. One blank line between members is kept where the author wrote
  one or more, none after `{` or before `}`. Contexts in one file are separated by one blank line.
- An enum stays on one line (`enum Currency { JPY "日本円" USD "米ドル" }`), unless it has comments or would be longer
  than 120 columns (a Japanese character counts as two); then one value per line.
- An expression body stays inline (`invariant positive { amount > 0 }`), unless it has comments or its line would be
  longer than 120 columns; then the expression goes on a line of its own between `{` and `}`. An expression is never
  broken.
- A command with at most one clause — a transition, `requires`, `changes`, `emits` with one event, or `errors` — and
  no comments stays on one line if it fits in 120 columns: `command start() Draft -> InProgress`. Otherwise each clause
  goes on a line of its own, one level deeper, in the order of the grammar, and a list of several events after `emits`
  takes one line per event, aligned after `emits `:

  ```text
  command cancel(reason: CancelReason)
    Draft | Confirmed -> Cancelled
    emits OrderCancelled,
          RefundRequested when Confirmed ->
  ```

- Parameters, `with`, `changes` and `errors` lists stay on one line. One space after `:` and `,` and around `->`, `|`,
  `=>` and operators; none inside `( )`, `[ ]`, around `.` and `..`, or before `?`. One space before a comment at the
  end of a line.

A `.dtes` file has its own layout, in the same spirit: 2 spaces per level; every element, clause, timeline step and group
event on its own line; an element without clauses on one line (an empty `{}` is dropped unless it holds a comment); one
blank line kept where the author wrote some, one between stormings; no spaces around the dots of a `ref`; a list as
`emits A, B`. The clauses of a body go in one order, each with its comments (ADR 0032): `ref`, `by`, `reads`,
`handledBy`, `emits`, `on`, `issues`, `from`, `status`, `resolution`, `level`; a policy's go `on`, `reads`, `issues`, `by`.

<!-- topic: export -->
## Sharing the sources and the diagrams

`dt export sources` writes the model's sources as one ZIP archive, `<workspace>-sources.zip` in the current directory
(`-o <file>` for another name, `-o -` for stdout), so that someone without git or the repository can open them and run
`dt` on them: unzip it anywhere and run `dt check` in the folder it holds. The Live View offers the same archive in its
menu (「ソース一式をダウンロード」).

- It holds the files `dt check` analyzes (the config's `sources`; only `.dt` and `.dtes` files) and the config file
  (`domaintrail.jsonc` / `.json`), below one folder named after the workspace (the root's directory), their folders
  kept: `shop/domaintrail.jsonc`, `shop/sales/order.dt`.
- Never in it: the local override (`domaintrail.local.jsonc`), `.domaintrail`, `.git`, `node_modules`, generated output,
  symlinks (neither followed nor stored), and, in a git repository, any file git ignores (even with
  `"respectGitignore": false`).
- Exits 1 when the workspace has no `.dt` or `.dtes` file.

**Drawing a diagram as SVG.**

`dt export svg` draws a diagram of the Live View as the SVG its 書き出し → SVG saves, without a browser: for the
figures of a document or a site built in CI. `-o <file>` is required (`-o -` for stdout); an existing file is replaced.

```sh
dt export svg --storming ConvenienceStoreIssuance -o all.svg
dt export svg --storming ConvenienceStoreIssuance --stage Issuance --level design --legend -o issuance.svg
dt export svg --storming ConvenienceStoreIssuance --timeline PinForgottenBranch --theme dark --lang en -o pin.svg
dt export svg --storming ConvenienceStoreIssuance --exceptions hide --heading -o main-flows.svg
dt export svg --storming OrderToCash --level design --resolved-hotspots hide -o open-questions.svg
dt export svg --model --view map --all -o map.svg
dt export svg --model --context Sales Billing --level aggregates -o - > sales.svg
```

- **An Event Storming:** `--storming <ID>`, the whole storming by default, or `--stage <ID>` (its main flows and its
  exceptions) or `--timeline <ID>`; `--level big-picture` (default) or `design`; `--exceptions hide` leaves the
  exceptions out of the whole storming or a stage (「例外を表示」 off); `--resolved-hotspots hide` leaves the resolved
  hotspots out of any view (「解決済みを表示」 off: their notes and lines are not drawn, their stickies keep a ✓, nothing moves).
- **The domain model:** `--model`, the Structure View by default (`--level detail`, `overview` or `aggregates`;
  `--context <names…>` focuses it on some bounded contexts, their dependencies as stubs) or `--view map`, the Context
  Map (`--all` with the shared and external contexts).
- **As the Live View's export asks:** `--heading` (the line above the diagram: workspace › world › view · conditions)
  and `--legend` (under it). Besides: `--theme light` (default, on white as the Live View exports) or `dark` (on the
  dark canvas), `--lang ja` (default) or `en` for the badges, the heading and the legend, and `--names label`
  (default), `name` or `both` as the Live View's name display.
- **The same bytes every time:** every view is laid out from scratch (never from the Live View's saved layouts), with
  nothing marked as changed and no time or random ID in the file; the diagnostics' marks are drawn as on the screen.
- **Colours and text:** the colours are the Live View's stylesheet's, and the text is laid out with a table of its
  fonts' widths (Hiragino Sans and SF Mono as Chrome on macOS measures them), so labels wrap and fit their notes as the
  Live View lays them out there. The SVG names the Live View's font stacks and embeds no font: another machine draws
  it in its own (Noto Sans CJK on Linux), a little wider or narrower.
- An unknown storming, stage, timeline or context is named with the choices (exit 1); options that do not go together
  (`--stage` with `--timeline`, `--storming` with `--model`, …) exit 2.

<!-- topic: output -->
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
`written` (the output directories). A failure other than the diagnostics (missing root, invalid config, no `.dt` or `.dtes` file,
generation refused) is an `error` message in the document, e.g. `{ "error": "Root directory not found: domain" }`;
`diagnostics` and `summary` are there whenever the check ran.

| Exit code | Meaning |
|---|---|
| 0 | success (`check`: no errors; warnings are allowed) |
| 1 | the model or a storming has errors, no `.dt` or `.dtes` file was found, generation was refused, `show` did not find the name (or it is ambiguous), `guide` got an unknown topic, `export svg` has no such diagram, or the root / a file could not be read |
| 2 | invalid configuration (`domaintrail.jsonc` / `--config`, including a context name in `generate.ts.contexts` or a type in `generate.ts.tests.types` that the model does not have), an unknown `generate` target, or `export svg` options that do not go together |

<!-- topic: config -->
## Configuration

`domaintrail.jsonc` (comments and trailing commas allowed) or `domaintrail.json` is looked up in `--root` (`-r`,
default `.`) and its parents, like `tsconfig.json`; `--config <file>` (`-c`) picks one explicitly. All paths in it are
relative to the config file, and its directory becomes the root. Without a config file, the defaults apply with
`--root` as the root. Every key is optional.

**Your own settings: `domaintrail.local.jsonc`.** A local override beside the config file — `domaintrail.local.jsonc`
(or `domaintrail.local.json`), and `<name>.local.<ext>` beside a `-c <name>.<ext>` — holds the settings that are yours
only (a port, a model, the paths the AI reads outside the workspace) and is never committed. It is read after the
config file and merged into it: objects key by key, arrays and scalars replaced (`"sources": [...]` in it replaces the
whole list); any setting may be overridden. It is checked against the same schema: the project's file on its own
first (its errors name it), then the merge (its errors name the local file). Its relative paths are relative to its
own directory, the config file's. Without a project config file, a local file alone is the configuration. Every
command loads both (`check`, `generate`, `fmt`, `show`, `lsp`, `open`, `collab`, `agent`); `dt open`, `dt collab` and
`dt agent` print them (`Config: domaintrail.jsonc + domaintrail.local.jsonc`) and warn when git tracks the local file or
does not ignore it, with the line to add to `.gitignore` (the file is never edited for you). A file is taken only under
its exact name (`DomainTrail.Local.JSONC` is not it, even where the file system ignores case). The paths the AI reads
outside the workspace (`agent.read.paths`, see `dt guide session-agent`) are honoured **only from a local file git
ignores** (or outside any repository): in the project's file, or in a local file git tracks or does not ignore, they
are a config error.

**Approving the security-relevant settings.** `dt open`, `dt collab` and `dt agent` start only with security-relevant
settings you approved for the workspace: what the AI reads outside the workspace (`agent.read.paths` and the roles'),
`agent.run.allowedTools`, `agent.run.dt`, `collab.identity`, `collab.host`, `collab.access`, `open.host`,
`classifier` (but its `threshold`) and, with the `cloudflare` knowledge store, `knowledge.url` and `knowledge.project`
(where the knowledge and the store's service token go), as they are after the local file is merged. When they differ from the defaults and
from what you approved last for this workspace (by its real path), they are printed and asked about (`Start with
these settings? [y/N]`); without a terminal, `--yes` approves them, else the command refuses to start. Approvals are
kept outside the workspace, in `$XDG_CONFIG_HOME/domaintrail/trust.json` (by default `~/.config/domaintrail/trust.json`,
on macOS too; private to you). So a commit, or anything that writes in the workspace, cannot widen what the AI may do
without your seeing it.

```jsonc
{
  "$schema": "./node_modules/domaintrail/schema/domaintrail.schema.json",
  // globs of DSL files; "!" excludes (node_modules, .git, .domaintrail are never scanned)
  "sources": ["domain/**/*.dt", "domain/**/*.dtes", "!domain/drafts/**"], // default: ["**/*.dt", "**/*.dtes"]
  // skip what .gitignore ignores when finding sources
  "respectGitignore": true,                                 // default: true
  // print a hint on generate when no lint rule against casts to domain types is found (dt guide lint)
  "lintHint": true,                                         // default: true
  "generate": {
    "ts": {
      "out": "src/domain/generated",                        // default: "generated/domain"
      // policies: "optional" (a handler type each) or "required" (also <Context>PolicyHandlers, which the contract tests take)
      "policies": "optional",                               // default: "optional"
      // per context: a directory of its own instead of "out" (with "module": the name its package exports it by),
      // and/or its own "policies" (all optional; see dt guide output-dirs)
      "contexts": { "Common": { "out": "packages/shared/src/generated" }, "Billing": { "policies": "required" } },
      // contract tests, written only with this key (optional); they import domaintrail/testing and need fast-check
      "tests": {
        "out": "src/domain/generated/tests", // default: <out>/tests
        "runner": "vitest",                 // bun, vitest, jest, node
        // how deep drawn values of recursive types go, overall and per type (a cycle uses its greatest)
        "maxRecursionDepth": 4,             // default: 4
        "types": { "Sales.Category": { "maxRecursionDepth": 3 } }
      }
    }
  },
  "open": { "port": 4321, "host": "127.0.0.1" },            // dt open; defaults shown
  // the chat's message templates, listed after / with the built-in ones (dt open and dt collab); text and name: one
  // string, or { "ja", "en" }; {target} is where the selected element goes; "when" (optional): big-picture,
  // design-level, storming, model, element, aggregate, event, state, none
  "templates": [
    { "id": "glossary", "name": { "ja": "用語を確かめる", "en": "Check the terms" }, "text": "用語集と食い違うところを挙げて", "when": ["model"] }
  ],
  // the knowledge taken from the sessions (ADR 0031): see below
  "knowledge": { "store": "files" },                        // default: files, the project named after the directory
  // collab, agent and classifier: see dt guide session-config
}
```

**Knowledge: `knowledge`.** Where the knowledge taken from the sessions is kept, which project it belongs to, and when it
is extracted from the talk ([Knowledge from the sessions](#knowledge-from-the-sessions)). Every key is optional; with `cloudflare`, `project` and `url` are required.

```jsonc
{
  "knowledge": {
    // files: one Markdown file per item in the workspace's knowledge/ (versions left to git; anything in it stays in
    // git's history). cloudflare: the Worker you deploy from DomainTrail's template, behind Cloudflare Access (an item
    // and its personal data can be deleted for good)
    "store": "cloudflare",                                  // default: "files"
    // the project this workspace reads and writes: lowercase letters, digits and "-", 63 characters at most. Required
    // with cloudflare, so that every clone and worktree names the same one; with files, by default the workspace's
    // directory name made into one ("My Shop" → "my-shop"), which changes nothing: the files are the workspace's own
    "project": "shop",
    // the Worker's base URL: https (http only on localhost, for wrangler dev); required with cloudflare, unused with files
    "url": "https://knowledge.example.com",
    "extraction": {
      "enabled": false,          // off unless enabled; the facilitator switches it for the session in the Live View
      "quietSeconds": 30,        // an extraction after this many seconds without a message after a person's (and after each answer of the AI, and at the end)
      "minIntervalSeconds": 60,  // at most one extraction per this many seconds
      "contextMinutes": 10,      // the talk before the new messages given as context, in minutes
      "gateContextMinutes": 3,   // the same for the light model that decides first whether to extract
      "settleSeconds": 120       // a held update or conflict applies after this many seconds of quiet on its topic (dropped if still held at the end)
    }
  }
}
```

What each store keeps, how the extraction decides and what deleting does: `dt guide knowledge`.

The `cloudflare` store's Access service token is never in the file: dt reads it from the environment variables
`DOMAINTRAIL_KNOWLEDGE_CLIENT_ID` and `DOMAINTRAIL_KNOWLEDGE_CLIENT_SECRET` (sent as `CF-Access-Client-Id` and
`CF-Access-Client-Secret`). Give the session's dt the token that writes and `dt mcp` the one that reads. Since the token
goes to `knowledge.url`, the Worker's URL and the project are security-relevant settings you approve (above). A
`"store": "files"` in your local file tries things out without the Worker, the project's `url` left unused.

CLI options win over the file: `generate ts --out`, `open --port`, `open --host` (and `collab --port`, `collab --host`). `--out` replaces `generate.ts.out`
only; contexts listed in `generate.ts.contexts` keep their own directories. Sources and output directories, `--out`
included, must stay inside the config file's directory (the root without a config file): an absolute path or one with
`..` is a config error, and an output directory reached through a symlink stops generation. A name in
`generate.ts.contexts` that is not a context of the model is a config error, reported by `generate ts` once the model
has been checked; so is a name in `generate.ts.tests.types` that is not a type of the model, and one that is not a
recursive type is warned about. Without `generate.ts.tests.out`, the tests follow `--out` (`<out>/tests`); the tests of
a context with a `module` go into `<its out>/tests`. The policies of a context
are `generate.ts.contexts.<Context>.policies` if given, else `generate.ts.policies`, else `optional` (see
[Reactions to events](#reactions-to-events-policies)).

**Sources and `.gitignore`.** The sources are the files below the root that match `sources`, outside `node_modules`,
`.git` and `.domaintrail`, and not ignored by git: every command that finds them (`check`, `generate`, `open`, `collab`, `fmt`,
`show`, `lsp`) skips the files and directories that the `.gitignore` files ignore, with git's rules (`!` negation,
`dir/` for directories only, a leading or inner `/` anchoring to the file's directory, a deeper file winning). The
`.gitignore` files that count are those of the root and its subdirectories, those of the directories above the root up
to the top of the enclosing git repository, and the repository's `.git/info/exclude`; without a repository, only those
from the root down (a `.gitignore` counts whether or not the directory is a repository). A root that the rules above it
ignore (a copy of a project in an ignored directory, checked with `-r`) is still checked, with the `.gitignore` files
from the root down only. So a generated or cloned copy of the model in an ignored directory (an editor's grammar
checkout, a build output) is not checked twice. `"respectGitignore": false` turns this off; files named on the command
line (`dt fmt <files>`) are never skipped.

**Where dt keeps its files.** Nothing of dt's is written into the workspace but the generated sources: what dt keeps of
a workspace is outside it, per user, in one directory per workspace named after it and a short hash of its real path
(`shop-3f9a1c2b`), with a `workspace.json` that records that path:

| What | Where (Linux and macOS) | Windows |
|---|---|---|
| State: the session (`session.db` and its WAL files, `blobs/`), the running server's address (`server.json`), the record of `dt generate ts` (`generated.json`) | `$XDG_STATE_HOME/domaintrail/<workspace>/`, by default `~/.local/state/domaintrail/<workspace>/` | `%LOCALAPPDATA%\domaintrail\state\<workspace>\` |
| Cache, made again when missing: the layouts (`layout.json`) | `$XDG_CACHE_HOME/domaintrail/<workspace>/`, by default `~/.cache/domaintrail/<workspace>/` | `%LOCALAPPDATA%\domaintrail\cache\<workspace>\` |

`DOMAINTRAIL_STATE_DIR` (an absolute path, or one relative to the working directory) replaces the state's root, for CI
and containers: the workspaces' directories go below it. A state or cache directory inside the workspace (or a workspace
inside one) is refused: the AI reads the workspace, and never the sessions (`agent.read.paths` refuses them too).
Directories are 0700 and files 0600, private to you, and dt never writes through a symbolic link there. Two workspaces
whose names and hashes are the same are told apart by `workspace.json`: the second is refused, and says so. A moved
workspace starts a new session (its directory has another hash); the first run says where the old one is.

Nothing there is removed by itself. `dt session prune` lists the directories of workspaces that no longer exist (deleted,
or moved), and with `--older-than <days>` also those not used for that long; `--yes` removes them. The state of a
running server is kept.

Older versions kept all of this in `.domaintrail/` in the workspace. The first command that uses the state (`dt open`,
`dt collab`, `dt agent`, the links, `dt generate ts`) moves it — the session database with its WAL files, the blobs,
the layouts — prints `Moved .domaintrail/ to ~/.local/state/domaintrail/<workspace>/` once, and deletes the emptied
`.domaintrail/`. It refuses while a server of the older version still runs there (stop it first), keeps `.domaintrail/`
as it is when the new directory already holds a session, and keeps the files in it that are not dt's. The move copies,
checks and then renames the files into place: a move cut short leaves the old directory whole, and the next run
finishes it.

A `.domaintrail/` can also come with a cloned repository, so the move takes only what it can trust:

- Nothing moves when git tracks or does not ignore anything in `.domaintrail/` (in any case of its name; dt's own
  always ignored itself), or when git cannot tell: it is left as it is, the workspace starts a new session, and the
  line says how to remove it (`git rm -r --cached .domaintrail` when it is tracked). Outside a git repository there is
  nothing to ask. A directory named in another case (`.DomainTrail`) is not dt's and is never moved.
- Only regular files of yours, in directories of yours that nobody else can write, move; the others stay, named in one
  line. The session database moves with its WAL files or not at all.
- The moved database keeps the session — messages, runs, revisions, participants — but none of its credentials: the
  sign-ins, the facilitator links, the sign-in and pairing codes, the invites and who holds the facilitator role are
  deleted, so everyone signs in again (`dt open` prints a new link; `dt collab` a new facilitator link). Only a
  database dt made moves: its schema must be exactly the one a known version of dt made (every table, column and index;
  no trigger or view, nothing more); any other is not moved.
- The record of `dt generate ts` (`generated.json`) is not moved: it says which files a run deletes. The next
  `dt generate ts` writes its output as usual and records it; generated files of earlier runs outside the output
  directories it writes (a moved output directory, a removed context) are not deleted then: delete them by hand.
- Its `.gitignore` files, a stopped server's `server.json` and an old `agent.json` are not kept either.

<!-- topic: lsp -->
## Language server

`dt lsp` is a language server (LSP) for `.dt` and `.dtes` files, speaking over stdin/stdout. Editors and AI agents start it; it
runs until the client shuts it down. It offers:

- **Diagnostics equal to `dt check`**: the same rules, severities, codes (the rule ID, e.g. `M009`) and messages,
  computed over the whole workspace (the config's `sources`) with the unsaved text of open files, after every change.
  A hint follows the message on a second line (`hint: did you mean 'Confirmed'?`) and is also in the diagnostic's
  `data.hint`.
- **Go to definition** and **find references** for types, states, events, errors, field sets and the commands of
  policies, across files and contexts (`Sales.Order` included).
- **Hover**: kind, name, Japanese name, `///` description, the expression of an invariant or requirement, the
  `emits` entries of a command and the policies that run it, the reaction of a policy, and the policies that react to
  an event.
- **Outline** (document symbols), **completion** of names, and **rename** of context elements, states and commands
  (a command is referenced by policies), which updates every reference (a qualified `Sales.Order` keeps its context).
  Contexts, fields and parameters are not renamed, since their names also appear outside references (in qualified
  names, expressions and terms).
- **In `.dtes` files**: the diagnostics (S rules, the `ref`s checked against the model), formatting as `dt fmt`, hover
  (kind, ID, label, `///` description, storming and `ref`), the outline of each storming, and go to definition of a
  local reference (a relation's target, a timeline step) and of each part of a `ref` (`Sales`, `Sales.Order`, its
  command), into the `.dt` files.

The workspace is the config found from `--root` or `--config` when given, else from the client's (first) workspace
folder, else from the current directory, exactly as `dt check` would find it there (with the same sources, `.gitignore`
included). When that search finds no config file, the first `.dt` or `.dtes` file opened below that directory whose directory or
a parent (up to it) has a `domaintrail.jsonc` / `domaintrail.json` makes that config the workspace: its directory is
the root, its `sources` are loaded, and the files no longer in the workspace lose their diagnostics. So opening a
repository with the model in `examples/shop/` checks that model as `dt -r examples/shop check` does. A session has one
workspace: a file opened later under another config file gets no diagnostics, and a warning says so once (open that
directory as its own project to check it). An open file outside the workspace's sources gets no diagnostics either.

A client needs only: command `dt lsp` (with `dt` on the `PATH`, or e.g. `npx dt lsp`), transport stdio, file
extensions `.dt` and `.dtes`. For Claude Code, a plugin declares it in an `.lsp.json` at the plugin root (load it with
`claude --plugin-dir <plugin directory>`); Claude then sees the diagnostics after each edit of a `.dt` or `.dtes` file:

```json
{
  "domaintrail": {
    "command": "dt",
    "args": ["lsp"],
    "extensionToLanguage": { ".dt": "domaintrail", ".dtes": "dtes" }
  }
}
```

<!-- topic: knowledge -->
## Knowledge from the sessions

A storming says what happens; the talk around it says why, how often, who said so, and what the AI found when asked.
**Knowledge** keeps that, item by item, apart from the `.dtes` and `.dt` files and tied to their stickies (ADR 0031).
The test for a piece of text: if it were deleted, would the drawing change? Then it belongs in the storming. If the
drawing stays the same but reading or changing it correctly needs the text, it is knowledge.

| | Storming (`.dtes`) | Knowledge |
|---|---|---|
| Holds | what happens, who does what, what reacts | why, how concretely, who said it, what was found |
| Size | one short label per sticky | long, with numbers, exceptions, images |
| Truth | the current agreement only (history in git) | dated: what was said stays said, even when later overturned |
| Checked | references, types, the link to the `.dt` | only that the stickies it is about exist (K002) |
| Written by | the AI tidies, people correct | taken from what people say and the AI answers; people delete what is wrong |

**An item** holds one finding: its **title** (one short line of plain text, at most 40 characters, which a closed item
shows alone), its text (Markdown, without headings — the title is its heading, and a `#` line shows as an ordinary
paragraph; images as `![…](image:img_…)`), the stickies it is `about`
(`<Storming>.<LocalId>`, so that a label can be renamed in place), its **sources** (the session, the message, its time
and a short quote, which lets a reader check the wording without the session database), a version, and the items it
**conflicts with**. Four labels, fixed for now:

| Label | Values |
|---|---|
| `when` | `as_is` AS-IS, `to_be` TO-BE, or none |
| `kind` | `rule` ルール, `flow` 流れ, `example` 例, `term` 言葉, `pain` 困りごと, `want` 要望, `decision` 決定 |
| `origin` | `said` 発言 (one person, not confirmed), `agreed` 合意 (several present agreed), `investigated` 調査 (the AI checked code or documents), `inferred` 推測 (the AI's hypothesis, said by nobody) |
| `perspective` | a role (案件担当, 営業 …), never a person's name; optional |

An item records what was said or found at a time; nothing marks it confirmed: `origin` tells how far to trust it. A
`term` is about the words of the business; the `.dt` `terms` keep defining the model's.

**Taken from the talk.** In a session (`dt open`, `dt collab`), the AI's **extractor** turns the talk into items: after
30 seconds without a message following a person's message (`quietSeconds`), right after each answer of the AI, and when
the session ends; at most once a minute (`minIntervalSeconds`). It is **off unless enabled**:
`knowledge.extraction.enabled` gives the default, and the facilitator switches it for the session with the 💡 in the
Live View's app bar (the others see a 💡 while it is on). Each extraction goes through three stages, so that the
stronger model runs only when there is something to extract:

1. messages that are surely nothing (empty, emoji only, a fixed acknowledgement) stop it, without any model;
2. a light model (`agent.extract.gateModel`, Haiku unless configured), given the new messages, the talk of the last
   `gateContextMinutes` and the stickies' names, says whether they hold a finding; it stops the extraction only when
   sure;
3. the extractor (`agent.extract.model`; no tools, a fresh Claude Code process each time) reads the new messages, the
   talk of the last `contextMinutes`, the workspace's stickies (below), the items made in this session, those about the
   stickies the talk points at and those about the stickies the new messages name by their label, and replies with
   operations: **add** an item, **addSource** (the same finding again; `said` may become `agreed`), **update** (more
   precise; with the messages it rests on as new sources) or **conflict** (both kept, linked). Each add, update and
   conflict carries the title: short and concrete (「月末締めの案件は翌月の作業になる」, not 「締めについて」), in the
   talk's language, never a person's name; an update rewrites it when the finding changed.

Both models see the same stickies: those of the storming the facilitator's page has open (else one any page has open)
and of the session's current journey; when neither is known, every storming's; at most 300. The extractor links each
finding to the stickies it is about by meaning, preferring those pointed at with `#`, so that items get their sticky
even when nobody points at one.

Each extraction's stages and what each model cost are recorded in the session database. Switched on again after being
off, the extraction picks up the last `contextMinutes` of talk, not everything said while it was off. So that a remark
in mid-talk does not become a conclusion:

- add and addSource apply at once (a wrong item costs a deletion); update and conflict are **held**, unseen, and apply
  only when the next extraction makes the same call or the topic stays quiet for `settleSeconds`; those still held when
  the session ends are dropped;
- an update carries the messages it rests on as new sources (one without is dropped) and then makes a new version,
  so that a correction can be followed to its message; only a rewording that adds no source rewrites an item made in
  this session in place; versions are kept for items of earlier sessions (and for a person's correction);
- a correction within the same stretch of talk is an update, not a conflict; questions and "maybe" are not extracted,
  or get `inferred`; `agreed` only when the talk moved on without objection;
- an extraction is sent as operations: one on an item a person corrected or deleted meanwhile is dropped, and the
  person's change stands.

Nobody approves item by item: everything extracted is kept, and what is wrong or unwanted is deleted afterwards.

**Where it is kept: the store** (`knowledge.store`, see [Configuration](#configuration)):

| | `files` (the default) | `cloudflare` |
|---|---|---|
| Where | the workspace's `knowledge/`, committed with the model | a Worker you deploy from DomainTrail's template: D1 and R2, behind Cloudflare Access |
| Versions and audit | git's history; `knowledge/audit.jsonl` | the store's own (`?history=1`, `GET /audit`) |
| Deleting | gone from the working tree, **not from git's history** | gone for good after the sweep (D1's Time Travel keeps 30 days) |
| Read outside a session | the files, `dt mcp` | `dt mcp`, the Worker's page (`dt publish`) |
| For | trying it out; projects where no personal data is spoken | projects where personal data may appear, and readers without the repository |

What must be protected is **personal data, which must be deletable on request**; keeping knowledge on GitHub, showing
it to developers and sending it to Anthropic's API are accepted. git cannot forget what was committed, so a project
where a name, a phone number or a customer's details may be spoken uses `cloudflare`.

With `files`, each item is `knowledge/<id>.md` (`kn_…`): a YAML front matter (its `title`, labels, `about`, conflicts,
session, times and sources with their quotes) and the text, written by dt in a fixed order so that a diff shows what changed; its
images are in `knowledge/images/`. `knowledge/audit.jsonl` (who changed what) and `knowledge/redactions.jsonl` (the
redaction log, IDs only) are appended, and merge with `union` (`knowledge/.gitattributes`). Commit them with the
model. A person may edit an item's file by hand; `dt check` reports one that does not read (K001) — among them one
without a `title`, as written before items had one —, which the store skips and never writes over, and an `about` that
names no sticky of the workspace (K002).

With `cloudflare`, every clone and worktree that names the same `knowledge.project` and `knowledge.url` reads and
writes the same knowledge. The Worker's migration 2 adds the title and removes the items written before it (the
feature is still in development). Deploying and upgrading the Worker, its Access application and service tokens:
`node_modules/domaintrail/dist/knowledge-worker/README.md`.

**Reading it.** In a session, the Live View marks the stickies that have knowledge, lists a sticky's items and every
item in the ナレッジ tab, each closed to its title and labels; an opened item's labels are the tab's filter chips, and
pressing one shows the tab filtered by that label ([the Live View](live-view.md#knowledge)). The session's AI reads it too: its answers and
runs get `dt mcp`'s tools when the store is usable when `dt agent` starts (`files`: `knowledge/` exists; `cloudflare`:
approved, with the token), and cite the items they rest on. Outside one, Claude Code reads it through `dt mcp`
(below), and with `cloudflare` the business reads it on the Worker's page (`dt publish`, below).

**Conflicts.** Two items that contradict each other are linked and shown side by side, with ホットスポットにする (a
message that asks the AI to add a hotspot) and 食い違いではない (the link removed from both). A conflict whose other side
was deleted no longer shows.

**Correcting and deleting.** Anyone who can open the project may correct (直す: title, text and labels, a new version) and
delete (消す), in the Live View and on the Worker's page. Deleting hides the item from everyone at once, with 元に戻す
for 10 seconds; then the store's **sweep** (the `files` store's: run by dt on its next write and every few minutes;
the Worker's: a Cron Trigger every 5 minutes) removes every version and image of it, and appends the IDs of its source
messages to the project's **redaction log**. Every dt of the project reads the log when it starts and every 3 minutes
during a session, and redacts those messages (and the copies of their text) in its own session database, so that the
sessions on other machines forget them too. With `files`, the item stays in the commits that had it: rewrite the
history (and every clone) to forget it.

<!-- topic: mcp -->
### MCP server (knowledge for Claude Code)

`dt mcp` is a Model Context Protocol server over stdin/stdout that gives Claude Code (or any MCP client) the project's
knowledge — what was said and found in its sessions (ADR 0031) — read-only, from the store the config's `knowledge`
names (`files`: the workspace's `knowledge/`; `cloudflare`: the Worker, with the service token that reads in
`DOMAINTRAIL_KNOWLEDGE_CLIENT_ID` and `DOMAINTRAIL_KNOWLEDGE_CLIENT_SECRET`). Its tools:

- `knowledge_for_element({ element })` — the items about an element, newest first, each with its ID, title, labels,
  date and text (cut when long).
  `element` is a sticky, `<Storming>.<LocalId>` (`Ordering.CreateSpecification`), or a `.dt` element prefixed with
  `dt:` (`dt:Sales.Order.confirm`, `dt:Sales.Order`, `dt:Sales.OrderPlaced`), resolved through the stickies whose `ref`
  is that element or one inside it. The tool to call before implementing an element.
- `knowledge_search({ query, about, when, kind, origin, perspective, limit })` — every given filter holds: `query` full
  text (titles, texts and quotes), `about` stickies or `dt:` elements, `when` / `kind` / `origin` one value or a list, `perspective` a role,
  `limit` at most 50 (default 20).
- `knowledge_get({ id, history })` — one item whole: its title and text, labels, stickies, conflicts and sources with their
  quotes; with `history`, its earlier versions (the `files` store keeps none: `git log -p knowledge/<id>.md`).

The stormings are read again on every call. A wrong input, an unknown item or a store that cannot be reached is an
error of the tool, with its reason. With `cloudflare`, the service token goes to `knowledge.url`, so `dt mcp` opens the
store only when the workspace's security-relevant settings are approved as they are now (it cannot ask: its stdin is
the protocol's); approve them by starting `dt open`, `dt collab` or `dt agent` in a terminal once, and again after a
change of `knowledge.url` or `knowledge.project`. Register it in Claude Code from the workspace (with `dt` on the `PATH`, or
`npx dt mcp`):

```sh
claude mcp add domaintrail -- dt mcp
```

or, for everyone working in the repository, in `.mcp.json` at its root (add `"-r", "domain"` before `"mcp"` when the
config is in `domain/`):

```json
{
  "mcpServers": {
    "domaintrail": { "command": "dt", "args": ["mcp"] }
  }
}
```

<!-- topic: publish -->
### Publishing the stormings (the knowledge page)

With `knowledge.store: "cloudflare"`, the store's Worker also serves a read-only page behind the same Access: people
from the business read the knowledge there at any time, on the canvas of a storming (ADR 0031, section 11). The
Worker cannot read the repository, so `dt publish` sends it each storming's **published form**: the stickies with
their labels, links and places, as the Live View lays out the whole storming at its Big Picture and its Design Level,
with the commit and date of the drawing — no chat and no person. Run it in CI when `main` changes, so that readers
see the drawing that was agreed and merged. The same drawing published again changes nothing.

```sh
dt publish                          # every storming
dt publish --storming OrderToCash   # some of them
dt publish --prune                  # then remove the stormings the workspace no longer has
dt publish --out published/         # the forms as <ID>.json files, sent nowhere (any store)
```

A storming removed or renamed in the workspace stays on the page until `dt publish --prune` removes it (`DELETE
/published/<storming>`, a writing token only); the knowledge about its stickies stays, listed apart. `--prune` sends
nothing while a `.dtes` file has an error, so that a storming that does not parse is never taken for removed.

It sends the **writing** service token (`DOMAINTRAIL_KNOWLEDGE_CLIENT_ID` and `DOMAINTRAIL_KNOWLEDGE_CLIENT_SECRET`)
to `knowledge.url`, so, like `dt open`, it publishes only with the workspace's settings approved: approved before, or
asked in a terminal. In CI nobody can be asked: pin the destination outside the repository with
`DOMAINTRAIL_PUBLISH_URL` and `DOMAINTRAIL_PUBLISH_PROJECT` (CI variables, not files of the repository), and
`dt publish` goes ahead only when the config names exactly that Worker and project; a commit that points
`knowledge.url` elsewhere makes it refuse instead of sending the token there. Fetch the whole history
(`fetch-depth: 0`), so that each drawing is dated by the last commit that changed its file. The Worker's README has a
GitHub Actions example.

The page shows the storming with a dot on each sticky that has knowledge (a mark for a conflict), a sticky's items
when it is selected, the ナレッジ list with its search and filters, the items about stickies no published storming
has (removed or renamed) apart, and the date of the drawing. Anyone who can open it may correct and delete, with
元に戻す for 10 seconds.

<!-- topic: editors -->
## Editors

**Zed.** The extension in `editors/zed` of the repository highlights `.dt` files with the tree-sitter grammar in
`tree-sitter-domaintrail`, gives brackets, indentation and an outline (contexts, their declarations, the states and
commands of aggregates), and starts `dt lsp` (diagnostics, navigation, hover, rename, formatting; see [Language
server](#language-server)). Install it with *zed: install dev extension* and the `editors/zed` directory of a clone
(it needs Rust, installed with rustup). The language server is the first of: `lsp.domaintrail.binary` in Zed's
settings, `dt` on the `PATH`, else domaintrail at the version the extension pins, installed into the extension's own
directory and run with Zed's Node. By default the extension runs no file of the project (such as its
`node_modules/.bin/dt`); to use the project's own `dt`, name it in the settings. Zed merges a project's
`.zed/settings.json` into these settings, so a project can name a command too, as for Zed's built-in language servers:
open untrusted repositories in Zed's restricted mode.

```json
{ "lsp": { "domaintrail": { "binary": { "path": "/path/to/dt", "arguments": ["lsp"] } } } }
```

Open the directory with the `domaintrail.jsonc` as the project, or a directory above it: then the first `.dt` file
opened picks the nearest config (see [Language server](#language-server)), provided no config is found from the
project directory itself. Directories that `.gitignore` ignores, such as the grammar checkout Zed keeps in
`editors/zed/grammars` when the extension is installed from a clone, are not part of the workspace.

**Other editors.** Any LSP client works with command `dt lsp`, transport stdio, file extensions `.dt` and `.dtes`
(see [Language server](#language-server)). Editors that highlight with tree-sitter (Neovim, Helix, Emacs) can use the
grammar in `tree-sitter-domaintrail`.

**`.dtes` files** have no tree-sitter grammar and are not highlighted, in Zed either; `dt lsp` gives them diagnostics,
formatting, hover, an outline and go to definition.

<!-- topic: session -->
## Collaboration sessions

A **session** is the Live View with a chat to the AI, in one of two modes. **`dt open`** is for one person: on
loopback, signed in as the facilitator by the one-time link it prints (no form), every message goes to the AI. **`dt collab`** is the
Live View shared by several people while an AI agent edits the model: the facilitator runs it on their machine, the
participants open the page in their browsers, see each other, and post **messages** in a chat, about elements of the
`.dt` model or the `.dtes` stormings; the facilitator applies messages as **runs** (requests to the agent). In both,
the agent (Claude Code) runs in the same process when `claude` is usable, on the facilitator's workspace, one run at a
time (`dt agent` runs it alone, in another terminal or on another machine). The edits reach every page through the
Live View, and every run leaves a **revision** of all the `.dt` and `.dtes` sources that can be compared or restored.
Sessions need Node.js 22.13 or later (for `node:sqlite`). In the repository,
`docs/session-first-run.md` walks through a first run with Claude Code, and ADR 0026 has the decisions behind them.

**The commands.** All four find the workspace like `dt check` (`-r`, `-c`):

- `dt open` — the Live View and a chat for you alone, at `http://127.0.0.1:4321` (`--port`, `--host`, or `open.port` /
  `open.host`; `--base <ref>` compares with a git revision), until Ctrl+C. It prints a one-time link instead of the
  plain address: opened within 60 minutes, it signs that browser in as you, the facilitator (an HttpOnly session
  cookie this server alone knows: a restart prints a new link), with no join form; a browser or another program without that cookie is not let in, and no one else
  joins. It answers loopback only (never `collab.access`'s hosts). The chat, runs and revisions are kept across restarts. It refuses a
  workspace with an open collab session (resume it with `dt collab`, or end it from its collab menu). With `--host` on
  a non-loopback address it serves the Live View read-only: no chat, no agent.
- `dt open link` — another one-time sign-in link, for the `dt open` server running on the workspace (each link works
  once, for 60 minutes; all are revoked when the server stops), e.g. for another browser or after the first link
  expired, without restarting the server. It refuses a running `dt collab` server (use `dt collab link`).
- `dt collab` — the session server for several people, at `http://127.0.0.1:4321` (`--port`, `--host`, or
  `collab.port` / `collab.host`; `--base <ref>`), until Ctrl+C or until the facilitator closes the session. A
  workspace has one open session: starting again resumes it, with its sign-ins, requests, runs and revisions, and a
  `dt open` session is continued as a collab one (its history kept; open the facilitator link to hold the role). It
  prints the page's URL, a one-time **facilitator link** and the agent API's address.
- `dt collab link` — another facilitator link, for the collab server running on the workspace (each link works once,
  for 10 minutes).
- `dt agent --code <code>` — the agent alone: it pairs with the running server (`dt open` or `dt collab`) with the
  one-time code `dt collab agent-link` (or `dt open agent-link`) prints, keeps the agent API's credential in memory, and
  takes on its two roles (below) — the **runner**, which runs the queued runs one after another, and the
  **answerer**, which triages and answers the messages addressed to the AI — until Ctrl+C or the session closes;
  `--once` handles one run and exits. `--role run` or `--role answer` takes on one of them; both by default.

`dt open` and `dt collab` start the agent, with both roles, in their own process (as `dt agent` would, over loopback) when Claude Code is
usable (`claude` on the `PATH`, answering `--version`, with the flags the agent needs); otherwise they start without
it and print one line saying why (`AI: not started (…)`). `--no-agent` does not start it; `--agent claude` makes an
unusable Claude Code an error. `dt view`, `dt session start`, `dt session link` and `dt session subscribe` were
removed: each fails with the name of its replacement.

**Roles.** Everyone signed in is a **participant**: they see the Live View and the session's chat, a pillar at the
right end of the page — チャット: every message posted, one card per run, and the composer; AI の作業: everything sent to the AI,
awaiting an answer, running, queued and finished — and post messages. Closed, the chat leaves a 💬 button at the bottom right of the canvas that shows whether the
agent is running or waiting for an answer and how many messages and cards are new. The **facilitator** is whoever
opened the facilitator link while signed in (never derived from Cloudflare Access); a new link moves the role (the
collab menu's ファシリテーターを引き継ぐ issues one, as `dt collab link` does), and the previous holder's pages reconnect as a participant. Only the
facilitator applies messages, answers the agent, stops and reverts runs, records and restores revisions, changes the
shared 比較対象 (baseline) and closes the session (the collab menu's コラボを終える). The server checks every role; the page
only hides what is not yours.

**The collab menu.** The page calls a session a *collab* (コラボ). The chat's head has one button — the avatars and how
many are online ▾ — that opens the participants (where each is, and → to open the view another is on) and
the collab's actions: 招待リンクをコピー for everyone (the address of the page: the Live View's URL, the public URL
behind Access in `access` mode), and 退出 for a participant (it signs out). The facilitator has いまの状態を記録,
以前の状態に復元 (below), ファシリテーターを引き継ぐ and コラボを終える instead of 退出: they hand the role over first to leave. Ending asks first and
lists what is not finished — runs queued or running and questions waiting for an answer — then 終える. Every page then shows コラボを終えました: the changes (the runs that changed
files, with how many files and who asked), the participants and how long it lasted, computed from what the page held
when it ended; the session's record stays in the workspace's state directory (outside the workspace).

**Messages and sending to the AI.** Everything posted in the chat is a **message**, shown in the stream as it is
sent. A message is **addressed to the AI** when it mentions `@AI` or replies to the AI (one of its answers, or a run);
other messages are talk between people, and no model sees them ([ADR 0030](adr/0030-modes-triage-and-the-warm-agent.md)).
An addressed message is **triaged** — nobody says whether it is a question or a request: stage 1 (on the server) takes
sure acknowledgements such as ありがとう as needing no answer; stage 2 is Clef when `classifier` is enabled
(below); stage 3 is a light model of the agent's answerer (`haiku` unless configured, no tools); still unknown is a
question. A **question** (相談) is answered at once by the answerer, read-only, in parallel with the runs: the answer is
a message of the AI replying to it. A **request** (依頼) from the facilitator is queued as a run at once; from a
participant, the answerer writes a **change proposal** (what, where, how) that the facilitator approves (as is or
edited; several approved together are one run), or rejects with a note; its author may withdraw it while it waits.
Anyone may run the `/` commands (`/es:start`, `/es:exceptions`, `/guide` …; one of each kind at a time). What changes
files is the facilitator's to approve: the candidates of `/es:exceptions` and the like are checked and applied by the
facilitator, whoever started the command, and the brief of a participant's `/es:start` or `/model:start` (they answer
its questions) waits for the facilitator's 承認, 編集して承認 or 却下. An answer (`/guide`, `/es:recap`) is for everyone;
the ✓ on a step of the guide's map that only people can judge is the facilitator's to set or clear.
Participants see only where a triage went; the facilitator sees its record (each stage's answer, confidence, reason
and model). On each message the facilitator has the robot button, AI に送る (addresses it to the AI, as a mention would
have: its triage decides what follows, and a request the facilitator sends this way is queued without a proposal), and
… (その他の操作): もう一度送る once it was sent (a run of that message, queued at once; runs are serial, so it waits as
実行待ち while another runs), コメントをつけて送る (a run with a comment for the agent first) and まとめて送る (choose
several). Shift- or ⌘-click chooses messages too; a bar then offers コメント… and まとめて送る, one
run of all of them, and Esc leaves it. Right after sending, AI に送りました offers 実行を中止, which stops the run while it
is still queued. Participants see a run once it is in the stream, and the queue in AI の作業. Every message and
AI turn has a status slot at the right end of its name row, there only when the row has a status and then as wide on
every row (the longest state of the language), so what is there lines up in one column down the chat. The row's
actions (AI に送る and …, ↩, ☺+) take no room in it: they float in a small bar over the row's top right while it is
hovered or focused (or one of their menus is open), always on touch. The state is the work's, so
only the AI turn shows it (below); a message that was sent shows, in its slot, a small link to the AI turn of its
latest run (the AI's mark and ↓), its state in the tooltip (`AI の作業へ（実行待ち）`), and a click goes to the turn —
several messages sent in one run read as one queued run, not one per message. What the run did of each message
(`✓ 対応`, `◐ 一部`, `– 未対応`) is on the message's quote in the AI turn.

**Cards.** A run is one card, updated in place: queued, running (with the time), then done, a question, declined,
failed or cancelled; its status slot shows the state where nothing else does (queued, running with the time,
declined, failed, cancelled; a question shows itself), and the facilitator's ✕ that cancels a queued or running run
stands right after it, always shown. While it runs, one small line under its quotes (and under its
row in AI の作業) tells what the AI is doing now — `読んでいます`, `書き換えています`, `確かめています` or `まとめています`, with
the file (its last segment; the path in the tooltip) or the command (`dt check`). It changes as the agent goes, is
not kept once the run ends, and appears only after the agent first tells it. A card is one chunk of change, so it is named, not numbered: the AI gives each run a short title
(about 20 characters, in the requests' language), and the card's title is the one of its first run that has one — the
runs that continue it never rename it. The AI turn's name row reads `AI · 請求書の税区分 · 19:21` (who queued it in the
time's tooltip); before the AI gave a title (still running, or a run from before titles) it reads `AI · 19:21`, the
quotes under it saying what it is about. Where a card must be named without any title (AI の作業, a reply, a mark's tooltip), the head of its first
message stands for it, on one line. In AI の作業, the cards are grouped — 答え待ち, 実行中, 待ち (in the order they will
run, numbered), 終わったもの (newest first; すべて filters only these) — and the tab's badge counts the running and
queued ones. Each card's row is its name, then, small, whose messages its first run applied (`佐藤 ほか 2 人の依頼`), how
many runs when more than one and its time span (`19:21–22:32`; the running one's elapsed time), then
what the whole card changed in the model's words: up to three elements as chips — `＋` added, `✎` changed, `−` removed,
then `#` and the element's own name (its whole name in the tooltip; a click goes to it, a removed one is struck
through) — `ほか n` and 変更を見る; the same line is under each run's text. 変更を見る lists the elements added, changed
and removed, each with what it is (`返品 の状態`), and keeps the source diff of `.dt` and `.dtes` files folded at the
bottom. A field, a parameter or an invariant counts as a change of the element it is in. The chat speaks
of the work, not of revisions: their numbers are only in tooltips and in the source diff. At its top, a quote of each message it applied (`↳ name: …`) — followed, once the run replied, by
what it did of it, in its color (`✓ 対応`, `◐ 一部`, `– 未対応`; none for a message it asks about, whose question follows; the quote is cut with … first, never that), and,
when it applied several, the reply's short note on each; a click goes to the message (hovering one does not mark the
other). A run of the same messages as the one before on the card quotes them only when its reply says what it did
of them. A
run that answers the card's question, or that picks another alternative of one of its assumptions, is added to the same
card under the one before (question → answer → result), under its time alone (`19:25`; the run's number is in its
tooltip); a run of the same messages after a completed one too. The card stays where its first run was queued; when it
changes out of sight, a pill at the bottom of the stream (「「請求書の税区分」が更新されました」, or 「AI が回答しました」 for an answer that arrived while you were scrolled up) goes to it; its ✕ (閉じる) puts it away without moving the stream, until something else changes out of sight. Scrolled up, the stream stops following the newest; a round ↓ button at its bottom right (最新へ) goes back to the bottom and follows again, marked with how many messages and AI turns arrived below since (`@ n` when some mention you or reply to you, as on 💬). For the facilitator, a question's options can be chosen in the card (one, or several
when it says so) and 答えて再実行 queues the run's messages again with that answer at once. その他 is the last row, a
radio or checkbox like the options: its own words are written in a dialog — ✎ at the row's end, or choosing その他
while it has none (Space or Enter on it too) — with the question at its top; 決定 (⌘/Ctrl+Enter) chooses その他 with the
words, キャンセル (Esc) leaves it as it was, and 決定 on an emptied text clears it. The row then reads
`その他: <the words>` on one line (all of them on hover). In a single-choice question その他 is one of the group: the
answer is one option or the own words, never both; choosing an option deselects その他 but keeps its words, so choosing
it again brings them back. In a multiple-choice question it is a checkbox, sent together with the options chosen. Words
under an unselected その他 are not sent. On a
done card, an alternative of an assumption queues them again with that pick and a note asking for it; the facilitator's ✕ (a bordered
button first among a queued or running card's actions, and at the end of its row in AI の作業) stops it after a
dialog asks: 実行を中止しますか？ for a running run (its work so far is not applied), 待ちの実行を中止しますか？ for a
queued one, with the card's name; やめる (or Esc) keeps it, 実行を中止 stops it (its state reads 中止). The card's ⋯
reverts the work (この作業を打ち消す, asked first, below) or shows its changes (変更を見る).

Three operations look alike and are kept apart by their words: **stop** (実行を中止) a run that is queued or running;
**revert** (この作業を打ち消す) a finished piece of work, by a new change that counteracts it, history and later
changes kept; **restore** (以前の状態に復元) the whole workspace to an earlier state.

**Reverting a piece of work.** On a card whose work changed files, the facilitator's ⋯ → この作業を打ち消す takes back
what that work changed and nothing else: later work's changes stay. Asked first (〈作業名〉の変更を打ち消しますか？ —
打ち消す or やめる), it sends the facilitator's message 「〈作業名〉の変更を打ち消す」 to the chat, so everyone sees what is
reverted, and the page goes to it; the revert is then followed in the chat alone, like any request: that message and
its card below it, whose state changes as it goes. It queues like any other change: behind the run in progress and the
runs waiting (実行待ち, 前に n 件 beside the state, as on any queued card), stoppable with ✕ 実行を中止 while it waits —
never refused because something is running. When its turn comes, the revert is done one of two ways:

- **Mechanically** when it can, by the server itself (no agent needed, none needs to be connected): for each file the
  work changed, the file is set back as it was before the work when nothing changed it since; otherwise the work's
  change is reversed line by line around the later changes (as `git revert` does), against the workspace as it is
  when its turn comes. The result is checked as a run's (`dt fmt`, no `.dt` error the workspace does not have now,
  every `.dtes` parses) and written. Its card is an AI turn like any other (who did it, the server or the AI, does not
  matter to the people in the collab), done, with the elements it changed and 変更を見る. When none of the work's
  changes is left by then (they were edited away by hand, say), the revert ends without writing anything and its card
  says 打ち消すものはありませんでした.
- **By the AI** otherwise — a later change overlaps or touches what the work changed (a file it added and someone
  edited, a file it changed and someone removed), or the reverted sources would not check: the revert stays queued
  for the AI — its card shows it simply as 実行待ち, why only in the tooltip on the state — and runs as any run (running, done, stoppable), with the work's changes file by
  file; the AI reverts only those, keeps the later ones and says what it could not revert and why.

A revert stopped or failed reads as any run (中止, 失敗 and why); a call that fails (the network, say) is told under the
chat as the other actions' failures are. A work being reverted (its revert waiting or running) or
reverted already offers no second revert (a revert that failed or was stopped can be asked again); a revert is work
too, and can be reverted in turn. What the AI assumed in a reverted work is closed as 打ち消し済み (no 承認待ち, no
承認), with who reverted it and when, as the work's own card says (打ち消し済み 〈誰〉 · 〈時刻〉).
**Restoring an earlier state** of the whole workspace is the collab menu's 以前の状態に復元, the last resort: it lists
the earlier states by what they were (コラボの開始時, 〈作業名〉の前, 〈作業名〉の後, 〈作業名〉の打ち消しの前, a state
someone recorded, 復元の前 or 復元の後), and the chosen one goes through the restore below.

**Replies to an AI turn.** Hover an AI turn (on touch it is always there) and ↩ 返信 in its actions starts a
reply to its latest run — when that run ended: done, failed, declined or cancelled (a question has its answer form, and
a queued or running run is not replied to yet). Anyone can reply. A chip `↩ 「請求書の税区分」への返信 ✕` (the card's
name) sits above the composer,
whose targets start with those of the run's messages (change them as usual); ✕, or Esc on an empty text, stops the
reply. The reply is a message like any other — classified like one (a 「ありがとう」 reads as talk), sent to the AI or not
by the facilitator (AI に送る runs it at once, or まとめて送る several replies as one run; in collab mode the facilitator's own reply
too) — and shows `↩ 請求書の税区分: <what the AI said>` on one muted line at its top, a click going to the card. The run
made from replies continues the replied run's card in place, quoting the replies like any applied message, and a reply to
that run extends the same card. The agent is given the replied run as context: its messages, how it ended, its reply
(summary, per-message status, assumptions, questions) and what it changed — the unified diff of the sources between
its base and result revisions, or only the list of the changed files when the diffs of all the replied runs together
exceed `agent.run.maxPreviousRunDiff` (20480 characters by default). Answering a question gives the agent the run
that asked in the same way. The current files stay the truth for the agent: other runs may have changed them since.

**Replies to a message.** People answer each other too: ↩ just before ☺+ on any message (on hover, always on touch),
one's own included, starts a reply to it. The chip reads `↩ 田中への返信 ✕` (the author by their current name), the
composer's targets start with those of the message, and the posted reply shows `↩ 田中: <the head of its text>` on one
muted line at its top, a click scrolling to the message and flashing it (nothing shows when the message is not there).
A reply right under what it replies to (the AI's answers included, and in Solo the AI's card under your message) has
no such line: it stays at the level of the other messages, joined by a thin line in the avatar column from the avatar
of the message (or the card) it replies to down to its own, and the replies that follow it on the same message hang
on the same line.
A reply to your message is marked in your stream as a message that mentions you is; nothing else notifies, and the
stream stays one list (no threads). Applied, such a reply continues no card, and the agent is given the message it
replies to — its author and text as they were sent — as context for the request.

**Votes and reactions.** Participants signal a preference; the facilitator decides. On a question's options, everyone
but the facilitator sees ♡ at the right of each option: a click votes for it (again to take it back). In a
single-choice question each participant has one vote, and voting another option moves it; in a multiple-choice question
any number. The same goes for an assumption of a done card: ♡ on 前提 means "keep it as it is", ♡ on an alternative
asks for that one — one vote per assumption, moving. Counts show as `♡ 2`, small; your own vote is a filled ♥ in violet.
Who voted is not on the screen: hover the count for the names, or click it for a small list (on touch). The facilitator
sees the counts (and the same names) next to the options of the answer form and next to 前提 and each 別案, never votes,
and nothing is chosen for them. A vote closes when its run is no longer the latest run of its messages — answering the
question, picking an alternative, or applying the same messages again — or when the run no longer waits for an answer;
cancelling that later run before it started opens it again. Closed votes are frozen, muted and not clickable (who
voted is still on hover and click). Once answered, a question stays as it was asked — the same options in the same
order, with their frozen votes — with the filled mark on what was chosen (その他 and its words as a last row, on one line: hover it for all of them, or click it to read them in a dialog), the other
options muted, and `回答 name · time` under the questions; the amber bar is gone. Each option starts with the mark of
its kind, the shape of the facilitator's controls: ○ for a single-choice question, ☐ for a multiple-choice one, filled
(◉, ☑) once chosen; screen readers hear 選択 / 未選択. An assumption is a group of rows, one under the other —
`○ 前提: …` and `○ 別案: …` for each alternative, each with its votes —, of which one is taken. One whose alternative
was picked shows ◉ on it, the others muted, and `選択 name · time` under it (the time goes to the run the pick queued, in
the same card); one
left as it was (a later run without a pick) has nothing filled and keeps only its frozen votes. A pick is recognized by the note the page writes for it. On every message and
every AI turn, anyone (the facilitator too) can **react** with an emoji: hover the message (on touch it is always
there) and ☺+ at the end of its actions offers a row of quick emoji (`collab.quickReactions`, by default 👍 👀 🤔 🎉 ❤️ 🙏)
and ＋, a small field where any one emoji can be typed or pasted (the OS emoji picker works there; Enter adds it, Escape
closes the field), with who reacted under them. The app gives no emoji a meaning. A reaction is exactly one emoji — a
ZWJ sequence (👨‍👩‍👧‍👦), a skin tone (👍🏽), a flag (🇯🇵) or a keycap (1️⃣) counts as one; text and two emoji are refused —
kept in one form, so ❤ and ❤️ are the same reaction. The reactions placed show under the message as emoji with counts, in
the order they first appeared; yours has its count in violet with a faint violet outline; a click toggles yours; the
tooltip shows the emoji and who. A message or a turn holds at most 20 different emoji (adding to one already there is
always possible). No closing, and neither votes nor reactions count as unread or notify anyone. A page that joins late
gets every vote and reaction with the session's state.

**Requests and targets.** A request is a text (up to 10,000 characters) about **0 to 20 targets** — none means the
whole workspace, and such a message shows no target chips (nor the composer any chip). A target is a `.dt` element (a context's element, a state or a command, by its model ID), a `.dtes`
element (by storming and local ID), or one **occurrence** of an event in a timeline. In the chat's composer, type `#`
to pick an element or a storming's note by its label or name (the list shows its kind and context or storming; ↑↓,
Enter or Tab, Esc; Japanese input works, `＃` too: a candidate is never picked while the IME converts): it becomes a
chip under the text and a small chip in the text (`#支払済み`), which the caret steps over as one character and one
Backspace deletes. (The text is stored with tokens, `#name[n]` for target n, which the composer never shows.) Wherever a target is shown on its own — a chip, being
written or sent, a mention in a sent text, a card named after its first message — it reads as its own name, without
what it is in (`#支払済み`, not `#請求書.支払済み`), its whole name in the tooltip; only the `#` list keeps the kind and
where beside each name, to tell the candidates apart. (Messages written before `#` named elements have
`@name[n]`: they still read as elements.) The chips are the request's targets: delete every mention of one to
drop it, or remove it with ×, which leaves its mentions as plain text. Selecting changes nothing in the composer: to
make the selection targets, press the 💬 button next to it on the canvas (or next to the element's name in the
inspector, for something selected in the explorer or by a search), or `C`; that adds it as chips, opens the chat and
puts the caret in the text. Once everything selected is a chip, the 💬 shows a ✓. The chips take two rows at most:
`+n` shows the others, and they fold again when you send. Selecting a
note in one timeline's view of a storming targets that occurrence (the timeline and the step), the integrated canvas,
which draws each event once, targets the event's definition, and a selection of several shapes adds each of them. The
text and chips you are writing stay in your browser (IndexedDB, per session and participant) until you send them. A
sent message never changes. (Sessions from before kept a *dismissed* mark on some requests; they load and show as
messages, and the page no longer dismisses.) A sent message shows its targets above its text as read-only chips, each
by its own name (`#支払済み`, its whole name in the tooltip), and its mentions the same way, a link to each; each target shows whether it is still in the sources
(`current`), no longer found (`stale`: a target is never re-bound to something else), or `unknown` while the file it
would be in does not parse. The agent sees each request's targets numbered from 1, so `#注文[1]` in one request never
means another request's target.

**Mentioning people.** Type `@` in the composer to mention someone in the session: the list offers the others —
online first, then those away, the facilitator among them, never you — with their avatar and name; it does not open
when no one else is in the session. Picking puts `@佐藤` in the text, as one piece (stored as `@name[pN]`; a sent
message shows the name they have now), and the message names them (up to 20 people; the server checks each is a participant of the session). In the stream a
mentioned person is a link that opens the participants at them. The person mentioned sees that message with a faint
blue background in their own stream, and while their chat is closed its floating button shows `@ 2` for the new
messages that mention them instead of the count of new items. Nothing else notifies: no sound, no e-mail. The agent
reads a person mentioned as a plain `@name`, never as a target.

**Runs.** A run is up to 100 messages sent to the AI (requests) with the facilitator's comment if any (its `note`, up
to 4,000 characters); its input is frozen when it is queued, and a message stays as it was, so it can go into another run later.
A run is `Queued`, `Running`, then `Completed`, `NeedsClarification` (the agent asked questions, answered in its card), `Declined` (the agent would not do the requests: they break its rules or are not
about the model; the chat shows why, and no `dt fmt`/`dt check` runs), `Failed` or `Cancelled`; the facilitator can
cancel a queued or running one. A run **succeeds** when the agent exits 0, `dt fmt` and `dt check` ran, there is no new
`.dt` error compared with the run's base revision, and every `.dtes` file still parses; diagnostics that were there
before and `.dtes` warnings are shown (before → after), not a failure. A run that changes nothing completes with its
base revision as its result.

**The agent's reply** is structured (Claude Code's structured output, `--json-schema`): a short summary, a line per
request (✓ done, ◐ partly, – not done, ? a question, with a note for the last ones), the assumptions it made where a
request left a choice open (with the alternatives it saw), and for a question up to 3 questions, each with up to 5
options (the page always adds "other"). The chat shows what the AI says — its summary, an answer given instead of an
edit, a question asked without the form — as Markdown, the way it shows the AI's answers (lists, **bold**, `code`,
code blocks and tables; every heading level one heading; links and images as text, never HTML), its short texts (a
request's note, an assumption, a question and its options) as plain text, then the files the run changed on a small
line of their own (a file-diff icon, `billing.dt、tax.dt`: a link comparing the revisions before and after the run);
nothing when no file changed. The AI names elements by identifier (`@{Sales.Order}`, `@{es:Returns/ReturnRequested}`); the page shows each by its own name in the
name display setting (a state or a command without its aggregate, a storming element without its storming; the whole
name in its tooltip), as a link to the element. Whether a run succeeded is
never taken from the reply. A reply that does not fit its shape or limits is shown as far as it can be read (its
summary or question), never failing the run. The limits live in one module (`domain/reply.ts`). An answer chosen in the
card is frozen into the next run as `answerTo` and `answer` (the question and the options as they were shown); another
alternative picked is frozen as `pick` (the run, the assumption and the alternative as they were shown), with a note
asking for it; the agent is given the run it assumed in, and the card shows the pick with ◉.

**Clef, stage 2 of the triage (opt-in).** With `classifier.enabled`, the session server asks Cloudflare
Workers AI's Clef (`@cf/cloudflare/clef-flash`, or `clef`) three questions about each message **addressed to the AI**
(only those): is it a question about the model, a request to change it, or does it need no answer. One answer at or
above `threshold` decides; anything else — none or several, a failure, a timeout — leaves the message to stage 3. Talk
between people is never sent. **The text of each addressed message is sent to Cloudflare** under your account (the token is read from the environment variable named by `apiTokenEnv`, never from
the file); Cloudflare states that it does not use customer content processed by Workers AI to train models
([Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/)). Disabled (the default),
nothing is sent: the triage's record says Clef is not configured, and stage 3 decides.

**Presence** is never stored: each page tells the others where it is (this page, the same view, another view,
offline) and its cursor, at most about 20 times a second. A cursor is drawn only on the same view — the same `.dt`
view with the same layout, or the same storming, level and timeline (Big Picture and Design Level, or two timelines, are
different views). An occurrence is only told apart in a timeline's view.

**Privacy.** Pages show participants by name only: the name picked on the join form (`dev`), or the Access identity's
name, else the part of the e-mail before `@` (`access`). The e-mail is never sent to any page, not even your own, and
never logged; an avatar is shown only from the hosts in `collab.access.avatarHosts`, else initials. The server's log
has no token, cookie, link code or e-mail. A run's prompt carries the requests' text and their authors' names to the
agent.

**What is stored where.** Everything of the session is outside the workspace, in its state directory
(`~/.local/state/domaintrail/<workspace>/` by default; `dt guide config`, Where dt keeps its files): `session.db`
(SQLite: the session, requests, runs, revisions, the event outbox, sign-ins and facilitator links as hashes, the log of
restores), `blobs/` (the revisions' file contents, by SHA-256), and `server.json` (the page's and the agent API's
addresses, no secret, mode 0600, removed when the server stops; for `dt open link`, `dt collab link`, `dt collab
agent-link` and `dt agent`). Nothing is written into the workspace, so there is nothing to ignore in git. The agent
API's credential is never written to disk: the agent in process is handed it in memory, and a standalone `dt agent`
exchanges the one-time code of `dt collab agent-link` (or `dt open agent-link`; single use, 10 minutes, revoked when the
server stops) for it and keeps it in memory. The `.domaintrail/` of an older version is moved there on the first run,
without its credentials: everyone signs in again (`dt guide config`). `dt session prune` removes the state of workspaces that are gone. Drafts are in each
browser; presence only in memory.

**Limitations.** The log of restores is in `session.db` only, not served over HTTP. In the `access` mode, leaving the
session sends the page to Access's logout, but the server cannot see a sign-out made elsewhere: the person's other
pages stay until their token expires. Comparisons are bounded (below). Claude Code is the only agent, and there is
one open session per workspace.

<!-- topic: session-config -->
### Session configuration

The sections `open`, `collab`, `agent` and `classifier` of `domaintrail.jsonc`; every key is optional, and the defaults
are shown. The old sections `session` and `view` are refused when the file is loaded, with where each key went.

```jsonc
{
  // dt open (one person, the Live View with the chat)
  "open": {
    "port": 4321,
    "host": "127.0.0.1"        // a non-loopback address serves the Live View read-only (no chat, no agent)
  },
  // dt collab and dt collab link
  "collab": {
    "port": 4321,              // the page and its API
    "host": "127.0.0.1",       // the dev identity refuses a non-loopback address
    "identity": "dev",         // "dev", "access" or "link" (dt collab --tunnel sets "link")
    // only with "identity": "link" and your own tunnel (not with --tunnel); see docs/session-link.md
    // "link": { "publicUrl": "https://dt.example.com" }, // https, no path: the only host and origin answered
    // only with "identity": "access" (then teamDomain and audience are required); see docs/session-access.md
    "access": {
      "teamDomain": "myteam.cloudflareaccess.com", // your team domain
      "audience": "<the Access application's AUD tag>",
      "publicUrl": "https://session.example.com", // optional; must be https, in allowedHosts and allowedOrigins
      "allowedHosts": ["session.example.com"],    // default: none (loopback names only)
      "allowedOrigins": ["https://session.example.com"], // default: none
      "acceptCookie": false,   // also accept the CF_Authorization cookie when the header is missing
      "avatarHosts": []        // hosts an https avatar may come from; default: none, initials
    },
    "maxParticipants": 50,
    // the emoji ☺+ offers first in the chat (1 to 8, each one emoji, distinct); any other can be typed there
    "quickReactions": ["👍", "👀", "🤔", "🎉", "❤️", "🙏"]
  },
  // the agent (dt agent, or the one dt open and dt collab start in process), in both modes
  "agent": {
    "port": 0,                 // the agent API, on 127.0.0.1 only; 0 = any free port (written to server.json)
    // the runner: the runs that edit the workspace
    "run": {
      // Claude Code permission rules; this is the default
      "allowedTools": ["Read", "Edit", "Write", "Glob", "Grep", "Bash(dt fmt:*)", "Bash(dt check:*)", "Bash(dt guide:*)"],
      "warm": true,            // one Claude Code process across runs (each run a turn); false: one process per run
      "restartAfter": 20,      // runs of one warm process before a fresh one replaces it
      "idleTimeout": 30        // minutes without a run before the warm process ends (its memory freed); 0 = never
      // "model": "sonnet",    // claude --model; default: your Claude Code settings' model
      // "effort": "medium",   // claude --effort (low, medium, high, xhigh, max); default: your settings'
      // the dt the agent runs (and dt fmt / dt check after it); default: the running dt itself.
      // ["node" | "bun" | "deno", "<script>"] or ["<dt executable>"], relative to this file, outside the workspace:
      // "dt": ["node", "../domaintrail/dist/dt.js"],
      // the most characters of diff given to the agent of the runs a run replies to or answers, all together;
      // past it, only their changed files (default 20480)
      // "maxPreviousRunDiff": 20480
      // what the runner also reads outside the workspace, besides agent.read (never writes there);
      // in domaintrail.local.jsonc only (git-ignored): "read": { "paths": ["../tools/notes.md"] }
    },
    // the answerer: read-only answers to questions and change proposals (its tools are Read, Grep and Glob, not configurable)
    "answer": {
      "warm": true,
      "restartAfter": 50,      // answers of one warm process before a fresh one replaces it
      "idleTimeout": 30,
      "timeout": 120           // the most seconds an answer may take
      // "model": "sonnet",    // default: your Claude Code settings' model (never the runner's)
      // "effort": "low"
      // what the answerer also reads outside the workspace, besides agent.read;
      // in domaintrail.local.jsonc only (git-ignored): "read": { "paths": ["~/notes/glossary.md"] }
    },
    // the light model that sorts the messages addressed to the AI (question, change request or neither)
    "triage": {
      "model": "haiku",
      "warm": false            // true: one long-lived process; false: a fresh claude -p per message
    },
    // the extractor of knowledge (the knowledge section, dt guide config), no tools at all, a fresh process per extraction
    "extract": {
      "timeout": 180,          // the most seconds an extraction may take
      "gateModel": "haiku"     // the light model that decides first whether to extract; default: triage.model, else haiku
      // "model": "sonnet",    // default: answer.model, else your Claude Code settings' model
      // "effort": "low"       // default: answer.effort
    },
    // what both roles may read outside the workspace, read-only: directories or files, absolute, ~/… or relative to
    // this file (see dt guide session-agent); in domaintrail.local.jsonc only (git-ignored), never in this file
    // "read": { "paths": ["../specs", "~/notes/glossary.md"] }
  },
  // opt-in, stage 2 of the triage: the messages addressed to the AI classified by Cloudflare Workers AI (their text is sent to Cloudflare)
  "classifier": {
    "enabled": false,
    "provider": "cloudflare-clef",
    "model": "clef-flash",     // or "clef"
    // "accountId": "<your Cloudflare account ID, 32 hex digits>", // required when enabled
    "apiTokenEnv": "CLOUDFLARE_API_TOKEN",       // the NAME of the variable holding a Workers AI token
    "threshold": 0.9           // from this probability one of Clef's answers decides; below it, stage 3
  }
}
```

**Identity modes.** `dev` is for a session on one machine: the first visit gets a join form asking for a name, and an
HttpOnly cookie keeps the sign-in (the collab menu's 退出 signs out). Another cookie, `dt_name`, remembers the name for
a year, so the next join form (of any session on that host) starts with it. The join form and the server's other pages
are in Japanese when the browser prefers Japanese, else in English. `access` puts the session behind Cloudflare Access
and a Cloudflare Tunnel: each request's Access token is verified (signature with the team's keys, issuer, audience,
expiry), the name comes from Access's Identity API, a page's WebSocket closes when its token expires, and only the
configured hosts and origins are answered; `docs/session-access.md` in the repository sets it up and checks it by
hand. `link` puts the session on the internet without an account: `dt collab --tunnel` starts a Cloudflare quick
tunnel (`cloudflared`, a temporary public `https://….trycloudflare.com` address, stopped with the session), the
facilitator shares an invite link (the collab menu's 招待, or `dt collab invite`; 60 minutes, a new one stops the
previous), each person who opens it gives a name and waits, and the facilitator lets them in or not from the page.
Only the public URL's host and origin are answered, every change needs that Origin, the cookies are Secure and
SameSite=Strict, and every sign-in ends with the server; `docs/session-link.md` in the repository tells the security
model and its limits. With your own tunnel, set `link.publicUrl` instead of `--tunnel`. `--port` and `--host` win
over the file.

<!-- topic: session-revisions -->
### Revisions, comparison and restore

A **revision** is every `.dt` and `.dtes` source of the workspace at one moment, with the validation per DSL (`.dt`
errors; `.dtes` errors and warnings; the warnings of `ref`s into the model). One is taken when the session starts,
before and after each run, when the facilitator records the current state (*Record the current state*), and around a
restore; saves while a run is in progress make none. They are numbered in the order taken; the chat words them by the
work (a card's result, the state before it) and keeps their numbers in tooltips, and a run's card reaches the two
around it (its ⋯ → 変更を見る).

- **Changes**: a card (⋯ → 変更を見る, or 変更を見る on its line) lists the model's elements its revisions differ by —
  `.dt` elements, states and commands by their IDs, storming elements by their storming and local IDs — as added,
  changed or removed. Under it, folded, the source diff: the files added, removed or changed, `.dt` and `.dtes`
  together, each with a line diff, and both validations side by side when either has an error or a warning. When a side
  does not parse, the model is not compared and the source diff is open. The work is bounded: a file over
  1 MiB, or of more than 10,000 lines or 1,000 edits, gets no diff; lines are cut at 1,000 characters; a comparison
  stops its diffs after 512 KiB (and a file's after 2,000 lines), and the files after that get none.
- **Restore** (the collab menu's 以前の状態に復元): the facilitator writes a past revision back: every source becomes
  that revision's, on everyone's page at once, later work's changes included — to take back one piece of work, revert it
  from its card instead. The current state is kept first as a *before a restore* revision, so a restore can itself be taken back by
  restoring that one. A restore is refused, and nothing is written, when:
  - a run is in progress (a revert the server is trying too): wait for it, or stop it from the restore dialog, then
    restore again (files the agent changed before it stopped count as external changes, below);
  - the workspace changed since the last revision (an edit by hand, a `git checkout`): the dialog lists the files and
    offers *Record the current state, then restore*, which keeps the current state as a revision first;
  - a source is a symbolic link or outside the root.

  If writing fails halfway, nothing is recorded as restored and the page says that manual recovery is needed: check
  the files, then restore the *before a restore* revision it names (through *Record the current state, then restore*,
  since the workspace now differs from the last revision).

**People's edits of the stickies** ([ADR 0033](adr/0033-people-edit-stickies.md)). Anyone in the session can change a
sticky's label and name, put a hotspot on any sticky and write a hotspot's resolution on the canvas; dt writes it into
the `.dtes` at once, without an AI run, changing only the label string, or for a new name the declaration's name and
every reference to it in the storming (relations — `by`, `reads`, `handledBy`, `emits`, `on`, `issues`, `from` —, timelines and groups, an exception's `then`, a stage's `after`) —
the rest of the file stays as it was (no `dt fmt`). An edit is refused, with nothing written, when the sticky is no
longer as the page showed it, when the name is not an ID of `.dtes` or is taken in the storming, or when the file would
not parse. Each edit is a unit of work with its revisions before and after: it shows in AI の作業 as 「◯◯が編集しました」
with old → new, and the facilitator reverts it as any work. Edits are allowed while the AI works, even on what it is
changing: when its run ends, an edit its result dropped (the old label or name left in the file) is written again, and
a label the run changed to something else is kept as the run's, with both wordings offered to people in AI の作業. The
next run is told what people edited, old → new, and to keep their wording.

<!-- topic: session-agent -->
### The agent and its security

The agent (`dt agent`, or in process) runs `claude` from the `PATH` in the workspace's root, for each run, as
`claude --print --output-format stream-json --no-session-persistence --strict-mcp-config --setting-sources ""
--permission-mode dontAsk --tools … --disallowedTools … --allowedTools …`, with the rules of `agent.run.allowedTools`
only (any other tool is refused without asking, and no MCP server is loaded). The prompt tells it to read the related files, edit only
the `.dt` and `.dtes` sources, keep a storming exploratory, and change no `.dt` when the requests are only about
stormings, and lets it answer instead (status `answered`) a request that turns out to be a question. It also gives the
ways of working of the languages the requests are about, as `dt guide storming-practice` and `dt guide
modeling-practice` print them (both for a request about the whole workspace), with the syntax by example of `dt guide
dtes-quick` after the storming's and of `dt guide dsl-quick` after the modeling's; the answerer's prompts give them too
(its interviews without the syntax). Its rules say to write a storming's relations in Event Storming's grammar and to
mark a relation nobody knows with a hotspot on the element, never to fill it by guessing.
Then `dt fmt` and `dt check` run when the run changed files (else both are skipped), and the server records the
result.

- **The agent's `dt`.** The agent may run `dt fmt`, `dt check` and `dt guide` (the default `allowedTools`), whatever
  is installed: for each run the subscriber puts a `dt` first on the agent's `PATH`, in a private temporary directory
  (0700) outside the workspace. It runs `agent.run.dt` — `["node" | "bun" | "deno", "<script>"]` or
  `["<dt executable>"]`, e.g. a clone of DomainTrail next to the workspace while developing it — or, unset, the very
  `dt` running the subscriber. That command is read once when the subscriber starts (never again from the config file,
  which is in the workspace), pinned to absolute real paths (the runtime found on the `PATH`), refused when the script
  or executable is inside the workspace (symbolic links followed), and fingerprinted: a run does not start once either
  file changed. The agent's `dt` takes `fmt` or `check` and then `.dt` / `.dtes` files of the workspace only, or
  `guide` alone, with one topic or rule name, or with `--all` (it only prints); any other option or argument is
  refused with a message to the agent, and `-r <workspace>` is always added by the shim. Both the agent's `dt` and the
  `dt fmt` / `dt check` after the agent run with a private working directory, never the workspace.

- **Request text is untrusted.** Any participant writes it, and the agent reads it: the prompt puts the requests (and,
  for replies and answers, the earlier run's messages, reply and diff) in a delimited block of JSON marked as data, but admit only people you trust, and keep `allowedTools` narrow (never a
  plain `Bash`).
- **What the agents can read: the workspace, minus what git ignores.** Both roles may read any file inside the
  workspace's root — the model, READMEs, notes, code — and nothing else: no path outside the root (your home, `..`,
  absolute paths) unless `agent.read.paths` names it (below), never the sessions' state (outside the workspace) nor an older version's `.domaintrail/` nor `.git/`, and no file `.gitignore` ignores (`.env`,
  build outputs, `node_modules`). **Keeping secrets out of the repository is your responsibility**: a secret committed
  or merely not ignored can be read by the agents and quoted in the chat to every participant. `claude` is started
  without any settings file (`--setting-sources ""`): neither the workspace's `.claude/` (the agent could write it) nor
  your `~/.claude/settings.json` (its allow rules could let it read anywhere) is loaded; only its `model` and
  `effortLevel` are taken as the agents' when they have none of their own. Your hooks and `apiKeyHelper` do not run
  for the agents (sign in to Claude Code, or set `ANTHROPIC_API_KEY`). The answerer reads a private copy of the
  readable files (refreshed before each job, outside the workspace); the runner, which edits the workspace, has deny
  rules for `.domaintrail/`, `.git/` and the ignored files and directories present when its run starts. "Ignored" is
  git's own answer (your global excludes file and `.git/info/exclude` included). A nested repository or a submodule
  is left out as a whole: the answerer never sees its files and the runner is denied its directory. More than 500
  ignored entries and nested repositories make a run fail (`ReadScopeTooLarge`, shown on the page): ignore whole
  directories (e.g. `dist/` rather than its files) or move nested repositories out. As defense in depth, the server
  refuses an answer, a proposal or a run's reply that contains the agent API's credential.
- **Reading outside the workspace: `agent.read.paths`.** You may let the AI read directories or files outside the
  workspace, read-only: `agent.read.paths` for both roles, `agent.answer.read.paths` and `agent.run.read.paths` added
  for one (absolute, `~/…`, or relative to the config file). They are yours to choose: honoured only from
  `domaintrail.local.jsonc` when git ignores it (or outside any repository), an error in the project's file, and asked
  about when they change (see the approval in `dt guide config`). A path inside the workspace, one holding it, one in a
  `.git` or `.domaintrail` directory, `/`, your home directory, and a path that is or holds `~/.ssh`, `~/.gnupg`,
  `~/.aws`, `~/.azure`, `~/.config`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/Library`, `/etc`, `/private/etc`, `/var`
  or `/private/var` (or is inside one of them, but `~/Library`, `/var` and `/private/var`), or is inside or holds dt's
  state or cache directory (`~/.local/state/domaintrail`, `~/.cache/domaintrail` or where `DOMAINTRAIL_STATE_DIR`,
  `XDG_STATE_HOME` and `XDG_CACHE_HOME` put them: every workspace's session) is a config error naming its key. Each path is taken by its real path (symbolic links followed, the file system's case) when the agent starts,
  and one that is missing is skipped (its log says so); before each answer and each run it must still be the same
  directory or file (else that turn or run fails: restart the agent). In each, the workspace's rules apply: in a git
  work tree the files git does not ignore there, elsewhere every file; never `.git` nor `.domaintrail` at any depth; a
  nested repository inside it denied as a whole (the path itself may be one). The answerer reads private copies of
  them, as of the workspace (200 MiB at most, all together; copies an agent that was killed left behind are removed
  when the next starts); the runner reads them in place (`--add-dir` for a directory, a `Read(//…)` rule for a file)
  and may never edit, write or remove anything there (`Edit(//…)` deny rules, which win over every allow rule); what
  git ignores there, the nested repositories and the symbolic links are denied to it as a whole, counted with the
  workspace's against the 500 entries; a name no permission rule can express (a line break in it) makes the run fail
  rather than go without its rule. `dt open`, `dt collab` and `dt agent` print what each role reads beyond the
  workspace when they start (`AI answers read outside the workspace: …`, `AI runs read (never write) outside the
  workspace: …`). **In a collab session, any participant can make the AI quote these files in the chat**: name only
  what every participant may read.
- **The configuration files are never written by the agents.** Deny rules keep them from editing
  `domaintrail.jsonc`, `domaintrail.json`, `domaintrail.local.jsonc` and `domaintrail.local.json` at any depth and in any
  case, and a `-c` file and its local override by every path they may be reached by; a configuration-like file
  created or changed beside a `-c` file outside the workspace fails the run as a change outside the DSL does.
- **A change outside the DSL stops the subscriber.** The workspace is scanned before and after the agent; if any file
  other than a `.dt` or `.dtes` source was added, changed or removed (`.claude/` included, and files that `.gitignore`
  ignores), the run fails (`AgentError`) and the subscriber claims no further run. Its log names the files (`not
  claiming further runs: review … then restart the subscriber`). Review them and undo what you do not want, then start
  `dt agent` (or `dt open` / `dt collab`) again and queue the requests in a new run. A scan that fails stops it the same
  way.
- **The agent API** listens on 127.0.0.1 only, on its own port, with a bearer token held in memory only (paired for
  with a one-time code by a standalone `dt agent`); it refuses a request with an `Origin` or a `Host` other than loopback, and is never reachable through the page's port.
- **Two roles, two entry points.** The runner follows `GET /agent/events` and claims runs; the answerer follows `GET
  /agent/answers/events`, where the server hands each job (stage 3 of a triage, an answer, a proposal) to one connected
  answerer with none in hand — no claim, no lease, never waiting for the runs — and takes its result at `POST
  /agent/answers/:job`; a job not answered within its timeout (120 s) is withdrawn (a triage's stage 3 is then a
  question; an answer or a proposal is handed out again, twice at most), and the jobs of an answerer that disconnects go
  to another or wait. The answerer's Claude Code has the reading tools only (`--tools Read,Grep,Glob`; stage 3: none),
  whatever the message says; it is warm (one process across answers) by default, stage 3 a fresh `claude -p` per
  message. Every prompt carries the session so far (the chat, the AI's turns and what is open), whole for a fresh
  process and only what was added since for a warm one. The page's state and `agent.presence` say how many of each role
  are connected and how much work waits for one.
- **One run at a time.** Each run is claimed with a lease kept alive by heartbeats. If the subscriber dies, the run's
  lease expires and a running run fails (`LeaseExpired`) rather than run twice; a run only claimed goes back to the
  queue. Ctrl+C fails the running run as `Interrupted`.
- **What the agent is doing** reaches the pages as it goes: the subscriber runs `claude` with `--output-format
  stream-json --verbose` and maps its tool calls onto four phases (reading, editing, checking, finishing) with the file
  or the `dt` command; a path outside the workspace is never sent. Nothing of the agent's output itself reaches the
  pages, and the activity is not stored.
