# Contributing

This page is about working on DomainTrail itself. To use it, start with the [README](README.md) and
[Getting started](docs/getting-started.md).

## Setup

Requires [Bun](https://bun.sh) (the version is pinned in `mise.toml`) and Node.js 22.13 or later. `bun run dt` runs the
CLI from source.

The repository is a Bun workspace: the root package (the published CLI, `test/`) and the private packages under
`contexts/`, `capabilities/`, `platform/`, `shared/` and `apps/` (see [Repository layout](#repository-layout)). `bun install` at the root installs all of them
with the isolated linker (`bunfig.toml`), so each package resolves the dependencies its own `package.json` declares.

```bash
bun install
bun run langium:generate   # after editing a .langium grammar (and once after cloning); one Langium project per context
bun run typecheck
bun run lint               # oxlint --type-aware, no narrowing casts without a reason (after `bun run dt -r examples/shop generate ts`)
bun run fmt                # oxfmt (`fmt:check` in CI); the .dt files are formatted by `dt fmt`, the Markdown by hand
bun test                   # all the tests: unit tests next to the code, integration tests in test/ (see Tests)
bun run build              # dist/: the CLI bundled for Node and the Live View page (needed by `view` and the tests)
```

Try the CLI on the example:

```bash
bun run dt -r examples/shop check
bun run dt -r examples/shop generate ts      # then examples/shop/src type-checks against it
(cd examples/shop && bun test)               # passes the generated contract tests and the application's tests
(cd examples/shop && bun src/demo.ts)        # a walk through the shop: orders, an invoice, a refund request
bun run build && bun run dt -r examples/shop view
```

CI (`.github/workflows/ci.yml`) runs the build, the type check, the lint, the format check and the tests, and checks
`examples/shop` with the built CLI on Node.

## Repository layout

| Path | Contents |
|---|---|
| `contexts/modeling` | `@domaintrail/modeling`, the `.dt` language (a context of ADR 0027): `domain` (the Typed Model, its dependencies between contexts and between aggregates, the diff of two models, the stable IDs, Modeling's rule IDs; the model as written that the checkers read — sites, expression trees, resolved references — with its static types and the rule sink; the checkers in `rules/`), `application` (Modeling's analysis of the `.dt` sources: the models and the rules, on what the syntax parses), `infrastructure/syntax` (the grammar and its Langium project, `langium-config.json`; the generated parser and AST, scoping, parsing and the diagnostics of the syntax and the links, the AST index, labels, the sites, the AST → model mappings, the printer of `dt fmt`) |
| `contexts/storming` | `@domaintrail/storming`, the Event Storming DSL `.dtes` (ADR 0024), upstream Modeling: `domain` (the IR, the validator, the link to the Typed Model, the semantic graph and timeline occurrences, its rule IDs, `isStormingFile`), `application` (its analysis against the Typed Model), `infrastructure/syntax` (its own grammar and Langium project, the parser into the IR, the printer) |
| `contexts/collaboration` | `@domaintrail/collaboration`, collaboration sessions (ADR 0026): `model/` (`.dt`) and the TypeScript generated from it, committed in `src/generated` (after changing the model, `bun run dt -r contexts/collaboration generate ts`; `test/collaboration-contracts.test.ts` fails when generating again differs, `src/contracts.test.ts` runs its contract tests); `domain` (the commands and pure decisions, the emoji of a reaction), `application` (use cases, ports — the model validator among them —, its settings in the config's `session` section), `infrastructure` (`node:sqlite` store, blobs, identity) |
| `capabilities/analysis` | `@domaintrail/analysis`, the project analysis behind `dt check` (ADR 0027's capability `analysis`): `application` (Modeling's and Storming's analyses and the generation's checks combined into one `Analysis`), `core` (the config's `sources` section) |
| `capabilities/generation` | `@domaintrail/generation`: `core` (the TypeScript generator, generated checks and contract tests, naming, its name check M011 run by the project analysis; the config's `generate` and `lintHint` sections) |
| `capabilities/visualization` | `@domaintrail/visualization`, the Live View's model: `core` (graph IR and the rows marked against the baseline, the storming views: the prefix trie, the render graph), `application` (the view service and its ports), `adapters` (the ELK layout, the layout file, git), `protocol.ts` |
| `capabilities/agent` | `@domaintrail/agent`, `dt session subscribe` (ADR 0026): `core` (the subscriber and the run pipeline over its ports, the prompt), `adapters` (the agent API client and its SSE parser, the Claude Code adapter, `dt fmt`/`dt check`, the workspace scan; their settings `session.agent.allowedTools` and `session.agent.dt`) |
| `platform/workspace` | `@domaintrail/workspace`, the workspace on disk: sources and `.gitignore` (which files are sources is given by the app), finding and reading the config file (its format given by the app), the output of `dt generate ts`, the file and git ref watchers |
| `shared/kernel` | `@domaintrail/kernel`, ADR 0027's shared kernel: `Diagnostic` (its code a plain string; each context owns its rule IDs), the suggestions, `SourceFile`, `Location`, `camel`; it imports nothing |
| `apps/dt` | `@domaintrail/dt`, the one binary: `main.ts` (`runDt`, called by `bin/dt.ts`, and `cliDeps`), `wiring` (the Live View server, the session server, the subscriber, the model validator, with every adapter wired), `cli` (the commands, `dt guide`, `dt show`), `lsp` (`dt lsp`), `server` (`http` and `websocket`: the Live View server and its access check; `session`: the session's routes, identities, presence, the agent API), `config` (`domaintrail.jsonc` composed from its sections' owners; the ports, hosts and allowed hosts and origins are the app's own) |
| `apps/web` | `@domaintrail/web`, the Live View page (React + tldraw): `app` (shell, top bar, socket), `view` (the view's hooks and workspace), `session`, `shared` |
| `docs` | the guide (`dt guide`), Getting started, the Live View, the ADRs, releasing |
| `examples/shop` | the complete example, also run by the tests |
| `tree-sitter-domaintrail` | the tree-sitter grammar |
| `editors/zed` | the Zed extension |

Each package is `@domaintrail/<name>`, of a kind of [ADR 0027](docs/adr/0027-domain-and-application-boundaries.md)
(Layout): a context (`domain/`, `application/`, `infrastructure/`), a capability (`core/`, `application/`, `adapters/`),
the platform, the shared kernel, or an app. Its rules:

- A package declares in its `package.json` every package it imports, `@domaintrail/*` and third-party alike. A
  third-party dependency the CLI needs at run time is also in the root's `dependencies` (the bundle keeps those
  external), at the same version: a dependency declared in several manifests must have the same version everywhere.
- Across packages, import only a package's entries: `@domaintrail/<area>` (its `src/index.ts`: published language,
  use cases, the adapters an app wires) and, where a package has wire types, `@domaintrail/<area>/protocol` (its
  `src/protocol.ts`). `exports` lists nothing else ([ADR 0027](docs/adr/0027-domain-and-application-boundaries.md)).
  Inside a package, import relatively with `.js`.
- `test/architecture.test.ts` enforces the boundary map of ADR 0027 (`test/architecture/map.ts`): the kind and the
  upstream of each package, the declared dependencies, the entries (a context takes only the published language of its
  upstream contexts), the versions, the layers (`domain/` and `core/` import no I/O, no `application/` and no
  technology; only an app imports another package's `infrastructure/` or `adapters/`), the kernel (it imports nothing)
  and the syntax (Langium is imported only under a context's `infrastructure/syntax/`, and by an app's language
  server; `domain/` and `core/` import neither Langium nor `infrastructure/syntax/`: the checkers read the model as
  written). A new package gets an entry in the map.
- `domaintrail.jsonc` is split by owner (ADR 0027, Project analysis and configuration): each section's type, defaults
  and validation live with the package that uses it, as `validate…(section, fail)` and `resolve…(section)` and its
  keys; `apps/dt/src/config` composes them (the checks in a fixed order, the first error wins) and the
  workspace reads the file. A new setting goes to its owner and into `schema/domaintrail.schema.json`, which a test
  compares with the composed keys.

## Tests

Three kinds of test, by what a test crosses:

| Kind | What it tests | Where | Imports |
|---|---|---|---|
| **Unit test (UT)** | one package through that package's code only | next to the code: `<kind>/<pkg>/src/**/<module>.test.ts` (`apps/web/**/<module>.test.ts` for the page) | its own package by relative paths; another package only through its entries (`.` / `./protocol`) |
| **Integration test (IT)** | across packages: the app's wiring, the app's HTTP and WebSocket servers on a port, the CLI as a child process (`node dist/dt.js`), the agent pipeline with a fake agent, the session seed, the baseline contract tests (generated output, `dt check`, Live View payloads, session error bodies), the architecture test | `test/` | the packages only through their entries (and `dist/`), plus the helpers in `test/` |
| **End-to-end test (E2E)** | `dt view` and `dt session` in a browser, as a user | `e2e/` (none yet) | |

A unit test may use its package's own technology: temporary directories, fixture files, a file or in-memory SQLite
database (collaboration's store test is a unit test). When it tests its package's own adapter or output, it may also
spawn child processes and open ports on localhost (the agent's `dt` shim, the JWKS verifier against a local stand-in,
`tsc` over the generated code); it never reaches the network beyond localhost. To decide, ask whether the test still makes sense
with that package alone: if it does, it is a unit test; if it needs another package's internals, split it, or make it
an integration test that goes through the entries.

- Snapshots live in `__snapshots__/` next to their test (`bun test` puts them there), so a colocated test's snapshots
  move with it. The baseline snapshots (see `docs/plans/0027-boundaries.md`, Baseline) are in `test/__snapshots__/`.
- Fixtures used by several tests or packages stay in `test/fixtures/`; a fixture only one package's unit tests read
  lives in `<kind>/<pkg>/test-fixtures/`, outside its sources. Helpers shared by a package's unit tests are in
  `<kind>/<pkg>/src/test-helpers.ts` (`apps/web/test-helpers.ts`; counted as test code: the bundle and the layer rules
  ignore it).
- `test/architecture.test.ts` checks the imports of the tests too: a unit test imports other packages only through
  their entries, and so does an integration test (or `dist/`). A package declares the test-only dependencies its unit
  tests import (`fast-check`) in its own `devDependencies`.

```bash
bun test               # all of them (CI)
bun run test:unit      # the unit tests: contexts, capabilities, platform, shared, apps
bun run test:it        # the integration tests: test/
```

`bun test` runs, among others:

- **examples/shop**: generated into a temporary copy, type-checked with its own `tsconfig.json`, its contract tests and
  application tests run with `bun test`, and its demo run (`test/contract-tests.test.ts`).
- **The documentation**: the `dt` blocks of the guide, the README and Getting started check and are formatted, the
  guide's TypeScript blocks type-check against generated code, Getting started's code is generated, type-checked and
  passes its contract tests, the Japanese Getting started has the same structure and code as the English one, and the
  relative links of the README, CONTRIBUTING and Getting started resolve (`test/guide.test.ts`, `test/docs.test.ts`).
  `docs/guide.md` is printed by `dt guide`, so a heading there needs a `<!-- topic: … -->` line above it.
- **The tree-sitter grammar**: parses with the committed wasm (`test/tree-sitter.test.ts`; see below).

## The tree-sitter grammar

`tree-sitter-domaintrail/grammar.js` is a second grammar of the DSL, for editors that highlight with tree-sitter; the
Langium grammar in `contexts/modeling/src/infrastructure/syntax` stays the reference. After changing it, run:

```bash
bun run tree-sitter
```

It regenerates the parser, runs the corpus tests and builds `tree-sitter-domaintrail.wasm` with the tree-sitter CLI
(which downloads the wasi-sdk, about 100 MB, once), then writes `build-stamp.json`, the hashes of the grammar, the
parser and the wasm. Commit all of them: the tests parse with the committed wasm and fail when the stamp is stale, so
CI needs neither the tree-sitter CLI nor the wasi-sdk.

## The Zed extension

`editors/zed` is a Rust extension (built by Zed, which needs Rust installed with rustup). Install it locally with *zed:
install dev extension* and that directory. `extension.toml` pins the grammar to a commit of this repository
(`[grammars.domaintrail] rev`): after changing the grammar and committing, point `rev` at that commit. Its version
follows the package's.

## Commits

Changes reach `main` through pull requests, squash merged, so the title of a pull request becomes its commit on `main`
and its description the commit's body. Titles follow [Conventional Commits](https://www.conventionalcommits.org):
`type(scope): description`, where the type is one of `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`,
`chore` and `revert`, the scope is optional, and `!` before the colon marks a breaking change. The description is one
sentence in the imperative, starting in lowercase, that says what changes and why. The PR title workflow checks it.

```text
feat(view): compare the model with a git revision
fix!: reject a policy whose command is not on the aggregate
build: use Bun 1.4.4 locally and in CI
```

`npm version` commits as `chore(release): <version>` (`.npmrc`).

## Release

The changelogs have no `Unreleased` section: when releasing, write the new version's section in both `CHANGELOG.md` and
`CHANGELOG.ja.md` from the merges since the previous tag (with `### Upgrading` steps for breaking changes), review both
languages and merge them through a pull request, then, as an admin on `main`, run `npm version <patch|minor|major>` and
`git push --follow-tags`. The Release
workflow stops if either changelog lacks the version, tests, builds and stages the package on npm; it is published only
after you approve it on npmjs.com (Staged Packages) or with `npm stage approve`. The workflow also creates the GitHub
Release as a draft with the notes from the changelogs: review it and publish it by hand. See
[docs/releasing.md](docs/releasing.md).
