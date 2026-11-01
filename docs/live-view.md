# The Live View

`dt view` watches the workspace, re-validates on every save and pushes updates to the browser over WebSocket. It
serves the page at <http://127.0.0.1:4321> (`--port`, `--host`, or `view.port` / `view.host` in `domaintrail.jsonc`)
and runs until Ctrl+C. [Getting started](getting-started.md#watch-it-in-the-live-view) shows what to look at first;
this page describes every pane.

The screen has no header. It is laid out like an IDE: the left pane with its lists, the main canvas, and the inspector
(right of the canvas, or below it); in a session, the chat is a pillar of its own at the right end. Panes are closed
and opened with the icon buttons at their top (a closed inspector leaves a narrow rail with the buttons that open it)
and resized by dragging; all of it is remembered per browser. A pane slides in and out as it opens and closes (its
content does not reflow on the way), and the canvas keeps what is at its center in place whenever its size changes
(a pane, the window); the inspector moving between right and below fades out and back in. With the OS's "reduce
motion" setting everything is instant.

## Left pane

Its head names the workspace (the folder of `domaintrail.jsonc`) after DomainTrail. A column of icons at its left edge,
the activity bar, picks the list it shows — 木, 問題 and 差分, with the number of problems and changes as badges — and
clicking the list shown collapses the pane to the activity bar (it never disappears). At its foot:

- **The health**: a dot, green when all is well, larger and amber or red with a word when it is not (警告: connecting,
  no sources, an older diagram shown, warnings; エラー: the model does not validate, or the server is gone). A click
  shows the status, the number of files, the version, the time of the last update and the connection.
- **The settings** (the gear): 名前の表示, the theme, the language and 文字の大きさ.

Collapsed, the pane keeps the brand's mark at the top of the activity bar, and the health and the gear at its bottom.

### 木 (tree)

The model tree — shared contexts first, then each context grouped by kind; aggregates expand to their states and
commands — and the `.dt` and `.dtes` files with error/warning counts. Click selects (a file too); double-click opens the item in
the view or inspector tab that suits it.

### 問題 (problems)

The diagnostics; a click locates one (in the inspector's source for a syntax error, which belongs to no element).

### 差分 (changes)

The 比較対象 button at its top names what the model is compared with and opens the menu choosing it (see below); under
it, the items added, changed and removed since then. A removed item opens in the inspector as it was in the baseline.

## Main (center)

Views of the whole model, in tabs. Under the tabs, every view's toolbar puts the same kinds of controls in the same
places, leaving out what the view does not have: at the left the subject (what is looked at: the storming and its
timeline) and then the level (how much of it is drawn: icons, named in their tooltips); at the right
「⏷ 絞り込み」 (what is hidden: the BCs, the kinds…, in a popover; while anything is narrowed the button shows how many
narrowings are active, e.g. 「絞り込み 2」, and the popover clears them all with すべて解除). On a narrow canvas the
subject's names are cut short first (the whole name in a tooltip); 絞り込み stays, and goes onto a second row only when
even that is not enough. Notices — the connection lost, a syntax error that keeps the last diagram, a revision that cannot be compared,
a storming that stopped parsing — are a strip over the canvas. Anything about one selected item is in the inspector.
See [ADR 0007](adr/0007-pane-roles.md).

The canvas's controls sit at its bottom-left: `− 85% +` zooms out and in around the middle (the level shows live;
a click on it goes back to 100%), ⤢ fits everything (`Shift+1`), ◎ fits the selection (`Shift+2`; disabled while
nothing is selected), the book (凡例, named in its tooltip) opens the legend upward, and « at the right end collapses the
bar toward the corner, leaving only », which brings it back (the legend's panel is hidden while collapsed and keeps
its own open or closed state). `U` does the same as « and » (`H` stays tldraw's hand tool), and the choice is
remembered per browser. Hovering an edge (its line or arrowhead) tells what it means, in the legend's words for that
view (「参照（ID で別の集約へ）」…). The keys do nothing while typing. The
inspector's 状態遷移 diagram has the same controls.

- **Context Map**: one node per bounded context and one edge per dependency between contexts, labeled with the number
  of ID references and borrowed types (solid when types are borrowed). Shared contexts and contexts that only declare
  IDs are hidden unless 「共有・外部の BC も表示」 is checked (in 絞り込み; checking it counts as a narrowing, being
  the view's non-default choice). Selecting a context lists every use in the inspector
  (依存先 / 依存元). See [ADR 0006](adr/0006-context-map.md).
- **Structure**: contexts, aggregate boundaries, entities, value objects, unions, `owns` / `references`. Pick bounded
  contexts in 絞り込み (any number) to draw only them, with the elements they use and the elements that use them as
  stubs; the eye next to each other context hides its stubs and the edges to and from them (the BCs picked and the hidden stubs
  count as one narrowing each). The first row, 「すべての BC」, checks or unchecks every context and shows or hides every stub. Three
  levels work in both, switched by the icons in the toolbar: 詳細 (every field), 概観 (the elements' names only) and
  集約 (only the aggregates with their descriptions, and one edge per pair of aggregates that depend on each other,
  also through the entities, value objects and IDs they hold; shared contexts are left out, and a context without
  aggregates stays as a frame with its description).
- **Catalog**: cards to look over the model, one section per kind; for now the domain primitives per context (shared
  first) with base type, invariants and usages. The text filter is at the left of the toolbar (the catalog has no
  subject or level); 絞り込み picks the BCs and the kinds (checkboxes with each kind's colour). The catalog's filter is
  not remembered across reloads, so that a reload never hides elements without saying so.
- **Event Storming** (イベントストーミング, shown when the workspace has a `.dtes` storming; a workspace of `.dtes` files only
  opens on it): one storming as sticky notes, laid out left to right (`dt guide storming-views`). The toolbar's
  subject is a breadcrumb of two pickers: the storming (表示するストーミング; its name alone when there is only one) ▸ the
  タイムライン — すべて（統合） for the integrated canvas, or one timeline with its one-hop causal paths (a subject, not
  a filter: the two draw different things). The level icons are ビッグピクチャー (the telescope: events, timelines
  and hotspots only) and デザインレベル (the microscope: also commands, policies, actors, external systems, aggregates
  and read models). The choices are
  remembered per browser and never change the `.dtes` file. The integrated canvas draws each event once (no group
  frames), and a dashed arrow between two events names the timelines it belongs to when not all of them do; one
  timeline draws each occurrence, and a group is a frame around its events. Solid arrows are type-level causes
  (possible, not "happened"), dashed orange arrows the order of a timeline, dotted lines the other relations (without
  an arrowhead for a hotspot's event); the colours of the notes are defaults with no
  meaning (see the legend). A storming whose file stops parsing stays as it last parsed, with a banner.

## Inspector (right or below)

The selected item — name, description, diagnostics, a back button naming the item it returns to (「〇〇 に戻る」), and
buttons to show it in a view. Its menu (⋯, next to its close button) moves it below the canvas (下に移動) or back to its
right (右に移動). Sub-tabs: 構造 / 状態遷移 / 振る舞い / 参照 / ソース. An event shows 永続化 / 非永続 next
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

## Comparing with a git revision

The 比較対象 menu, at the top of the 差分 list, picks what additions, changes and removals are shown against: 前回の保存 (the last valid
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
- The language of the Live View (Japanese or English) follows the browser, or is forced in the settings (the gear at
  the foot of the left pane). It covers the screen and the diagrams' own words (集約 / aggregate…); the model's names
  and labels are shown as written, and diagnostics are in English.
- The theme follows the OS (自動), or is forced with ライト / ダーク in the settings menu; both choices are remembered
  per browser.
- 文字の大きさ (小 / 標準 / 大 / 特大, remembered per browser) sizes the text of the panes, the toolbars, the menus,
  the dialogs, the tooltips and the canvas's controls and legend: 90%, 100%, 115% and 130% of the browser's default
  font size, so a larger default font size in the browser enlarges the page too (標準 at the usual 16px is the page's
  original size). The diagrams' own text is not affected; it follows the canvas's zoom. Until you drag them, the left
  pane, the inspector and the chat open wider (and the narrow-window thresholds below grow) in proportion, so that
  larger text does not wrap everywhere; a width you dragged is kept.
- Names follow the 名前の表示 setting: ラベル (the string after a declaration's name, falling back to the
  name), 名前 or 両方. Layouts are cached in `<root>/.domaintrail/layout.json`. The canvas is read-only.

See [ADR 0001](adr/0001-mvp-implementation-decisions.md) for the design decisions.

## In a session

Under `dt session start` (not `dt view`) the session's chat is a pillar at the right end of the page, the whole height,
the same for everyone and open when the page joins. Its head shows the participants online (a click lists them) and
the agent's status at a glance, with ✕ to close it; while it is closed, a round 💬 button at the bottom right of the
canvas opens it again, marked with a spinner while the agent runs, `?` while it waits for an answer, and the number of
messages since the chat was last shown (else of the requests awaiting approval). The 💬 next to the selection and `C`
open it too. Its width is remembered per browser; on a window narrower than about 1280px the left pane collapses to
its activity bar while the chat is open, and below about 1024px the inspector moves below the canvas (your own choices
come back when the window is wide again).

The chat has two views:

- **チャット**: one stream of every message posted, one card per run — updated in place, with the runs that continue it
  (an answer, an alternative) one under the other and a quote of each message it applied (with the reply's mark when
  it applied several) — the
  revisions confirmed or restored, and a composer for a message about up to 20 targets (none: the whole workspace),
  picked with `@` or added from the selection, whose unsent text and targets stay in the browser. An applied message
  shows its latest run's mark (`✓ #3`). The facilitator applies messages from the stream (⤓, ▾ with a note, several
  with Shift/⌘-click), answers questions and picks alternatives in the cards, cancels runs, and reaches confirm,
  restore and comparison from a card's ⋯ and the session's actions from the head's ⋯.
  Participants vote with ♡ on a question's options and on an assumption (kept, or one of its alternatives) while the
  run waits; the facilitator sees the counts and decides. An answered question keeps its options, with ✓ on what was
  chosen, the rest muted, the votes frozen and `回答 name · time` under it; a picked alternative has ✓ and
  `選択 name · time → #n`. Anyone reacts to a message or an AI turn (☺+ on hover:
  賛成, 疑問, いいね, 了解). Counts are small; who marked is in the tooltip and, for a vote, in a list on a click.
  ↩ on an ended AI turn (on hover) replies to it: a chip above the composer (`↩ AI #3 への返信 ✕`), the targets of its
  messages to start with; the posted reply shows `↩ AI #3: …` on top, a click going to the card. Replies are applied
  like any message, and the run made from them continues the replied run's card; the agent gets that run's messages,
  reply and diff as context.
- **履歴**: the history of changes, newest first. Each row is one run that changed files — or a run that asked a
  question together with the run queued again to answer it — with its number, time, outcome, what the AI says about
  it, the number of files it changed (measured from the revisions) and who asked. Opened, it shows the run's card, and
  チャットで見る scrolls the chat to it. すべて also lists the runs
  that changed nothing, and those declined, failed or cancelled.

The others' cursors are drawn on the same view. `dt view` serves the same page without any of it. See [`dt guide session`](guide.md#collaboration-sessions).
