# examples/shop

A small shop in three bounded contexts — **Sales** (customers, orders), **Billing** (invoices) and the shared
**Common** (money, email addresses) — showing the whole picture of DomainTrail in three layers:

| Layer | Where | Who writes it |
|---|---|---|
| The model: structure and contracts | `common/`, `sales/`, `billing/` (`*.dt`) | people and AI agents, together |
| Types, command contracts, checks, contract tests | `generated/domain/` (gitignored) | `dt generate ts` |
| Behaviour: the commands, the application around them | `src/` | an AI agent following `dt guide` |
| Event Storming: what happens, beside the model | `stormings/` (`*.dtes`) | people and AI agents, together |

## The loop

```bash
# from the repository root (inside the example: `dt fmt`, `dt check`, … without -r)
bun run dt -r examples/shop fmt            # 1. edit .dt files, then format them
bun run dt -r examples/shop check          # 2. until it exits 0 (no errors, no warnings)
bun run dt -r examples/shop generate ts    # 3. the contracts and the contract tests
#                                            4. implement the contracts in src/
bunx tsc -p examples/shop                  # 5. the compiler checks src/ against the contracts
(cd examples/shop && bun test)             # 6. the contract tests and the application's tests
(cd examples/shop && bun src/demo.ts)      #    and a walk through the shop
```

When the contract and the implementation disagree, the DSL is changed, not the implementation. Writing this example
did that twice: an order's items had no rule about currencies, so its total could not be one `Money`
(`singleCurrency` and `requires sameCurrency … else CurrencyMismatch` in `sales/order.dt`); and `Invoice.pay` declared
an error `AlreadyPaid` it could never return, since it accepts only open invoices (removed; paying a paid invoice is
rejected by the application, as `NotAllowed`). `InvoicePaid` became `persistent`: a payment is a record to keep.

## The stormings

`stormings/` holds two Event Stormings (`dt guide storming`), checked by `dt check` with the model:

- `order-to-cash.dtes` (UC2: stormed from the model) — from an order to its payment, at Design Level, with a `ref` from
  every event, aggregate and command that the model has. Its policy `BillConfirmedOrder` crosses from Sales to Billing
  like the `.dt` one. Its three timelines share their start (the Live View draws `OrderPlaced → ItemAdded → OrderConfirmed`
  once), and a group holds the two results of cancelling a confirmed order. What the model lacks is
  left without `ref` and asked in hotspots: `Invoice.issue` emits no event (`InvoiceIssued`), a payment may fail
  (`PaymentFailed`, reported by the external `PaymentService`), and the invoice of a cancelled order is open. The
  hotspot on mixed currencies is resolved: the model's `singleCurrency` answers it.
- `returns.dtes` (UC1: before any model) — returns at Big Picture only: events, two timelines and open questions.

## What the agent wrote, and why

`src/domain/` — the implementations of the generated contracts. They import only `generated/domain`.

- `order-commands.ts`, `customer-commands.ts`, `invoice-commands.ts` — one command each as a decision with `decide`:
  the compiler checks every outcome's fields and events against the contract. Commands are pure: IDs and times are
  parameters. The requirements use the generated `check…Requires`, so their expressions stay the DSL's.
- `primitives.ts` — the `make…` constructors, all generated here (every invariant has an expression). A `Decimal`
  comes from the runtime's `parseDecimal`; nothing here casts to a domain type (`as Amount`), which the lint rule in
  `.oxlintrc.json` reports (`dt guide lint`).
- `order-total.ts` — the amount to bill: a calculation, which the DSL does not describe, relying on what a
  Confirmed order guarantees (`hasItems`, `singleCurrency`).

`src/app/` — the application: in memory, no framework, no external services.

- `use-cases.ts` — load → check the state the command accepts → call the command with IDs and the time from the
  providers → on success `outcome(…)`, save, record `eventList(…)`; a domain error is returned as it is.
- `verifications.ts` — the factory of the verified type `AvailableEmail` (`sales/customer.dt`): no other customer
  uses the address, a check a pure command cannot make. `register` and `changeEmail` take an `AvailableEmail`, so the
  use cases cannot call them without it; the check holds at that moment, so a real store would also keep a unique
  index.
- `repositories.ts` — `Versioned<A>`: the aggregate with its technical metadata (version, timestamps) in an envelope,
  and optimistic locking on save.
- `event-store.ts` — stores the events the DSL declares `persistent` in an envelope `{ event, meta }` (event ID,
  recording time, correlation and causation) and publishes every event to subscribers.
- `policies.ts` — reactions across contexts. Billing declares one in the DSL, `policy BillConfirmedOrder when
  Sales.OrderConfirmed -> Invoice.issue` (`billing/context.dt`), and its handler implements the generated
  `Billing.BillConfirmedOrderPolicy`: from the event to `IssueInvoiceInput`, the new ID, the order and its total. The
  in-process bus runs `Invoice.issue` with it right after the event; the rule only says "eventually", so a queue or a
  batch would do as well. Billing's policies are `required` (`generate.ts.contexts.Billing.policies` in
  `domaintrail.jsonc`): `Billing.BillingPolicyHandlers` must list every one, and the contract tests run them (the
  example is clearer with the handler tested than with a type nobody has to use). A refund request is only recorded
  for a person: there is no refund command, so no policy can name one.
- `providers.ts`, `shop.ts` — IDs and the clock, injected; the wiring.

`src/contract.test.ts` registers the generated contract tests of every context, aggregate and domain primitive, and of
Billing's policy (with the order it reads given for any ID);
`src/app.test.ts` tests what happens around the commands; `src/demo.ts` is the walk through the shop.
