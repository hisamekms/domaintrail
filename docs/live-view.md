# The Live View

`dt view` watches the workspace, re-validates on every save and pushes updates to the browser over WebSocket. It
serves the page at <http://127.0.0.1:4321> (`--port`, `--host`, or `view.port` / `view.host` in `domaintrail.jsonc`)
and runs until Ctrl+C. [Getting started](getting-started.md#watch-it-in-the-live-view) shows what to look at first;
this page describes every pane.

The screen is laid out like an IDE; every pane is closed and opened with the icon button at its top (a closed side
pane leaves a narrow rail with the button that opens it) and resized by dragging (remembered per browser).

## Explorer (left)

The model tree — shared contexts first, then each context grouped by kind; aggregates expand to their states and
commands — and the `.dt` and `.dtes` files with error/warning counts. Click selects (a file too); double-click opens the item in
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
- **Event Storming** (イベントストーミング, shown when the workspace has a `.dtes` storming; a workspace of `.dtes` files only
  opens on it): one storming as sticky notes, laid out left to right (`dt guide storming-views`). The toolbar picks
  the storming (表示するストーミング, when there are several), the タイムライン — すべて（統合） for the integrated canvas,
  or one timeline with its one-hop causal paths — and the level: ビッグピクチャー (events, timelines and hotspots only)
  or デザインレベル (also commands, policies, actors, external systems, aggregates and read models). The choices are
  remembered per browser and never change the `.dtes` file. The integrated canvas draws each event once (no group
  frames), and a dashed arrow between two events names the timelines it belongs to when not all of them do; one
  timeline draws each occurrence, and a group is a frame around its events. Solid arrows are type-level causes
  (possible, not "happened"), dashed orange arrows the order of a timeline, dotted lines the other relations (without
  an arrowhead for a hotspot's event); the colours of the notes are defaults with no
  meaning (see the legend). A storming whose file stops parsing stays as it last parsed, with a banner.

## Inspector (right)

The selected item — name, description, diagnostics, a back button naming the item it returns to (「〇〇 に戻る」), and
buttons to show it in a view. Sub-tabs: 構造 / 状態遷移 / 振る舞い / 参照 / ソース. An event shows 永続化 / 非永続 next
to its kind, as it does in an aggregate's 発生させる Event list; persistent events have a database icon in the
explorer.

- **状態遷移**: states and command transitions of the aggregate (`new` marks factory commands), for the aggregate and
  its states and commands; it pans and zooms like the main canvas and shows the selected state or command.
- **振る舞い**: what a command takes, requires, changes, emits and returns, and the policies that trigger it.
- **A storming's element** (selected in the Event Storming view): its kind, label, ID, `///` description, file and
  line (ファイルを開く), and diagnostics; for an event, aggregate or command, its `.dt` との対応 (the `ref`, a link to the
  `.dt` element, or 「.dt にありません」 when it does not resolve); for a hotspot, its 状態 and 結論; its 関係 (きっかけ,
  発行, 発生, 対象, 実行者, 参照, 論点), as links; for an event, where it appears in the timelines (タイムラインでの出現)
  and which notes of the view draw it; for a timeline or group, its events.
- **ソース**: the whole file, read-only, syntax-coloured, diagnostics in the gutter, scrolled to the declaration, which
  is highlighted with a button that copies its code (to paste into feedback for an AI agent); clicking a declaration
  selects it. A selected file shows here the same way.

## Problems and changes (bottom)

Diagnostics (click to locate) and additions / changes / removals since the baseline (below), under a heading naming
it (「main (d22ce69) からの変更」) that opens the menu choosing it; a removed item opens in the inspector as it was
there.

## Comparing with a git revision

The 比較対象 menu in the header picks what additions, changes and removals are shown against: 前回の保存 (the last valid
model shown before, the default) or a git revision of the workspace — a branch, a tag, one of the latest commits, or
any revision typed in (`main`, `HEAD~3`, a commit). `dt view --base main` starts with one. The model compared is the
working tree, saved but not necessarily committed, against the `.dt` files of that commit (picked by `sources`). The
choice is the server's, so every open page follows it; a branch is followed as it moves (a commit, a checkout).

With either baseline:

- The diagrams mark added and changed elements, draw removed ones as ghosts where they were in the baseline's
  layout, and mark the rows of a node: added and changed fields in colour, removed ones struck through.
- The inspector marks the rows of its 構造, 状態遷移 and 振る舞い tabs — fields, invariants, states, values, commands
  with their transitions, parameters, requirements, changed fields, events, errors and policies — added, changed or
  removed (struck through), and strikes through the former value of a changed one (a field's type, an expression, a
  transition, a description).

A revision whose sources do not parse is reported in a banner, and nothing is marked then. Stormings are compared with
neither baseline: their views are not marked.

## Behaviour and settings

- Selecting never switches the main view by itself; the item is highlighted when the current view shows it.
- Added / changed elements are highlighted; removed ones appear as ghosts (see
  [Comparing with a git revision](#comparing-with-a-git-revision)). On a syntax error the last diagram stays.
- The language of the Live View (Japanese or English) follows the browser, or is forced in the settings menu (the gear
  at the right of the header). It covers the screen and the diagrams' own words (集約 / aggregate…); the model's names
  and labels are shown as written, and diagnostics are in English.
- The theme follows the OS (自動), or is forced with ライト / ダーク in the settings menu; both choices are remembered
  per browser.
- Names follow the 名前の表示 switch in the header: ラベル (the string after a declaration's name, falling back to the
  name), 名前 or 両方. Layouts are cached in `<root>/.domaintrail/layout.json`. The canvas is read-only.

See [ADR 0001](adr/0001-mvp-implementation-decisions.md) for the design decisions.

## In a session

Under `dt session start` (not `dt view`) the page gains a session panel on the right: the participants and where they
are, the others' cursors on the same view, drafts and requests about the selection, the runs of the agent and the
revision timeline with comparison, confirm and restore. `dt view` serves the same page without it. See
[`dt guide session`](guide.md#collaboration-sessions).
