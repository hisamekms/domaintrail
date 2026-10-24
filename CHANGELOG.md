# Changelog

[日本語](CHANGELOG.ja.md)

What changed in each version of domaintrail. The format follows [Keep a Changelog](https://keepachangelog.com/), and
the versions follow [Semantic Versioning](https://semver.org/) (before 1.0.0, a minor version may break models and
code).

**After upgrading domaintrail**, read the **Upgrading** section of every version between the one you had and the new
one, oldest first, and follow its steps. This file is in the package: `node_modules/domaintrail/CHANGELOG.md`.

## [Unreleased]

### Added

- [Getting started](docs/getting-started.md) in English and [Japanese](docs/getting-started.ja.md): working with an AI
  agent (the block for `CLAUDE.md` / `AGENTS.md`), a first model step by step, generating, implementing with `decide`,
  contract tests, linting, and the editors.
- [The Live View](docs/live-view.md): every pane and view of `dt view`, moved out of the README.
- This changelog, in English and Japanese, in the npm package (`CHANGELOG.md`, `CHANGELOG.ja.md`), and a GitHub Release
  with its notes for each version.

### Changed

- The README is organized around Getting started; the developer content moved to `CONTRIBUTING.md`.

### Fixed

- The Zed extension has its license file and an author address, as Zed's extension registry requires.

## [0.5.0] - 2026-10-24

### Added

- **Policies** (`dt guide reactions`, ADR 0022): `policy P when Event -> Aggregate.command` — when the event happens,
  the command of the policy's own context is eventually run. M023 checks the event, the aggregate and the command, and
  warns about the same reaction twice. Each policy generates the type of its handler, from the event to the command's
  input (`<Command><Aggregate>Input`). With `generate.ts.policies: "required"` (default `"optional"`, also per context
  in `generate.ts.contexts`), `<Context>PolicyHandlers` is generated and the contract tests take it and check that every
  event resolves to an input the command accepts. The context map counts a policy as an event dependency.
- **Verified types** (`dt guide verified`, ADR 0023): `verified X of T for C? errors E` — the evidence of a check made
  outside the aggregate (an email address nobody else uses). Only its async factory, `Make<Name>`, written by you, makes
  it; commands take it as a parameter. M024 keeps verified types to command parameters.
- **Payload names** (ADR 0021): M022 warns when an event or error field likely takes its value from a differently
  named source (a parameter, one of its fields, or a field of the aggregate before / after the command).
- **Zed extension** (`editors/zed`) and a **tree-sitter grammar** (`tree-sitter-domaintrail`): highlighting, outline and
  `dt lsp` in Zed; the grammar for other tree-sitter editors (`dt guide editors`).
- **Linting against casts** (`dt guide lint`): how to make every domain type without `as`, and how to enable
  `no-unsafe-type-assertion` with oxlint or typescript-eslint. `dt generate ts` prints a hint (`hints` in
  `--format json`) when no oxlint or ESLint config mentions the rule; `"lintHint": false` turns it off. The JSDoc of
  IDs, domain primitives and verified types names the way to make them.
- `parseDecimal(text)` in the generated runtime: the one place that makes a `Decimal`.
- `dt guide policies`: how to write rules that depend on a changeable policy.
- `examples/shop` is a complete project: every aggregate implemented, an application layer (use cases, repositories, an
  event store, policies, a verified type's factory), tests and a demo, described in its README.
- Language server: commands can be renamed.

### Changed

- Every command that collects the workspace's files (`check`, `generate`, `view`, `fmt`, `show`, `lsp`) skips what the
  `.gitignore` files (of the root, its subdirectories and its parents up to the repository's top) and
  `.git/info/exclude` ignore. `"respectGitignore": false` turns it off; files named on the command line are never
  skipped.
- When the language server finds no config file, the first `.dt` file opened below a config makes that config the
  workspace.

### Fixed

- A domain primitive over `Int` or `Decimal` can be compared with the numbers `count()` and `length()` compute.

### Upgrading

1. If `.dt` files of your model are in a directory that `.gitignore` ignores, they are no longer part of the
   workspace. Move them, or set `"respectGitignore": false` in `domaintrail.jsonc`. Run `dt check` and compare the
   file count with before.
2. M011: `parseDecimal` is now a runtime name. Rename an element of your model with that name.
3. Run `dt generate ts`. If it prints the lint hint, follow `dt guide lint` (or set `"lintHint": false`), and replace
   casts to domain types in your code with `make<Name>` / `parseDecimal`.
4. New warnings may appear: M022 (rename the event or error field after its source, or the source after the field).
   Warnings do not fail `dt check`.

## [0.4.0] - 2026-10-24

### Added

- **`requires`** on commands (`dt guide requires`, ADR 0017): `requires name { expr } else Error` — the command is
  accepted only if the expression holds, otherwise it returns the error (M019).
- **`changes`** on commands (`dt guide changes`, ADR 0019): the fields a command may change (M021).
- **`emits` with multiplicities and `when`** (`dt guide events`, ADR 0018): `X?`, `X[0..*]`, `X[1..*]`, `X[n..m]`, and
  `X when Draft ->` / `X when -> Completed` for events of some outcomes only.
- **`unique` and `contains`** in expressions, and invariants without an expression, stated in words only (M018; ADR
  0016).
- **Decisions and `decide`** (`dt guide decide`): each command is implemented as a `<Command><Aggregate>Decision` — per
  source state, the outcome's `set` and `events` — and `decide(<Aggregate>Shape, decision)` from the runtime makes the
  aggregate. The compiler names a missing event, an extra event, and a field the command may not set.
- **Generated checks and constructors** (ADR 0020): `check<Name>` / `check<Command><Aggregate>Requires` from the
  invariant and requirement expressions, and `make<Name>` for every ID and domain primitive.
- **Generated contract tests** (`dt guide tests`): with `generate.ts.tests` (`runner`: `bun`, `vitest`, `jest` or
  `node`; `out`), `dt generate ts` writes fast-check suites per context that check the constructors, the requirements,
  the invariants after each command, the events and purity. They need `fast-check` in your project.
- **`dt fmt`**: one canonical layout for `.dt` files, keeping every comment (`--check` for CI); also LSP formatting.
- **`dt show <name>`**: one element, state, command or context resolved, with who uses it (`--format json`).
- **`dt lsp`**: a language server with the diagnostics of `dt check`, definition, references, hover, outline,
  completion and rename.
- **Hints** on diagnostics (did you mean …, and what to change), and `--format json` for `check` and `generate ts`
  (schema in `schema/diagnostics.schema.json`).
- `@see <file>:<line>` on every generated declaration, pointing back to the DSL.
- Runtime helpers `outcome(value)` (`{ to, aggregate, events }`) and `eventList(events)` for code that handles any
  command.
- M020 (warning): a `create command` without a parameter of the aggregate's ID type.

### Changed

- **`emits X` means exactly one `X`** when the command succeeds (it meant "may emit"), and nothing on an error.
- **Command results are keyed by outcome**: `{ Confirmed: { aggregate, events: { OrderConfirmed } } }` instead of the
  tuple `[aggregate, events[]]`; events are keyed by name and have no order. A command without events has `NoEvents`.
- Commands are pure: IDs and times come in as parameters (factories take their ID).
- `ok` infers its type from the contract only, so an extra event in the literal is reported.
- Without `changes`, a command changes no common field.
- Generated modules export values (`<Aggregate>Shape`): import them as values, not with `import type`.
- `dt guide` prints a quick reference and the list of topics; `dt guide <topic>` one section, `dt guide <rule>` one
  rule, `dt guide --all` the whole guide.
- `[0..1]` is the same as `?` and `[1..1]` the same as no multiplicity.
- The Live View shows the multiplicity and `when` of each event, `requires` and `changes`, and hints in the problems
  pane.

### Removed

- `byState` and the `<Command><Aggregate>ByState` types (0.3.0): every command is implemented with `decide`.

### Upgrading

Change the model first, then generate, then the code. The full rules are in `dt guide events`, `dt guide changes` and
`dt guide decide`.

1. **Events.** `emits X` is now exactly one `X` on every success. For each `emits` entry, decide when the event
   happens and write it so:

   ```dt
   // before (0.3.0): "may emit"
   command changeNote(note: String?)
     Draft -> Draft, Confirmed -> Confirmed
     emits NoteChanged
   command cancel(reason: CancelReason)
     Draft | Confirmed -> Cancelled
     emits OrderCancelled, RefundRequested
   // after (0.4.0)
   command changeNote(note: String?)
     Draft -> Draft, Confirmed -> Confirmed
     changes note
     emits NoteChanged?                    // at most one; X[0..*] for any number
   command cancel(reason: CancelReason)
     Draft | Confirmed -> Cancelled
     emits OrderCancelled,
           RefundRequested when Confirmed -> // only from Confirmed
   ```

2. **Factories take their ID, commands take the time.** Add a parameter of the aggregate's ID type to each
   `create command` (M020 warns until you do), and a `Timestamp` parameter where the implementation read the clock:

   ```dt
   create command place(customer: CustomerId) -> Draft            // before
   create command place(id: OrderId, customer: CustomerId) -> Draft // after
   ```

   Callers make the ID (`make<Name>(crypto.randomUUID())`) and pass it in.
3. **`changes`.** Add `changes f1, f2` to every command that changes a field common to its source and target states
   (or any field of an aggregate without states). Without it, the generated decision does not let the command set the
   field.
4. **Optionally `requires`.** A check that returns an error before anything changes can become
   `requires name { expr } else Error`; the generated `check<Command><Aggregate>Requires` and the contract tests then
   check it.
5. **Reserved names (M011).** `decide`, `Decide`, `Shape`, `NoChanges`, `outcome`, `eventList`, `NoEvents`, `Outcome`,
   `EventOf`, `sameOptional`, `sameList` and `distinct` are runtime names, and `<Command><Aggregate>Decision`,
   `<Aggregate>Shape` are generated: rename elements whose names clash. Run `dt check` until it exits 0.
6. **Regenerate and rewrite every command with `decide`.** Return the outcome's `set` (the fields in `changes` and the
   target state's new fields; a factory sets every field, optional ones as `undefined`) and its `events`, keyed by the
   target state (by the aggregate's name without states). One handler per source state, also with one source; a
   factory is a single function:

   ```ts
   // before (0.3.0)
   import { byState, ok, type Sales } from '../generated/domain/index.js';
   export const orderCommands: Sales.OrderCommands = {
       place: (customer) => {
           const order: Sales.DraftOrder = { state: 'Draft', id: crypto.randomUUID() as Sales.OrderId, items: [], customer };
           return ok([order, [{ type: 'OrderPlaced', orderId: order.id }]] as const);
       },
       confirm: (order, at) =>
           ok([{ ...order, state: 'Confirmed', confirmedAt: at }, [{ type: 'OrderConfirmed', orderId: order.id, confirmedAt: at }]] as const),
       changeNote: byState<Sales.ChangeNoteOrderByState>({
           Draft: (order, note) => ok([{ ...order, note }, []] as const),
           Confirmed: (order, note) => ok([{ ...order, note }, []] as const),
       }),
   };

   // after (0.4.0)
   import { Sales, decide, ok } from '../generated/domain/index.js';
   export const orderCommands: Sales.OrderCommands = {
       place: decide<Sales.PlaceOrderDecision>(Sales.OrderShape, (id, customer) =>
           ok({ Draft: { set: { id, items: [], customer, note: undefined }, events: { OrderPlaced: { type: 'OrderPlaced', orderId: id } } } }),
       ),
       confirm: decide<Sales.ConfirmOrderDecision>(Sales.OrderShape, {
           Draft: (order, at) =>
               ok({ Confirmed: { set: { confirmedAt: at }, events: { OrderConfirmed: { type: 'OrderConfirmed', orderId: order.id, confirmedAt: at } } } }),
       }),
       changeNote: decide<Sales.ChangeNoteOrderDecision>(Sales.OrderShape, {
           Draft: (order, note) => ok({ Draft: { set: { note }, events: {} } }), // with `emits NoteChanged?`, give it when the note changes
           Confirmed: (order, note) => ok({ Confirmed: { set: { note }, events: {} } }),
       }),
   };
   ```

7. **Callers** read the keyed result: `result.value.Confirmed.aggregate` / `.events.OrderConfirmed`, or, in code that
   handles any command, `outcome(result.value)` → `{ to, aggregate, events }` and `eventList(events)`.
8. Type-check (`tsc --noEmit`). When the contract and the implementation disagree — an event that cannot always be
   emitted, a field that must change — change the DSL (`X?`, `changes`), not the implementation.
9. Optionally enable the contract tests (`generate.ts.tests`, `dt guide tests`) and run `dt fmt` once.

## [0.3.0] - 2026-10-19

### Added

- Handlers per source state: a command whose targets depend on its source state also gets
  `<Command><Aggregate>ByState`, implemented with `byState({...})` from the runtime (ADR 0015).
- The State View draws one edge per transition, and the inspector shows a row per transition.

### Changed

- **Commands list their transitions** instead of `from … to …` (ADR 0014): `Draft -> Confirmed`,
  `Draft | Confirmed -> Cancelled`, `Draft -> Draft, Confirmed -> Confirmed`; a factory has one transition without
  sources, `-> Draft`. A state is the source of one transition per command (M006). `from` and `to` are no longer
  keywords.
- The generated contract of a command whose targets depend on its source state is generic over the input state, so a
  `Draft` gives a `Draft` and a `Confirmed` a `Confirmed`.

### Fixed

- The `bin` paths of the package are written so that `npm publish` does not warn about them.

### Upgrading

1. Rewrite each command's `from … to …` as transitions:

   ```dt
   // before (0.2.0)
   create command place(customer: CustomerId) to Draft
   command confirm(at: Timestamp) from Draft to Confirmed emits OrderConfirmed
   command changeNote(note: String?) from Draft | Confirmed to Draft | Confirmed
   // after (0.3.0)
   create command place(customer: CustomerId) -> Draft
   command confirm(at: Timestamp) Draft -> Confirmed emits OrderConfirmed
   command changeNote(note: String?) Draft -> Draft, Confirmed -> Confirmed // say which source goes where
   ```

   `from A | B to C | D` becomes `A | B -> C | D` when every source may end in every target; prefer the precise
   transitions.
2. Run `dt check`, then `dt generate ts`. A command whose targets depend on its source state has a generic contract:
   implement it with `byState<Ctx.<Command><Aggregate>ByState>({ Draft: (…) => …, Confirmed: (…) => … })` instead of
   a type assertion.

## [0.2.0] - 2026-10-18

### Added

- **Field sets** (`dt guide field-sets`, ADR 0013): `fields Name { ... }` declares plain fields that aggregates,
  entities and events take on with `with A, B` (M016). Shared contexts may hold them. They generate an interface that
  the elements extend.
- Generated unions per context: `DomainEvent` (every event), `Aggregate` (every aggregate) and `<Aggregate>Event` (the
  events an aggregate's commands emit).
- M017 (warning): an event emitted by an aggregate's command has no field of that aggregate's ID type.
- The guide explains domain vs technical fields, and attaching technical metadata with envelopes.
- Live View: a filter bar in the catalog (text, kinds, contexts); field sets in the explorer, catalog, inspector and
  structure diagram.

### Changed

- Live View: catalog cards put the badges above the heading and the label over the name; the catalog's section links
  are gone (the filter finds a section).

### Upgrading

1. M011: `DomainEvent`, `Aggregate` and `<Aggregate>Event` are generated names now. Rename an element of a context
   whose name clashes with them, then run `dt check`.
2. `fields` and `with` are keywords; they are still allowed as field and parameter names.
3. Address the new M017 warnings by adding the aggregate's ID to its events (`orderId: OrderId`).

## [0.1.0] - 2026-10-18

The first published version.

### Added

- The DomainTrail DSL: bounded contexts, aggregates with states, entities, value objects, IDs, domain primitives,
  enums, unions, commands (`from … to …`), events (`persistent`), errors, shared contexts, labels and descriptions,
  and invariant expressions; rules M001–M015 and L001–L003.
- The `dt` CLI (also installed as `domaintrail`), on Node.js 22.12 or later: `dt check`, `dt generate ts` (TypeScript
  types and command contracts, one output directory per context with `generate.ts.contexts`), `dt view` and
  `dt guide`.
- `domaintrail.jsonc` (`sources`, `generate.ts`, `view`) with its JSON Schema in `schema/domaintrail.schema.json`.
- The Live View (`dt view`): the context map, the structure diagram (three levels), the catalog, the state diagram,
  the inspector with the source, problems and changes, updated on every save; in Japanese or English, light or dark.

[Unreleased]: https://github.com/hisamekms/domaintrail/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/hisamekms/domaintrail/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/hisamekms/domaintrail/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/hisamekms/domaintrail/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hisamekms/domaintrail/compare/b9f56885cde82f404bbf6b558f43b8ecb6254dfe...v0.2.0
[0.1.0]: https://github.com/hisamekms/domaintrail/tree/b9f56885cde82f404bbf6b558f43b8ecb6254dfe
