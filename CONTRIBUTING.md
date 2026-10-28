# Contributing

This page is about working on DomainTrail itself. To use it, start with the [README](README.md) and
[Getting started](docs/getting-started.md).

## Setup

Requires [Bun](https://bun.sh) (the version is pinned in `mise.toml`) and Node.js 22.12 or later. `bun run dt` runs the
CLI from source.

```bash
bun install
bun run langium:generate   # after editing src/language/domain.langium (and once after cloning)
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
| `src/language` | Langium grammar, generated parser/AST, scoping |
| `src/core` | analyzer, diagnostics, validation rules (`checker/`) |
| `src/model` | Typed Model (serializable, resolved) |
| `src/generator` | TypeScript generator and naming, generated checks (`checks.ts`) and contract tests (`tests.ts`, `testing/`) |
| `src/format` | `dt fmt` |
| `src/graph`, `src/layout` | Graph IR, diff, ELK layout |
| `src/server`, `web` | Live View server and React + tldraw client |
| `src/lsp` | `dt lsp`, the language server |
| `src/cli` | the commands, `dt guide`, `dt show` |
| `docs` | the guide (`dt guide`), Getting started, the Live View, the ADRs, releasing |
| `examples/shop` | the complete example, also run by the tests |
| `tree-sitter-domaintrail` | the tree-sitter grammar |
| `editors/zed` | the Zed extension |

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
Langium grammar in `src/language` stays the reference. After changing it, run:

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
languages, then run `npm version <patch|minor|major>` and `git push --follow-tags`. The Release
workflow stops if either changelog lacks the version, tests, builds and stages the package on npm; it is published only
after you approve it on npmjs.com (Staged Packages) or with `npm stage approve`. The workflow also creates the GitHub
Release as a draft with the notes from the changelogs: review it and publish it by hand. See
[docs/releasing.md](docs/releasing.md).
