# Contributing

This page is about working on DomainTrail itself. To use it, start with the [README](README.md) and
[Getting started](docs/getting-started.md).

## Setup

Requires [Bun](https://bun.sh) (the version is pinned in `mise.toml`) and Node.js 22.13 or later. `bun run dt` runs the
CLI from source.

The repository is a Bun workspace: the root package (the published CLI and `domaintrail/testing`, `test/`) and the private packages under
`contexts/`, `capabilities/`, `platform/`, `shared/` and `apps/` (see [Repository layout](#repository-layout)). `bun install` at the root installs all of them
with the isolated linker (`bunfig.toml`), so each package resolves the dependencies its own `package.json` declares.

```bash
bun install
bun run langium:generate   # after editing a .langium grammar (and once after cloning); one Langium project per context
bun run typecheck
bun run lint               # oxlint --type-aware, no narrowing casts without a reason (after `bun run dt -r examples/shop generate ts`)
bun run fmt                # oxfmt (`fmt:check` in CI); the .dt files are formatted by `dt fmt`, the Markdown by hand
bun test                   # all the tests: unit tests next to the code, integration tests in test/ (see Tests)
bun run build              # dist/: the CLI bundled for Node, the Live View page, domaintrail/testing (needed by `open`, examples/shop and the tests)
```

Try the CLI on the example:

```bash
bun run dt -r examples/shop check
bun run dt -r examples/shop generate ts      # then examples/shop/src type-checks against it
(cd examples/shop && bun test)               # passes the generated contract tests and the application's tests (after `bun run build`)
(cd examples/shop && bun src/demo.ts)        # a walk through the shop: orders, an invoice, a refund request
bun run build && bun run dt -r examples/shop view
```

`dt generate ts`, `dt open` and the other commands that keep state write it outside the workspace, per user
(`~/.local/state/domaintrail/<workspace>/` and `~/.cache/domaintrail/<workspace>/`; `dt guide config`). To keep what
you try on the example (and this repository's own `bun run dt generate ts`) out of your home directory, point them at a
scratch directory first:

```bash
export DOMAINTRAIL_STATE_DIR="$(mktemp -d)/state" XDG_CACHE_HOME="$(mktemp -d)"
```

`bun test` needs nothing: `test/preload.ts` gives every test process, and the processes it starts, directories of
their own (a test that starts one with `Bun.spawn` passes `env: process.env`: Bun gives a child the environment the
process started with).

CI (`.github/workflows/ci.yml`) runs the build, the type check, the lint, the format check and the tests, and checks
`examples/shop` with the built CLI on Node.

## Repository layout

| Path | Contents |
|---|---|
| `contexts/modeling` | `@domaintrail/modeling`, the `.dt` language (a context of ADR 0027): `model/` (`.dt`: what it publishes — the Typed Model, the diff, the dependency types, its rule IDs; its locations are the kernel's `Location`) and the TypeScript generated from it, committed in `src/generated` (imported by `domain` with `import type` only; see [Bootstrap](#bootstrap)); `domain` (the helpers over the Typed Model, its dependencies between contexts and between aggregates, the diff of two models, the stable IDs, Modeling's rule IDs; the model as written that the checkers read — sites, expression trees, resolved references — with its static types and the rule sink; the checkers in `rules/`), `application` (Modeling's analysis of the `.dt` sources: the models and the rules, on what the syntax parses), `infrastructure/syntax` (the grammar and its Langium project, `langium-config.json`; the generated parser and AST, scoping, parsing and the diagnostics of the syntax and the links, the AST index, labels, the sites, the AST → model mappings, the printer of `dt fmt`) |
| `contexts/storming` | `@domaintrail/storming`, the Event Storming DSL `.dtes` (ADR 0024), upstream Modeling: `domain` (the IR, the validator, the link to the Typed Model, the semantic graph and timeline occurrences, its rule IDs, `isStormingFile`), `application` (its analysis against the Typed Model), `infrastructure/syntax` (its own grammar and Langium project, the parser into the IR, the printer) |
| `contexts/collaboration` | `@domaintrail/collaboration`, collaboration sessions (ADR 0026): `model/` (`.dt`) and the TypeScript generated from it, committed in `src/generated` (see [Bootstrap](#bootstrap); `src/contracts.test.ts` runs its contract tests); `domain` (the commands and pure decisions, the emoji of a reaction), `application` (use cases, ports — the model validator among them —, its settings in the config's `collab` and `classifier` sections and `agent.run.maxPreviousRunDiff`), `infrastructure` (`node:sqlite` store, blobs, identity) |
| `contexts/knowledge` | `@domaintrail/knowledge`, the knowledge taken from sessions (ADR 0031): `model/` (`.dt`: the item, its labels, sources and versions, the operations of an extraction, the audit and redaction records) and the TypeScript generated from it, committed in `src/generated` (see [Bootstrap](#bootstrap); `src/contracts.test.ts` runs its contract tests); `domain` (the item's commands as pure decisions, an extraction's operations applied to the items, the audit, redaction and past-version records), `application` (the `KnowledgeStore` port its adapters implement, `authorize`) |
| `capabilities/analysis` | `@domaintrail/analysis`, the project analysis behind `dt check` (ADR 0027's capability `analysis`): `application` (Modeling's and Storming's analyses and the generation's checks combined into one `Analysis`), `core` (the config's `sources` section) |
| `capabilities/generation` | `@domaintrail/generation`: `core` (the TypeScript generator, generated checks and contract tests, naming, its name check M011 run by the project analysis; the config's `generate` and `lintHint` sections) |
| `capabilities/visualization` | `@domaintrail/visualization`, the Live View's model: `core` (graph IR and the rows marked against the baseline, the storming views: the prefix trie, the render graph), `application` (the view service and its ports), `adapters` (the ELK layout, the layout file, git), `protocol.ts` |
| `capabilities/agent` | `@domaintrail/agent`, `dt agent` and the agent in process (ADR 0026, ADR 0030): `core` (the subscriber and the run pipeline over its ports, the prompt), `adapters` (the agent API client and its SSE parser, the Claude Code adapter, `dt fmt`/`dt check`, the workspace scan; their settings in the config's `agent` section: `agent.run`, `agent.answer`, `agent.triage`) |
| `platform/workspace` | `@domaintrail/workspace`, the workspace on disk: sources and `.gitignore` (which files are sources is given by the app), finding and reading the config file (its format given by the app), the output of `dt generate ts`, the file and git ref watchers |
| `shared/kernel` | `@domaintrail/kernel`, ADR 0027's shared kernel: `Diagnostic` (its code a plain string; each context owns its rule IDs), the suggestions, `SourceFile`, `Location`, `camel`; it imports nothing. Its types are the shared context Kernel in `model/` (`.dt`), generated into `src/generated` (committed) and exported whole by its index.ts, through which the generated code of other packages imports the context (`@domaintrail/kernel`; see [Bootstrap](#bootstrap)) |
| `apps/dt` | `@domaintrail/dt`, the one binary: `main.ts` (`runDt`, called by `bin/dt.ts`, and `cliDeps`), `wiring` (the Live View server, the session server, the subscriber, the model validator, with every adapter wired), `cli` (the commands, `dt guide`, `dt show`), `lsp` (`dt lsp`), `server` (`http` and `websocket`: the Live View server and its access check; `session`: the session's routes, identities, presence, the agent API), `config` (`domaintrail.jsonc` composed from its sections' owners; the ports, hosts and allowed hosts and origins are the app's own) |
| `apps/web` | `@domaintrail/web`, the Live View page (React; the diagrams through the canvas port `view/diagram.ts`, drawn with React Flow by `view/flow-canvas.tsx` only, see [ADR 0029](docs/adr/0029-react-flow-canvas.md) and [the plan](docs/plans/react-flow.md)): `app` (shell, top bar, socket), `view` (the view's hooks and workspace), `session`, `shared`; `render.ts` builds the scene (`scene.ts`) the canvas draws, `diagram-items.tsx` draws its items |
| `testing` | `domaintrail/testing`, the support of the generated contract tests (ADR 0028, decision 5): a subpath of the published package, built into `dist/testing.js` (see [The testing support](#the-testing-support)) |
| `docs` | the guide (`dt guide`), Getting started, the Live View, the ADRs, releasing |
| `examples/shop` | the complete example, also run by the tests |
| `tree-sitter-domaintrail` | the tree-sitter grammar |
| `editors/zed` | the Zed extension |

## The testing support

The generated contract tests import their generic helpers from `domaintrail/testing`, a subpath of the published
package (`exports` in the root `package.json`): its source is `testing/index.ts`, and `bun run build` writes
`dist/testing.js` and `dist/testing.d.ts`. fast-check is an optional peer dependency. In the repository the import
resolves without a package to install:

- the code below the root `tsconfig.json` (Collaboration's committed tests, `test/`) takes the source through its
  `paths`, for `tsc` and Bun alike; the architecture test lets a package's generated tests import it undeclared;
- `examples/shop`, which has a `tsconfig.json` of its own and no `package.json`, takes the built package through the
  root package's `exports` (a self-reference), like a project that installed domaintrail: run `bun run build` first;
- the temporary projects of the tests get a `node_modules` whose `domaintrail/testing` is the source
  (`linkNodeModules` in `test/helpers.ts` and in `capabilities/generation/src/test-helpers.ts`).

The generated tests state the version of domaintrail that generated them and check it when loaded
(`testing.checkVersion`); the baselines of the generated code leave it out (`withoutVersion` in `test/helpers.ts`), so
that a release changes no snapshot.

## Boundaries

Each package is `@domaintrail/<name>`, of a kind of [ADR 0027](docs/adr/0027-domain-and-application-boundaries.md)
(Three kinds of module, Layout). The boundary map, `test/architecture/map.ts`, gives each package its kind and the
packages it depends on, and `test/architecture.test.ts` derives every check below from it (it also checks that this
table matches the map):

| Package | Path | Kind | Depends on |
|---|---|---|---|
| `modeling` | `contexts/modeling` | context | kernel |
| `storming` | `contexts/storming` | context | kernel, modeling |
| `collaboration` | `contexts/collaboration` | context | kernel, modeling, storming |
| `knowledge` | `contexts/knowledge` | context | — |
| `analysis` | `capabilities/analysis` | capability | generation, kernel, modeling, storming |
| `generation` | `capabilities/generation` | capability | kernel, modeling |
| `visualization` | `capabilities/visualization` | capability | analysis, kernel, modeling, storming |
| `agent` | `capabilities/agent` | capability | collaboration |
| `workspace` | `platform/workspace` | platform | kernel |
| `kernel` | `shared/kernel` | kernel | — |
| `dt` | `apps/dt` | app | agent, analysis, collaboration, generation, kernel, modeling, storming, visualization, workspace |
| `web` | `apps/web` | app | analysis (its unit tests only, a devDependency), collaboration, kernel, modeling, storming, visualization |

| Kind | Inside `src/` | May depend on | Takes from another package |
|---|---|---|---|
| context | `domain/` (pure), `application/` (use cases, ports), `infrastructure/` (technology; `infrastructure/syntax/` the grammar, the parser, the AST and its mappings) | its declared upstream contexts, the kernel | `.`, and of an upstream context only its published language |
| capability | `core/` (pure), `application/`, `adapters/` (technology) | contexts, the capabilities it declares (`analysis → generation`), the platform, the kernel | `.`, `./protocol` |
| platform | | the platform, the kernel | `.` |
| kernel | | nothing | |
| app | its entry points and wiring | contexts, capabilities, the platform, the kernel; never another app | `.`, `./protocol` |

The rules, with the name a failure gives (a failure also names the section of ADR 0027 and the usual fix):

- **Declared dependencies.** A package's `package.json` declares exactly the `@domaintrail/*` packages the map lists,
  and every third-party package it imports. A third-party dependency the CLI needs at run time is also in the root's
  `dependencies` (the bundle keeps those external), at the same version: a dependency declared in several manifests has
  the same version everywhere. Between kinds, only what the table above allows (`kinds`).
- **Public surface.** `exports` lists only `.` (`src/index.ts`: published language, use cases, the adapters an app
  wires), where a package has wire types, `./protocol` (`src/protocol.ts`; collaboration and visualization), and, where
  the tests of other packages draw values of its context, `./tests` (its generated `src/generated/tests/<Context>.ts`;
  the kernel), which only tests import (`exports`). Across packages, import only those entries (`public-surface`); inside a package, import relatively with
  `.js`, never out of the package. An index.ts names what it exports, module by module (no `export *`). A context's
  **published language** is the modules the map lists in `published` — Modeling's Typed Model, dependencies, usages,
  stable IDs, aggregates' dependencies, diff and rule IDs; Storming's IR, semantic graph, rule IDs and files — and a
  context takes nothing else from an upstream's `.`, keyed by the module the name comes from.
- **Layers.** `domain/` and `core/` import no I/O (`pure-core-io`: no `node:*` but `node:path`, `node:path/posix` and
  `node:url`, no `bun`, `chokidar`, `ws` or `elkjs`) and neither `application/` nor `infrastructure/` / `adapters/`
  (`pure-core-layers`). `application/` imports no I/O either (`application-io`): it reaches technology through ports.
  Only an app imports another package's `infrastructure/` or `adapters/`, even through `.` (`foreign-infrastructure`).
- **Syntax** (`syntax`). Langium is imported only under a context's `infrastructure/syntax/`, and by an app (the
  language server); `domain/` and `core/` import neither Langium nor `infrastructure/syntax/`. The checkers read the
  model as written (`contexts/modeling/src/domain/source-model.ts`), which the syntax builds from the AST with a site
  for every part they report on.
- **Generated code** (`generated`). A package's code generated from the model (the map's `generated`: Modeling's and
  the kernel's `src/generated`) imports only its own files and the modules of the contexts that the root
  `domaintrail.jsonc` writes into other packages (`generate.ts.contexts.<Ctx>.module`: Modeling's imports
  `@domaintrail/kernel`), and the rest of the package imports only its types (`import type`), but for the index.ts of a
  package whose generated code other packages import (the map's `publishesGenerated`: the kernel's), which exports it
  whole. The generated contract tests (`src/generated/tests`) count as tests. See [Bootstrap](#bootstrap).
- **The kernel** (`kernel`). `shared/kernel` imports only its own files and the pure builtins, and its index.ts exports
  every module. Keep it small: what needs Langium or the model stays in the module that uses it.
- **Runtimes.** Collaboration and the agent run on Node (`node:*` only in their `infrastructure/` / `adapters/`, no
  `bun`); the page imports no `infrastructure/`.
- **Exceptions.** The map can list a rule's known violations per package (`exceptions`); it lists none. A listed
  violation that no longer occurs fails the test, so the list only shrinks: new code adds none.

A new package gets an entry in the map and a row in the table above.

`domaintrail.jsonc` is split by owner (ADR 0027, Project analysis and configuration): each section's type, defaults and
validation live with the package that uses it, as `validate…(section, fail)` and `resolve…(section)` and its keys;
`apps/dt/src/config` composes them (the checks in a fixed order, the first error wins) and the workspace reads the file.
A new setting goes to its owner and into `schema/domaintrail.schema.json`, which a test compares with the composed keys.

## The page's UI

The Live View's page (`apps/web`) follows [the UI rules](docs/ui-rules.md): every text button is an `<Act kind="…">`
whose look says what pressing it does (decide, send, insert, see, open, stop or danger; one decide per place), and
spacing follows the rhythm of `--gap-inside`, `--gap-between` and `--gap-turn`. `apps/web/ui-rules.test.ts` holds both;
an exception goes into its lists with a reason.

## Tests

Three kinds of test, by what a test crosses:

| Kind | What it tests | Where | Imports |
|---|---|---|---|
| **Unit test (UT)** | one package through that package's code only | next to the code: `<kind>/<pkg>/src/**/<module>.test.ts` (`apps/web/**/<module>.test.ts` for the page) | its own package by relative paths; another package only through its entries (`.` / `./protocol`) |
| **Integration test (IT)** | across packages: the app's wiring, the app's HTTP and WebSocket servers on a port, the CLI as a child process (`node dist/dt.js`), the agent pipeline with a fake agent, the session seed, the baseline contract tests (generated output, `dt check`, Live View payloads, session error bodies), the architecture test | `test/` | the packages only through their entries (and `dist/`), plus the helpers in `test/` |
| **End-to-end test (E2E)** | `dt open` and `dt collab` in a browser, as a user | `e2e/` (none yet) | |

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

## Bootstrap

DomainTrail describes itself in `.dt`, with one configuration at the root (`domaintrail.jsonc`, ADR 0028): the kernel
(`shared/kernel/model`, a shared context), Modeling (`contexts/modeling/model`: what it publishes), Collaboration
(`contexts/collaboration/model`) and Knowledge (`contexts/knowledge/model`). Each is generated into its package's `src/generated` (committed, with its contract
tests in `src/generated/tests`), and imported from the other packages by the package's module (`generate.ts.contexts.
<Ctx>.module`): Modeling's Typed Model takes the kernel's `Location` from `@domaintrail/kernel`. `bun run dt check` and
`bun run dt open` at the root show all four. The tool is built on the generated code: Modeling imports it with `import
type` only (the architecture test's rule `generated`), so the tool runs from the committed output even when the
generator is broken. `test/self-contracts.test.ts` fails when the model does not check clean, is not formatted, or
generating it again differs from the committed files.

- **Changing the model** (any of the four): edit the `.dt`, run `bun run dt fmt` and `bun run dt generate ts` at the
  root, then `bun run typecheck` and fix what uses the changed types (a type the kernel's generated code adds is also
  exported from `shared/kernel/src/index.ts`). A change of the Typed Model's shape changes the Live View payload (a T0
  baseline): make it in one commit with every consumer and the updated snapshots (`bun test -u` on those tests), and
  say why in the commit message.
- **Changing the generator:** regenerate (`bun run dt generate ts` at the root) and commit the generated files with
  the change.
- **A broken generator** (its output does not type-check, or the tool no longer runs): `git restore
  shared/kernel/src/generated contexts/modeling/src/generated contexts/collaboration/src/generated
  contexts/knowledge/src/generated` to get the committed
  output back, fix the generator with it in place, then regenerate.

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

## Adding a keyword

A keyword lives in the Langium grammar of its language (`contexts/<context>/src/infrastructure/syntax/*.langium`), in
the tree-sitter grammar and its highlight query (`tree-sitter-domaintrail/queries/highlights.scm`, copied to
`editors/zed/languages/domaintrail/highlights.scm`, which a test compares), and in the Live View's highlighter
(`apps/web/highlight.ts`). Decide whether it may also be a name: a field, parameter or command name (`FeatureName` in the
Langium grammar, `FEATURE_KEYWORDS` in `grammar.js`) — the declaration keywords are — and an enum value or variant name
(`ValueName`, `VALUE_KEYWORDS`: every keyword); `test/tree-sitter.test.ts` checks that both grammars agree. The words of
expressions are not field names. A new declaration should start with its keyword followed by a name, never like
`name :`, which is how a field starts: the parser tells a keyword used as a name from the keyword by the token after it.
Compare the syntax errors of common mistakes (a keyword with its name missing, a block left open) before and after;
`parser-messages.ts` rewrites those that read worse.

## The Zed extension

`editors/zed` is a Rust extension (built by Zed, which needs Rust installed with rustup). Install it locally with *zed:
install dev extension* and that directory. `extension.toml` pins the grammar to a commit of this repository
(`[grammars.domaintrail] rev`), which Zed fetches from GitHub: after a change of the grammar reaches `main`, point
`rev` at that commit of `main` in a follow-up pull request (a branch's commits are gone once it is squash merged). Its
version follows the package's: `npm version` sets it (`scripts/zed-version.ts`), and `test/zed-version.test.ts` checks it.

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
