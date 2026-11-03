# The Live View

`dt open` watches the workspace, re-validates on every save and pushes updates to the browser over WebSocket. It
serves the page at <http://127.0.0.1:4321> (`--port`, `--host`, or `open.port` / `open.host` in `domaintrail.jsonc`)
and runs until Ctrl+C. [Getting started](getting-started.md#watch-it-in-the-live-view) shows what to look at first;
this page describes every pane.

The app bar runs across the top; under it the screen has three columns: the left column — the navigator (the lists)
on top and the detail of the selected item (the inspector) under it — the canvas, and, in a session, the chat at the
right end. Panes are closed and opened with the icon buttons at their top (a closed detail leaves a narrow rail at the
bottom of the left column, with the button that opens it). The left column's width, the chat's width and the split
between the navigator and the detail are dragged; each edge is also a separator the keyboard moves (focused, the arrow
keys along it step it, Shift in larger steps, Home / End go to its limits) and a double click gives its default size
back. The split has a grip, so that it is seen at rest; the navigator and the detail each keep a little room. All of it
is remembered per browser. A pane slides in and out as it opens and closes (its content does not reflow on the way),
and the canvas keeps what is at its center in place whenever its size changes (a pane, the window). With the OS's
"reduce motion" setting everything is instant.

## App bar

It holds only what concerns the whole page. At the left, DomainTrail and the workspace's name (the folder of
`domaintrail.jsonc`), then the world switch: **ドメインモデル** (the `.dt` model, seen through three views) and
**イベントストーミング** (the `.dtes` stormings; it can be chosen with no storming yet, and then says how to start one).
Switching worlds returns to the view, the storming and the conditions last used in each. At the right end: 問題 (the
number of errors, else warnings, as a badge; a click opens the problems in the left column's navigator, and closes it again), and in
a session the collab menu, the AI's state and, in Solo, ⋯ (see below). On a narrow window the world switch shows its
icons only, each named in its tooltip.

In a session, after the world switch, the **current journey's chip** (the session has one current journey: the
facilitator chooses it, the one person in Solo; with none chosen, the most recently created active one): 🧭 the journey
· 📍 the step here → 🏁 the goal (✓ 到達 once it is reached). A narrower bar shows 🧭 and the journey's name, then 🧭
alone. With no journey it reads 🧭 ゴールを決める. A dashed chip names a storming or context that is gone. The
facilitator's chip counts the participants' requests waiting. Pressing it opens the **journeys panel** (everyone reads
it): the requests waiting (承認 / 却下 for the facilitator; the requester's own, 承認待ち and 取り下げ); the current
journey — its brief (目的, 範囲, 制約, 参加者, 使い道, もと), its map as the guide draws it, and ガイドを見る, ゴールを変える
(the ES levels, or the goals of its pattern), ブリーフを見直す (`/es:start` or `/model:start` into the composer),
完了にする, しまう; the other journeys with where each stands (この旅にする makes one current); 新しい旅 (`/es:start`,
`/model:start`); and the archived ones, counted, opened on demand (戻す). A participant's choice, goal, done, archive
or mark becomes a request the facilitator approves in the panel. Everything comes from `domaintrail.journey.json`
(see [`dt guide`](guide.md#the-journey-file)): a change to it from git or another tool shows at once.

## Left column

A column of icons at its left edge, the activity bar, picks the list the navigator shows — 木 and 差分, with the
number of changes as a badge (問題 is opened from the app bar) — and clicking the list shown collapses the column to the
activity bar (it never disappears); the detail goes with it (it is not shown alone: to give the detail the whole
column, drag the split up). Opening something in the detail from elsewhere (a link in the chat, a double click in the
tree, a problem) opens the column again. At its foot:

- **The health**: a dot, green when all is well, larger and amber or red with a word when it is not (警告: connecting,
  no sources, an older diagram shown, warnings; エラー: the model does not validate, or the server is gone). A click
  shows the status, the number of files, the version, the time of the last update and the connection.
- **The settings** (the gear): 名前の表示, the theme, the language and 文字の大きさ.

Collapsed, the column keeps the health and the gear at the bottom of the activity bar.

### 木 (tree)

The navigator follows the world. In the domain model, the model tree — shared contexts first, then each context grouped by kind (a folded group says how many it holds, 「集約 (1)」; an open one lists them, so it does not); aggregates expand to their states and
commands — and the `.dt` and `.dtes` files with error/warning counts. Click selects (a file too); double-click opens the item in
the view or inspector tab that suits it.

In event storming, the stormings › their stages › each stage's timelines (its main flow, then its exceptions, marked
with a small arrow in the exceptions' red), and a storming's timelines that are in no stage right under it (all of
them, for a storming without stages); a collapsed stage counts its timelines after its name, muted, as 「(3)」, as the
model tree's groups do. A click shows that view — the storming's integrated canvas, the stage or the timeline — as the
view bar's pickers do (the two always show the same choice) and selects it for the detail. The filter at the top keeps the rows whose name or ID holds the text, with their rows above
(a matching storming or stage keeps all its rows); what is folded is remembered per browser.

### 問題 (problems)

The diagnostics; a click locates one (in the inspector's source for a syntax error, which belongs to no element).

### 差分 (changes)

The 比較対象 button at its top names what the model is compared with and opens the menu choosing it (see below); under
it, the items added, changed and removed since then. A removed item opens in the inspector as it was in the baseline.

## Main (center)

One row above the canvas, the view bar, holds what acts on the canvas only. It puts the same kinds of controls in the
same places in every view, leaving out what the view does not have: in the domain model, first the view switch —
マップ (the Context Map), 構造 (the Structure View) and カタログ — then the subject (what is looked at: the structure's
focused contexts, the catalog's search, the storming and its timeline) and the level (how much of it is drawn: the
structure's 詳細 / 概観 / 集約 with their names, the storming's two levels as icons named in their tooltips); at the right
「⏷ 絞り込み」 (what is hidden: the BCs, the kinds, a storming's exceptions…, in a popover; while anything is narrowed
the button shows how many narrowings are active, e.g. 「絞り込み 2」, and the popover clears them all with すべて解除),
then 「⤓ 書き出し」 (a menu: 印刷, PDF, PNG, SVG; see [Printing and exporting](#printing-and-exporting)) — the
catalog has 「印刷」 there instead. The view bar says what is shown (what an AI is told the view was); the canvas's
controls, how it is looked at. As the canvas narrows, the bar gives up words in turn, each control keeping its name in
a tooltip: first the right end's buttons become icons (the count stays), then the view switch, then the structure's
levels; last, the subject's names are cut short with … (the whole name in a tooltip). Notices — the connection lost, a syntax error that keeps the last diagram, a revision that cannot be compared,
a storming that stopped parsing — are a strip over the canvas. Anything about one selected item is in the inspector.
See [ADR 0007](adr/0007-pane-roles.md).

The canvas's controls sit at its bottom-left: `− 85% +` zooms out and in around the middle (the level shows live;
a click on it goes back to 100%), ⤢ fits everything (`Shift+1`), ◎ fits the selection (`Shift+2`; disabled while
nothing is selected), 詰めて表示 (two inward arrows, named in its tooltip) closes up the gaps between the notes and
boxes of every diagram, the shapes (凡例,
named in its tooltip) open the legend upward, and « at the right end collapses the bar toward the corner, leaving only
», which brings it back (the legend's panel is hidden while collapsed and keeps its own open or closed state). `U` does the same as « and », and the choice is remembered per browser. The legend starts hidden, and each view
remembers its own: opening it on the context map leaves it closed on the structure (its levels and focus share one),
the 状態遷移 diagram and the Event Storming. Hovering an
edge (its line or arrowhead) tells what it means, in the legend's words for that view (「参照（ID で別の集約へ）」…).
The keys do nothing while typing. The inspector's 状態遷移 diagram has the same controls, without 詰めて表示, and
with its own 書き出し (the download arrow: PNG and SVG, opening upward).

詰めて表示 is off by default and remembered per browser. While it is on, every diagram — the Event Storming views (the
stages' grid included), the Context Map, the Structure View (focused views included) and the inspector's 状態遷移 —
is laid out again with narrower gaps between notes, boxes, layers and frames (arrowheads, edge labels, the exceptions'
captions and the frames' titles keep their room). The page asks for a diagram's compact layout the first time it shows
it and shows the normal one until it comes; both are kept (in `layout.json` in the workspace's cache directory, outside
it, under their own keys), so switching back and forth lays out nothing again. Each spacing keeps its own camera. A compact diagram draws no ghosts
of removed elements (they are where the baseline's normal layout had them), and the others' cursors are drawn only
between viewers who see the same spacing.

The canvas is read-only and moves the same way everywhere: a drag pans (on the background or over an item; there is
no hand tool, so `H` does nothing), the wheel or a trackpad's two fingers pan, and Ctrl / ⌘ + wheel or a pinch zoom
around the pointer. A click selects an item and Shift-click adds one (or takes it out); Shift + drag draws a selection
box; `Escape` clears the selection. Once you clicked a canvas, `+` / `-` zoom, `Shift+0` goes back to 100% and, in the
inspector's diagram, `Shift+1` / `Shift+2` fit everything or the selection. The levels go from 5% to 800%, and − and +
step through 5, 10, 25, 50, 100, 200, 400 and 800% ([ADR 0029](adr/0029-react-flow-canvas.md)).

- **Context Map**: one node per bounded context and one edge per dependency between contexts, labeled with the number
  of ID references and borrowed types (solid when types are borrowed). Shared contexts and contexts that only declare
  IDs are hidden unless 「共有・外部の BC も表示」 is checked (in 絞り込み; checking it counts as a narrowing, being
  the view's non-default choice). Selecting a context lists every use in the inspector
  (依存先 / 依存元). See [ADR 0006](adr/0006-context-map.md).
- **Structure**: contexts, aggregate boundaries, entities, value objects, unions, `owns` / `references`. Pick bounded
  contexts in 絞り込み (any number) to draw only them, with the elements they use and the elements that use them as
  stubs; the eye next to each other context hides its stubs and the edges to and from them (the BCs picked and the hidden stubs
  count as one narrowing each). The first row, 「すべての BC」, checks or unchecks every context and shows or hides every stub. Three
  levels work in both, switched in the view bar: 詳細 (every field), 概観 (the elements' names only) and
  集約 (only the aggregates with their descriptions, and one edge per pair of aggregates that depend on each other,
  also through the entities, value objects and IDs they hold; shared contexts are left out, and a context without
  aggregates stays as a frame with its description).
- **Catalog**: cards to look over the model, one section per kind; for now the domain primitives per context (shared
  first) with base type, invariants and usages. The text filter is in the view bar, after the view switch (the catalog has no
  subject or level); 絞り込み picks the BCs and the kinds (checkboxes with each kind's colour). The catalog's filter is
  not remembered across reloads, so that a reload never hides elements without saying so.
- **Event Storming** (the イベントストーミング world; a workspace of `.dtes` files only opens on it): one storming as
  sticky notes, laid out left to right (`dt guide storming-views`). The view bar's subject is a breadcrumb of two pickers: the storming (表示するストーミング; its name alone when there is only one) ▸ the
  タイムライン — すべて（統合） for the integrated canvas, or one timeline with its one-hop causal paths and the causes of its events (a subject, not
  a filter: the two draw different things). The level icons are ビッグピクチャー (the telescope: events, timelines
  and hotspots only, without the events marked `level design`) and デザインレベル (the microscope: also commands, policies, actors, external systems, aggregates
  and read models). The choices are
  remembered per browser and never change the `.dtes` file. The integrated canvas draws each event once (no group
  frames), and a dashed arrow between two events names the timelines it belongs to when not all of them do; one
  timeline draws each occurrence, and a group is a frame around its events. Solid arrows are type-level causes
  (possible, not "happened"), dashed orange arrows the order of a timeline (the event's orange, not a warning),
  dotted lines the other relations (without an arrowhead for a hotspot's event). The notes take the convention's
  colours, and the legend shows each kind with its colour and name: event orange, command blue, policy purple,
  aggregate yellow, read model green, hotspot pink, actor pale yellow (rounded), external system lilac (dashed edge),
  and a group a dashed frame tinted with the event's orange. A resolved hotspot (`status resolved`) is a paler,
  greyer pink with a green ✓ in its top-right corner and a fainter dotted `on`; hovering it shows its `resolution`, and
  the legend has it as 解決済みのホットスポット next to ホットスポット (the canvas, the printed sheet and the exported
  SVG and PNG alike). Every note also names its kind above its label
  («イベント»), so the colour is never the only cue. Light: soft pastel paper, a coloured edge and dark text; dark:
  muted deep paper of the same hue, a coloured edge and pale text. A storming whose file stops parsing stays as it last parsed, with a banner.
  A storming with stages or exceptions (`stage`, `exception`) is drawn in time order: the stages as labelled frames
  left to right, the trunk of the main flows one straight row through them, every other timeline on a row below the
  step it branches off at (the exceptions' dashed arrows a quieter red, a dotted arrow back for `then`). The タイムライン
  picker then also lists each stage (「…（例外を含む）」), and the 絞り込み has 「例外を表示」 (on by default,
  remembered per browser; off counts as one narrowing) to draw the integrated canvas and the stages without their exceptions.
  Selecting a note keeps it and what it is joined to in full view and dims the rest (a short fade; none with reduced
  motion): the steps before and after it in the timelines shown (an exception's first step and its `then` included),
  the command that causes an event with its actor or external system, read model and aggregate, the policies that
  react to it and its hotspots, and the edges between them; a command, policy or actor selected keeps the notes its
  edges join. An element drawn once per use (an actor beside each command) counts as one: selecting one of its notes
  keeps every copy. An event in a group is joined through its group's time order, and a group joined to the selection
  keeps its events; the stages' and groups' frames are never dimmed. Clicking the empty canvas (or `Escape`) clears the
  selection and brings everything back. Both drawings do it, the integrated canvas and a timeline laid out by ELK and
  the stages' grid.

The modeling views (Context Map, Structure, Catalog, the inspector, the explorer) use the same hues for the same
concepts, on smaller areas: the cards are neutral, and the kind is on their edge, their stereotype («集約ルート») and
their shape. A bounded context is a slate frame with its caption (dashed for a shared one); an aggregate root an indigo
edge with a tinted header, and its boundary indigo dashes (indigo, not the storming's yellow: the boundary of
consistency is the model's structure); an entity slate; a value object teal with rounded corners (a union also dashed).
A command is blue, a domain event orange and a policy purple (the kind chips, the explorer's dots, the 振る舞い
cards' stripes, a state view's transitions), as in the storming; a domain error is a deep red, apart from the
diagnostics. A state is neutral: the arrows and names tell the way through the states. References by ID are indigo
dashes (they point at an aggregate root).

On every canvas, the overlays keep their own channel and never recolour a node's kind: the local selection is an
indigo ring outside the node; a change from the baseline is a green (added) or yellow (changed) ring with a 追加 / 変更
badge, and a removed element a faded, dashed ghost with its name struck through and a 削除 badge; a diagnostic is a ✕
or ! mark on the node's corner, with its text in the inspector and the problems list (a state view's transitions keep
their command's blue). The others' cursors and names have a light halo, so that they read over any sticky note.

## Printing and exporting

The browser's print (Ctrl+P / ⌘P) prints the current diagram alone — without the panes, the chat, the bars, the
canvas's controls or the legend — fitted whole to one landscape page, in the light colours whatever the theme. The
paper size is chosen in the browser's print dialog; the diagram is scaled to it. The diagram is printed in its compact
layout when the page has it (詰めて表示 on, or printed before), else in the layout shown.

The page has no margin of the browser's, so the browser prints no header or footer of its own (the page's title, its
URL, the date); the sheet keeps its own margin. Above the diagram, one line says what it is and how it is shown, in the
display mode's names: the workspace, the world, the view and what in it is shown, then its conditions, e.g.
`ws › ドメインモデル › 構造図 · 詳細` or
`ws › イベントストーミング › 住民票などのコンビニ交付 › コンビニでの発行 · デザインレベル · 例外を含む` (an Event Storming
view: the storming, すべて（統合）, a stage or a timeline, the level, and whether the exceptions are drawn when the storming
has some; the Structure View: the focused contexts, if any, and the level; the Context Map: すべてのコンテキスト when
shared and external BCs are shown). Nothing else is printed (no date, no version).

書き出し at the right end of the view bar opens a menu below it. Its **印刷** is the surer way to print: it gets
the compact layout first (the button spins meanwhile), then opens the print dialog. The catalog has 「印刷」 there
instead: it prints as a page, its list without the panes around it (it has no export). The menu:

- **PNG**: the current diagram (its stage, level and exceptions, and its spacing: compact while 詰めて表示 is on) on
  white, at twice its size (less for a diagram too large for a browser's canvas).
- **SVG**: the same as a portable SVG — plain shapes and text, no embedded HTML, the colours as attributes, the fonts as
  the page's font stack ending with a generic family — that opens in browsers, Figma and Inkscape. Each note's label is
  broken into lines, shrunk and cut short with «…» as on the canvas (measured in the page's fonts); a viewer without
  those fonts draws the same lines in its own, a little wider or narrower.
- **PDF（印刷画面から保存）**: the 印刷 action; the print dialog saves the PDF.
- **見出しを含める** (off by default): the heading line above the diagram in a PNG or SVG (a printed sheet always has it).
- **凡例を含める** (off by default): the view's legend under the diagram, at the left, in a PNG, an SVG and a print.

The two options are remembered per browser. A file is named from IDs, not labels:
`<workspace>-<view>-<storming or contexts>-<stage or timeline>-<level>.png`, e.g.
`shop-storming-OrderToCash-all-design-level.svg` or `shop-structure-detail.png`; a state diagram's is
`shop-states-Billing.Invoice.png`.

## Downloading the sources

ソース一式をダウンロード (en: Download sources (.zip)), in the collab menu (under `dt open`, its ⋯), is for everyone on
the page: the facilitator and every participant. It saves `<workspace>-sources.zip`, the same archive as
[`dt export sources`](guide.md#sharing-the-sources): the `.dt` and `.dtes` files `dt check` analyzes and the config
file, below a folder named after the workspace, made from the files on disk when it is clicked — never the local
override, `.domaintrail`, `.git`, generated output, symlinks or files git ignores. The server serves it at
`GET /api/export/sources.zip` behind the page's own sign-in (no identity: 401; a Host or Origin not allowed: 403), as
an attachment (`Content-Disposition` with the UTF-8 `filename*`), never cached; 404 when the workspace has no
sources, told in the menu. The read-only Live View (`dt open --host <address>`) serves the same path to whoever it
serves the view, but has no menu.

## Detail (the inspector, under the navigator)

The selected item — name, description, diagnostics, a back button naming the item it returns to (「〇〇 に戻る」), and
buttons to show it in a view; with nothing selected, a line says to pick one. Its close button folds it to the rail at
the bottom of the left column. Sub-tabs (on a second row when the column is narrow): 構造 / 状態遷移 / 振る舞い / 参照 / ソース. An event shows 永続化 / 非永続 next
to its kind, as it does in an aggregate's 発生させる Event list; persistent events have a database icon in the
explorer.

- In a session, a selected storming shows its event storming journey in brief (its purpose, where it stands, its
  goal), and a selected context the modeling journeys over it (those that name it, and those over the whole model);
  a row opens the journeys panel.
- **状態遷移**: states and command transitions of the aggregate (`new` marks factory commands), for the aggregate and
  its states and commands; it pans and zooms like the main canvas and shows the selected state or command.
- **振る舞い**: what a command takes, requires, changes, emits and returns, and the policies that trigger it.
- **A storming's element** (selected in the Event Storming view) is read next to the canvas: it shows only what the
  canvas does not, and its connections are what the canvas keeps in full view. Its kind, a grey microscope badge for
  an event shown at Design Level only, its name with the 💬 that targets it in the chat, and its `///` description in
  full. Then rows, each named by a grey icon (its name in the tooltip and `aria-label`), each only when it has
  something: its problems on top (a soft warning: the checker's message in plain words — 「戻り先が本流にない」 —
  the code in the tooltip, with a 🔧 to have the AI fix it); ほかの場所 (`MapPin`: the timelines it occurs in outside
  the view shown — another stage or timeline, an exception hidden by the filter — each a link that shows that
  timeline with the event selected); 今は隠れているつながり at Big Picture (`EyeOff`: the command that causes it with
  who issues it → ここ → the policies reacting, as links, and a microscope to see it at Design Level); in a session,
  話題 (`MessageSquare`: how many messages target it or an occurrence of it, a link to the latest in the chat, and
  that message on one line), AI の作業 (`Bot`: how many runs its messages target or its changes touched, a link to
  the latest in AI の作業) and このセッションで追加 / 変更 (`CirclePlus` / `PencilLine`: the first message of the run
  that added it, else of the latest that changed it, a link to the run's card); its `.dt` counterpart (`Blocks`: an
  event's, command's or aggregate's `ref`, a link while the model has it), and a resolved hotspot's conclusion
  (`CircleCheck`). Last, the actions, brand-coloured icons on a pale wash: AI に聞く (filled), 問いを足す (an event),
  解決を伝える (an open hotspot). Each action, and 🔧, only puts the beginning of a message in the composer with the
  element as its `#` target (「#暗証番号を忘れた について、」), opens the chat and puts the caret there: the person
  writes the rest and sends it. Outside a session, or once it ended, there are no actions. Its file and line, the DSL's
  words (on, issues, emits) and the list of its relations are not shown (the canvas draws them; the AI edits the
  files). A stage shows the stage it comes after, its main flows and its exceptions, a timeline its steps (a group's
  events in braces) and where an exception returns to, a group its events — each row an icon — and a stage or a
  timeline has an eye that shows its view.
- **ソース**: the whole file, read-only, syntax-coloured, diagnostics in the gutter, scrolled to the declaration, which
  is highlighted with a button that copies its code (to paste into feedback for an AI agent); clicking a declaration
  selects it. A selected file shows here the same way.

## Comparing with a git revision

The 比較対象 menu, at the top of the 差分 list, picks what additions, changes and removals are shown against: 前回の保存 (the last valid
model shown before, the default) or a git revision of the workspace — a branch, a tag, one of the latest commits, or
any revision typed in (`main`, `HEAD~3`, a commit). `dt open --base main` starts with one. The model compared is the
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
  the foot of the left column). It covers the screen and the diagrams' own words (集約 / aggregate…); the model's names
  and labels are shown as written, and diagnostics are in English.
- The theme follows the OS (自動), or is forced with ライト / ダーク in the settings menu; both choices are remembered
  per browser.
- 文字の大きさ (小 / 標準 / 大 / 特大, remembered per browser) sizes the text of the panes, the toolbars, the menus,
  the dialogs, the tooltips and the canvas's controls and legend: 90%, 100%, 115% and 130% of the browser's default
  font size, so a larger default font size in the browser enlarges the page too (標準 at the usual 16px is the page's
  original size). The diagrams' own text is not affected; it follows the canvas's zoom. Until you drag them, the left
  column and the chat open wider (and the narrow-window thresholds below grow) in proportion, so that
  larger text does not wrap everywhere; a width you dragged is kept.
- Names follow the 名前の表示 setting: ラベル (the default; the string after a declaration's name, falling back to
  the name when there is none or it is blank), 名前 or 両方 (the label and the name; the name alone without a label).
  Layouts are cached outside the workspace, in `~/.cache/domaintrail/<workspace>/layout.json` (`$XDG_CACHE_HOME`;
  `dt guide config`), the compact ones of 詰めて表示 beside the normal ones. The canvas is read-only.

See [ADR 0001](adr/0001-mvp-implementation-decisions.md) for the design decisions.

## In a session

Under `dt collab` (and `dt open`, for one person) the session's chat is a pillar at the right end of the page, the whole height,
the same for everyone and open when the page joins. Its head holds its two views and ✕ to close it. The app bar's right
end shows the collab menu (the avatars and the participants online ▾: who is where, the invite link,
ソース一式をダウンロード, 退出, and the facilitator's actions; see [`dt guide session`](guide.md#collaboration-sessions); in
Solo a plain ⋯) and the agent's status at a glance (running and for how long, waiting for an answer, or queued; nothing
when idle). A click on the status (AI の作業を見る) opens the chat on AI の作業 and the card it stands for — the running one,
else the next to run, else the one waiting longest for an answer — scrolled to and marked for a moment, besides those
already open; the chat keeps its scroll, so チャット brings the reader back where they were. While the chat is closed, a round 💬 button at the bottom right of the
canvas opens it again, marked with a spinner while the agent runs, `?` while it waits for an answer, and the number of
messages since the chat was last shown (else of the requests awaiting approval). The 💬 next to the selection (on the canvas,
or next to the element's name in the inspector) and `C` add the selection as targets and open it too. Its width is remembered per browser. The detail and the chat are seen side by side; only on a window narrower than
about 1024px does the left column collapse to its activity bar while the chat is open (your own choice comes back
when the window is wide again).

The chat has two views:

- **チャット**: one stream of every message posted, one card per run — updated in place, with the runs that continue it
  (an answer, an alternative) one under the other and a quote of each message it applied (followed, once the run
  replied, by what it did of it: `✓ 対応`, `◐ 一部`, `– 未対応`; none when it asks about it) — the
  revisions restored, and a composer for a message about up to 20 targets (none: the whole workspace, shown with no target chips),
  picked with `#` or added from the selection, whose unsent text and targets stay in the browser; `@` mentions a
  participant (`@佐藤`, a link that opens the participants at them). A message that mentions you has a faint blue
  background in your stream, and the closed chat's button shows `@ n` for the new ones. A card is named by the title
  the AI gave its first run (`AI · 請求書の税区分 · 19:21`), else by the head of its first message; the runs continuing
  it show their time only (the title takes the row's width, cut with … only when it is too narrow, whole in its
  tooltip). An AI turn shows its state in the status slot at the right end of its name row (queued, running with its
  time, declined, failed, cancelled), so the states line up in one column; a row without a status leaves no gap. The
  state is the work's, so a message sent to the AI shows none, only a small link to its turn in the same slot (the AI's mark and ↓; its state in the tooltip,
  `AI の作業へ（実行待ち）`, a click going to the turn). While
  a run runs, a small line under its quoted messages tells what the AI is doing, as it goes: `読んでいます order.dt`,
  `書き換えています`, `確かめています dt check`, `まとめています` (a file by its last segment, its path in the tooltip). The
  facilitator sends messages to the AI from the stream (AI に送る on a message not addressed or judged to need nothing,
  several with Shift/⌘-click or … → まとめて送る, each then triaged), answers questions and picks alternatives in the cards, stops runs (✕ right after a running or
  queued turn's state, always shown, after a dialog asks: 実行を中止), and reaches
  the revert and the changes from a card's ⋯ (この作業を打ち消す, 変更を見る; the revisions are
  in the tooltips only: a revert, once confirmed, is the facilitator's message 「〈作業名〉の変更を打ち消す」 and an AI
  card below it, followed in the chat like any request — 実行待ち with 前に n 件 while it waits, as any queued card, then
  done by the server mechanically or by the AI, the reason it went to the AI in the tooltip on its state; a reverted
  work's assumptions read 打ち消し済み) and recording, 以前の状態に復元 (the last resort), the hand-over and コラボを終える
  from the collab menu. Once the
  collab ended, everyone sees its summary (コラボを終えました: the changes, the participants, how long it lasted).
  Participants vote with ♡ on a question's options and on an assumption (kept, or one of its alternatives) while the
  run waits; the facilitator sees the counts and decides. Options start with ○ (single choice) or ☐ (multiple), and
  an assumption's 前提 and 別案 stand one under the other, each with ○. An answered question keeps its options, with
  the filled mark (◉, ☑) on what was chosen, the rest muted, the votes frozen and `回答 name · time` under it; a picked
  alternative has ◉ and `選択 name · time`, the time a link to the run the pick queued. Anyone reacts to a message or an AI turn with any one emoji
  (☺+ on hover: a row's actions — the facilitator's tools, ↩ and ☺+ — float in a small bar over its top right while
  it is hovered or focused, always on touch; the quick row of `collab.quickReactions` and ＋ to type or paste another; the app gives none a
  meaning). Reactions show as colored emoji with small counts, mine with a violet count and a faint violet outline;
  who marked is in the tooltip and, for a vote, in a list on a click.
  ↩ on an ended AI turn (on hover) replies to it: a chip above the composer (`↩ 「請求書の税区分」への返信 ✕`), the targets of its
  messages to start with; the posted reply shows `↩ <the card's name>: …` on top, a click going to the card. Replies are applied
  like any message, and the run made from them continues the replied run's card; the agent gets that run's messages,
  reply and diff as context. ↩ on any message replies to it the same way (`↩ 田中への返信 ✕`, its targets to start
  with); the reply shows `↩ 田中: …` on top, a click going to the message, and a reply to my message is marked in my
  stream as a mention of me is. The agent gets the replied message's author and text.
  The composer's text is 6 rows high to start. The handle on its top edge makes it taller (drag up) or shorter, from 2
  rows up to 60% of the chat's height — focused, ↑↓ change it by a row and Home/End go to the ends; a double click
  brings the default back. The height is in rows, so it follows the text size, and is remembered per browser.
- **The AI as a participant** (ADR 0030): `@` offers `AI` first; a message mentioning it, replying to the AI or to an
  AI turn, and every message under `dt open`, reaches the AI (the composer shows the AI's mark beside 送る in collab).
  Such a message shows the AI's mark and a quiet `…` in its status slot while it is triaged and answered, then a link
  (the AI's mark and ↓) to what came of it: the AI's answer (a message of the AI under it, its element names as links;
  replying to it reaches the AI again), a change proposal (変更案, a participant's 依頼: 何を / どこを / どう, 承認待ち until
  the facilitator approves it — as is, after 編集, or several chosen together, one run — or rejects it with an optional
  note; its requester can 取り下げ it meanwhile), or its run's card; nothing when it needed nothing from the AI (the
  facilitator can still AI に送る it). An answer the server gave up after its retries reads AI が答えられませんでした, with
  もう一度 for the facilitator. The facilitator opens a message's 仕分けの記録 from its … (how it was addressed, each stage's
  answer, confidence, model, time and reason). A run that answered a question instead of editing shows its answer,
  flagged when it changed files all the same. The head says AI 接続なし (with n 件待ち) while no agent is connected, and
  nothing once it is. Under `dt open` the collab menu is a ⋯ with the workspace's record, restore and download only, and
  reactions, votes, `@` and AI に送る are gone: every message goes to the AI as it is sent. How long a run takes is
  mostly the model and effort it runs with: `agent.run.model` / `agent.run.effort` (and `agent.answer.*` for answers)
  are the biggest lever.
- **`/` in the composer** (the plan's rounds 4 and 5): `/` alone opens a list like `@`'s (↑↓, Enter or Tab, Esc; the
  text after `/` filters by an item's English ID or its name in the page's language; `/es` lists every ES command). First
  the **commands**, grouped by prefix (`es:` then `model:`, each group's `:start` first): `/es:start` (ES を始める) and
  `/model:start` (モデリングを始める), for anyone while none runs (`/es` and `/model` are still read; every command is
  listed for everyone, one of a kind already running dimmed). Each starts an **interview**: the AI asks one question at a time (digging into a vague answer, skipping what the
  stormings and the model already say) and every message of the person who started it answers it — no triage —
  while the others' messages go to the AI as usual. A bar above the composer says it runs (AI が考えています while the
  AI writes) with 中止 (its starter's and the facilitator's). It ends with a **brief** in that bar: where it goes (a new
  storming or context, or that it replaces the current description), four or five lines with heads (目的 / 範囲 / 使い道 /
  レベル for `/es:start`), and for the facilitator 確定 / 編集して確定 / 中止. A participant's brief waits for the
  facilitator: they see 承認 / 編集して承認 / 却下 (with an optional note, which its starter then reads), everyone else
  承認待ち. A message instead of confirming takes it back to the questions. Confirmed, dt writes the journey into
  `domaintrail.journey.json` (a run only creates a new storming's block) and posts a **note** under the AI's name as
  the last reply in the interview's thread, with no AI call: what was decided (「旅程に「…」を加えました（ゴール：…）」,
  the revised fields, who approved a participant's brief; for a new storming once its run ended, or that it could not
  be created), then where the journey is and the next step (「いまは「例外」の段階です。次は「依頼・準備」の例外を
  出しましょう。」), with the next command's button (into the composer), the source storming to show when that is the
  step, and 旅程を開く. A question with natural candidates shows them as buttons under it for its starter
  (one sends it at once; several are checked and sent with 送る; その他 goes to the composer). The interview survives a reload. `/es:exceptions` (例外を洗い出す) has
  the AI list, for the storming in view (its stage or timeline when one is shown), the exceptions its main flow does
  not model yet: a card in the chat with each candidate (its label, the events as chips, how in a line, why), none
  checked; whoever started it, the facilitator checks some and 採用したものを反映 makes one run that adds them as
  `exception`s (中止 drops it: the facilitator's or its starter's); the others read it, 「ファシリテーターが選んで反映します」. The run's card links back to it. With no storming in view the card only says so.
  `/es:gaps` (間を埋める), `/es:levels` (レベルを見直す) and `/es:names` (名前を揃える) work the
  same way: the events missing between two consecutive events of a flow in view, the events to move to Design Level
  (`level design`) or back to Big Picture, and the labels to rename (not in the past tense, the same thing named
  differently, too long, technical) — the label only, the ID stays. A candidate's chips are the elements that exist;
  one to be added is named by its label and how. `/es:recap` (ここまでのまとめ) has the AI answer in the chat
  with a short recap of the session: what was decided, what was added or changed, what is still open. `/guide`
  (ガイド; listed first, and a button with a compass at the left end of the composer's bar that runs it at once,
  its label dropped when the chat is narrow) shows a card at once: the map of where the person is — the steps of the
  event storming (brief, events, flows and stages, exceptions, questions, Design Level) or of a modeling journey (its
  pattern's steps, with a row per context: aggregates, commands, invariants), each done (✓), here (📍) or to do, up
  to the goal (🏁), the steps past it faint; whether a step is done comes from the files, and a step the files cannot
  tell (the BCs are split, the terms aligned, a stage that needs no exception) is marked done with a small ✓ on the
  latest card (kept in the journey file; a participant's ✓ is a request to the facilitator) —,
  then what is known at once (a stage without exceptions, open questions, long labels, a context without aggregates,
  errors…), each with a button that shows it. Until a goal is set, the map is one step, ゴールを決める, with
  `/es:start` or `/model:start`. The card draws the session's current journey: its 🏁 changes the goal, its name opens
the journeys panel; the latest card follows the journey file as it is now. A few
  seconds later the AI's advice fills the card: where the person stands and why the step here is next, then one to
  three steps, each with its reason, the command that does it (a button that puts it in the composer), the places to
  show, and 聞くことをメモ for a question to the people (a message asking the AI to add it as a hotspot: a
  participant's waits for the facilitator's approval). An older card keeps its map as it was, with a note; in `/`'s
  list, the commands the latest guide suggests have a star (ガイドのおすすめ). A command's opening message shows in its sender's row as the command's chip (its icon, as in
  `/`'s list, `/id` and name; pressed, what it does), not as text. Then the **templates**: the beginnings of a message
  for what is open and selected (このあとを足す at Big Picture, 前後を詰める for a selected event, 不変条件を挙げる for an
  aggregate …), then the team's from `templates` in `domaintrail.jsonc`; picking one only puts its text in the composer
  (the selected element as its `#` target), to edit and send. An empty view says how to start its own world while an AI is
  connected: the storming view 「まだありません。チャットで
  /es:start から始められます」, the model's views (context map, structure, catalog; also with stormings but no BC)
  「まだありません。チャットで /model:start から始められます」; otherwise 「まだありません」.
- **AI の作業**: everything sent to the AI, from start to end; the tab's badge counts what is not finished (running and
  queued; not what awaits an answer). Each row is one card — a run with the runs that continue it — in groups:
  答え待ち (the AI asked a question), 実行中 (a pulsing dot, how long it has run, and the line of what the AI is doing), 待ち n (numbered in the order they
  will run) and 終わったもの (newest first). A row reads its mark and name (the title, else the first message), then,
  small, whose messages its first run applied, how many runs and its time span; and what the whole card changed, in
  the model's words: up to three elements as chips (`＋ #受付期限切れ` added, `✎ #返品を受け付ける` changed, `− #返品メモ`
  removed, in green, amber and red; the element's own name, its whole name in the tooltip; a click goes to it, a removed
  one is struck through and goes nowhere), `ほか n` and 変更を見る. The same line is under each run's text in the chat.
  変更を見る opens この作業の変更: the card's name, requesters and time, then 追加, 変更 and 削除 with each element and what it is
  (`返品 の状態`, `集約`, `返品 のイベント`), a click closing it and going to the element; at the bottom, folded,
  ソースの差分: the files changed between the revisions before and after, with their line diffs, and both validations
  when either has an error or a warning. When the model could not be compared (a side does not parse), it says so and
  the source diff is open. The dialog keeps one width and its top in place whether the source diff is open or not; its
  body scrolls under the header. The facilitator cancels a running or
  queued card with ✕, after a dialog asks.
  A row is one block between lines: a click anywhere on it but a chip, 変更を見る and ✕ opens it, and under the same left
  edge it shows the run's card, compact — a waiting one with the AI's question, answered (or voted on with ♡) as in the
  chat, the choices shared with the chat's card — and チャットで見る scrolls the chat to it. By default 終わったもの lists the cards
  that changed files; すべて also lists the runs that changed nothing, and those declined, failed or cancelled. The
  other groups always show.

The others' cursors are drawn on the same view. `dt open --host <non-loopback>` serves the same page read-only, without any of it. See [`dt guide session`](guide.md#collaboration-sessions).
