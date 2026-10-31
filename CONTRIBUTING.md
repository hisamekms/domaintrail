# Contributing

This page is about working on DomainTrail itself. To use it, start with the [README](README.md) and
[Getting started](docs/getting-started.md).

## Setup

Requires [Bun](https://bun.sh) (the version is pinned in `mise.toml`) and Node.js 22.13 or later. `bun run dt` runs the
CLI from source.

The repository is a Bun workspace: the root package (the published CLI, `test/`) and the private packages
`packages/*` and `web` (see [Repository layout](#repository-layout)). `bun install` at the root installs all of them
with the isolated linker (`bunfig.toml`), so each package resolves the dependencies its own `package.json` declares.

```bash
bun install
bun run langium:generate   # after editing a .langium grammar (and once after cloning); packages/modeling/langium-config.json
bun run typecheck
bun run lint               # oxlint --type-aware, no narrowing casts without a reason (after `bun run dt -r examples/shop generate ts`)
bun run fmt                # oxfmt (`fmt:check` in CI); the .dt files are formatted by `dt fmt`, the Markdown by hand
bun test                   # the repository's tests (bunfig.toml: test/ only)
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
| `packages/modeling/src` | `language` (Langium grammars, generated parser/AST, scoping), `core` (analyzer, diagnostics, validation rules in `checker/`, the config's types and validation), `model` (the Typed Model), `generator` (TypeScript generator, generated checks and contract tests), `format` (`dt fmt`), `storming` (the Event Storming DSL) |
| `packages/workspace/src` | the workspace on disk: sources and `.gitignore`, config loading, the output of `dt generate ts`, the file and git ref watchers |
| `packages/visualization/src` | the Live View's model: graph IR and diff, the storming views, the view service and its ports, the ELK layout, the layout file and git adapters, `protocol.ts` |
| `packages/presentation/src` | `cli` (the commands, `dt guide`, `dt show`), `lsp` (`dt lsp`), `http` and `websocket` (the Live View server, its access check) |
| `packages/collaboration` | collaboration sessions (ADR 0026): `model/` (`.dt`) and the TypeScript generated from it, committed in `src/generated` (after changing the model, `bun run dt -r packages/collaboration generate ts`; `test/collaboration-contracts.test.ts` fails when generating again differs, `test/collaboration-contract-run.test.ts` runs its contract tests); `domain` (the commands and pure decisions), `application` (use cases, ports), `infrastructure` (`node:sqlite` store, blobs, validator) |
| `packages/agent/src` | `dt session subscribe` (ADR 0026): `application` (the subscriber and the run pipeline over its ports, the prompt), `infrastructure` (the agent API client and its SSE parser, the Claude Code adapter, `dt fmt`/`dt check`, the workspace scan) |
| `packages/composition/src` | the wiring: `cli.ts` (`runDt`, called by `bin/dt.ts`), `view.ts` (`startViewServer`) |
| `web` | the Live View page (React + tldraw): `app` (shell, top bar, socket), `view` (the view's hooks and workspace), `shared` |
| `docs` | the guide (`dt guide`), Getting started, the Live View, the ADRs, releasing |
| `examples/shop` | the complete example, also run by the tests |
| `tree-sitter-domaintrail` | the tree-sitter grammar |
| `editors/zed` | the Zed extension |

Each package is `@domaintrail/<area>` (`web` is `@domaintrail/web`); the graph, the layers and the ports are in
[ADR 0025](docs/adr/0025-m0-refactoring.md). Its rules:

- A package declares in its `package.json` every package it imports, `@domaintrail/*` and third-party alike. A
  third-party dependency the CLI needs at run time is also in the root's `dependencies` (the bundle keeps those
  external), at the same version: a dependency declared in several manifests must have the same version everywhere.
- Across packages, import by package name without an extension (`@domaintrail/modeling/core/analyze`, served by
  `"exports": { "./*": "./src/*.ts" }`); inside a package, import relatively with `.js`.
- `test/architecture.test.ts` enforces the package graph, the declared dependencies, the versions and the layers
  (`domain/`, `application/`, `infrastructure/`). A new package gets an entry in its `PACKAGES`.

## Tests

`bun test` runs everything in `test/`, including:

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
Langium grammar in `packages/modeling/src/language` stays the reference. After changing it, run:

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
