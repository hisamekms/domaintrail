# DomainTrail

A type-checkable domain modeling DSL shared by humans and AI.

DomainTrail models are `.dt` files that state a domain's **structure and contracts** — bounded contexts, aggregates
and their states, commands with what they require, change and emit, invariants — and are their single source of truth.
AI agents write the model and implement it; people watch it update live in the browser and give feedback on the model
rather than on the code. From the model, `dt` generates TypeScript types, command contracts, checks of the invariants
and requirements, and contract tests for your implementation — never business logic, which is written against the
generated types and held to the model by the compiler and the tests.

## Quick start

Requires Node.js 22.12 or later.

```bash
npm i -D domaintrail
```

Write a model, e.g. `booking/reservation.dt`:

```dt
context Booking "会議室予約" {
  id ReservationId: UUID
  primitive Headcount "人数": Int { value in 1..50 }

  aggregate Reservation "予約" {
    id: ReservationId
    attendees: Headcount
    state Requested
    state Confirmed {
      confirmedAt: Timestamp
    }

    create command request(id: ReservationId, attendees: Headcount) -> Requested
    command confirm(capacity: Headcount, at: Timestamp)
      Requested -> Confirmed
      requires roomFits { attendees <= capacity } else RoomTooSmall
      emits ReservationConfirmed
  }

  event ReservationConfirmed {
    reservationId: ReservationId
    confirmedAt: Timestamp
  }
  error RoomTooSmall
}
```

Check it, and watch it in the browser:

```bash
npx dt check      # 1 file(s) checked: 0 error(s), 0 warning(s).
npx dt view       # the Live View at http://127.0.0.1:4321, until Ctrl+C
```

Then `npx dt generate ts` writes the TypeScript into `generated/domain`. The package installs the command as `dt` and
as `domaintrail`, its full name, for when `dt` clashes with another command.

## Where to read next

- **[Getting started](docs/getting-started.md)** ([日本語](docs/getting-started.ja.md)): working with an AI agent,
  a first model step by step, generating, implementing and testing, and the editors.
- **[The guide](docs/guide.md)**, also printed by `dt guide` one topic at a time: the reference for the DSL and the
  CLI, written for people and AI agents. Start with its [quick reference](docs/guide.md#quick-reference).
- **[examples/shop](examples/shop/README.md)**: a complete example — the model, the generated code and the code an AI
  agent wrote against it, with the contract tests and a demo.
- **[The Live View](docs/live-view.md)**: every pane and view of `dt view`.
- **[Changelog](CHANGELOG.md)** ([日本語](CHANGELOG.ja.md)): what changed in each version, and how to upgrade.
- **[Design decisions](docs/adr)**: the ADRs behind the language.

## Features

- **The DSL**: contexts and shared contexts, aggregates with states and transitions, entities, value objects, domain
  primitives, unions, field sets, labels (表示名) and terms; invariants, command requirements (`requires`), the fields
  a command changes, the events it emits as an exact contract, verified types and policies.
- **`dt check`**: syntax, references, types and DDD rules, with a hint on what to change; text or JSON.
- **`dt fmt`**: one canonical layout for `.dt` files, keeping every comment.
- **`dt generate ts`**: types per context, command contracts and decisions for `decide`, checks of the invariants and
  requirements, constructors of domain primitives, and contract tests with fast-check (bun, vitest, jest, node).
- **`dt view`**: the Live View — context map, structure, state transitions, behaviour, source and the changes since the
  last save or a git revision, in Japanese or English.
- **`dt show`**: one element resolved, for people and agents, as text or JSON.
- **`dt lsp`**: a language server — diagnostics, definitions, references, hover, rename, formatting; a
  [Zed extension](editors/zed) and a [tree-sitter grammar](tree-sitter-domaintrail).
- **`dt guide`**: the guide in the terminal, one topic at a time.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for building, testing and releasing DomainTrail itself.

## License

MIT — see [LICENSE](LICENSE).
