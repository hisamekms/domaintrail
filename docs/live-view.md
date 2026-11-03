# The Live View

`dt open` watches the workspace, re-validates on every save and pushes updates to the browser over WebSocket. It
serves the page at <http://127.0.0.1:4321> (`--port`, `--host`, or `open.port` / `open.host` in `domaintrail.jsonc`)
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
its own open or closed state). `U` does the same as « and », and the choice is remembered per browser. Hovering an
edge (its line or arrowhead) tells what it means, in the legend's words for that view (「参照（ID で別の集約へ）」…).
The keys do nothing while typing. The inspector's 状態遷移 diagram has the same controls.

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
  and hotspots only, without the events marked `level design`) and デザインレベル (the microscope: also commands, policies, actors, external systems, aggregates
  and read models). The choices are
  remembered per browser and never change the `.dtes` file. The integrated canvas draws each event once (no group
  frames), and a dashed arrow between two events names the timelines it belongs to when not all of them do; one
  timeline draws each occurrence, and a group is a frame around its events. Solid arrows are type-level causes
  (possible, not "happened"), dashed orange arrows the order of a timeline (the event's orange, not a warning),
  dotted lines the other relations (without an arrowhead for a hotspot's event). The notes take the convention's
  colours, and the legend shows each kind with its colour and name: event orange, command blue, policy purple,
  aggregate yellow, read model green, hotspot pink, actor pale yellow (rounded), external system lilac (dashed edge),
  and a group a dashed frame tinted with the event's orange. Every note also names its kind above its label
  («イベント»), so the colour is never the only cue. Light: soft pastel paper, a coloured edge and dark text; dark:
  muted deep paper of the same hue, a coloured edge and pale text. A storming whose file stops parsing stays as it last parsed, with a banner.
  A storming with stages or exceptions (`stage`, `exception`) is drawn in time order: the stages as labelled frames
  left to right, the trunk of the main flows one straight row through them, every other timeline on a row below the
  step it branches off at (the exceptions' dashed arrows a quieter red, a dotted arrow back for `then`). The タイムライン
  picker then also lists each stage (「…（例外を含む）」), and the toolbar has 「例外を表示」 (an icon toggle, on by
  default, remembered per browser) to draw the integrated canvas and the stages without their exceptions.

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
- Names follow the 名前の表示 setting: ラベル (the default; the string after a declaration's name, falling back to
  the name when there is none or it is blank), 名前 or 両方 (the label and the name; the name alone without a label).
  Layouts are cached in `<root>/.domaintrail/layout.json`. The canvas is read-only.

See [ADR 0001](adr/0001-mvp-implementation-decisions.md) for the design decisions.

## In a session

Under `dt collab` (and `dt open`, for one person) the session's chat is a pillar at the right end of the page, the whole height,
the same for everyone and open when the page joins. Its head shows the collab menu (the avatars and the participants online ▾: who is where, the invite link,
退出, and the facilitator's actions; see [`dt guide session`](guide.md#collaboration-sessions)) and
the agent's status at a glance (running and for how long, waiting for an answer, or queued; nothing when idle), with ✕ to
close it. A click on the status (AI の作業を見る) switches to AI の作業 and opens the card it stands for — the running one,
else the next to run, else the one waiting longest for an answer — scrolled to and marked for a moment, besides those
already open; the chat keeps its scroll, so チャット brings the reader back where they were. While the chat is closed, a round 💬 button at the bottom right of the
canvas opens it again, marked with a spinner while the agent runs, `?` while it waits for an answer, and the number of
messages since the chat was last shown (else of the requests awaiting approval). The 💬 next to the selection (on the canvas,
or next to the element's name in the inspector) and `C` add the selection as targets and open it too. Its width is remembered per browser; on a window narrower than about 1280px the left pane collapses to
its activity bar while the chat is open, and below about 1024px the inspector moves below the canvas (your own choices
come back when the window is wide again).

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
  nothing once it is. Under `dt open` the collab menu is a ⋯ with the workspace's record and restore only, and
  reactions, votes, `@` and AI に送る are gone: every message goes to the AI as it is sent. How long a run takes is
  mostly the model and effort it runs with: `agent.run.model` / `agent.run.effort` (and `agent.answer.*` for answers)
  are the biggest lever.
- **`/` in the composer** (the plan's rounds 4 and 5): `/` alone opens a list like `@`'s (↑↓, Enter or Tab, Esc; the
  text after `/` filters by an item's English ID or its name in the page's language). First the **commands**, for the
  facilitator (under `dt open`, the person) while none runs: `/es` (ES を始める) and `/model` (モデリングを始める). A
  command starts an **interview**: the AI asks one question at a time (digging into a vague answer, skipping what the
  stormings and the model already say) and every message of the person who started it answers it — no triage —
  while the others' messages go to the AI as usual. A bar above the composer says it runs (AI が考えています while the
  AI writes) with 中止. It ends with a **brief** in that bar: where it goes (a new storming or context, or that it
  replaces the current description), four or five lines with heads (目的 / 範囲 / 使い道 / レベル for `/es`), and 確定 /
  編集して確定 / 中止. A message instead of confirming takes it back to the questions. Confirmed, a run writes the brief as
  the `///` description right above the `storming` (or the `context`), creating it when new; the inspector shows it
  when the storming is selected. The interview survives a reload. Then the **templates**: the beginnings of a message
  for what is open and selected (このあとを足す at Big Picture, 前後を詰める for a selected event, 不変条件を挙げる for an
  aggregate …), then the team's from `templates` in `domaintrail.jsonc`; picking one only puts its text in the composer
  (the selected element as its `#` target), to edit and send. An empty view says 「まだありません。チャットで /es から
  始められます」 while an AI is connected.
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
