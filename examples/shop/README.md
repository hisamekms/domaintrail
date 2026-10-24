# examples/shop

A small shop in three bounded contexts — **Sales** (customers, orders), **Billing** (invoices) and the shared
**Common** (money, email addresses) — showing the whole picture of DomainTrail in three layers:

| Layer | Where | Who writes it |
|---|---|---|
| The model: structure and contracts | `common/`, `sales/`, `billing/` (`*.dt`) | people and AI agents, together |
| Types, command contracts, checks, contract tests | `generated/domain/` (gitignored) | `dt generate ts` |
| Behaviour: the commands, the application around them | `src/` | an AI agent following `dt guide` |

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

## What the agent wrote, and why

`src/domain/` — the implementations of the generated contracts. They import only `generated/domain`.

- `order-commands.ts`, `customer-commands.ts`, `invoice-commands.ts` — one command each as a decision with `decide`:
  the compiler checks every outcome's fields and events against the contract. Commands are pure: IDs and times are
  parameters. The requirements use the generated `check…Requires`, so their expressions stay the DSL's.
- `primitives.ts` — the `make…` constructors, all generated here (every invariant has an expression), plus
  `parseDecimal`: which strings are decimals is a format choice, not a rule of the domain.
- `order-total.ts` — the amount to bill: a calculation, which the DSL does not describe, relying on what a
  Confirmed order guarantees (`hasItems`, `singleCurrency`).

`src/app/` — the application: in memory, no framework, no external services.

- `use-cases.ts` — load → check the state the command accepts → call the command with IDs and the time from the
  providers → on success `outcome(…)`, save, record `eventList(…)`; a domain error is returned as it is.
- `repositories.ts` — `Versioned<A>`: the aggregate with its technical metadata (version, timestamps) in an envelope,
  and optimistic locking on save.
- `event-store.ts` — stores the events the DSL declares `persistent` in an envelope `{ event, meta }` (event ID,
  recording time, correlation and causation) and publishes every event to subscribers.
- `policies.ts` — reactions across contexts: a confirmed order is invoiced for its total; a refund request is
  recorded for a person, since the model has no refund command yet.
- `providers.ts`, `shop.ts` — IDs and the clock, injected; the wiring.

`src/contract.test.ts` registers the generated contract tests of every context, aggregate and domain primitive;
`src/app.test.ts` tests what happens around the commands; `src/demo.ts` is the walk through the shop.
