# DomainTrail

A type-checkable domain modeling DSL shared by humans and AI.
AI agents edit `.dt` files; humans watch the model update live in the browser and give feedback.
The DSL is the single source of truth for domain **structure and contracts** — it generates TypeScript types, command
contracts, checks of the invariants and requirements it states, and contract tests for your implementation, never
business logic.

## Setup

Requires Node.js 22.12 or later.

```bash
npm install -D domaintrail   # then: npx dt <command>
npx domaintrail <command>    # or run it without installing
```

## CLI

```bash
dt guide [topic]               # quick reference and topics; one topic (dt guide requires); --all for everything
dt -r <root> fmt               # format .dt files in place in the canonical layout (--check for CI)
dt -r <root> check             # validate syntax, references, types and DDD rules
dt -r <root> generate ts       # generate TypeScript into <root>/generated/domain (--out to change)
dt -r <root> view              # Live View at http://127.0.0.1:4321 (--port, --host); runs until Ctrl+C
dt lsp                         # language server over stdio: dt check's diagnostics, definitions, references, hover
dt -r <root> show <name>        # one element resolved: field sets, labels, commands' contracts, who uses it
```

The package installs the same command under two names: `dt` for everyday use and `domaintrail`, its full name, for
when `dt` clashes with another command or a script should spell it out (CI, for example).

`<root>` defaults to the current directory; every `*.dt` file below it (except in `node_modules`, `.git`, `.domaintrail`
and what `.gitignore` ignores) belongs to the workspace, unless a `domaintrail.jsonc` says otherwise. `dt --help` and `dt <command> --help` show the options with examples.

`check` prints diagnostics as `file:line:col - error M00X: message` (with a `hint:` line on what to change, when there is
one) and exits non-zero on errors; `check --format json` prints them as one JSON document (`schema/diagnostics.schema.json`).
`generate ts` runs `check` first and generates nothing if there are errors.

Try it with the example in this repository (see [Development](#development)):

```bash
bun run dt -r examples/shop check
bun run dt -r examples/shop generate ts   # then examples/shop/src/order-commands.ts type-checks against it
(cd examples/shop && bun test)            # and passes the generated contract tests
bun run build && bun run dt -r examples/shop view
```

## Guide

**[docs/guide.md](docs/guide.md)** is the reference for writing models and using the CLI. It starts with a
[quick reference](docs/guide.md#quick-reference) (the workflow, the DSL at a glance, the commands), and its sections are
**topics** that the CLI prints one at a time, so people and AI agents read only what they need without leaving the
terminal:

```bash
dt guide                       # the quick reference and the list of topics (about one screen)
dt guide requires              # one topic: a ## section with its ### sections, or one ### section
dt guide M010                  # one rule and the topics that explain it
dt guide --all                 # the whole guide, the same text as docs/guide.md
```

The sections, in the guide's order:

- [Workflow](docs/guide.md#workflow): `fmt` → `check` → `generate ts` → implement with `decide` → type-check your own
  code (`tsc --noEmit`) → run the generated contract tests
- [File layout (recommended)](docs/guide.md#file-layout-recommended): `<context>/<aggregate>.dt` and
  `<context>/context.dt` (see [ADR 0009](docs/adr/0009-file-layout.md))
- [DSL](docs/guide.md#dsl): contexts, aggregates, entities, values, states, commands, events, errors,
  [domain primitives](docs/guide.md#domain-primitives), [unions](docs/guide.md#unions),
  [shared contexts](docs/guide.md#shared-contexts), [field sets](docs/guide.md#field-sets),
  [domain and technical fields](docs/guide.md#domain-fields-and-technical-fields),
  [names (表示名)](docs/guide.md#names-labels-and-descriptions),
  [invariant expressions](docs/guide.md#invariant-expressions), [command requirements](docs/guide.md#command-requirements),
  [command changes](docs/guide.md#command-changes), [command events](docs/guide.md#command-events) and
  [pure commands](docs/guide.md#pure-commands)
- [Generated TypeScript](docs/guide.md#generated-typescript): [decisions and `decide`](docs/guide.md#decisions-and-decide),
  [what is generated and what you write](docs/guide.md#generated-code-and-your-code) (see
  [ADR 0011](docs/adr/0011-generated-code-boundary.md)), [generated checks](docs/guide.md#generated-checks) and
  [generated tests](docs/guide.md#generated-tests) (see [ADR 0020](docs/adr/0020-generated-checks-and-contract-tests.md)),
  [technical metadata](docs/guide.md#technical-metadata) (see [ADR 0013](docs/adr/0013-field-sets-and-technical-metadata.md))
  and [output directories](docs/guide.md#output-directories)
- [Rules](docs/guide.md#rules): M001–M022, L001–L003
- [Looking up one element](docs/guide.md#looking-up-one-element): `dt show`, as text or JSON
- [Formatting](docs/guide.md#formatting): `dt fmt`, the one canonical layout of `.dt` files
- [Output and exit codes](docs/guide.md#output-and-exit-codes): text, or JSON with `--format json`
- [Configuration](docs/guide.md#configuration): `domaintrail.jsonc` (`sources`, `generate.ts.out` /
  `generate.ts.contexts` / `generate.ts.tests`, `view.port` / `view.host`; JSON Schema in `schema/domaintrail.schema.json`)
- [Language server](docs/guide.md#language-server): `dt lsp`, and how to use it from an editor or Claude Code
- [Editors](docs/guide.md#editors): the Zed extension in `editors/zed` (tree-sitter highlighting, outline, `dt lsp`),
  other editors through `dt lsp` and the tree-sitter grammar in `tree-sitter-domaintrail`

A taste of the DSL:

```dt
context Sales "販売" {
  id OrderId: UUID
  aggregate Order "注文" {
    id: OrderId
    state Draft
    state Confirmed {
      confirmedAt: Timestamp
    }
    create command place(id: OrderId) -> Draft
    command confirm(at: Timestamp)
      Draft -> Confirmed
      emits OrderConfirmed
  }
  persistent event OrderConfirmed {
    orderId: OrderId
    confirmedAt: Timestamp
  }
}
```

The design decisions behind the DSL are in [docs/adr](docs/adr): shared contexts ([0004](docs/adr/0004-shared-contexts.md)),
unions ([0005](docs/adr/0005-unions.md)), persistent events ([0008](docs/adr/0008-persistent-events.md)),
command transitions ([0014](docs/adr/0014-command-transitions.md)), handlers per state
([0015](docs/adr/0015-handlers-per-state.md), superseded), collection constraints and declared invariants
([0016](docs/adr/0016-collection-constraints-and-declared-invariants.md)), command requirements
([0017](docs/adr/0017-command-requirements.md)), command events as an exact contract
([0018](docs/adr/0018-command-events-contract.md)), the fields a command changes and decisions
([0019](docs/adr/0019-command-changes-and-decisions.md)), generated checks and contract tests
([0020](docs/adr/0020-generated-checks-and-contract-tests.md)), event and error fields named after their source
([0021](docs/adr/0021-payload-field-names.md)) and more.

## Live View

`dt view` watches the workspace, re-validates on every save and pushes updates over WebSocket.
The screen is laid out like an IDE; every pane is closed and opened with the icon button at its top (a closed side
pane leaves a narrow rail with the button that opens it) and resized by dragging (remembered per browser).

- **Explorer (left)**: model tree — shared contexts first, then each context grouped by kind; aggregates expand to
  their states and commands — and the `.dt` files with error/warning counts. Click selects (a file too);
  double-click opens the item in the view or inspector tab that suits it.
- **Main (center)**: views of the whole model, in tabs with a view-specific toolbar. Anything about one selected item
  is in the inspector. See [ADR 0007](docs/adr/0007-pane-roles.md).
  - *Context Map*: one node per bounded context and one edge per dependency between contexts, labeled with the
    number of ID references and borrowed types (solid when types are borrowed). Shared contexts and contexts that
    only declare IDs are hidden unless 「共有・外部の BC も表示」 is checked. Selecting a context lists every use in
    the inspector (依存先 / 依存元). See [ADR 0006](docs/adr/0006-context-map.md).
  - *Structure*: contexts, aggregate boundaries, entities, value objects, unions, `owns` / `references`. Pick bounded
    contexts in the toolbar (any number) to draw only them, with the elements they use and the elements that use them
    as stubs; the eye next to each other context hides its stubs and the edges to and from them (the toolbar shows how
    many are hidden). The first row, 「すべての BC」, checks or unchecks every context and shows or hides every stub.
    Three levels work in both, switched by the icons in the toolbar: 詳細 (every field), 概観 (the elements' names
    only) and 集約 (only the aggregates with their descriptions, and one edge per pair of aggregates that depend on
    each other, also through the entities, value objects and IDs they hold; shared contexts are left out, and a
    context without aggregates stays as a frame with its description).
  - *Catalog*: cards to look over the model, one section per kind; for now the domain primitives per context (shared
    first) with base type, invariants and usages.
- **Inspector (right)**: the selected item — name, description, location (copy `file:line-line` for AI feedback),
  diagnostics, a back button naming the item it returns to (「〇〇 に戻る」), and buttons to show it in a view. Sub-tabs: 構造 / 状態遷移 / 振る舞い / 参照 /
  ソース. An event shows 永続化 / 非永続 next to its kind, as it does in an aggregate's 発生させる Event list;
  persistent events have a database icon in the explorer.
  - *状態遷移*: states and command transitions of the aggregate (`new` marks factory commands), for the aggregate
    and its states and commands; it pans and zooms like the main canvas and shows the selected state or command.
  - *ソース*: the whole file, read-only, syntax-coloured, diagnostics in the gutter, scrolled to the declaration;
    clicking a declaration selects it. A selected file shows here the same way.
- **Problems / changes (bottom)**: diagnostics (click to locate) and additions / changes / removals since the previous model.
- Selecting never switches the main view by itself; the item is highlighted when the current view shows it.
- Added / changed elements are highlighted; removed ones appear as ghosts. On a syntax error the last diagram stays.
- The language of the Live View (Japanese or English) follows the browser, or is forced in the settings menu (the gear
  at the right of the header). It covers the screen and the diagrams' own words (集約 / aggregate…); the model's names
  and labels are shown as written, and diagnostics are in English.
- The theme follows the OS (自動), or is forced with ライト / ダーク in the settings menu; both choices are remembered
  per browser.
- Names follow the 名前の表示 toggle in the header: ラベル (the string after a declaration's name, falling back to the
  name), 名前 or 両方. Layouts are cached in `<root>/.domaintrail/layout.json`. The canvas is read-only.

See [docs/adr/0001-mvp-implementation-decisions.md](docs/adr/0001-mvp-implementation-decisions.md) for the design decisions.

## Development

Requires [Bun](https://bun.sh) (version pinned in `mise.toml`). `bun run dt` runs the CLI from source.

```bash
bun install
bun run langium:generate   # after editing src/language/domain.langium
bun run typecheck
bun test                   # the repository's tests (bunfig.toml: test/ only)
bun run build              # dist/: the CLI bundled for Node and the Live View page (needed by `view` and the tests)
```

### Release

Run `npm version <patch|minor|major>` and `git push --follow-tags`. The Release workflow tests, builds and stages the
package on npm; it is published only after you approve it on npmjs.com (Staged Packages) or with `npm stage approve`.
See [docs/releasing.md](docs/releasing.md).

| Path | Contents |
|---|---|
| `src/language` | Langium grammar, generated parser/AST, scoping |
| `src/core` | analyzer, diagnostics, validation rules (`checker/`) |
| `src/model` | Typed Model (serializable, resolved) |
| `src/generator` | TypeScript generator and naming, generated checks (`checks.ts`) and contract tests (`tests.ts`, `testing/`) |
| `src/graph`, `src/layout` | Graph IR, diff, ELK layout |
| `src/server`, `web` | Live View server and React + tldraw client |

## License

MIT — see [LICENSE](LICENSE).
