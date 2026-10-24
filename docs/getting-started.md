# Getting started

[日本語](getting-started.ja.md)

This page takes you from "what is this" to a working loop: an AI agent writes the domain model and the code, and you
review the model in the browser. It is written for people. The reference that agents read, and that you can look up
when you need the details, is the guide: `dt guide` in the terminal, the same text as [guide.md](guide.md).

DomainTrail is a language for domain models (`.dt` files) and a CLI, `dt`. The model states the **structure and the
contracts** of a domain — bounded contexts, aggregates and their states, commands with their requirements and events,
invariants — and is their single source of truth. `dt check` checks it, `dt view` shows it live in the browser, and
`dt generate ts` turns it into TypeScript types, command contracts, checks of the invariants, and contract tests for
your implementation. It never generates business logic: that is written by hand (or by the agent) against the
generated types, and the compiler and the tests hold it to the model.

## Working with an AI agent

This is the way DomainTrail is meant to be used. If you only want to get going: install it (`npm i -D domaintrail`,
see [Install](#install)), add the block below to your agent's instructions, run `npx dt view`, and ask the agent to
model something. The rest of the page walks through by hand what the agent does, so that you can follow its work.

### Who does what

- **The agent** edits the `.dt` files, runs `dt fmt` and `dt check` until the model is valid, generates the
  TypeScript and implements the commands against it, until the compiler, the linter and the generated contract tests
  pass.
- **You** watch the model in the Live View while the agent works: the structure, the states and transitions, what
  each command requires and emits. You do not need to read the `.dt` files or the generated code to review the model.
  You give feedback about the model, and the agent changes the `.dt` files.
- **The model** is where you and the agent agree. When the implementation and the model disagree, the model is
  changed first, and the code follows.

### Tell the agent how to work

Put this block into the file your agent reads at the start of every session — `CLAUDE.md` for Claude Code,
`AGENTS.md` for agents that read that — and adjust the paths and scripts to your project (they match the setup on this
page):

```markdown
## Domain model (DomainTrail)

The domain model is in `domain/**/*.dt` (DomainTrail DSL). It is the single source of truth for the domain's
structure and contracts; `generated/domain` is generated from it.

- Before working on the model, run `npx dt guide` and read it. Run `npx dt guide <topic>` (e.g. `npx dt guide requires`)
  for the details of what you are about to write.
- After every change to `.dt` files, run `npx dt fmt`, then `npx dt check` until it reports 0 errors.
- Then run `npx dt generate ts`, implement each command with `decide` against its generated
  `<Command><Aggregate>Decision` type, and run `npm run typecheck`, `npm run lint` and `npm test` (the generated
  contract tests) until they pass.
- Never edit generated files: change the `.dt` sources and generate again.
- When the contract and the implementation disagree, follow `@see` on the generated type to the declaration and
  change the DSL, not the implementation: never emit an event or set a field only to satisfy the types. Say what you
  changed in the model and why.
- Never cast to a domain type (`as X`): make values with `make<Name>`, `parseDecimal` or a verified type's factory.
- To look up one element, run `npx dt show <name>` (e.g. `npx dt show Booking.Reservation.confirm`) instead of reading
  the `.dt` files. Use `--format json` with `check`, `generate ts` and `show` when you parse the output.
- People watch the model in the Live View (`npx dt view`). Do not wait for it: it runs until stopped.
```

`dt guide` prints a quick reference of about one screen — the loop, the DSL at a glance, the commands — and the list
of topics, so the agent reads the details of one topic when it needs them, not the whole guide. `dt --help` also
points agents to it.

### Start a session

Start the Live View in a terminal of your own and open it in the browser:

```bash
npx dt view
```

Then ask for the model in the words of the domain, one step at a time. A model is reviewed more easily when the agent
stops after the `.dt` files, before any code:

- "Model meeting-room booking: a reservation is requested for a room and a time slot, and confirmed when the room is
  big enough. Only the `.dt` files for now."
- "Add a command `cancel` to Reservation: a requested or confirmed reservation can be cancelled, with a reason."
- "The model is fine. Generate the TypeScript, implement the commands of Booking and make the contract tests pass."

The Live View follows every save: added and changed elements are highlighted, removed ones appear as ghosts, and the
problems of the model are listed at the bottom while the agent fixes them.

### Give feedback from the Live View

Select the element you want to talk about — in the explorer on the left or in a diagram — and look at it in the
inspector on the right: its fields and invariants (構造), the states and transitions of its aggregate (状態遷移), what a
command requires, changes and emits (振る舞い), who uses it (参照) and its source (ソース). In the ソース tab, the copy
button on the highlighted declaration copies its code. Paste it into the conversation with what should change, or name
the element (`Reservation.confirm`; the 名前 / 両方 switch in the header shows the names next to the labels):

> `command confirm(capacity: Headcount, at: Timestamp) "確定する"` — a reservation should also record who confirmed
> it.

The agent finds the declaration with `dt show` (or the `// file:line` that `dt show` prints for each one), changes the
model, runs `dt check`, and you see the change in the Live View. When the agent says that the implementation could
not follow the model — an event it could not always emit, an error it could never return — it is the model that is
discussed and changed, never the generated types.

### Tools for agents

- `dt show <name>` prints one element, state or command resolved: the fields of field sets inline, the labels and
  where they come from, each command's transitions, requirements, the fields each outcome sets, carries over or
  drops, its events and errors, and who uses the element. A name may leave out its context when it is unique.
- `--format json` makes `check`, `generate ts` and `show` print one JSON document (the schema of the diagnostics is in
  `schema/diagnostics.schema.json` of the package).
- `dt lsp` is a language server: the diagnostics of `dt check` after every edit, definitions, references, hover and
  rename. With Claude Code, a plugin makes Claude see the diagnostics after each edit of a `.dt` file (see
  [Claude Code](#claude-code)).

## Install and the first model

This part builds a small model by hand, as the agent would: one bounded context with one aggregate.

### Install

DomainTrail needs Node.js 22.12 or later. Install it into your project:

```bash
npm i -D domaintrail
```

The package installs the same command under two names, `dt` and `domaintrail` (for when `dt` clashes with another
command). Run it with `npx dt`, or as `dt` from your package scripts. `npx domaintrail <command>` also works without
installing.

### Configure the project

A `domaintrail.jsonc` at the root of the project tells `dt` where the model is. Every key is optional; without the file,
every `.dt` file below the current directory is part of the model.

```jsonc
{
  "$schema": "./node_modules/domaintrail/schema/domaintrail.schema.json",
  "sources": ["domain/**/*.dt"]
}
```

The recommended layout is one directory per bounded context and one file per aggregate:

```text
domaintrail.jsonc
domain/
  booking/
    context.dt           the context's label, description and terms (when it has them)
    reservation.dt       an aggregate, with its ID and what only it uses
generated/domain/        written by dt generate ts: never edited
src/                     your code: the command implementations and the application
```

File names carry no meaning to `dt`: the layout is a convention that keeps a growing model easy to find your way
in (`dt guide layout`).

### Step 1: a context, an ID and an aggregate

Create `domain/booking/reservation.dt`:

```dt
// domain/booking/reservation.dt
context Booking "会議室予約" {
  id ReservationId: UUID

  aggregate Reservation "予約" {
    id: ReservationId
  }
}
```

A `context` is a bounded context. `id ReservationId: UUID` declares an ID type, and every aggregate has an `id` field
of its own ID type. The strings after the names are labels (表示名): display names, in any language, shown in the Live
View and in the generated JSDoc. This model uses Japanese ones; they are optional.

```bash
npx dt check
```

```text
1 file(s) checked: 0 error(s), 0 warning(s).
```

### Step 2: values and invariants

A reservation is for a room, a time slot and a number of people:

```dt
// domain/booking/reservation.dt
context Booking "会議室予約" {
  id ReservationId: UUID
  id RoomId: UUID
  primitive Headcount "人数": Int { value in 1..50 }
  value Slot "時間帯" {
    start: Timestamp
    hours: Int
    invariant withinDay "1〜8時間" { hours >= 1 and hours <= 8 }
  }

  aggregate Reservation "予約" {
    id: ReservationId
    room: RoomId
    owns slot: Slot
    attendees: Headcount
  }
}
```

- `primitive Headcount: Int { value in 1..50 }` is a domain primitive: a single value with a constraint. Every
  `Headcount` is between 1 and 50, wherever it is used.
- `value Slot` is a value object: values that belong together, compared by all their fields. Its `invariant` holds for
  every slot.
- `room: RoomId` refers to a room by its ID only, and `owns slot: Slot` holds the value inside the aggregate.

### Step 3: states, a command and an event

A reservation is first requested, then confirmed. Commands are the only way to make or change an aggregate:

```dt
// domain/booking/reservation.dt
context Booking "会議室予約" {
  id ReservationId: UUID
  id RoomId: UUID
  primitive Headcount "人数": Int { value in 1..50 }
  value Slot "時間帯" {
    start: Timestamp
    hours: Int
    invariant withinDay "1〜8時間" { hours >= 1 and hours <= 8 }
  }

  aggregate Reservation "予約" {
    id: ReservationId
    room: RoomId
    owns slot: Slot
    attendees: Headcount

    state Requested "申込み"
    state Confirmed "確定" {
      confirmedAt: Timestamp
    }

    create command request(id: ReservationId, room: RoomId, slot: Slot, attendees: Headcount) "申し込む"
      -> Requested
      emits ReservationRequested
  }

  event ReservationRequested "予約申込み" {
    reservationId: ReservationId
    room: RoomId
    slot: Slot
  }
}
```

- `state Confirmed { confirmedAt: Timestamp }` is a state with a field of its own: a reservation has a `confirmedAt`
  only once it is confirmed.
- `create command request(…) -> Requested` makes a new reservation in the state `Requested`. It takes the new ID as a
  parameter: commands are pure functions, so IDs and times come in from outside.
- `emits ReservationRequested` is a contract: the command emits exactly one such event whenever it succeeds.

### Step 4: a command with a requirement

Confirming needs the room to be big enough. The room's capacity is data of another aggregate, so it comes in as a
parameter:

```dt
// domain/booking/reservation.dt
context Booking "会議室予約" {
  id ReservationId: UUID
  id RoomId: UUID
  primitive Headcount "人数": Int { value in 1..50 }
  value Slot "時間帯" {
    start: Timestamp
    hours: Int
    invariant withinDay "1〜8時間" { hours >= 1 and hours <= 8 }
  }

  aggregate Reservation "予約" {
    id: ReservationId
    room: RoomId
    owns slot: Slot
    attendees: Headcount

    state Requested "申込み"
    state Confirmed "確定" {
      confirmedAt: Timestamp
    }

    create command request(id: ReservationId, room: RoomId, slot: Slot, attendees: Headcount) "申し込む"
      -> Requested
      emits ReservationRequested
    command confirm(capacity: Headcount, at: Timestamp) "確定する"
      Requested -> Confirmed
      requires roomFits "部屋に収まる" { attendees <= capacity } else RoomTooSmall
      emits ReservationConfirmed
  }

  event ReservationRequested "予約申込み" {
    reservationId: ReservationId
    room: RoomId
    slot: Slot
  }
  event ReservationConfirmed "予約確定" {
    reservationId: ReservationId
    confirmedAt: Timestamp
  }
  error RoomTooSmall "部屋が狭い"
}
```

- `Requested -> Confirmed` is the transition: `confirm` takes a requested reservation and makes a confirmed one, which
  sets the new state's `confirmedAt`.
- `requires roomFits { attendees <= capacity } else RoomTooSmall`: the command is accepted only when the expression
  holds; otherwise it returns the error `RoomTooSmall` and emits nothing.
- Fields of events are named after where their value comes from (`confirmedAt` of the state `Confirmed`), so that the
  implementation does not have to guess.

That is the whole model of this page. `dt guide` lists what else the language has: unions, shared contexts, field
sets, `changes`, conditional events, verified types, policies.

### When something is wrong

Say `confirm` is written with two typos, `attendee <= capacity` and `emits ReservationConfirm`. `dt check` says where
and what, with a hint when it has one:

```text
domain/booking/reservation.dt:28:36 - error M001: Cannot resolve name 'attendee'.
  hint: did you mean 'attendees'?
domain/booking/reservation.dt:29:13 - error M007: Cannot resolve event 'ReservationConfirm' in this context (use Context.Name for other contexts).
  hint: did you mean 'ReservationConfirmed'?
1 file(s) checked: 2 error(s), 0 warning(s).
```

It exits 1 while there are errors; warnings do not fail it. Each diagnostic names its rule, and `dt guide M001` prints
the rule and the topics that explain it. `dt check --format json` prints the same as one JSON document.

`dt fmt` writes every `.dt` file in one canonical layout, keeping the comments, so that a diff shows only what
changed. `dt fmt --check` changes nothing and fails when a file is not formatted (for CI):

```text
domain/booking/reservation.dt
1 file(s) checked: 1 not formatted. Run `dt fmt` to format them.
```

### Watch it in the Live View

```bash
npx dt view
```

```text
Config: domaintrail.jsonc
Live View: http://127.0.0.1:4321/
```

Open the address in the browser; it runs until Ctrl+C (`--port` to change the port). What to look at for this model:

- **Structure** (the main view): the context `Booking` with `Reservation`, the value `Slot` it owns, and the ID it
  refers to.
- Select `Reservation`, then **状態遷移** in the inspector: `request` makes a `Requested` reservation, `confirm` moves
  it to `Confirmed`.
- Select `confirm`, then **振る舞い**: its requirement `roomFits`, its error `RoomTooSmall` and its event.
- Change the file and save: the view follows. Break something: the problem appears at the bottom, and the last valid
  diagram stays.

The panes, the views and the settings are described in [The Live View](live-view.md).

## Generate, implement, test

### Generate the TypeScript

Add `generate` to `domaintrail.jsonc`. With `tests`, `dt generate ts` also writes contract tests, here for vitest:

```jsonc
{
  "$schema": "./node_modules/domaintrail/schema/domaintrail.schema.json",
  "sources": ["domain/**/*.dt"],
  "generate": {
    "ts": {
      "out": "generated/domain",
      "tests": { "runner": "vitest" } // bun, vitest, jest or node; into generated/domain/tests
    }
  }
}
```

```bash
npx dt generate ts
```

```text
1 file(s) checked: 0 error(s), 0 warning(s).
TypeScript written to generated/domain, generated/domain/tests
hint: no lint rule against casts to domain types found (no-unsafe-type-assertion); see dt guide lint
```

It checks the model first and writes nothing when there are errors. The hint goes away once the lint rule below is
set up. `generated/domain/Booking.ts` holds the types of the context — `Reservation` is
`RequestedReservation | ConfirmedReservation` — the contract of each command, the generated checks and the
constructors of IDs and domain primitives. Every declaration's JSDoc ends with `@see domain/booking/reservation.dt:…`,
the place in the model it comes from. Never edit these files; generate them again after changing the model
(`examples/shop` keeps them out of git, in `.gitignore`).

Install what your own code needs, and add to `package.json` the scripts the agent's instructions name:

```bash
npm i -D typescript fast-check vitest oxlint oxlint-tsgolint
```

```json
{
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "oxlint --type-aware",
    "test": "vitest run"
  }
}
```

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "generated"]
}
```

### Implement a command with decide

Each command is implemented as a **decision**: for its outcome, the fields to `set` and the `events`. `decide` from the
generated runtime makes the aggregate from it, taking the other fields from the input. The compiler checks every
outcome against the contract: a missing event, an event the contract does not emit, or a field the command may not
set is a compile error that names it.

```ts
// src/reservation-commands.ts
import { Booking, decide, err, ok } from '../generated/domain/index.js';

export const reservationCommands: Booking.ReservationCommands = {
    request: decide<Booking.RequestReservationDecision>(Booking.ReservationShape, (id, room, slot, attendees) =>
        ok({
            Requested: {
                set: { id, room, slot, attendees },
                events: { ReservationRequested: { type: 'ReservationRequested', reservationId: id, room, slot } },
            },
        }),
    ),

    confirm: decide<Booking.ConfirmReservationDecision>(Booking.ReservationShape, {
        Requested: (reservation, capacity, at) => {
            // the requirement's expression stays the DSL's: the generated check evaluates it
            if (Booking.checkConfirmReservationRequires(reservation, capacity, at)) return err({ type: 'RoomTooSmall' });
            return ok({
                Confirmed: {
                    set: { confirmedAt: at },
                    events: { ReservationConfirmed: { type: 'ReservationConfirmed', reservationId: reservation.id, confirmedAt: at } },
                },
            });
        },
    }),
};
```

The decision of `confirm` has one handler per source state (here only `Requested`), so that a command that runs in
several states is written the same way. `dt guide decide` explains the shape of the results.

### Make domain values

Domain types are brands: a `Headcount` is a `number` the compiler tells apart, which only `makeHeadcount` makes. Make
them with the generated constructors, never with a cast:

```ts
// src/request.ts
import { Booking } from '../generated/domain/index.js';
import { reservationCommands } from './reservation-commands.js';

/** Makes the domain values from plain input, then runs the command. */
export function requestReservation(input: { room: string; start: Date; hours: number; attendees: number }) {
    const attendees = Booking.makeHeadcount(input.attendees); // Result: the value, or InvalidHeadcount
    if (!attendees.ok) return attendees;
    const slot: Booking.Slot = { start: input.start, hours: input.hours };
    if (Booking.checkSlot(slot).length > 0) throw new Error('a slot is 1 to 8 hours');
    const id = Booking.makeReservationId(crypto.randomUUID()); // an ID has no invariants: it cannot fail
    return reservationCommands.request(id, Booking.makeRoomId(input.room), slot, attendees.value);
}
```

- `make<Name>` exists for every ID and domain primitive. It returns a `Result` when the type has invariants
  (`makeHeadcount`), the value itself when it has none (`makeReservationId`).
- `check<Name>` returns the invariants a value violates (`checkSlot`): value objects are plain objects.
- A `Decimal` is made with `parseDecimal(text)` from the runtime (`undefined` when the text is not a number).
- Where IDs and times come from is the application's choice; the command only takes them.

### Wire the contract tests

The generated tests check what the types cannot: the values. They generate inputs with fast-check and use the
generated checks as the oracle — the constructors accept exactly the valid values, a command returns the error of the
first requirement that does not hold, an aggregate made by a command holds the invariants of its state, and commands
are pure. Register them with one test file:

```ts
// src/contract.test.ts
import { Booking as Domain } from '../generated/domain/index.js';
import { Booking, register } from '../generated/domain/tests/index.js';
import { reservationCommands } from './reservation-commands.js';

register(
    Booking.contract({
        make: { ReservationId: Domain.makeReservationId, RoomId: Domain.makeRoomId, Headcount: Domain.makeHeadcount },
        Reservation: reservationCommands,
    }),
);
```

```text
$ npx vitest run

 Test Files  1 passed (1)
      Tests  6 passed (6)
```

With `"runner": "bun"` the same file runs with `bun test` (add `"types": ["bun"]` to `tsconfig.json`). If `confirm`
forgot its requirement, the test would say so with the shrunk counterexample:

```text
Got error: Reservation.confirm({"state":"Requested",…,"attendees":2}, 1, new Date("2000-01-01T00:00:00.000Z")) succeeded, but requirement 'roomFits' does not hold: expected the error RoomTooSmall.
```

What happens around the commands — loading, saving, publishing events — is outside the generated tests and covered by
your own (`dt guide tests`).

### Lint against casts

A cast (`'x' as Booking.RoomId`, `5 as Booking.Headcount`) makes a domain value without its constructor, so nothing
checks it. Let the linter report casts that narrow a type, and leave the generated directory out (it makes the domain
types, so it casts):

```jsonc
// .oxlintrc.json — run `oxlint --type-aware`
{
  "plugins": ["typescript"],
  "rules": { "typescript/no-unsafe-type-assertion": "error" },
  "ignorePatterns": ["generated/**"]
}
```

```text
src/bad.ts:2:35: error typescript(no-unsafe-type-assertion): Unsafe type assertion: type 'RoomId' is more narrow than the original type. …
```

With typescript-eslint, the rule is `@typescript-eslint/no-unsafe-type-assertion` with type information; `dt guide lint`
shows both configurations. The only legitimate casts are in factories (your own `Make<Name>`, a verified type's
factory), each with a disable comment that says why.

### Beyond this model

Two features connect an aggregate with the world outside it; both are explained in the guide and used in
`examples/shop`.

A **verified type** (`dt guide verified`) is the evidence of a check a pure command cannot make — an email address no
other customer uses. You write its factory, the only code that may assert the type:

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

A **policy** (`dt guide reactions`) states "when this event happens, that command eventually runs". Its handler,
which you write, computes the command's input from the event:

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

### The complete picture

[examples/shop](../examples/shop/README.md) is a complete project: a model of three contexts, the generated code, and
the code an AI agent wrote against it — the commands, a small application layer with repositories, an event store and
a policy across contexts — with the contract tests, the application's tests and a demo. Its README explains what was
written and why, including the two times the model was changed because the implementation could not follow it.

## Editors

The editor support comes from `dt lsp`, a language server over stdio: the diagnostics of `dt check` with the unsaved
text, go to definition, find references, hover, outline, completion, rename and formatting. The workspace is the one
`dt check` would find from the project directory.

### Zed

The extension in [`editors/zed`](../editors/zed) highlights `.dt` files, gives an outline and starts `dt lsp`. It is
not in Zed's extension registry yet: install it from a clone of this repository with *zed: install dev extension*,
choosing the `editors/zed` directory. Building it needs Rust, installed with rustup. It runs the first of:
`lsp.domaintrail.binary` in Zed's settings, `dt` on the `PATH`, else the domaintrail version the extension pins, which
it installs into its own directory. It does not run the project's `node_modules/.bin/dt` unless the settings name it
(`dt guide editors`).

### Claude Code

A Claude Code plugin can declare the language server in an `.lsp.json` at the plugin root; load the plugin with
`claude --plugin-dir <plugin directory>`. Claude then sees the diagnostics after each edit of a `.dt` file, without
running `dt check`:

```json
{
  "domaintrail": {
    "command": "dt",
    "args": ["lsp"],
    "extensionToLanguage": { ".dt": "domaintrail" }
  }
}
```

`dt` must be on the `PATH` for this; otherwise use `"command": "npx", "args": ["dt", "lsp"]`.

### Other editors

Any LSP client works with the command `dt lsp` (or `npx dt lsp`), transport stdio, for files ending in `.dt`. There is
no VS Code extension yet; a generic LSP client extension can start the server. Editors that highlight with
tree-sitter (Neovim, Helix, Emacs) can use the grammar in
[`tree-sitter-domaintrail`](../tree-sitter-domaintrail).

## Where to go next

- `dt guide` and [guide.md](guide.md): the reference for the language and the CLI, one topic at a time.
- [examples/shop](../examples/shop/README.md): a complete example with an implementation.
- [The Live View](live-view.md): every pane and view of `dt view`.
- [docs/adr](adr): the design decisions behind the language.
