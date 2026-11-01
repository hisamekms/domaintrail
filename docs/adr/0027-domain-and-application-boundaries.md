# ADR 0027: Domain boundaries and application boundaries — contexts, capabilities, platform, apps

- Status: accepted, not implemented. Implementation waits until the large pull request in flight has landed. Decided
  by the maintainer: the split into contexts and capabilities, the checkers moved onto the typed model, Modeling
  described in its own `.dt`, protocols as a separate export, the boundary map as a TypeScript table first, the
  project analysis as its own capability named `analysis`, the top-level names, and authorization written with
  parameters and `requires` without new syntax (marked *Decided by the maintainer*).
- Date: 2026-11-01
- Input: the code on `main` at `8a77a8d` (M0, ADR 0025, and M1, ADR 0026, merged).

## Context

M0 split the code into workspace packages by functional area (`modeling`, `workspace`, `visualization`,
`presentation`, `composition`, `web`); M1 added `collaboration` and `agent`. The packages mix two kinds of boundary
that change for different reasons:

- **Domain boundaries**: what the users of domaintrail talk about and the rules they hold — the model, Event Storming,
  the collaboration. They change when the understanding of the domain changes.
- **Application and technical boundaries**: what the tool does with the domain and how — drawing graphs, emitting
  TypeScript, running Claude Code, reading files. They change with features and technology.

Mixing them has costs the code already shows:

- `visualization/src/domain/` is a functional core named `domain`. It holds drawing measures (`CHAR_WIDTH`,
  `LINE_HEIGHT`, `HEADER_HEIGHT`), display languages and modes, next to domain knowledge that grew there: the model
  diff (`ModelDiff`, `fingerprints`, `diffModels`), `aggregateDependencies`, the storming's semantic edges and
  timeline occurrences. "Domain" means two things: the product's domain and a module's pure core.
- `modeling` (about 9,000 lines) holds the `.dt` language, the checkers, the typed model, the TypeScript generator, the
  formatter, the whole `.dtes` language, the project analysis and the project configuration, with cycles between its
  directories: `core/analyze → storming → core`; `core/config → generator` (`RUNNERS`, `POLICY_MODES`);
  `core/checker/{tsnames,events} → generator/naming`; `model/build → core/checker/expressions`, `format`.
- The 13 checkers run on the Langium AST and `ModelIndex`; the typed model (`DomainModel`) is built after them and is
  what every consumer downstream reads.
- No package has a public surface: every import across packages is a deep path (`@domaintrail/modeling/model/model`,
  `@domaintrail/visualization/domain/graph/ir`, `@domaintrail/modeling/core/analyze`, ...).
- Rules between packages are added one by one to `test/architecture.test.ts` ("collaboration reaches only modeling and
  the types of visualization", "only agent, composition, presentation and web depend on collaboration"). They are a
  dependency graph that is nowhere declared as one.
- `core/config.ts` in `modeling` holds settings owned by others: the generator's options, the server's port and host,
  the session's identity mode and participant limit, the agent's tools.
- Business rules about who may do what live in HTTP routes: `presentation/src/session/routes.ts` keeps a per-route
  role table, and the handler of `dismiss` decides "the author or the facilitator". Another entry point calling the
  same use case would skip them.

## Decision

### Three kinds of module

| Kind | Answers | Holds | Replacing it |
|---|---|---|---|
| **Context** (bounded context) | What do we deal with? | concepts and rules the users talk about | changes what the product means |
| **Capability** | What does the app do with it? | the behavior and specification of a feature (what is shown, how TypeScript is named, what is checked) | changes a feature's behavior as users see it |
| **Infrastructure** | How is it done? | technology (ELK, SQLite, Langium, the file system, child processes) | must not change behavior users see |

A capability owns no domain state. It uses contexts in one of three ways:

- **orchestrates** their application use cases (`analysis` runs Modeling's and Storming's analyses and Generation's
  checks);
- **projects or translates** their published language — types and pure functions, read only, without going through
  their application (`visualization` turns `DomainModel` and `Storming` into graphs; `generation` into TypeScript);
- **drives** a context through the ports it defines or the API it offers (`agent` claims a request, runs it, reports
  the result).

Two rules keep the line: domain rules that grow inside a capability move to their context; a capability changes a
context's state only through that context's application.

Questions to classify a piece of code: Would it exist as a rule of the work without software? → context. Do users call
it a feature, with options and output rules? → capability. Can it be swapped for another technology without users
noticing? → infrastructure.

### Layout

```text
contexts/                  bounded contexts (the DSL's word `context`)
  modeling/
    model/*.dt             the context's contracts, written in domaintrail
    src/
      generated/           `dt generate ts`, committed
      domain/              typed model, rules (checkers), model diff, dependency analysis
      application/         use cases and ports
      infrastructure/
        syntax/            the Langium grammar, the parser, AST → domain, the printer of the notation
      index.ts             published language (the `.` export)
      protocol.ts          wire types, when it has any (the `./protocol` export)
  storming/                same shape; `syntax/` holds the `.dtes` grammar
  collaboration/           same shape; `infrastructure/` holds SQLite, blobs, identity

capabilities/              app features over the contexts' published language
  analysis/                the project analysis (`dt check`): sources by language, Modeling → Storming → link →
                           Generation's checks, one `Analysis`; owns the `sources` setting
  visualization/           core/ (projection, view options, line changes), application/ (ViewService), adapters/ (ELK,
                           git, layout store), protocol.ts
  generation/              core/ (TypeScript, checks, tests; naming; the TypeScript name check); owns its settings
  agent/                   core/ (subscriber, prompt, claim and heartbeat policy), adapters/ (agent API client, Claude
                           Code process, dt tools, workspace scan)

platform/                  infrastructure shared by everyone, knowing no context
  workspace/               files, watching, git refs, .gitignore, snapshots, reading the configuration file

shared/
  kernel/                  Diagnostic, SourceFile, Location, didYouMean — kept small

apps/                      deliverables: entry points and wiring
  dt/                      the one binary: cli/, lsp/, server/ (http, websocket, session routes), main.ts (wiring)
  web/                     the browser app: app/, view/, storming/, session/, shared/
```

- `domain/` appears only under `contexts/`. A capability's pure part is `core/` and its technology is `adapters/`; a
  context's technology is `infrastructure/`. The layer rules apply to both: `domain/` and `core/` import no I/O.
- Each context has `model/*.dt` and `src/generated/`, as `collaboration` does today. An agent reads `model/` and
  `index.ts` to learn a context's contract.
- `apps/dt` merges today's `presentation` and `composition`: one deliverable, one place for its entry points and its
  wiring. `web` is a separate build and stays a separate app.

### Dependency rules

| From → to | contexts | capabilities | platform | shared/kernel |
|---|---|---|---|---|
| contexts | declared upstream only, published language only | ✗ | ✗ | ✓ |
| capabilities | published language and application only | declared only (`analysis → generation`) | ✓ | ✓ |
| platform | ✗ | ✗ | ✓ | ✓ |
| apps | published language and application only | ✓ | ✓ | ✓ |

Upstream contexts: Storming → Modeling; Collaboration → Modeling, Storming. Today's test also lets Collaboration
take visualization's types; it imports none, and the map does not carry that edge over.

- Across packages only what `package.json` `exports` lists is imported: `.` (published language and use cases) and
  `./protocol` where a module has wire types. Deep imports are rejected.
- The map — kind of each package, its declared upstreams, its exceptions — is one TypeScript table read by
  `test/architecture.test.ts`. It replaces the per-package rules there. *Decided by the maintainer:* a table first;
  it moves to a `.dt` context map (ADR 0006) once the context map can say upstream/downstream and published language.

### Enforcement

What can be stopped by a mechanism is; the architecture test covers the rest; review covers what is about meaning.

| Stage | Mechanism | Stops |
|---|---|---|
| Declared dependencies | Bun's isolated linker, each package's `package.json` | imports of undeclared packages, at install and run time |
| Public surface | `exports` narrowed to `.` and `./protocol` (today `"./*"` exposes every file) | deep imports, at typecheck (`moduleResolution: bundler` follows `exports`) |
| Architecture test | `test/architecture.test.ts` reading the map | the rest, below |
| Review | this ADR, pull request review | rules about meaning: a capability holds no domain state; domain rules do not grow in a capability |

The linker alone is not enough: a lookup that misses a package's own `node_modules` walks up to the root's, which
hold every `@domaintrail/*` package (the note at the top of `test/architecture.test.ts`). The test checks:

- each `package.json` declares exactly the `@domaintrail/*` packages the map allows (derived from the map, not listed
  again);
- the rules between kinds in the table above;
- `exports` lists only `.` and `./protocol`;
- the layers: `domain/` and `core/` import no I/O, only `apps/` imports another package's `infrastructure/` or
  `adapters/`;
- no violation outside the exception list, and **no exception that no longer occurs**, so the list only shrinks.

A failure names the rule, this ADR and the usual fix ("a context may not import a capability; move the domain
knowledge into the context, or let the capability read the context's published language"), so that an agent can fix
it without reading the ADR first.

No lint rule (`no-restricted-imports`) and no third-party tool (dependency-cruiser, eslint-plugin-boundaries): both
would repeat the map, and typecheck plus `bun test` in CI already fail the build.

### Modeling

- *Decided by the maintainer:* **every checker moves onto the typed model.** The typed model keeps source locations
  for diagnostics; the AST → model mapping lives in `infrastructure/syntax`. Langium is imported nowhere else. Until
  the move ends, `domain → infrastructure/syntax` imports are listed as exceptions in the map and the list only
  shrinks.
- The TypeScript name check (`checker/tsnames`) and `naming` move to `capabilities/generation`; `analysis` runs it.
- `ModelDiff`, `fingerprints`, `diffModels` and `aggregateDependencies` move from visualization to Modeling's domain;
  `markLineChanges` stays in visualization. The storming's semantic graph and timeline occurrences move to Storming's
  domain; the trie and rendering stay in visualization.
- *Decided by the maintainer:* **Modeling is described in its own `.dt`**, like Collaboration: the generated code is
  committed and a test fails when generating again differs. When a change breaks the generator, the committed output
  builds the tool once, then the output is generated again; `CONTRIBUTING.md` gives the steps. The types at the core
  of the language (the shape of the AST and its mapping) are not described in `.dt`: little is gained there.

### Project analysis and configuration

- *Decided by the maintainer:* today's `core/analyze` becomes the capability **`analysis`**. CLI, LSP, the view
  service, the git baseline and Collaboration's validator all use it (Collaboration through its `ModelValidator`
  port, implemented in `apps/dt`). It is not a context: it has no concepts of its own beyond the combined `Analysis`.
- Configuration is split by owner. Each owner defines the type and validation of its section: `analysis` the
  `sources`; `generation` its output and options; `collaboration` the identity mode and participant limit; `agent` the
  allowed tools; `apps/dt` the port and host. `apps/dt` composes them into the schema of `domaintrail.jsonc`;
  `platform/workspace` reads the file and knows none of the sections.

### Protocols

*Decided by the maintainer:* wire types (today's `visualization/protocol.ts`, `collaboration/protocol.ts`) stay with
the module that owns them and are exported as `./protocol`, apart from the published language. `apps/dt` and
`apps/web` import them from there.

### Authorization

| Kind | Example | Where |
|---|---|---|
| Connection guards | Host and Origin, the agent API on loopback only | `apps/dt` |
| Authentication | Access JWT, the dev cookie, the facilitator link | infrastructure verifies; the context's application binds the identity to a participant |
| Rules of the work | "only the facilitator confirms a revision", "the author or the facilitator dismisses a request" | the context's domain |
| Settings of the deployment | sign-in required, the agent's allowed tools | application and apps; the agent's tools are enforced by its adapter |

- Whether a permission is a domain or an application concern depends on the rule: a rule users state about the work,
  often over the aggregate's state, is domain; a rule of the deployment or of security is application.
- Every use case receives an `Actor` (participant and role, or the agent), built by the context's application from the
  authenticated identity. Information held by another aggregate (the role is in `Session`) reaches a command as a
  parameter.
- *Decided by the maintainer:* **no new syntax.** Rules of the work are written in `.dt` as command parameters and
  `requires` (ADR 0017), for example
  `command dismiss(dismissedBy: ParticipantId, dismissedByRole: ParticipantRole, dismissedAt: Timestamp) requires authorOrFacilitator { dismissedBy == author or dismissedByRole == ParticipantRole.Facilitator } else NotYourRequest`.
  The generated checks and contract tests then guard them. A first-class actor on commands — which would link the
  `.dtes` `actor` (docs/dtes-v0.1.md) to `.dt` commands and could draw who may do what — is reconsidered once
  Collaboration shows the participant/role pair repeating.
- `apps/dt` answers 401 when no one has signed in and maps domain errors to 403. The route role table may stay as a hint
  for the UI; it is not what makes a request allowed.

## Migration

Implementation starts after the large pull request in flight has landed. Each step keeps behavior, generated output,
CLI, DSL, HTTP and WebSocket unchanged, and passes typecheck, lint, tests and build.

- **P1 — declare, move nothing.** `exports` in every package and the imports changed to use them; the boundary map
  table and the tests that read it (kinds, upstreams, published language only, exceptions listed). `modeling` counts
  as one context until P3.
- **P2 — untangle `modeling` in place.** The kernel types out of `core`; `analyze` split so that `storming` no longer
  sits inside it; `tsnames` and `naming` to the generator's side; configuration split by owner; the domain knowledge
  out of visualization.
- **P3 — move.** `contexts/`, `capabilities/`, `platform/`, `shared/kernel/`, `apps/`; `presentation` and
  `composition` merged into `apps/dt`; `web` into `apps/web`.
- **P4 — checkers onto the typed model**, one checker at a time; the syntax exception list shrinks to empty. Then
  Modeling's own `.dt`.
- **Authorization (independent of P1–P4):** `dismiss` and the facilitator-only operations (confirm, restore, close)
  become `requires` on Collaboration's commands, with `Actor` passed by the use cases.
- The release with `.dtes` should go out before P3, or wait until after it: P3 moves every path.

## Consequences

- Two axes are visible in the tree and checked by tests: a change to a context and a change to a feature or a
  technology touch different directories, and the map says which may depend on which.
- Eleven packages instead of eight (`web` counted). Each is smaller, and an agent reads less to change one.
- The checker move (about 2,200 lines) is the largest piece of work and the reason Langium can be confined; until it
  ends, the exception list says where Modeling still depends on its syntax.
- Building domaintrail requires its own generated code, committed; a broken generator needs the bootstrap steps.
- Permissions that are rules of the work show up in the model and its generated tests; those of the deployment do not.
- Out of scope: new DSL syntax (actor, access declarations), a `.dt` context map of domaintrail itself (until the
  context map can express it), publishing the packages separately.
