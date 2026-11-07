# The Live View

`dt open` watches the workspace, re-validates on every save and pushes updates to the browser over WebSocket. It
serves the page at <http://127.0.0.1:4321> (`--port`, `--host`, or `open.port` / `open.host` in `domaintrail.jsonc`)
and runs until Ctrl+C. [Getting started](getting-started.md#watch-it-in-the-live-view) shows what to look at first;
this page describes every pane. How its buttons and spacing are built is in [UI rules](ui-rules.md).

The app bar runs across the top; under it the screen has three columns: the left column — the navigator (the lists;
the tree with the detail of the selected item, the inspector, under it) — the canvas, and, in a session, the chat at
the right end. Panes are closed and opened with the icon buttons at their top. The left column's width (up to half
the window, always leaving the canvas some room), the chat's width and the split between the tree and the detail are
dragged; each edge is also a separator the keyboard moves (focused, the arrow keys along it step it, Shift in larger
steps, Home / End go to its limits) and a double click gives its default size back. The split has a grip, so that it is seen at rest; the tree and the detail each keep a little
room, and the tree folds to its head line when the split is dragged to the top (see [木](#木-tree)). All of it is
remembered per browser. A pane slides in and out as it opens and closes (its content does not reflow on the way), and
the canvas keeps what is at its center in place whenever its size changes (a pane, the window). With the OS's "reduce
motion" setting everything is instant.

## App bar

It holds only what concerns the whole page. At the left, DomainTrail and the workspace's name (the folder of
`domaintrail.jsonc`), then the world switch: **ドメインモデル** (the `.dt` model, seen through three views) and
**イベントストーミング** (the `.dtes` stormings; it can be chosen with no storming yet, and then says how to start one).
Switching worlds returns to the view, the storming and the conditions last used in each; the world and its view are
remembered per browser, so a reload comes back to them. In the middle, **探す** (see [探す](#探す-find)), in the same
place in both worlds. At the right end: 問題 (the
number of errors, else warnings, as a badge; a click opens the problems in the left column's navigator, and closes it again), and in
a session the collab menu, the AI's state and, in Solo, ⋯ (see below). On a narrow window the world switch shows its
icons only, each named in its tooltip; narrower (40rem) the workspace's name goes and 探す is its magnifier alone;
at a phone's width (30rem) the brand's name, the knowledge extraction switch and the words of the AI's state go (its
mark ○ stays, its words in its tooltip), so that the bar's right end stays in the window.

### 探す (find)

A button shaped like a search field — 🔍 探す and its key, `⌘K` on a Mac and `Ctrl K` elsewhere (none on a device
without a keyboard) — opens the command palette; the key opens it from anywhere. One field for doing and going:

- Nothing typed: the actions on the selected stickies (the menu's, with their keys), and **最近** — the last five
  selections of both worlds.
- Typed: the actions whose name holds it, then what it finds in **both worlds**, a section each — イベントストーミング
  (every sticky of every storming) and ドメインモデル (contexts, elements, commands, states) — the world shown first,
  each headed with how many it found. A row is the kind's mark (the sticky's colour, the model's), the label, the kind
  and where it is (the storming; the context, and `› the aggregate` for a command or a state).
- It finds by the **label and the name** (the ID) only, case and letter width ignored (NFKC): where it is narrows only
  with another word (「返品 依頼」), the kind never matches. In the 名前 display mode the name is shown and the label found
  besides. The label equal comes first, then starting with it, then holding it, then found by the name only (that row
  shows the name at the right, in monospace, the part found marked); else the order they are written. Eight per
  section, the rest on 「ほか n 件」.
- A sticky whose `ref` names a model element has that element hung under it, joined by a line (「ref · …」), and the
  model's section leaves it out; with the domain model shown first, an element hangs the stickies whose `ref` name it.
  The same label without a `ref` is not joined.
- Picking one goes there. A sticky: its storming at a level that draws it (the design level when it is not on the big
  picture), what keeps it out of the canvas shown again (the exceptions included, すべて for a main flow without it,
  the 絞り込み), selected — an exception's sticky is not emphasized (going to it is a selection). An item of the model: a context, an
  aggregate, an entity, a value object or a union on the structure view (an aggregate's detail on 状態); a command or a
  state switches to the domain model too, its aggregate selected on the structure view and the detail on 状態 showing
  it; what the structure view never draws on the catalog; anything else in the detail's source. When the view hides it —
  a level that does not draw it, the contexts narrowed without its own, the catalog's filter — that is taken away
  first. What was taken away is said for a moment under the app bar (「デザインレベルにしました」「すべてにしました」
  「例外を含めました」「絞り込みを外しました」).
  Going there is the reader's own move: it stops [following](#following). Back is the browser's.
- Participants and the facilitator find the same; outside a session the actions are seeing and copying only.

In a session, after the world switch, the **current journey's chip** (the session has one current journey: the
facilitator chooses it, the one person in Solo; with none chosen, the most recently created active one): 🧭 the journey
· 📍 the step here → 🏁 the goal (✓ 到達 once it is reached). A narrower bar shows 🧭 and the journey's name, then 🧭
alone. With no journey it reads 🧭 ゴールを決める. A dashed chip names a storming or context that is gone. The
facilitator's chip counts the participants' requests waiting. Pressing it opens the **journeys panel** (everyone reads
it): the requests waiting (承認 / 却下 for the facilitator; the requester's own, 承認待ち and 取り下げ); the current
journey — its brief (目的, 範囲, 制約, 参加者, 使い道, もと), its map as the guide draws it, and ガイドを見る, ゴールを変える
(the ES levels, or the goals of its pattern), ブリーフを見直す (`/es:start` or `/model:start` into the composer),
完了にする, しまう; the other journeys with where each stands (このジャーニーにする makes one current); 新しいジャーニー (`/es:start`,
`/model:start`); and the archived ones, counted, opened on demand (戻す). A participant's choice, goal, done, archive
or mark becomes a request the facilitator approves in the panel. Everything comes from `domaintrail.journey.json`
(see [`dt guide`](guide.md#the-journey-file)): a change to it from git or another tool shows at once.

## Left column

A column of icons at its left edge, the activity bar, picks the list the navigator shows — 木 and 差分, with the
number of changes as a badge (問題 is opened from the app bar) — and clicking the list shown collapses the column to the
activity bar (it never disappears). The detail is under the tree only: 問題 and 差分 take the whole column. Opening
something in the detail from elsewhere (a link in the chat, a double click in the tree, a problem in a file) opens the
column again on the tree. At its foot:

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
model tree's groups do. A click selects the row for the detail and shows it on the same canvas (ADR 0032 §11): a
storming's row, all its timelines; a stage's row brings its frame into view (a stage has no view of its own); a main
flow's row puts that main flow on the canvas (as the timeline picker does); an exception's row emphasizes it (as the
exceptions' ▾ does) and brings its path into view. The rows of what the canvas shows are selected — the storming's, the
main flow's (the trunk's row of every stage at once), the exception emphasized —, as the view bar shows it. The filter at the top keeps the rows whose name or ID holds the text, with their rows above
(a matching storming or stage keeps all its rows); what is folded is remembered per browser.

The detail is under the tree, past the split. To give the detail more room, fold the tree: drag the split to the top,
press ▾ in the tree's head line (it turns while folded), or, with the split focused, press ↑ (or Home) at the tree's
smallest; the tree never folds by itself. Folded, the head line stays and names the world and what is selected
(「イベントストーミング › 配達を完了した」) in place of the filter. ▾ again, ↓ on the split, or a drag down opens it at
the height it had. It folds and unfolds in a short slide (none while dragged, or with "reduce motion"); the split's
place and the fold are remembered per browser.

### 問題 (problems)

The diagnostics; a click locates one (in the inspector's source for a syntax error, which belongs to no element).

### 差分 (changes)

The 比較対象 button at its top names what the model is compared with and opens the menu choosing it (see below); under
it, the items added, changed and removed since then. A removed item opens in the inspector as it was in the baseline.

## Main (center)

One row above the canvas, the view bar, holds what acts on the canvas only. It puts the same kinds of controls in the
same places in every view, leaving out what the view does not have: in the domain model, first the view switch —
マップ (the Context Map), 構造 (the Structure View) and カタログ — then the subject (what is looked at: the structure's
focused contexts, the catalog's search, the storming and its timeline, with the exceptions' layer beside it) and the level (how much of it is drawn: the
structure's 詳細 / 概観 / 集約 with their names, the storming's two levels as icons named in their tooltips); at the right
「⏷ 絞り込み」 (what is hidden: the BCs, the kinds, a storming's resolved hotspots…, in a popover, absent with nothing to hide; while anything is narrowed
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
edge (its line or arrowhead) tells what it means, in the legend's words for that view (「参照（ID で別の集約へ）」…); a
storming's line says its two ends and its relation instead (see Selection and lines below).
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
  sticky notes, laid out left to right (`dt guide storming-views`). The view bar's subject is what the canvas carries (ADR 0032 §11), a
  breadcrumb of two pickers: the storming (表示するストーミング; its name alone when there is only one) ▸ the タイムライン —
  すべて, or one main flow (the trunk through every stage is one main flow; every other main flow of a stage another;
  no picker for a storming with one). One main flow is drawn in the layout of すべて: the other main flows, and the
  exceptions branching off them, are left out where they stood, so no sticky moves; a stage with nothing drawn keeps its
  frame, dashed. Beside the breadcrumb, the exceptions' layer: a round toggle in the exceptions' pink, ↳ 例外 and how
  many it lays over the canvas (those branching off the main flow shown). Its left part includes them (the default) or
  not — without them the canvas is laid out again, the main flows in one straight row —; its ▾ lists them (under their
  stages on すべて) to emphasize one: its path (the main flow before it branches off, its steps, from where it returns
  onwards) stays dark and every other note and line goes faint, nothing moved, and the toggle names it (「↳ 例外: 取消 ×」).
  Emphasizing includes the exceptions first, and shows すべて when the main flow on the canvas does not have it. The
  emphasis is close to a selection: the page's own (never remembered, followed nor printed), apart from the stickies'
  selection (selecting a sticky keeps it); its ×, a second Escape (the first clears the stickies' selection) or a press
  on the canvas's empty space ends it. On the canvas each exception's lane has a pink band, and its label (the caption
  of the line into the lane) is a button: hovering it deepens the band, pressing it emphasizes that exception (pressed
  again, ends it); the lane emphasized has its label filled and its band outlined. The ▾ and the navigator bring the
  path into view; a press on a label leaves the camera where it is. The level icons are ビッグピクチャー (the telescope: events, timelines
  and hotspots only, without the events marked `level design`) and デザインレベル (the microscope: also commands, policies, actors, external systems, aggregates
  and read models). The choices are
  remembered per browser and never change the `.dtes` file. The integrated canvas draws each event once (no group
  frames), and a dashed arrow between two events names the timelines it belongs to when not all of them do; one
  timeline draws each occurrence, and a group is a frame around its events. The lines have three looks (ADR 0032):
  **流れ**, a thin solid arrow in one colour, for every relation between stickies (read model → issuer, issuer →
  command, command → handler, handler → event, event → policy, policy → command, an event feeding a read model, an
  external system → its event, a policy's actor); **時間**, a dashed arrow in the same colour, for the time order where
  the placement cannot show it; **問い**, a thin quiet line without a head, from a hotspot to its sticky (quieter still
  when resolved), and from an undecided slot to its command. Exceptions are not told by a line colour. Hovering or
  pressing a line says what it means (see Selection and lines below). Relations are possibilities, not "happened". Design Level follows Event Storming's grammar, left to right (ADR 0032): read model → issuer
  (`by`: an actor or external system, stuck on top of its command when no read model leads to it) → command → handler
  (`handledBy`: an aggregate or external system, from which the command's events come) → event → policy → the command it
  issues; commands converging on one event note through the same handler share one handler note before it (hovering
  its arrow names them); a command a policy
  issues has no issuer: the policy decides, and the read model it looks at goes to the policy (ADR 0032 §9), standing just
  before it, or to the actor applying the policy by hand (read model → actor → policy, ADR 0032 §12); when the read
  model is fed by the event that triggers the policy, that path says the trigger and no event → policy line is drawn
  beside it; an event that arrives `from`
  an external system has that system before it; a hotspot is stuck on top of the sticky it is `on` (an event, a
  command, a policy, …), never a step of the flow, and at Big Picture only one on an event is drawn. Where an event is
  drawn at several steps, the command before it, its copies and the policy after it are drawn at each step (ADR 0024,
  amendment of 2026-11-05). The notes take the convention's
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
  step it branches off at (a dashed arrow into the lane, another back for `then`). At Design
  Level no line joins two events in time order where the placement shows it (left to right): only an exception's branch
  and its `then` are drawn; Big Picture keeps the time order lines. An undecided issuer or handler (an open hotspot on
  the command asks it) is an empty dashed note 「誰が処理する？」 where it would stand. At Design
  Level each step is a group of columns (read models on the row of the issuer looking at them, commands with their
  issuers on top, handlers, the event, policies; a hotspot above the sticky it is on) and the elements stand in a band
  above the row of their event, an exception's above its lane.
  A storming with a resolved hotspot also has 「解決済みを表示」 in its 絞り込み, in every view (on by default, remembered
  per browser — a facilitator hiding them changes nothing for the others; off counts as one narrowing): off, the
  resolved hotspots and their lines are not drawn, their places left empty (nothing moves: the page hides them in the
  drawing alone; ADR 0032 §10), and each sticky they are on keeps a green ✓ in
  its corner (left of its 「k/n」), which tells what was agreed on hover and selects the hotspot. Going to an element the
  canvas does not draw — a link, the palette, the knowledge, the detail, a chat's reference, a turn's marks — shows it
  first (the exceptions included, then すべて, then what the 絞り込み hides), then selects it.
  **Acting on a sticky** ([ADR 0033](adr/0033-people-edit-stickies.md)): every action comes from one list, so the
  same ones are in four places. Selecting stickies shows a small toolbar above them (below them when there is no room;
  never on hover, hidden while the canvas moves): the frequent actions as icons — チャットに追加 (💬, a muted ✓ once
  added) and 編集 ✎ — then 「…」; with several selected, how many and the actions for several only. 「…」 and a
  right-click on a sticky open the menu of every action that applies to it, by group with their keys: よく使う
  (チャットに追加 `Enter`, 編集 `F2`), 見る (ナレッジを見る for a sticky with knowledge, opening it in the detail; ドメインモデルで見る for an event, a command or an aggregate whose
  `ref` the model has, its tooltip naming the element 「ドメインモデルの 注文 › 確定する を見る」; このタイムラインで見る for an
  event, opening a timeline it is in), 書く (ホットスポットを付ける on any sticky but a hotspot; 解決を書く on a hotspot) and そのほか (リンクをコピー
  `⌘⇧C`, a link that opens the Live View with that sticky selected). The arrow keys move in the menu, Escape closes
  it. Outside a session only seeing and copying are offered. [探す](#探す-find) (`⌘K`, Ctrl+K) lists the actions on the
  selection too, and finds every sticky.
  **Editing a sticky** (in a session; anyone may): a double-click, `F2` or ✎ opens a small window under it with its
  ラベル (selected) and 名前 (its ID) — the fields its kind declares. A name is checked as typed (the `.dtes` ID's form, not a keyword, not taken in the
  storming); a new one says 「参照 n 件も書き換えます（.dtes n）」. Enter saves, Escape — or a press outside the window, not while typing with an IME — cancels (the windows show no key hints;
  the buttons' tooltips name the keys). dt writes it at once — no
  AI run: only the label, and for a new name the name and every reference to it in the storming, change in the file —
  and everyone's canvas shows it; if someone (or the AI) changed the sticky meanwhile, the window says what it is now.
  ホットスポットを付ける opens a window with the question only, on several lines (Enter starts a new line, ⌘Enter / Ctrl+Enter
  adds it): its name (ID) is not asked — dt writes it at once as `<Sticky>Question` and selects it, and the agent's
  light model renames it from the question a few seconds later (knowledge or not; not when it was changed meanwhile). On a hotspot, 編集 (or a double-click, `F2`) opens its 問い alone, and 解決を書く (解決を直す once resolved) on its toolbar
  its 解決 alone, on several lines (⌘Enter / Ctrl+Enter saves); never its name; emptying 解決 reopens it. Each edit is in AI の作業.
  **Back from a jump**: after ドメインモデルで見る (or このタイムラインで見る), the detail's back button names the sticky
  (「← 注文を受け付けた」) and returns to the storming as it was shown — the same view, level and scope, the camera, the
  sticky selected; the browser's Back does the same.

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

### Selection and lines (Event Storming)

Selecting a sticky never dims the others. The selected note keeps its solid indigo ring; when its element is drawn
more than once (an actor beside each command it issues, the same aggregate before several events, a command at
several steps), every other note of it gets the dashed ring, and all of them a badge 「k/n」 on their top edge (the
selected one filled), numbered in reading order (left to right, then top to bottom). The lines joined to the selected
note are drawn thicker in the indigo of the selection; nothing else changes. A copy out of view gets a pointer at the
canvas's edge on its side — 「→ 2」「← 1」 (↑ and ↓ above and below), the arrow then how many are there, named in its
tooltip — and pressing it moves the camera to the nearest of them. The detail then has 「同じ付箋 3 件 ‹ 2/3 ›」: the
arrows step through the copies in reading order, selecting each and moving the camera to it.

Hovering a line shows two lines: its two ends in the line's direction, each a small box of its sticky's paper colour
(an actor's rounded, an external system's and an undecided slot's dashed; no kind words) and its label —
「■ 配車係 → ■ 配車を組む」 — then what the relation means in plain words, never the DSL's keywords
(`Messages.lines.relations` in `apps/web/i18n.tsx`, the one place of these texts; `{A}` is the source's label, `{B}`
the target's):

| line                                         | words                                                         |
| -------------------------------------------- | ------------------------------------------------------------- |
| actor / external system → command            | 「{A}」が「{B}」                                              |
| read model → actor / external system / policy | 「{B}」は「{A}」を見て判断する (whoever decides: the colour box tells the kind) |
| command → aggregate / external system        | 「{A}」を「{B}」が受けて処理する                              |
| aggregate / external system → event          | 「{A}」が処理して「{B}」 (a merged handler: …（「C1」「C2」から）) |
| event → policy                               | 「{A}」をきっかけにポリシー「{B}」が働く                      |
| policy → command                             | ポリシー「{A}」により「{B}」                                  |
| actor → policy (`by`)                        | 「{A}」がポリシー「{B}」に従って動く                          |
| event → read model                           | 「{A}」で「{B}」が更新される                                  |
| external system → event                      | 「{A}」から「{B}」が届く                                      |
| time: into an exception                      | 例外「{例外名}」へ分かれる                                    |
| time: an exception's `then`                  | 例外「{例外名}」から戻る                                      |
| time: the order (Big Picture)                | 「{タイムライン名}」で「{A}」のあとに「{B}」 (no name when in every timeline) |
| question: hotspot → sticky                   | 「{B}」への問い (a resolved hotspot's with a green check)     |
| question: undecided slot → command           | 「{B}」を誰が行うか / 誰が処理するかはまだ決まっていない      |

Pressing a line selects it and opens a small popover by where it was pressed, with the same two lines; its two ends
are buttons (named for screen readers with the kind, 「コマンド 配車を組む へ移る」) that move the camera to that
sticky and select it. An end out of view gets the same pointer at the canvas's edge as a copy. `Escape` (or a click
on the empty canvas) closes it. The camera's moves follow the OS's reduce motion (instant then).

## Printing and exporting

The browser's print (Ctrl+P / ⌘P) prints the current diagram alone — without the panes, the chat, the bars, the
canvas's controls or the legend — fitted whole to one landscape page, in the light colours whatever the theme. The
paper size is chosen in the browser's print dialog; the diagram is scaled to it. The diagram is printed in its compact
layout when the page has it (詰めて表示 on, or printed before), else in the layout shown.

The page has no margin of the browser's, so the browser prints no header or footer of its own (the page's title, its
URL, the date); the sheet keeps its own margin. Above the diagram, one line says what it is and how it is shown, in the
display mode's names: the workspace, the world, the view and what in it is shown, then its conditions, e.g.
`ws › ドメインモデル › 構造図 · 詳細` or
`ws › イベントストーミング › 配車 › すべて · デザインレベル · 例外を含む` (an Event Storming view: the storming, its
timeline when it has several main flows — すべて or the main flow —, the level, and 例外を含む or 例外なし when it has
exceptions; never the emphasis; the Structure View: the focused contexts, if any, and the level; the Context Map: すべてのコンテキスト when
shared and external BCs are shown). Nothing else is printed (no date, no version).

書き出し at the right end of the view bar opens a menu below it. Its **印刷** is the surer way to print: it gets
the compact layout first (the button spins meanwhile), then opens the print dialog. The catalog has 「印刷」 there
instead: it prints as a page, its list without the panes around it (it has no export). The menu:

- **PNG**: the current diagram (its stage, level and exceptions, and its spacing: compact while 詰めて表示 is on) on
  white, at twice its size (less for a diagram too large for a browser's canvas).
- **SVG**: the same as a portable SVG — plain shapes and text, no embedded HTML, the colours as attributes, the fonts as
  the page's font stack ending with a generic family — that opens in browsers, Figma and Inkscape. Each note's label is
  broken into lines, shrunk and cut short with «…» as on the canvas (measured in the page's fonts); a viewer without
  those fonts draws the same lines in its own, a little wider or narrower. `dt export svg` draws the same SVG without
  a browser, for a document's figures built in CI ([`dt guide export`](guide.md#sharing-the-sources-and-the-diagrams)).
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
[`dt export sources`](guide.md#sharing-the-sources-and-the-diagrams): the `.dt` and `.dtes` files `dt check` analyzes and the config
file, below a folder named after the workspace, made from the files on disk when it is clicked — never the local
override, `.domaintrail`, `.git`, generated output, symlinks or files git ignores. The server serves it at
`GET /api/export/sources.zip` behind the page's own sign-in (no identity: 401; a Host or Origin not allowed: 403), as
an attachment (`Content-Disposition` with the UTF-8 `filename*`), never cached; 404 when the workspace has no
sources, told in the menu. The read-only Live View (`dt open --host <address>`) serves the same path to whoever it
serves the view, but has no menu.

## Detail (the inspector, under the tree)

The selected item — name, description, diagnostics, a back button naming the item it returns to (「〇〇 に戻る」), and
buttons to show it in a view; with nothing selected, a line says to pick one. It has no close button: fold the tree
to give it the column. Sub-tabs (on a second row when the column is narrow): 構造 / 状態遷移 / 振る舞い / 参照 / ソース. An event shows 永続化 / 非永続 next
to its kind, as it does in an aggregate's 発生させる Event list; persistent events have a database icon in the
explorer.

- In a session, a selected storming shows its event storming journey in brief (its purpose, where it stands, its
  goal), and a selected context the modeling journeys over it (those that name it, and those over the whole model);
  a row opens the journeys panel.
- **状態遷移**: states and command transitions of the aggregate (`new` marks factory commands), for the aggregate and
  its states and commands; it pans and zooms like the main canvas and shows the selected state or command.
- **振る舞い**: what a command takes, requires, changes, emits and returns, and the policies that trigger it.
- **A storming's element** (selected in the Event Storming view) is read next to the canvas: it shows only what the
  canvas does not, and its connections are the lines the canvas draws thicker. Its kind, a grey microscope badge for
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
  event's, command's or aggregate's `ref`, a link while the model has it), the hotspots on a sticky
  (`MessageCircleQuestionMark`: each a link, a resolved one with its ✓; open and resolved, whatever the 絞り込み hides),
  and a resolved hotspot's conclusion (`CircleCheck`). Last, the actions, brand-coloured icons on a pale wash: AI に聞く (filled), 問いを足す (an event),
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
neither baseline: in a session their stickies are marked by turn instead (see [What a turn changed](#what-a-turn-changed)).

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
end shows the collab menu (the avatars and the participants online ▾: who is where — you, then the AI, then the others,
each one but you with ○ / ◉ to follow them (see [Following](#following)) —, the invite link,
ソース一式をダウンロード, 退出, and the facilitator's actions; see [`dt guide session`](guide.md#collaboration-sessions); in
Solo a plain ⋯) and the agent's status at a glance (running and for how long, waiting for an answer, or queued; nothing
when idle), with ○ / ◉ on its left to follow the AI. A click on the status (AI の作業を見る) opens the chat on AI の作業 and the card it stands for — the running one,
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
  the last reply in the interview's thread, with no AI call: what was decided (「ジャーニーに「…」を加えました（ゴール：…）」,
  the revised fields, who approved a participant's brief; for a new storming once its run ended, or that it could not
  be created), then where the journey is and the next step (「いまは「例外」の段階です。次は「依頼・準備」の例外を
  出しましょう。」), with the next command's button (into the composer), the source storming to show when that is the
  step, and ジャーニーを開く. A question with natural candidates shows them as buttons under it for its starter
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
  A person's edit of a sticky is a row of its own there — and, in the chat, a compact row of that person where it
  happened (their avatar, no bubble; the sticky as its `#` chip; never a message to the AI, nothing unread): 「◯◯が編集しました」, its time and what changed
  (ラベル: ~~旧~~ → 新; 名前 with the references it rewrote; a hotspot added; a resolution), and for the facilitator
  打ち消す, which reverts it as any card is reverted. An edit made while the AI was working and dropped by its result is
  written again after it (「AI の作業が落としたので…当て直しました」); when the AI's result gave the same sticky other
  wording, the row shows both, people and AI, with AI の文言のまま and 人の文言にする.
  A row is one block between lines: a click anywhere on it but a chip, 変更を見る and ✕ opens it, and under the same left
  edge it shows the run's card, compact — a waiting one with the AI's question, answered (or voted on with ♡) as in the
  chat, the choices shared with the chat's card — and チャットで見る scrolls the chat to it. By default 終わったもの lists the cards
  that changed files; すべて also lists the runs that changed nothing, and those declined, failed or cancelled. The
  other groups always show.
- **見直し** (the review at a run's end, [ADR 0034](adr/0034-reviewing-a-run.md)): a run that changed stormings is
  checked before it ends — dt's rules on its diff, then the AI, in the same run, over the neighbourhood of what it
  changed — and its card (in the chat and in AI の作業) says, under what the AI says, in a small muted block: 見直し, a
  line per kind dt found (解決したが付箋はそのまま, 付箋を変えたがホットスポットは開いたまま, 前のラベル・名前が残る, 同じラベルで別の ID)
  with how many and 「· 直した」, or 「· 残り n 件」 in the warning's ink when the run ended with some left; ✓ what the AI says
  it fixed, – what it kept and why (elements as links). Nothing when nothing was found, fixed or kept. While something
  is left, the facilitator's 見直しを頼む (on the card's latest run) sends a message to the AI that replies to the run,
  with the stickies left as its targets: the card continues with that run.

### What a turn changed

In a session (`dt open` and `dt collab` alike), when a run that changed the sources ends while the page is open, the
Event Storming canvas marks the stickies it changed, with the model canvas's marks: an added sticky has the green ring
and a 新 badge, a changed one the amber ring and 変 — with its label before the change small and struck through just
under it, when the label changed (the whole of it in the tooltip) — and a removed one is a faded, dashed ghost with
削除, where the page last saw it. A ghost that would cover a note (a sticky added where one was removed) is moved off it,
to the nearest free place. A small bar at the canvas's top right says whose changes are marked and how many —
「直前の作業：新 1 変 1 削除 1」 (a kind with none left out) — then 「ほかに n 件の変更 →」 while some of them are out of
view or not drawn in this view (a press goes to the nearest one, and, when none is drawn here, to the view that draws
them), and 印を消す. The bar is a group of ordinary buttons, reached with Tab.

- **Which turn**: the latest run that ended having changed the sources (completed, waiting for an answer, declined or
  reverted with changes), as the page saw it end. The marks stay until the next such run ends — whose marks replace
  them, or clear them when it changed no sticky (only `.dt`, or only a timeline's or a group's steps) — or until the
  reader presses 印を消す. A page opened after a run ended marks nothing until the next one: the reader did not see it
  end, and a card's 図で見る shows it.
- **Only the stickies**: the `.dtes` elements drawn as notes. A run that changed only `.dt` marks nothing here; the
  model canvas keeps marking against its own baseline (前回の保存 or a git revision, see
  [Comparing with a git revision](#comparing-with-a-git-revision)).
- **The camera** moves for a turn's marks only while the reader follows the AI (see [Following](#following)): then
  they are brought into view as they appear — in the view that draws them, switched to if needed, as 図で見る does —
  unless they all are in view already. A reader who does not follow it keeps the camera where it is: the marks and the
  bar (「ほかに n 件の変更 →」) tell them, and the bar's → is their own move (it does not start following). The camera
  fits the marks, zoomed in no further than it was (nor past 100%), or, when that would make them too small to read,
  centers on the nearest; never while the reader drags or pans. With reduced motion it jumps instead of gliding.
- **図で見る** (the eye, under a run's text in the chat and under a card's row in AI の作業, while it changed stickies)
  marks that run's (or that card's) changes the same way, whenever it ran, and brings them into view: the view shown if
  it draws any of them, else the integrated canvas of the storming they are in, at a level that draws them (switching
  from the domain model's views if needed). The bar then names it: 「作業「返品の受付」：新 1」.
- **Per viewer**: the marks are the page's own, never sent nor shared; each page marks the turns it saw end. A removed
  sticky is drawn only where this page saw it before (the last few versions of the stormings are kept in the page):
  marks shown for a run that ended before the page opened count it in the bar without a ghost. A compact layout
  (詰めて表示) draws no ghosts, as for the model's diff.

The marks take a span of revisions (before and after), not a run as such, so that other changes — a person's edit of a
sticky — can be marked the same way. Printing and exporting draw the diagram without them.

The others' cursors are drawn on the same view. `dt open --host <non-loopback>` serves the same page read-only, without any of it. See [`dt guide session`](guide.md#collaboration-sessions).

### Following

The camera moves only for the reader and for whom the reader follows: the AI (its changes) or another participant (their
view and camera). Nothing else moves it — not a turn that ends, not someone else's request.

- **Whom**: one at a time. The AI is followed from the small round toggle left of its status in the app bar (◉ while
  followed, ○ else; named for what a press does, 「AI を追う」 / 「AI を追うのをやめる」) or from its row in the
  participants (after you); a participant from their row (「佐藤を追う」). Following someone stops following anyone else.
  Under `dt open` there are no participants: only the AI's toggle.
- **Starting**: the reader's choice, and a request the reader sends to the AI — a message with `@AI`, a reply to the AI
  or to an AI turn, the facilitator's AI に送る, an answer or a pick in a card, and every message under `dt open` — which
  follows the AI on the sender's page only. A participant whose change proposal is approved follows the AI as it runs,
  on their page. Someone else's request starts nothing.
- **The AI followed**: as a turn ends, its changes are brought into view (see [What a turn changed](#what-a-turn-changed));
  choosing to follow it brings its latest changes into view at once. While it does not work, the toggle shows only while
  it is followed, faint (a press stops following); never while no agent is connected.
- **A participant followed**: the page opens the view they are on (the storming, level, timeline and whether its exceptions
  are included — not the exception they emphasize, nor what their 絞り込み hides —, the domain model's view, 詰めて表示) and fits what their canvas shows to its own, gliding as they pan and zoom (their presence's
  `camera`, sent a few times a second: [ADR 0026](adr/0026-collaboration-sessions.md#appendix-following-someone-amendment)).
  While they are where no canvas is (the catalog, a view still loading) or on a view this page cannot open, the page
  stays and keeps following; it catches up once they are back. The detail's pillar is not followed. When they leave
  the session, the following stops.
- **Stopping**: any move of the reader's own stops following at once, without asking: a pan or zoom (drag, wheel, pinch,
  the keys, the canvas's buttons), a selection (a click on the canvas, in the tree or the navigator, a link), switching
  what is shown (the world, the storming, the level, the timeline, the exceptions' layer and the one emphasized, the domain model's views, the filters, 詰めて表示, a
  participant's 「→」, 図で見る, 「ほかに n 件の変更 →」) — and the toggle again. The followee's own moves of the camera
  and the view are not the reader's and stop nothing.
- **How it shows**: a thin frame round the canvas in the followee's color (the AI's, or the participant's cursor color),
  faint while the AI followed is idle; the participant followed comes first among the avatars of the people button,
  with a ring in their color, and their row is marked.
- **Per viewer**: whom a page follows is its own, never sent; a reload forgets it.

### Knowledge

When the session's workspace has a knowledge store ([ADR 0031](adr/0031-knowledge.md), the `knowledge` section; what
it is: [`dt guide knowledge`](guide.md#knowledge-from-the-sessions)), the page shows what the sessions found, through
dt only (`/api/session/knowledge`):

- On the canvas, a sticky with knowledge has a dot at its top right corner, and a red `!` when one of its items is in a
  conflict; no count.
- Selecting a sticky shows ナレッジ in its detail: its conflicts first, the two items side by side (each opens to its detail
  there, and is not listed again below) with
  ホットスポットにする (a message to the AI, as 聞くことをメモ sends: the facilitator's goes to the runner, a
  participant's becomes a proposal) and 食い違いではない (the link removed from both); a conflict whose other side was
  deleted no longer shows. Then its other items, 新しい順 or 種類の順.
  A closed item shows its kind, its title (one line of plain text) and its labels' line (`AS-IS · 発言 · 営業 · 11/5`),
  no text; the cards of a conflict and of a hotspot's box show their titles too. An item opens, as one outlined card:
  its title stays where it was, the labels' line folds away as the rest unfolds (their heights move together, so
  nothing jumps): its whole text as Markdown with the chat's rules (but its headings drawn as ordinary paragraphs,
  the title being its heading; its `@{es:…}` references linking the stickies, each selects it; its images drawn, as
  wide as the column at most), its labels as the ナレッジ tab's filter
  chips (when, kind, origin, and the perspective it has; pressing one opens the tab filtered by that label alone, the
  search and the other filters cleared), its sources as the chat's reference lines (`↩ who: quote`: a
  message of this session by who said it, a click moves to it in the chat; another session's by its date; the whole
  quote and its time in the tooltip), the other stickies it concerns as the chat's `#name` chips (each selects it), its
  versions, and 直す (its title, text and labels, a new version), 画像を付ける (PNG, JPEG, GIF or WebP, at the end of its text)
  and 消す. Deleting hides it from everyone at once; 元に戻す shows for 10 seconds. Once the store's undo window has
  passed, its sweep removes the item for good and puts its source messages on the redaction log, which every dt of the
  project reads (when it starts and every few minutes) to redact them in its own session database.
- ナレッジ in the activity bar lists every item, with a search over the titles, the text and the quotes and filters by
  AS-IS / TO-BE, kind and origin (and by a perspective, chosen from an item's chip, shown as one more chip while it
  filters). The filters stay while the tab is closed. Opening an item rings its stickies on the canvas.
- **Retiring** (廃止, [ADR 0031](adr/0031-knowledge.md#12-retiring-an-item) section 12): an opened item has 廃止する,
  which offers the reasons 置き換わった (then the newer item, chosen among the others), 当てはまらなくなった and 誤り, one
  or none, and retires it at once with 元に戻す for 10 seconds, as 消す does. A retired item keeps its text, sources and
  versions; it leaves the ナレッジ list, a sticky's detail and the dots on the canvas, and the AI no longer reads it.
  The list's 廃止も表示 shows the retired items too, faded, their line headed by 廃止 and the reason; opened, the item
  that replaced one is linked (it opens in the list), and 廃止を取り消す brings it back.
- **廃止の候補**: when the AI (the extractor, or the review of a run) finds an item no longer holds, it proposes to retire
  it — or, when the talk brings a retired item's topic up anew, to undo its retirement. The proposals head the ナレッジ
  list (廃止の候補 n, also the count on its button in the activity bar), each with its item, its reason, why, and its
  evidence (quotes as the chat's reference lines, decisions, changed stickies as `#name` chips), and 承認 or 却下,
  for any participant; an approved retirement has 元に戻す too. A dismissed proposal is not made again unless it
  rests on new evidence. Nothing about it goes to the chat.
- Whether the talk is turned into knowledge shows in the app bar, with the session's other controls: the facilitator
  has a 💡 switch (pressed while the extraction is on, struck through while off; `POST /api/session/extraction`), the
  others a 💡 while it is on and nothing while it is off. Every page follows a change at once (`knowledge.extraction`
  over the WebSocket). None of it without a knowledge store.
- The page reads the knowledge again whenever it changes: after an extraction, or anyone's change.
