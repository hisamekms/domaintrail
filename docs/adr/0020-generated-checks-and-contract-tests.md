# ADR 0020: Generated checks and contract tests

- Status: accepted
- Date: 2026-10-24
- Amends: [ADR 0011](0011-generated-code-boundary.md) (generated code may hold logic derived 1:1 from DSL
  expressions) and [ADR 0017](0017-command-requirements.md) (requirements are checked by generated code; the first
  failing one decides the error)

## Context

The DSL is written by AI agents, and AI agents implement against the generated TypeScript. After ADR 0018 and 0019 the
types guarantee a command's events (kinds and the counts `X`, `X?`, `[0..*]`, `[1..*]`), its targets, the fields it
changes, what is carried over, and its error kinds. They do not guarantee **values**: that a `Make<Name>` rejects
`1000` for `value in 1..999`, that `confirm` returns `EmptyOrder` exactly when the order has no items, that a
cancelled order holds `otherNeedsNote`, that `ItemAdded[2..5]` is emitted two to five times, or that a command is pure.

The invariants and requirements already state these values as expressions with a defined semantics (ADR 0016), but
only as JSDoc: every implementation re-derived them by hand, and nothing compared the implementation with the model.
ADR 0011 recorded generating checks as a direction under consideration; ADR 0016 and 0017 named the slots for
constraints without an expression.

## Decision

### D1. Checks generated into the product code

Every invariant and requirement **expression** is translated 1:1 into a pure TypeScript function in the context's
module, next to the types it checks:

- per domain primitive with invariants `check<Name>(value)`, and for every domain primitive and ID `make<Name>`,
  implementing `Make<Name>` (the hand-written constructor of ADR 0011 becomes optional);
- per value object, entity and union with invariants `check<Name>(x)` (a union: the invariants of its variant);
- per aggregate with invariants `check<State><Aggregate>(x)` (the aggregate's and the state's invariants) and
  `check<Aggregate>(x)` (by its `state`);
- per command with requirements `check<Command>Requires(aggregate, …params)` with the parameters of its contract;
- per value object, entity and union `equal<Name>(a, b)`, the equality of ADR 0016.

An invariant check returns the violated invariants, in declaration order (`readonly ('a' | 'b')[]`, empty when the
value holds them); a requirement check the name of the first requirement that does not hold, or `undefined`.
`Invalid<Name>` reports the **first** violated invariant in declaration order.

The semantics are the DSL's: equality by value, all fields, `id`, or tag and fields; `exists` and `implies` as written
(an optional guarded by `exists` is read as present); regular expressions as JavaScript (`matches` is `RegExp.test`);
`length` is the string's `length`; Decimals (carried as strings) and Ints compare as numbers, Timestamps by time.
`_runtime.ts` gains three generic helpers for it: `sameOptional`, `sameList` and `distinct` (`unique`).

The Typed Model carries each expression as a tree (`InvariantModel.expr`, `RequirementModel.expr`), which the
generator reads; `dt show --format json` leaves it out (its `source` says the same to readers).

#### Slots for constraints without an expression

They cannot be generated. Their check becomes a typed slot that the user's code fills in and passes in, so that
generated code still never imports users' code:

```ts
export type SkuDeclaredChecks = { readonly reserved: (value: string) => boolean };
export function checkSkuWith(checks: SkuDeclaredChecks): (value: string) => readonly InvalidSku['invariant'][];
export const makeSkuWith: (checks: SkuDeclaredChecks) => MakeSku;
```

A type with such a constraint has only the `…With` form, which combines the generated parts and the slots in
declaration order; one without it has only the plain function. Aggregates have one `<Aggregate>DeclaredChecks` for all
their states (invariant names are unique across them, M002); requirements have `<Command>DeclaredRequires` and
`check<Command>RequiresWith`.

### D2. Several failing requirements: the first decides

When several requirements of a command do not hold, the command returns the `else` error of the **first** in
declaration order. A contract rule (ADR 0017 amended): the model's order is the order of the checks, and the tests
expect exactly that error.

### D3. Inputs: property-based, overridable, with examples

The tests generate inputs with fast-check from the types: IDs, domain primitives (ranges, lengths and the first
regular expression of their invariants as hints, `fc.stringMatching` for patterns), enums, value objects, entities,
unions, collections with their multiplicities, aggregates per state. Every generated value is filtered by the generated
checks. Values of a type are drawn often from a small pool (three values sampled with the seed), so that duplicates,
`contains`, `!=` and `unique` are decided both ways — random strings and UUIDs would almost never collide.

- Users override the arbitrary of any type (still filtered) and add examples: valid aggregates per state, mixed into
  the generated ones, and arguments per command, run first through fast-check's `examples`.
- Deterministic by default: seed 42, configurable, with fast-check's shrinking; a failure shows the counterexample and
  the seed.
- When filtering rejects 1000 values in a row, the case fails with a message naming the type to override.
- fast-check is a (dev) dependency of the user's project. It is not a runtime dependency of `domaintrail`: the
  generated product code does not use it, and the CLI only writes text.

### D4. Runner-agnostic suites and adapters

Per context, `tests/<Context>.ts` exports `arbitraries(options?)` and `contract(impl, options?)`, which returns a suite
(`{ name, children }`) of test cases `{ name, run(): void | Promise<void>, todo? }`. `impl` names what to test, each
optional: the constructors by primitive and the `<Aggregate>Commands` by aggregate. Options: `seed`, `runs`,
`arbitraries` and `declared` (by context, the same object for every context), `examples` (the context's own).

`generate.ts.tests: { out?, runner? }` in the config enables them (default directory `<out>/tests`, following
`--out`); `runner` (`bun`, `vitest`, `jest`, `node`) adds `_register.ts`, a few lines that register a suite with that
runner. The generic helpers are `tests/_testing.ts`, the same for every model; it is kept in the repository as a
type-checked source file (`src/generator/testing/_testing.ts`) and embedded as text. Like every generated file, the
test modules are recorded in `.domaintrail/generated.json`.

### D5. Inputs are always valid

Tests feed only aggregates that hold their invariants and parameters of their types. What a command does with invalid
input is outside its contract.

### The tests

| | Checks |
|---|---|
| T1 | `make<Name>`: values at and next to each bound of ranges and lengths, random values and strings for regular expressions; accepted exactly when the generated check finds no violation, else `Invalid<Name>` with the first violated invariant |
| T2 | the first failing requirement's `else` error; when all hold, none of the `else` errors (an error also listed in `errors` included: the model cannot tell them apart, and a command that returns it for another reason should name another error) |
| T3 | after success, the aggregate is in the outcome's state and holds its invariants (`check<Aggregate>`) |
| T4 | events with bounds the types do not express (`X[2..5]`, `X[2..*]`) are emitted that many times, for the outcomes their `when` selects |
| T5 | purity: the same input twice gives deep-equal results, and the input is not changed |

Every call gets its own deep copy of the input, so that an implementation that changes its input cannot change values
fast-check reuses. Constraints without an expression whose check is not passed in `declared` are listed as todo
cases, and the tests accept either outcome where such a constraint would decide (the error of a declared requirement
before the first failing one, the invariant of a declared invariant before the first violated one).

### ADR 0011 amended: logic derived 1:1 from DSL expressions

Generated code may contain logic **derived 1:1 from DSL expressions**: the checks, the equality they use, and the
constructors of domain primitives built from them. Everything else in ADR 0011 stands: generated files are never
edited and hold only what follows from the DSL; generated code never imports users' code (slots are passed in); users
write the behaviour — command implementations and the constraints the DSL does not express. Users may ignore the
generated checks and write their own; the tests use the generated ones as the oracle either way.

### Layout

| File | Holds |
|---|---|
| `<out>/<Context>.ts` | the types, as before, and the checks next to the types they check |
| `<out>/_runtime.ts` | also `sameOptional`, `sameList`, `distinct` |
| `<tests>/_testing.ts` | the generic test helpers (fast-check) |
| `<tests>/<Context>.ts` | `Arbitraries`, `DeclaredChecks`, `Examples`, `Options`, `Implementation`, `arbitraries`, `contract` |
| `<tests>/_register.ts` | the adapter of the configured runner |
| `<tests>/index.ts` | re-exports the helpers, `register` and one namespace per context |

Checks live in the context modules rather than a separate `<Context>.checks.ts`: users reach them as
`Sales.makeQuantity` and `Sales.checkConfirmedOrder` next to the types, and an AI agent reading the contract sees the
check where the invariant is documented. Their names join M011.

## Consequences

- `Make<Name>` need not be written by hand; invariants and requirements have one implementation, generated from the
  model, that applications and tests share.
- A model change changes the checks and the tests with it; an implementation that no longer follows the model fails
  its contract tests (the shop example's `cancel` was missing the requirement that `Cancelled` needs a note for
  `Other`, which the tests found).
- Generated modules import other contexts as values when their equality is used.
- Not covered: whether `decide` was used (ADR 0019 makes changed fields a type error), properties across commands
  (sequences), and whether a declared constraint's check is right — it is the user's code.
