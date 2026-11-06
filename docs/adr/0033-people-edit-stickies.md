# ADR 0033: People edit the stickies themselves, and the actions on a sticky

- Status: accepted, implemented (`feat/sticky-actions`). Decided by the maintainer: every participant may edit, the
  edits a running run drops are re-applied automatically, and a run's other wording of the same sticky is kept and
  offered to people as a choice (marked *Decided by the maintainer*).
- Date: 2026-11-06
- Input: the approved preview 「付箋の操作」 (one list of actions; a toolbar, a menu, keys and ⌘K drawn from it; the
  edit window), and `docs/plans/listening.md` §2 (people correct a sticky's wording on the canvas, dt writes the label
  without an AI run). ADR 0031 and 0032 are taken on other branches.

## Context

A live Collab test asked for people to write the stickies' wording themselves (`docs/plans/listening.md`). Until now
every change of a `.dtes` went through a message to the AI and a run, even a typo in a label. The canvas had one action
on a selection, the 💬 that adds it to the chat; the others (the detail's 見る, its `ref`, the timelines it is in) were
spread over the detail.

## Decision

### One list of actions (`apps/web/stickies/registry.ts`)

Each action of a sticky (a storming's element drawn as a note) has an ID, a lucide icon, its label, its key, the
stickies it applies to (their kind, and what they have: a `ref` the model has, the timelines an event is in, a live
session), whether it works on several selected at once, its group, and whether it is frequent. Everything is drawn from
it, so an action added there shows everywhere at once:

- **the toolbar** above the selected stickies (below them when there is no room), shown on selection, never on hover:
  the frequent actions as icon buttons (`icon-button`, an `aria-label` and a tooltip with the key), then 「…」; with
  several selected, how many and the actions for several only. On the storming canvas it replaces the 💬 that appeared
  on a click (the other views keep it);
- **the menu** of every action that applies, by group (よく使う, 見る, 書く, そのほか), with its key, from 「…」 or a
  right-click on a sticky (`apps/web/shared/menu.tsx`: `role="menu"`, the arrow keys, Home / End, Escape and Tab close
  it and give the focus back);
- **the keys** while stickies are selected and nothing that takes text has the focus: Enter adds them to the chat (`C`
  still does), F2 edits, ⌘⇧C (Ctrl+Shift+C) copies the link; Escape, which clears the selection, stays the canvas's; a
  double-click edits;
- **the command palette** (`apps/web/shared/palette.tsx`, ⌘K / Ctrl+K): the actions on the selection, then every
  sticky of every storming by name. It is generic (sections of items with a label, a detail, an icon, a key and what it
  runs), so that other features give it their items later.

| Action | Kinds | Several | Frequent | Key | Needs |
|---|---|---|---|---|---|
| チャットに追加 | all | yes | yes | Enter | a live session |
| 編集 (the window of the kind's fields, `EDIT_FIELDS`) | all | no | yes | F2 | a live session |
| ナレッジを見る | a sticky with knowledge (ADR 0031), in a session with a knowledge store | no | no | | a store |
| ドメインモデルで見る | event, command, aggregate with a `ref` the model has | no | no | | |
| このタイムラインで見る | an event in a timeline the view does not show | no | no | | |
| ホットスポットを付ける | any sticky but a hotspot (`HOTSPOT_TARGETS`, the grammar's `hotspot { on <any sticky> }` since ADR 0032) | no | no | | a live session |
| 解決を書く (解決を直す once resolved): the hotspot's edit window, at its resolution | hotspot | no | yes, a hotspot's (`frequent` may depend on the sticky) | | a live session |
| リンクをコピー | all | no | no | ⌘⇧C | |

The `see` actions have the `see` look (the eye) and name their place in the tooltip (「ドメインモデルの 注文 › 確定する
を見る」, in the display mode). ナレッジを見る opens the sticky's knowledge in the detail, under the tree; it is offered only
where the session keeps knowledge and the sticky has some (its dot on the canvas).

**Back from a jump** (*Decided by the maintainer*, after trying it). ドメインモデルで見る moves to the other world and
このタイムラインで見る to another view: each leaves a return point (the sticky, the view, the storming's scope and level,
the camera; `apps/web/stickies/return.ts`) and a browser history entry. While the page still shows where it went, the
detail's back button names the sticky and returns to it — the view, the scope and the level as they were, the camera
set back, the sticky selected — and the browser's Back does the same (the page kept no view state in the browser's
history before; these entries are the only ones it pushes).

**The windows** show no key hints (cut by the maintainer: the UX works without them); the keys are in the buttons'
tooltips and `aria-keyshortcuts`. The edit action is called 編集 everywhere (the toolbar, the menu, the palette, the
window, 「◯◯が編集しました」).

**A hotspot's name is the AI's** (*Decided by the maintainer*). ホットスポットを付ける asks the question only, in a text
area (Enter a new line, ⌘/Ctrl+Enter adds it; line breaks are written `\n` in the `.dtes` string). Nobody waits for the
AI (*Decided by the maintainer*): dt writes the hotspot at once under a provisional name after its sticky
(`<Sticky>Question`, suffixed when taken), the window closes and the new hotspot is selected. Then the server asks the
light model for its ID — the same tool-less Claude Code light model the knowledge extraction's gate uses
(`agent.extract.gateModel`, Haiku by default) — through the agent API's **helper stream** (`GET /agent/helpers/events`,
`POST /agent/helpers/:job`): a `hotspotName` job with the question and the sticky's ID, label and kind, schema
`{ name }`. The helper is not knowledge's: the server always serves the stream, and every `dt agent` (and the agent in
`dt open`) follows it, whatever the `knowledge` config, beside the extractor role (a stream of its own, so that a
running extraction never holds a name up). The reply is made an ID (PascalCase from its words, letters and digits, at
most 40). The job also lists the IDs the storming declares (every kind, at most 300) and says to give none of them —
other words for the question's point, a closing word such as `Question` or `Open` only if nothing else fits, never a
number; an answer that is still taken is asked once more, naming the clash, and only then given the first free
numeric suffix and written over the provisional one through the rename path
(`nameHotspot`) — only while the workspace is still the edit's result (nothing else changed since) and the hotspot
still has its provisional name and question; otherwise it is dropped. It is part of the same person's edit, not a
record of its own: the edit's run gets `hotspotName` and its result revision becomes the renamed workspace
(`run.hotspot_named`), so its revert takes the hotspot away whatever its name, and the chat's and AI の作業's rows show it
by its name now; the page keeps the hotspot selected under its new name. With no agent connected, a failure, or no
answer within 30 s (the job is withdrawn), the provisional name stays.

**Turn marks** (#63). A person's edit is a turn like a run's: its base → result revision feeds the storming canvas's
marks of the latest change (`changingRuns` takes `Edited` runs), so the stickies it added or changed are marked as
a run's are.

**The fields a person edits, by kind** (*Decided by the maintainer*). The registry declares them (`EDIT_FIELDS`) and the
edit window is built from them, so a field is added to a kind there: an event, a command, an aggregate, an actor, an
external system, a read model and a policy have ラベル (one line) and 名前 (checked, with the references a new name
rewrites); a hotspot has 問い and 解決 (several lines each: Enter a new line, ⌘/Ctrl+Enter saves). A hotspot's name
is the system's — written provisional, renamed once by the light model — and never shown nor asked: editing its
question does not rename it (chat `#` targets and knowledge items' `about` refer to it by its ID). 編集 on a hotspot and
解決を書く (解決を直す once resolved) open the same window, the latter at its resolution. Saving writes both in one edit
(`hotspot`: `question`, `resolution`; one record `HotspotEdited` with 問い and 解決 old → new): a resolution written sets
`status resolved` and `resolution`, one emptied reopens the hotspot (both clauses removed).

**Links.** A link names an element in the page's fragment, `#select=es/<Storming>/<Local>`: the view state stays the
page's (per browser, not in the URL), and the page opens the world and the storming's view that draws the element
(its integrated canvas, at a level that draws it), selects it and drops the fragment. A fragment never reaches the
server.

### Writing `.dtes` without an AI run

- **Planned on the AST** (`contexts/storming/src/infrastructure/syntax/edit.ts`, `planStickyEdit`): the storming and
  the declaration are found by their IDs in the parsed file; only the ranges of the tokens concerned are replaced or
  text inserted next to them — the label string, the declaration's name and every reference to it in the storming
  (the relation clauses — `by`, `reads`, `handledBy`, `emits`, `on`, `issues`, `from`, each name of a comma list, a
  hotspot's `on` any sticky —, the steps of timelines and groups, an exception's `then`, a stage's `after`; the IR's
  `referencesTo` finds the same places, and the page counts them with it). No `dt fmt` of the file: the rest stays byte
  for byte. A new hotspot goes after the storming's last hotspot (else after its last element), in the canonical
  layout (`hotspot <Name> "<question>" { on <Event> }`); resolving writes `status resolved` and `resolution "…"` where
  they belong. A name is checked first (the grammar's ID, not a keyword, not another declaration's ID: one namespace),
  a label on one line; the result must parse again (a safety net).
- **Elsewhere than the `.dtes`.** The journey file is keyed by storming IDs only (no element is named there), and the
  layout is the cache's (outside the workspace, keyed by the render graph; a renamed note is laid out anew). Neither is
  rewritten.
- **Where.** `POST /api/session/stickies { kind: 'wording' | 'addHotspot' | 'resolveHotspot', …, body }`, any
  participant, behind the watcher's hold (the view refreshed once). Collaboration's `editSticky` plans it through a port
  (`StickyEditor`, wired by the app with Storming's planner: a context takes no other's syntax), reads the sources,
  writes the whole set with the same refusal as every write (the sources must be as read; refused for a run's write in
  between, read again up to three times), and checks that every `.dtes` parses.
- **Optimistic concurrency.** A wording edit carries the label and the name the page saw (`expected`); when the file
  says otherwise the edit is refused (`StickyStale`, 409) with what the sticky is now, and the window says so.

### Recorded as a unit of work, reverted as one

*Decided by the maintainer*: every participant may edit (unlike the AI's requests, these are small and quickly fixed by
another edit) — not a proposal for the facilitator.

An edit is recorded like a run's work, so that it shows and is reverted with the existing mechanism (ADR 0026, "revert a
run"): a message (`Request.recordEdit`, its `edit: StickyEdit` — `Wording` with the name and label before and after
and the references rewritten, `HotspotAdded`, `HotspotResolved` — and the page's sentence 「旧」を「新」に編集) and a
run created in the new state `Edited` (`AgentRun.recordEdit`: never queued, never claimed), with base and result
revisions (`RunBase`, `RunResult`), `queuedBy` the person. The message is no chat message (the AI is not asked, it counts
as nothing unread); instead the chat shows the edit where it happened as an activity row of that person (their avatar,
no bubble, continuing their messages as theirs do; 「◯◯が編集しました」 with the sticky's `#` chip, which selects it, and the
change: ラベル / 名前 旧 → 新, 「ホットスポットを付けました: 〈問い〉」, 「解決を書きました」), re-applications and conflicts
included (*Decided by the maintainer*). AI の作業 shows the unit as 「◯◯が編集しました」 with its time and old → new. Both
offer 打ち消す (the facilitator's, as every revert) sends the revert request
「〈何を直したか〉の変更を打ち消す」 through the queue, which the server reverts mechanically. Migration: none (runs and
requests are JSON rows; the new event types `run.edited`, `run.edit_conflicted`).

### Edits while a run runs (*Decided by the maintainer*: re-apply)

Edits are allowed even on the elements a running run targets. The server writes them one at a time (one queue in the
application for the edits and the re-application; a run's agent writes the files itself, so its writes are not the
server's to queue). When a run ends with a result (completed or failed by the rule, asked, declined; before the agent is answered, so before
it claims the next run), `reapplyEdits` compares, for each wording edit recorded while it ran and not reverted, what
was there before the edit, what the person wrote, and what the run left (a three-way compare per sticky):

- the person's label and name are still there: nothing to do;
- the run left the old label, or the old name (it wrote a file as it had read it before the edit): the edit is written
  again — for a rename, the old name the run left and every reference to it, including those the run wrote — as one new
  `Edited` run attributed to the same person, `reapplies` the run;
- the run changed the same label to something else: the run's is kept, and the edit records the conflict
  (`EditConflict { run, runLabel, settled }`, `noteConflict`); AI の作業 shows both wordings with AI の文言のまま and 人の文言にする
  (a new edit over the run's, then settled; `POST /api/session/runs/:id/settle`).

The runner is told: a starting run gets `peopleEdits` (the edits since the previous run started, who and old → new);
the prompt shows them in `changedSinceYourLastRun.editedByPeople` for an agent that continues its conversation, else as
`editedByPeople`, and rule 3 says to keep people's wording — never set it back nor change it unless a request asks.

### Limits

- A revert is line based (ADR 0026): reverting a rename after a later edit used the new name (a hotspot `on` it) leaves
  that later reference as written.
- An edit made while a run runs is inside that run's base → result: reverting the run also takes it back where the run's
  result kept it (the run's revert is the facilitator's, who sees the edit in AI の作業).
- The comparison after a run reads labels and names only: a run that renamed the sticky to a third name, or removed it,
  is left alone.
- The helper takes one job at a time: of two hotspots added at the same moment, the second gets dt's name at once. An agent older than the helper stream does not follow it: dt names the hotspots.
- Only the wording of a sticky, a hotspot and its resolution are written by hand; placing stickies and the other clauses
  stay the AI's (`docs/plans/listening.md` §2).

## Consequences

- The canvas is no longer read-only for its words: a typo costs an edit, not a run. The AI keeps the tidying.
- `Edited` is a state every consumer of runs knows (the chat's stream leaves it out; AI の作業 draws it; the prompt
  calls it "edited by a person").
- The menu and the palette are shared components for the next features (other worlds' actions).
