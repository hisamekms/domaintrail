# ADR 0022: Policy declarations — reactions to events

- Status: accepted
- Date: 2026-10-24

## Context

Rules across aggregates and contexts are often reactions: "when an order is confirmed, it is billed". The model said
what happened (the events, ADR 0018) and what can be done (the commands), but not which event leads to which command.
That link lived in hand-written subscribers (`examples/shop/src/app/policies.ts`), invisible to `dt check`, the context
map, `dt show` and the Live View. An AI agent reading the model could not tell that Billing depends on Sales'
`OrderConfirmed`, nor that `Invoice.issue` must eventually follow it; renaming the event or the command broke the
subscriber silently.

ADR 0017 and 0023 cover the other ways to write a rule across aggregates: values passed as parameters and checked with
`requires`, and the evidence of a check made outside the aggregate. A reaction to another aggregate's events was the
missing one.

## Decision

### A policy states a reaction, nothing more

```dt
// billing/context.dt (the reacting context owns it)
/// 確定した注文は、その合計で請求する。
policy BillConfirmedOrder "確定した注文に請求する" when Sales.OrderConfirmed -> Invoice.issue
```

- Grammar: a context element `'policy' name=ID label=STRING? 'when' event=[EventDecl:QualifiedName] '->'
  aggregate=[Aggregate:ID] '.' command=[Command:FeatureName]`. `policy` is a keyword added to `FeatureName`, so it still
  names fields and parameters (the guide's `policy: ApprovalPolicy`).
- Meaning: **when the event happens, the command is eventually run** — Event Storming's policy.
- Declared in the **reacting** context: the target aggregate is one of its own, so it is named without its context; the
  event may be of any context. A shared context holds no policies (M014) and has no events to react to.
- Declaring is optional; it is recommended across contexts, where the dependency matters most.
- The command is a cross-reference looked up in the aggregate, so go-to-definition, find references and rename of the
  event, the aggregate and the command (commands are now renamable) update the policy.

M023 reports an event that does not exist, an aggregate that is not one of the policy's context (with the hint naming
the context to declare the policy in, when the aggregate exists elsewhere), a command the aggregate does not have, an
event of a shared context, and (warning) two policies of one context that state the same reaction. M002 covers the
name, M011 the generated names.

### Mechanism-neutral

"Eventually" is satisfied by any mechanism: the command run in the same use case, through an event bus, from a queue, by
a nightly batch. The generated code neither chooses nor forces one; the example runs it from an in-process bus.

### Generated TypeScript

```ts
export interface IssueInvoiceInput { readonly id: InvoiceId; readonly order: Sales.OrderId; readonly billedAmount: Common.Money }
export type BillConfirmedOrderPolicy = (event: Sales.OrderConfirmed) => Promise<IssueInvoiceInput>;
```

- **Always**, per policy, the type of its **handler**: from the event to the command's **input**, what the application
  needs to run it. The input is the command's parameters by name, after the ID of the aggregate to run it on (keyed like
  the aggregate parameter of the command type, `invoice: InvoiceId`, which M011 already keeps apart from the
  parameters) unless the command is a factory. An object rather than a tuple, so that it reads and serializes on its
  own (a queued command, a use case's input); written once per command, also when several policies run it.
- JSDoc: the reaction, the label and description, "eventually; any mechanism", that data from elsewhere comes in through
  closures and a rejected promise means the input cannot be computed now, and `@see`.
- The handler is async: computing the input usually reads data (the order's total) and makes IDs.

### Enforcement is a choice of the configuration

`generate.ts.policies: "optional" | "required"`, overridden per context by `generate.ts.contexts.<Context>.policies`;
the mode of a context is its own setting, else the project's, else `optional`. An entry of `generate.ts.contexts` now
needs `out` or `policies` (or both).

- `optional`: only the types above. Nobody has to use them.
- `required`: also `<Context>PolicyHandlers`, one handler per policy of the context, and the generated contract tests
  of the context take it as a required `policies` (a missing handler is a compile error). A case per policy feeds the
  handler generated events (fast-check, as for commands; event arbitraries are generated for every event) and checks
  that it resolves to an input the command accepts, as far as the run time can tell: every argument present unless
  optional, of its base type or enum, the fields of value objects and entities in turn, the invariants of its type by
  the generated checks, a list within its multiplicity. A handler that needs outside data gets it through the closures
  the user builds; the tests run with whatever the user wired (the example gives a confirmed order for any ID).

### Dependencies

The context map counts a policy as a dependency of the reacting context on the event's context, of a kind of its own,
`event` (`ID 2 · イベント 1`); such an edge is drawn solid, like one that borrows types. `dt show` prints a policy with its
event and command and the input, "triggered by" on the command and `reactedToBy` on the event; the Live View shows the
same in the explorer, inspector, behaviour cards and a catalog section.

## Rejected

The reaction was considered at three levels:

- **L1, the reaction only** (adopted): which event leads to which command.
- **L2, the reaction with its value mapping** (`when OrderConfirmed -> Invoice.issue(order = orderId, …)`): the
  arguments rarely come from the event alone — the total needs the order, the ID is new — so the mapping would cover
  the easy cases and push the others back into code, in two places. The generated input type gives the mapping a
  compiler-checked place in code instead. Like `emits X { a = b }` (ADR 0021), deferred.
- **L3, a process** (conditions, compensation, ordering, timeouts — a saga or process manager): workflow logic, which
  the DSL does not describe (it states structure and contracts, never behaviour). A condition belongs in the target
  command's `requires`, which the command checks wherever it is called from.

Also rejected: a declaration of cross-aggregate constraints with their means of enforcement (`rule … enforced by …`): it
would duplicate, unchecked, what policies, verified types (ADR 0023), `requires` and the aggregate boundaries already
state. Forcing handlers always (no `optional`) was rejected too: a policy is worth declaring for the map and the
documentation alone, and many applications wire reactions in infrastructure the generated code cannot see.

## Consequences

- Reactions are part of the model: checked, renamed with the event and the command, visible in the context map,
  `dt show`, the language server and the Live View.
- The generated types give the hand-written reaction a contract, and `required` makes the contract tests run it.
- `policy` is a keyword; it remains usable as a field, parameter and command name.
- See also ADR 0011 (generated code and your code), ADR 0018 (command events), ADR 0019 (decisions), ADR 0020
  (generated checks and contract tests), ADR 0023 (verified types).
