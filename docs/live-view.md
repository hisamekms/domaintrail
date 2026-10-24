# The Live View

`dt view` watches the workspace, re-validates on every save and pushes updates to the browser over WebSocket. It
serves the page at <http://127.0.0.1:4321> (`--port`, `--host`, or `view.port` / `view.host` in `domaintrail.jsonc`)
and runs until Ctrl+C. [Getting started](getting-started.md#watch-it-in-the-live-view) shows what to look at first;
this page describes every pane.

The screen is laid out like an IDE; every pane is closed and opened with the icon button at its top (a closed side
pane leaves a narrow rail with the button that opens it) and resized by dragging (remembered per browser).

## Explorer (left)

The model tree — shared contexts first, then each context grouped by kind; aggregates expand to their states and
commands — and the `.dt` files with error/warning counts. Click selects (a file too); double-click opens the item in
the view or inspector tab that suits it.

## Main (center)

Views of the whole model, in tabs with a view-specific toolbar. Anything about one selected item is in the inspector.
See [ADR 0007](adr/0007-pane-roles.md).

- **Context Map**: one node per bounded context and one edge per dependency between contexts, labeled with the number
  of ID references and borrowed types (solid when types are borrowed). Shared contexts and contexts that only declare
  IDs are hidden unless 「共有・外部の BC も表示」 is checked. Selecting a context lists every use in the inspector
  (依存先 / 依存元). See [ADR 0006](adr/0006-context-map.md).
- **Structure**: contexts, aggregate boundaries, entities, value objects, unions, `owns` / `references`. Pick bounded
  contexts in the toolbar (any number) to draw only them, with the elements they use and the elements that use them as
  stubs; the eye next to each other context hides its stubs and the edges to and from them (the toolbar shows how many
  are hidden). The first row, 「すべての BC」, checks or unchecks every context and shows or hides every stub. Three
  levels work in both, switched by the icons in the toolbar: 詳細 (every field), 概観 (the elements' names only) and
  集約 (only the aggregates with their descriptions, and one edge per pair of aggregates that depend on each other,
  also through the entities, value objects and IDs they hold; shared contexts are left out, and a context without
  aggregates stays as a frame with its description).
- **Catalog**: cards to look over the model, one section per kind; for now the domain primitives per context (shared
  first) with base type, invariants and usages.

## Inspector (right)

The selected item — name, description, diagnostics, a back button naming the item it returns to (「〇〇 に戻る」), and
buttons to show it in a view. Sub-tabs: 構造 / 状態遷移 / 振る舞い / 参照 / ソース. An event shows 永続化 / 非永続 next
to its kind, as it does in an aggregate's 発生させる Event list; persistent events have a database icon in the
explorer.

- **状態遷移**: states and command transitions of the aggregate (`new` marks factory commands), for the aggregate and
  its states and commands; it pans and zooms like the main canvas and shows the selected state or command.
- **振る舞い**: what a command takes, requires, changes, emits and returns, and the policies that trigger it.
- **ソース**: the whole file, read-only, syntax-coloured, diagnostics in the gutter, scrolled to the declaration, which
  is highlighted with a button that copies its code (to paste into feedback for an AI agent); clicking a declaration
  selects it. A selected file shows here the same way.

## Problems and changes (bottom)

Diagnostics (click to locate) and additions / changes / removals since the previous model.

## Behaviour and settings

- Selecting never switches the main view by itself; the item is highlighted when the current view shows it.
- Added / changed elements are highlighted; removed ones appear as ghosts. On a syntax error the last diagram stays.
- The language of the Live View (Japanese or English) follows the browser, or is forced in the settings menu (the gear
  at the right of the header). It covers the screen and the diagrams' own words (集約 / aggregate…); the model's names
  and labels are shown as written, and diagnostics are in English.
- The theme follows the OS (自動), or is forced with ライト / ダーク in the settings menu; both choices are remembered
  per browser.
- Names follow the 名前の表示 switch in the header: ラベル (the string after a declaration's name, falling back to the
  name), 名前 or 両方. Layouts are cached in `<root>/.domaintrail/layout.json`. The canvas is read-only.

See [ADR 0001](adr/0001-mvp-implementation-decisions.md) for the design decisions.
