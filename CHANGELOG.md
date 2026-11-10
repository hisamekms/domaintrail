# Changelog

[日本語](CHANGELOG.ja.md)

What changed in each version of domaintrail. The format follows [Keep a Changelog](https://keepachangelog.com/), and
the versions follow [Semantic Versioning](https://semver.org/) (before 1.0.0, a minor version may break models and
code).

**After upgrading domaintrail**, read the **Upgrading** section of every version between the one you had and the new
one, oldest first, and follow its steps. This file is in the package: `node_modules/domaintrail/CHANGELOG.md`.

## [0.10.0] - 2026-11-10

### Added

- **Kind-specific aggregate lifecycles and named command outcomes** (`dt guide kind-lifecycles`, ADR 0035): a required
  `readonly` enum field can select a lifecycle through `transitions for`; `initial` identifies its starting states.
  Named `outcome`s give each result its own target, changes and events, even when results share a target. `select`
  expressions distinguish results from the same source; a decision outside the DSL can declare a reasoned
  `@externalCheck`. The State View can show one kind at a time, and `dt show` lists its valid states and outcomes.
- **Generation readiness checks**: `dt check --for-generation` reports unresolved natural-language `select`,
  `requires` and `invariant` decisions as errors; `dt generate ts` runs this gate before writing. External checks
  require typed implementation slots and generated contract tests.
- **Collaborative Event Storming guidance**: distributable Big Picture and Design Level examples, optional
  `dt check --storming-level design-level` advice, and an invitation to choose a Design Level scope after the journey
  advances. A command issued by an actor can use `on Event` to express Event → Actor → Command without a policy.
- **Project-shared knowledge bookmarks** in the files and Cloudflare stores: mark or unmark an item and filter the
  list to bookmarks. The mark survives correction, extraction and retirement. A separate Knowledge screen opens a
  searchable list beside the full detail and its actions; the sidebar remains available beside the canvas.
- **Codex as an agent for `dt open`, `dt collab` and `dt agent`** with `--agent codex`, including read-only copies of
  approved external paths. Custom Claude Code `agent.run.allowedTools` rules are not supported for Codex.
- **`dt init` for AI-first setup**: a noninteractive, project-aware layout plan in text or versioned JSON, with
  evidence and unresolved decisions. `dt init --apply` creates `domaintrail.jsonc` only for a new single-package
  workspace without existing model files; it preserves existing settings and sources. In a monorepo, choose the
  generated TypeScript owner before editing the configuration. Independent products need separate roots.

### Changed

- In chat, a human answer appears after its AI question and the resumed AI work after that answer, with their thread
  links. Typing in the message composer no longer rerenders the whole page and chat stream for each character.
- At Design Level, a command or policy at the same position in several lanes is drawn once with lines to each lane's
  event. When the design already connects an exception's branch events, the redundant branch line is omitted while
  its selectable label remains.

### Fixed

- The reply action on a Solo AI run card is anchored to that card and revealed on hover, focus or touch.
- A command's undecided handler now asks “What handles it?”; its issuer still asks who acts. Codex can list an
  approved read-copy directory using the trailing slash shown in its prompt.

### Upgrading

1. **Review model decisions before generating.** Legacy commands with one target remain accepted. A legacy
   multi-target transition such as `Pending -> Approved | Rejected` cannot be generated until its alternatives have
   named outcomes. Move command-level `changes` and `emits … when` to the corresponding outcomes and give every
   competing outcome a `select` rule. For example:

   ```dt
   // before
   command review() {
     Pending -> Approved | Rejected
   }
   // after: replace result with the actual decision available in your model
   command review(approved: Bool) {
     outcome approved: Pending -> Approved
       select { approved }
     outcome rejected: Pending -> Rejected
       select { not approved }
   }
   ```

   An expression-free `requires` or `invariant` needs an executable expression or a reasoned
   `@externalCheck("why this decision is external")`; the annotation is an obligation, not a check. Run
   `dt check --for-generation` to find remaining blockers. For a kind-specific lifecycle, add a required `readonly`
   enum selector, applicable `initial` states and `transitions for` groups. See `dt guide kind-lifecycles`.
2. **Implement external obligations and run generated tests.** An external check needs its generated typed slot and
   contract tests enabled with `generate.ts.tests`; generation fails if those tests are disabled. After changing the
   model, run `dt generate ts`, update implementations for named outcomes, and run the generated tests. Regenerate
   even when the model did not change: contract tests generated by 0.9 do not load with another minor version.
3. **If using the Cloudflare knowledge store**, apply `0004_bookmark.sql` and deploy the new Worker and page as its
   template README's Upgrade section describes. Existing items start unbookmarked. The `files` store needs no
   migration.

## [0.9.0] - 2026-11-07

### Added

- **Following** (`docs/live-view.md`, ADR 0026's appendix): only the reader and whom the reader follows move the
  reader's camera. The AI is followed from the ○ / ◉ left of its status in the app bar or from its row in the
  participants; while followed, a run's changes are brought into view (in the view that draws them). Sending a request
  to the AI (a message for it, an answer, a pick, the facilitator's AI に送る, an approved proposal of one's own) follows
  it on the sender's page only. A participant is followed from their row: the page opens the storming, level, timeline
  and exceptions' layer they are on and fits what their canvas shows. Any move of the reader's own stops following; one
  followee at a time; a thin frame in the followee's colour shows it. A participant's presence now carries the camera.
- **Hiding the resolved hotspots** (ADR 0032 §10): 「解決済みを表示」 in the Event Storming 絞り込み, on by default, per
  viewer; off, the resolved hotspots and their lines are not drawn and their places are left empty — no sticky moves.
  Each sticky they are on keeps a green ✓ in its corner (left of its 「k/n」), which tells what was agreed on hover and
  selects the hotspot; the sticky's detail lists all its hotspots whatever the filter. `dt export svg
  --resolved-hotspots hide` draws the same. Going to an element the view does not draw (the palette, a `#select=` link,
  the knowledge, the detail, a chat's reference, a turn's marks) shows it first, then selects it.
- **Retiring knowledge** (廃止, ADR 0031 §12): an item that no longer holds is retired, not deleted — its text, sources
  and versions stay — with a reason (置き換わった, with the item that replaces it; 当てはまらなくなった; 誤り) or
  none, 元に戻す for 10 seconds, and 廃止を取り消す. A retired item leaves the lists, a sticky's detail and the dots
  (廃止も表示 shows it faded), and the AI no longer reads it: the answerer and the runner start
  `dt mcp --without-retired`, and the extractor gets only the retired items' titles and reasons. **The AI proposes,
  people decide**: the extractor and the review of a run (below) propose to retire an item, or to undo a retirement,
  with a reason and evidence, in 廃止の候補 at the head of the ナレッジ list (承認 / 却下, never in the chat); a
  dismissed proposal comes back only on new evidence; an AS-IS item is never proposed for differing from the TO-BE.
  The Worker's page retires and decides too. `dt mcp`'s `knowledge_for_element` and `knowledge_search` take
  `include_retired`. The `files` store keeps a `retired:` map in the item's file and the proposals in
  `knowledge/proposals/`; the `cloudflare` store needs the Worker's migration 3 (see Upgrading).
- **探す** in the middle of the app bar (`docs/live-view.md`): a button shaped like a search field (🔍 探す ⌘K, Ctrl K
  elsewhere), in both worlds, opening the palette that ⌘K opens. Empty, it lists the actions on the selected sticky and
  the five last selections; typed, the matching actions, then what it finds in both worlds, a section each with its
  count — the stickies of every storming and the domain model's contexts, elements, commands and states. It matches the
  label and the name (the ID) only: equal first, then starting with it, then holding it, then the name only (shown
  marked); eight per section, 「ほか n 件」 for the rest. A sticky whose `ref` names a model element has it hung under it.
  Picking one goes there, taking away what hides it (a level, the exceptions, a main flow, the 絞り込み, the contexts
  narrowed, the catalog's filter) and saying so for a moment.
- **The review at a run's end** (`dt guide session`, ADR 0034): a run that changed stormings is checked before it ends —
  dt's rules on its diff (a hotspot resolved while the sticky it is on stayed as it was, a sticky changed under a
  hotspot left open, a former label or name another sticky still has, a new sticky with another one's label), then one
  more turn of the same run over the neighbourhood of what it changed (the hotspots on it, one relation away, and the
  decisions and rules about them, never AS-IS nor retired), in which the AI fixes what is at odds within the request and
  says why for what it keeps. The run card shows 見直し — what was found, fixed and kept — and the
  facilitator's 見直しを頼む while something is left. What the review finds at odds with knowledge goes to the next
  extraction as a conflict, and an item it finds no longer holds becomes a 廃止の候補. A renamed sticky's knowledge
  follows the new name. On by default; `agent.run.review: false` turns it off.

### Changed

- **`reads` is written on the row of whoever decides** (ADR 0032 §9; see Upgrading): a policy `reads` the read models it
  looks at (「〜が起きたら、〜を見て、〜を出す」), and a command a policy issues has no `reads` (**S030**, an error whose
  hint names the policy). A policy issues one command (**S031**, an error: split it, one policy per command). `dt fmt`
  orders a policy's clauses `on`, `reads`, `issues`, `by`. `dt migrate dtes` also rewrites `.dtes` files of 0.8: it
  moves the `reads` of a command a policy issues to that policy, with its comments.
- **The Design Level draws a read model before whoever reads it**: read model → the policy's note (in both layouts, a
  read model column between events and policies), no longer read model → command. Every `reads` line says, in
  Japanese, 「「B」は「A」を見て判断する」.
- **The Event Storming canvas carries a timeline, and the exceptions are a layer over it** (ADR 0032 §11,
  `docs/live-view.md`): the breadcrumb is the storming › すべて or one main flow (the trunk through every stage is one;
  no picker for a storming with one), and one main flow is drawn in the layout of すべて, the other main flows and the
  exceptions branching off them left out where they stood — no sticky moves; a stage with nothing drawn keeps its
  frame, dashed. Beside the breadcrumb, the toggle ↳ 例外 (in the exceptions' pink, with how many) includes the
  exceptions (the default) or not — the former 「例外を表示」, out of the 絞り込み now — and its ▾ emphasizes one: its
  path stays dark, the rest goes faint, nothing moves. A lane's label on the canvas emphasizes its exception too. The
  emphasis is close to a selection: never remembered, followed nor printed; its ×, a second Escape or a press on the
  empty canvas ends it. The navigator's rows show the same canvas: a stage's row brings its frame into view, a main
  flow's row puts it on the canvas, an exception's row emphasizes it.
- **`dt export svg`** (see Upgrading): `--timeline <ID>` draws one main flow, by the ID of any of its timelines, in the
  layout of every flow; `--exceptions include|exclude` (`show` and `hide` are still taken, as their earlier names). The
  heading says すべて or the main flow, and 例外を含む / 例外なし.
- **The camera no longer moves for a run's changes** unless the reader follows the AI: the marks and the bar
  (「ほかに n 件の変更 →」) say where they are (it moved when none was in view).
- **The AI**, deciding what answers a hotspot, changes the sticky and writes the hotspot's resolution, both.
- **The app bar on a narrow window**: under 40rem the workspace's name goes and 探す is its magnifier alone; at a
  phone's width the brand's name, the extraction switch and the words of the AI's state go.

### Removed

- `reads` in a command a policy issues: an error (S030), moved by `dt migrate dtes`.
- **The view of a stage and the view of an exception**: a stage is a frame on the canvas, an exception is emphasized
  on the layer. `dt export svg --stage` is gone, and `--timeline` no longer takes an exception (see Upgrading).

### Fixed

- A run no longer fails as an agent error, with the subscriber claiming no further run until restarted, when dt writes
  `domaintrail.journey.json` while the run runs (the facilitator acting on the journey, an approved request, an
  interview's brief settled): the run's check of the files the agent changed skips it.
- ⌘K no longer matches a sticky by its kind or its storming: a word in a storming's name (「注文」 in 「注文から入金まで」)
  listed every sticky of it.

### Upgrading

`.dtes` files of 0.8 with `reads` in a command a policy issues, or a policy issuing several commands, no longer check.
Commit first, so that each step is a diff to review.

1. **Move `reads` to the policies:**

   ```sh
   dt migrate dtes --dry-run   # lists what would be moved and what is left
   dt migrate dtes             # rewrites in place; exits 1 if something is left
   ```

   It moves the `reads` of a command issued by exactly one policy to that policy, with its comments:

   ```dtes
   // before (0.8)
   command IssueInvoice "請求書を発行する" {
     reads OrderTotal // 合計を見て請求額を決める
     handledBy Invoice
     emits InvoiceIssued
   }
   policy BillConfirmedOrder "注文が確定したら請求する" {
     on OrderConfirmed
     issues IssueInvoice
   }
   // after (0.9)
   command IssueInvoice "請求書を発行する" {
     handledBy Invoice
     emits InvoiceIssued
   }
   policy BillConfirmedOrder "注文が確定したら請求する" {
     on OrderConfirmed
     reads OrderTotal // 合計を見て請求額を決める
     issues IssueInvoice
   }
   ```

   What it lists as left, to change by hand, then run it again:
   - **S031**, a policy that issues several commands (the `reads` of its commands are left where they are): split it,
     one policy per command, each `on` the same events.

     ```dtes
     // before: S031
     policy BillConfirmedOrder {
       on OrderConfirmed
       issues IssueInvoice, RequestShipment
     }
     // after
     policy BillConfirmedOrder {
       on OrderConfirmed
       issues IssueInvoice
     }
     policy ShipConfirmedOrder {
       on OrderConfirmed
       issues RequestShipment
     }
     ```

   - **S030**, the `reads` of a command several policies issue (not copied to each): write it in the policy that looks
     at it — in each, when they all do — and remove it from the command.

     ```dtes
     // before: S030
     command RemindPayment {
       reads Unpaid
       handledBy Invoice
       emits PaymentReminded
     }
     policy RemindWhenOverdue {
       on PaymentOverdue
       issues RemindPayment
     }
     // after (and the same in the other policy that issues RemindPayment, if it looks at Unpaid too)
     command RemindPayment {
       handledBy Invoice
       emits PaymentReminded
     }
     policy RemindWhenOverdue {
       on PaymentOverdue
       reads Unpaid
       issues RemindPayment
     }
     ```

   As in 0.8.0, what nobody has decided is never guessed: put an open hotspot on the policy, asking it.
2. **Run `dt fmt`** once and commit it apart: a policy's clauses are ordered `on`, `reads`, `issues`, `by` (a policy
   `by` an actor gets its `by` last).
3. **`dt export svg --stage <ID>`** is an error: drop it to draw every flow, with the stage's frame in it, or use
   `--timeline <ID>` for a main flow. `--timeline` with an exception's ID is an error too: draw every flow (its
   exceptions included by default). `--exceptions hide` / `show` still work; write `exclude` / `include`.
4. **The `cloudflare` knowledge store**: apply the Worker's migration `0003_retirement.sql` and deploy the new Worker,
   as its README's Upgrade says (`dist/knowledge-worker/README.md`): copy the new `worker.js`, `page/` and
   `migrations/`, `npx wrangler d1 migrations apply knowledge --remote`, then `npx wrangler deploy`. Until it is
   deployed, 廃止する and the proposals get 404. The `files` store needs nothing.
5. **Regenerate** with `dt generate ts`: the generated contract tests fail to load with another minor version.
6. **Config**: nothing to change. `agent.run.review` is new and on by default (one more turn for a run that changed
   stormings); set it to `false` to turn the review off. The Live View's remembered choices of a storming's view are
   read anew: a stage as every flow, an exception's timeline as every flow with its exceptions, 「例外を表示」 off as the
   exceptions excluded.

## [0.8.1] - 2026-11-06

### Fixed

- A run no longer fails as an agent error, with the subscriber claiming no further run until restarted, when the
  `files` knowledge store writes `knowledge/` while the run runs (an extraction, people's corrections and deletions, the
  sweep). The run's check of the files the agent changed skips that directory, and the agent may not edit it: the agents
  read knowledge through dt.

## [0.8.0] - 2026-11-06

### Added

- **Knowledge from the sessions** (`dt guide knowledge`, ADR 0031): what is said and found in a session — why, how
  often, who said so, what the AI found — kept item by item apart from the `.dtes` and `.dt` files, tied to the
  stickies it is about. An item has a title (one short line), a Markdown text (with images), labels (`when` AS-IS / TO-BE, `kind`,
  `origin` 発言 / 合意 / 調査 / 推測, an optional `perspective`), the stickies it is `about`, its sources with a short
  quote of each message, versions, and the items it conflicts with.
  - **Extraction in the session**: a third role of the AI, the extractor (`agent.extract`: `model`, `gateModel`,
    `timeout`, `effort`; no tools), turns the talk into items soon after it: after 30 seconds of quiet following a
    person's message, after each answer of the AI and at the end, at most once a minute. Three stages keep the stronger
    model for when there is something to extract: surely-nothing messages stop it without any model, then a light model
    (Haiku by default) decides whether there is a finding. New items and new sources apply at once; updates and
    conflicts are held until confirmed by the next extraction or by quiet, and dropped at the end. Each extraction's
    stages and costs are recorded. Off unless `knowledge.extraction.enabled`; the facilitator switches it for the
    session with the 💡 in the Live View's app bar.
  - **Two stores** (config section `knowledge`: `store`, `project`, `url`, `extraction`): `files` (the default), one
    Markdown file per item in the workspace's `knowledge/`, kept in git; and `cloudflare`, a Worker you deploy from
    the template shipped in the package (`dist/knowledge-worker/`: D1, R2 and Cloudflare Access; its README is the
    deploy and upgrade runbook), for projects where personal data may be spoken. dt sends the Access service token
    from `DOMAINTRAIL_KNOWLEDGE_CLIENT_ID` and `DOMAINTRAIL_KNOWLEDGE_CLIENT_SECRET`; `knowledge.url` and
    `knowledge.project` are security-relevant settings you approve. `dt check` reports an item file that does not
    read (K001) and an item about a sticky no storming has (K002, warning).
  - **In the Live View** (`docs/live-view.md`): a dot on each sticky with knowledge and a mark for a conflict; a
    sticky's items in its detail, newest first or by kind, each closed to its title and labels and opening to its text,
    its labels as the ナレッジ tab's filter chips (a press shows the tab filtered by it), quotes, other stickies, versions
    and images; the ナレッジ tab with search and filters; 直す, 画像を付ける and 消す; a conflict side by side with
    ホットスポットにする and 食い違いではない.
  - **Deleting**: an item is hidden from everyone at once, with 元に戻す for 10 seconds; the store's sweep then removes
    every version and image and puts the source messages on the project's redaction log, which every dt of the project
    follows to redact them in its own session database. With `files`, the item stays in git's history.
  - **`dt mcp`** (`dt guide mcp`): an MCP server over stdio for Claude Code, read-only: `knowledge_for_element` (a
    sticky, or a `.dt` element through the stickies that `ref` it), `knowledge_search` and `knowledge_get`.
  - **`dt publish`** (`dt guide publish`): each storming's published form (stickies, links and layout, with the commit
    and date of the drawing) to the `cloudflare` Worker, run by CI when `main` changes, the destination pinned with
    `DOMAINTRAIL_PUBLISH_URL` and `DOMAINTRAIL_PUBLISH_PROJECT`; `--prune` removes the stormings the workspace no
    longer has, `--out` writes the forms as files. The Worker serves a **read-only page** behind the same Access: the
    canvas of a published storming with the knowledge, the ナレッジ list, the items about stickies missing from the
    drawing, and correcting and deleting as in a session.
- **People edit the stickies in place** (ADR 0033, `docs/live-view.md`), without an AI run: one set of actions on the
  selected sticky, in its toolbar, its … / right-click menu, keys (Enter, F2, Esc, ⌘⇧C) and the ⌘K palette —
  チャットに追加, 編集, ナレッジを見る, ドメインモデルで見る, このタイムラインで見る, ホットスポットを付ける, 解決を書く / 解決を直す and
  リンクをコピー (a `#select=` link). 編集 changes a sticky's label and name (with every reference to it, all relations
  included) or a hotspot's question; 解決を書く writes a hotspot's resolution (emptying it reopens the hotspot); a new
  hotspot is written at once and named in the background by the light model. dt rewrites only the tokens concerned in
  the `.dtes`. Any participant may edit. Each edit is a person's revision: listed in AI の作業 and in the chat,
  revertible, and marked on the canvas. An edit made during a run is applied again if the run dropped it; when the run
  reworded the same text, people choose AI の文言のまま or 人の文言にする. The AI is given the people's edits and keeps
  their wording. The detail's back button and the browser's Back return from ドメインモデルで見る and このタイムラインで見る.
- **What a run changed, on the Event Storming canvas** (`docs/live-view.md`): after a run that changed the stormings,
  the stickies it added or changed get the rings 新 / 変 (a changed one with its former label struck through) and the
  removed ones a dashed ghost marked 削除, until the next such run or 印を消す. A bar counts them and leads to those out
  of view (ほかに n 件の変更 →); 図で見る on a run's changes (in the chat and in AI の作業) shows that run's marks. Marks
  are per viewer.
- **`.dtes`**: `readmodel R { from <event> }` (the events a read model is fed from), `event E { from <external> }` (an
  event that arrives from outside, without a command of ours), a hotspot `on` any sticky (not only events), a policy
  `by` an actor (a rule a person applies by hand), and a command `handledBy` an external system (see Changed).
- **`dt migrate dtes`** (`--dry-run`, or the files to migrate): rewrites `.dtes` files of 0.7.0 to the new relations,
  then lists what it could not rewrite and the errors `dt check` still reports (see Upgrading).
- **Rules for the Design Level** (`dt guide storming-rules`), errors with a fix in their hint: S023 (`actor` / `target`
  of 0.7.0), S024 (a command without its issuer, `handledBy` or `emits`), S025 (`by` on a command a policy issues),
  S026 (a relation written twice), S027 (an actor, external system, aggregate or read model no relation names), S028
  (an event both emitted and `from` an external system). S024, S027 and S008 are off for an element while an open
  hotspot is `on` it; `dt check` lists those elements, and the Live View draws the missing issuer or handler as a dashed
  note 誰が処理する？. S029 points at an event nothing produces.
- **Infos**: a third severity besides errors and warnings (S029), which changes no exit code; `info` in the JSON of
  `dt check --format json` with `summary.infos`, and Information in the language server.
- **`dt check` warns** about a `union` none of whose variants has a field (M026: write an `enum`) and a field or
  parameter named `…Id` / `…Ids` typed `String`, `UUID` or the ID type's base while the ID type or the aggregate exists
  (M027: type it with the ID type, or `references`).
- `dt guide` topics `dsl-quick` and `dtes-quick`: the syntax of `.dt` and of `.dtes` on one screen, each a checked
  example, also given to the AI when it works on those files.
- `dt guide` topic `knowledge` (with `mcp` and `publish`).

### Changed

- **The `.dtes` relations follow Event Storming's grammar** (ADR 0032; see Upgrading): a command holds its whole row,
  `by` (who issues it: an actor or an external system), `reads` (the read model the issuer looks at), `handledBy` (who
  handles it and produces its events: an aggregate or an external system, exactly one) and `emits`. `by` replaces
  `actor`, and `handledBy` replaces `target`. `by`, `handledBy` and `from` are keywords and no longer valid IDs. A
  syntax error suggests the keyword meant (`handledby` → `handledBy`). S003 and S006 hint at the relation meant (`by`
  an aggregate → `handledBy` it, `reads` an event → a read model `from` it, …).
- **`dt fmt` orders a body's clauses** (`ref`, `by`, `reads`, `handledBy`, `emits`, `on`, `issues`, `from`, `status`,
  `resolution`, `level`, each with its comments) and merges a relation written in several clauses into one list
  (`emits A` + `emits B` → `emits A, B`) unless a comment is on one of them.
- **The Design Level is drawn as the grammar reads** (`docs/live-view.md`), in both layouts: read model → issuer →
  command → handler → event → policy → command, the actor beside its command, one handler note where commands handled by
  the same element lead to one event. The lines have three looks — 流れ (a solid arrow), 時間 (a dashed arrow) and 問い
  (a hotspot's line, without a head). At Design Level, the time order is shown by the placement, with lines only for an
  exception's branch and `then`.
- **Selection and lines on the Event Storming canvas** (`docs/live-view.md`): selecting a sticky no longer dims
  the others. The copies of the same sticky are numbered 「k/n」, one out of view is pointed at by an arrow at the
  canvas's edge (pressing it moves there), and the detail steps through them (「同じ付箋 n 件 ‹ k/n ›」). Hovering or
  pressing a line shows its two ends (each in its kind's colour, with its label; pressing one moves there) and what the
  relation means in plain words, in place of the line's former tooltip. An open hotspot's undecided slot is joined to
  its command by a 問い line.
- **The AI** follows the DSL's idioms (a closed set of values is an `enum`; another aggregate is referred to by its ID
  type; each aggregate and entity has an ID type of its own), and never guesses a `.dtes` relation nobody gave: it
  asks with a hotspot on the element.
- **The Live View's left column** (`docs/live-view.md`): the tree with the detail under it, a splitter between them.
  The reader folds the tree (▾ in its head line, dragging the splitter to the top, or ↑ / ↓ on it), which shows what is
  selected while folded; never automatically, and kept like the other sizes. 問題 and 差分 show no detail. The detail
  no longer closes (its close button and rail are gone). The column widens to half the window (it stopped at 560px).
- The AI's texts on a run card (its answer, summaries, and a question asked without choices) are shown as Markdown,
  like the answerer's messages.
- The chat's notice of an update out of sight (「…」が更新されました, AI が回答しました) has a × that closes it without
  jumping.

### Removed

- The `.dtes` relations `actor` and `target` in a body: errors (S023), rewritten by `dt migrate dtes`.

### Fixed

- The detail's back button names a storming element by its label when labels are shown (it showed the ID).

### Upgrading

`.dtes` files of 0.7.0 with commands no longer check: migrate them, then decide what `dt check` asks. Commit first, so
that each step is a diff to review.

1. **Rewrite the relations:**

   ```sh
   dt migrate dtes --dry-run   # lists what would be rewritten and what is left
   dt migrate dtes             # rewrites in place; exits 1 if something could not be rewritten
   ```

   In every command it changes the keyword only, keeping comments and layout:

   ```dtes
   // before (0.7.0)
   command ConfirmOrder "注文を確定する" {
     actor Customer
     target Order
     emits OrderConfirmed
   }
   // after (0.8.0)
   command ConfirmOrder "注文を確定する" {
     by Customer
     handledBy Order
     emits OrderConfirmed
   }
   ```

   What it lists as not rewritten: `actor` / `target` in another element than a command (move the relation into the
   command it belongs to, or remove it), and a file that does not parse, usually because an element is named `by`,
   `handledBy` or `from` (rename it and its references, then run it again).
2. **Run `dt check` and decide what is left.** These are design decisions, not rewrites. Write what is known; **what
   nobody has decided is never guessed** — do not invent an actor, an aggregate or an event to silence an error: put an
   open hotspot on the element, asking it.
   - S024, a command without `handledBy` (the most common after the migration), without an issuer or without `emits`:

     ```dtes
     // before: S024
     command ConfirmOrder {
       by Customer
       emits OrderConfirmed
     }
     // after, when the handler is known
     command ConfirmOrder {
       by Customer
       handledBy Order
       emits OrderConfirmed
     }
     // after, when it is not (the hotspot the error's hint gives): S024 is off while it is open
     hotspot ConfirmOrderOpen "誰が処理する？" {
       on ConfirmOrder
     }
     ```

     A command a policy `issues` needs no `by`.
   - S025: remove `by` from a command a policy issues; a person who also issues it by hand is another command `by`
     that person (or the policy is `by` that person).
   - S026: remove the repeated relation. S027: name the element in the relation where it takes part, remove it, or put
     a hotspot on it. S028: an event that comes `from` an external system is not also emitted by a command (write
     `handledBy` the external system in that command, or make two events).
   - S003 / S006: follow the hint (`by` an aggregate → `handledBy`; `reads` an event → a `readmodel { from … }`).
   - S029 is an info: no change is needed. `dt check` exits 0 when only warnings and infos are left.
3. **Run `dt fmt`** once and commit it apart: it reorders the clauses and merges repeated relations.
4. **Readers of `dt check --format json`** accept the severity `info` and `summary.infos`.
5. **`.dt` models** may get the warnings M026 and M027:

   ```dt
   // before: M026, M027
   union Status { Draft {} Sent {} }
   customerId: String
   // after (as the warnings' hints say)
   enum Status { Draft Sent }
   references customer: CustomerId -> Customer
   ```

6. **Regenerate** with `dt generate ts`: the generated contract tests fail to load with another minor version.
7. **Config**: nothing to change. The sections `knowledge` and `agent.extract` are new; extraction of knowledge is off
   until `knowledge.extraction.enabled` is set (or the facilitator turns it on with 💡 for a session).

## [0.7.0] - 2026-11-04

### Added

- **Event Storming** (`.dtes`, `dt guide storming`, ADR 0024): stormings as text next to the `.dt` model — events,
  commands, policies, actors, external systems, aggregates, read models, hotspots, timelines and groups, with `ref`s to
  the model's events, aggregates and commands. `level design` keeps an event out of Big Picture; `stage … after …`,
  `exception` and `then` lay a storming out in time order, the stages left to right, one straight main flow and the
  exceptions below. Rules S001–S022 check the storming and its `ref`s (`dt guide storming-rules`). `dt check`, `dt fmt`
  and `dt lsp` (diagnostics, formatting, hover, outline, go to definition) take `.dtes` files, which the default
  `sources` now find; `dt generate ts` reads the `.dt` files only.
- **Modes: the Live View with the chat and an AI** (`dt guide session`, ADR 0030; the AI is Claude Code):
  - `dt open` — the Live View for you alone, signed in with a one-time link (`dt open link` prints another); every
    message goes to the AI. `dt open --host <address>` serves a read-only Live View, without the chat.
  - `dt collab` — a collaboration session: several people on the same Live View, a chat about the model's and the
    stormings' elements (`#` names elements, `@` people), replies, votes and reactions; the facilitator decides what
    changes. Identity `dev` (a name, on loopback), `access` (Cloudflare Access) or `link`: `dt collab --tunnel`
    starts a Cloudflare quick tunnel, people join with an invite link (`dt collab invite`) and the facilitator lets
    each one in.
  - `dt agent` — the AI on the running session, from another terminal or machine (`dt collab agent-link` pairs it);
    `dt open` and `dt collab` start one in process when `claude` is usable.
  - Each message to the AI is triaged: a question gets a read-only answer, a request becomes a run that edits the
    `.dt` / `.dtes` files, or a change proposal the facilitator approves. The AI is given the session so far and the
    view each message was sent from.
  - Every run leaves a revision of the workspace. The facilitator reverts one work item from its card (only its
    changes, keeping later ones), or restores an earlier state from the collab menu.
  - The **AI work** tab: what waits for an answer, runs, is queued and is done, what a running run is doing, and the
    changes of each work item in the model's words.
  - Config sections `open`, `collab`, `agent`, `classifier` (an optional Cloudflare classifier for the triage) and
    `templates` (`dt guide session-config`).
- **`/` commands in the chat**: `/es:start` and `/model:start` start an interview, one question at a time, with
  choices to pick (one sends at once, several are checked, "other" is always offered; everyone sees them, the starter
  answers), ending in a brief the facilitator confirms. For the storming in view, `/es:exceptions`, `/es:gaps`,
  `/es:levels` and `/es:names` list candidates (exceptions, missing events, events to move between levels, labels to
  rename) to check and apply in one run, and `/es:recap` sums up the session. `/guide` shows a map from the brief to
  the goal, what the files show at once, and the AI's advice with actions; its suggested commands get a star in the
  `/` list. Templates, built in and the team's, put the beginning of a message in the composer. Anyone runs the
  commands; the facilitator approves what changes files.
- **The journey file** (`domaintrail.journey.json`, `dt guide journey`, schema in `schema/journey.schema.json`): what
  the work in the workspace is for and how far it has come — one Event Storming journey per storming and named
  modeling journeys (patterns `Whole`, `FromStorming`, `OneContext`, `Review`), with their briefs, goals and marks.
  It is tracked by git and written by dt only. Rules J001 (the file reads against its schema, error), J002 and J003
  (a journey names a missing storming or context, warnings).
  - The session has one current journey: its chip in the app bar opens the journeys panel (brief, map, goal, done,
    archive, the other journeys); a participant's change is a request the facilitator approves.
  - The chat records what people do as small rows (goals, marks, journeys switched, requests and their decisions).
    Confirming a brief or completing a journey posts a note with the next step and its buttons.
  - The AI's answers, commands and runs get the current journey; runs keep within its scope and level, and ask
    before going beyond it.
- **The Live View's new layout** (`docs/live-view.md`): an app bar with the world switch (domain model / Event
  Storming, each remembering its view), the current journey and the problems; a left column with the navigator over the
  detail (the inspector) and a splitter between them; the chat as a column at the right; and one view bar over the
  canvas for every view (view switch, subject, level, filter, export). The Event Storming world has its own navigator
  (stormings, stages, timelines) and a detail for a storming's elements. A text size setting (four steps), and an
  empty view says how to start its world.
- **Printing and exporting** (`docs/live-view.md`): printing draws the current diagram alone, fitted to one page, with
  a heading line; the view bar's Export menu prints and saves PNG, a portable SVG (plain shapes and text, for browsers,
  Figma and Inkscape) and PDF, optionally with the heading and the legend. "Close up the gaps" lays every diagram out
  more compactly.
- **`dt export`** (`dt guide export`): `dt export svg` draws a Live View diagram as the same SVG without a browser
  (deterministic, for documentation built in CI); `dt export sources` writes the `.dt` and `.dtes` files and the
  config as one ZIP archive, also offered in the Live View's menu (Download sources (.zip)).
- **`dt session prune`**: lists (and with `--yes` removes) the state of workspaces that no longer exist, or with
  `--older-than <days>` that are unused.
- **`domaintrail.local.jsonc`**: a git-ignored override merged into the config; read paths outside the workspace for
  the AI (`agent.read.paths`) are taken from it only. Changes to security-relevant settings ask for approval at start
  (remembered in `~/.config/domaintrail/trust.json`; `--yes` without a terminal).
- **DSL**: the declaration keywords may name fields, parameters, terms, commands and discriminators, and any keyword
  may name an enum value or a union variant; value objects and unions may be recursive when each has a finite value
  (M012); value objects take field sets (`with`).
- **Generated TypeScript** (ADR 0028): `check<Aggregate>Common`, the aggregate's own invariants checked once; contract
  tests draw recursive types (`generate.ts.tests.maxRecursionDepth`, default 4, or per type); and
  `generate.ts.contexts.<Ctx>.module`, so that contexts generated into different packages import each other.
- `dt guide` topics: `storming`, `storming-refs`, `storming-views`, `storming-rules`, `storming-practice`,
  `modeling-practice`, `journey`, `export` and `session` (with `session-config`, `session-revisions`,
  `session-agent`). The AI is given the ways of working and may run `dt guide`.

### Changed

- **Generated TypeScript** (ADR 0028; see Upgrading):
  - A command takes its parameters as one object after the aggregate, typed `<Command><Aggregate>Params`
    (`cancel(order, { reason })`); decisions, requirement checks and contract-test inputs take it too.
  - An ID or domain primitive on `UUID` checks the form (RFC 9562): `make<Name>` returns
    `Result<Name, Invalid<Name>>` with the invariant `uuid`, and an invariant of its own cannot be named `uuid` (M002).
  - The slot of an aggregate's invariant declared without an expression takes `<Aggregate>Common`.
  - The contract tests import their support from `domaintrail/testing`, a subpath of the package, and check at load
    that it matches the domaintrail that generated them; fast-check is an optional peer dependency.
  - Generated checks read like the model (`A && !B` for a violated `A implies B`, the lambda names of the `.dt`,
    `'…'` strings), and the target of `references` is a `@see {@link …}`.
- **M025** (error): a context's description (`///`) is written once across its files. A second one was dropped
  silently, depending on the file names; now each later one is reported with the place of the kept one.
- **dt keeps its files outside the workspace** (`dt guide config`): the session, the server's address and the record
  of `dt generate ts` in `~/.local/state/domaintrail/<workspace>/` (`$XDG_STATE_HOME`, or `DOMAINTRAIL_STATE_DIR`),
  the layouts in `~/.cache/domaintrail/<workspace>/` (`$XDG_CACHE_HOME`); on Windows under `%LOCALAPPDATA%`. The
  first command that uses them moves an existing `.domaintrail/` there.
- The model in the Live View payload and in `dt show --format json` has a new shape: `{ contexts, elements }` lists
  in declaration order, each element a variant by `kind`, enum values as `{ name, label }`, binary operators by name
  (`eq`, `and`, …). The generated TypeScript does not change because of it.
- Node.js 22.13 or later is required (22.12 before).
- The Live View draws its diagrams with React Flow instead of tldraw, so they stay on screen behind any https origin:
  a drag always pans (`H`, the hand tool, is gone), Shift + drag draws a selection box, and tldraw's other shortcuts
  are gone; `+`, `-` and `Shift+0/1/2` stay.
- The Live View has the DomainTrail logo and one colour system for both themes: Event Storming notes in their
  conventional colours, the model's kinds by hue, shape and stereotype, and selection, changes and diagnostics as
  overlays that never recolour a node.
- Each canvas keeps its own legend toggle, hidden by default.
- Names show by their label by default; a missing or blank label falls back to the name.

### Removed

- `dt view`: use `dt open` (`--port`, `--host`, `--base` as before). It now fails, naming the replacement.
- The `view` section of `domaintrail.jsonc`: it is `open`. A config with `view` is refused when loaded, saying where
  each key went.
- `tests/_testing.ts` in the generated contract tests (replaced by `domaintrail/testing`); one written earlier is
  removed by `dt generate ts`.

### Fixed

- A reload of the Live View comes back to the world, storming and view shown before, and draws its first frame where
  the layout settles (the columns, the app bar and the view bar no longer move after it).
- The language server reads the sources in the order `dt check` does (by code point).
- The Live View's source highlights a keyword after `.` as a name.
- Generation refuses a symbolic link on every directory it writes to.
- Internal: the code is split into contexts, capabilities, the platform, the shared kernel and apps, with boundaries
  checked by tests (ADR 0025, ADR 0027); contributors see `CONTRIBUTING.md`.

### Upgrading

Upgrade Node.js first if needed (22.13 or later), then the config, then the model, then generate and fix the code.

1. **`dt view` → `dt open`.** Replace it in scripts and docs; its options are the same:

   ```sh
   dt view --port 8080 --base main   # before (0.6.0)
   dt open --port 8080 --base main   # after (0.7.0)
   ```

   In `domaintrail.jsonc`, rename the section `view` to `open` (dt refuses the old one until you do):

   ```jsonc
   "view": { "port": 8080 }   // before
   "open": { "port": 8080 }   // after
   ```

   If the config sets `sources` and you add stormings, list a `.dtes` glob too (`"**/*.dtes"`); the default finds both.
2. **`.domaintrail/` moves out of the workspace.** Run `dt open` or `dt generate ts` once: it prints
   `Moved .domaintrail/ to ~/.local/state/domaintrail/<workspace>/` and deletes the emptied directory. Stop any
   `dt view` of the older version first. The record of `dt generate ts` is not moved: after the next run, delete by hand
   the generated files of earlier runs that it no longer writes (a moved output directory, a removed context). The
   `.domaintrail` entry in `.gitignore` may then be removed. In CI or containers, set `DOMAINTRAIL_STATE_DIR` to a
   writable directory if the home directory is not.
3. **M025.** Where a context split across files has `///` above `context X` in more than one file, merge them into
   one (keep it in `context.dt`, with the context-wide types) and delete the others:

   ```dt
   // before: sales/order.dt and sales/customer.dt both had
   /// Orders and customers.
   context Sales { ... }
   // after: only sales/context.dt has the ///; the other files write `context Sales { ... }` without it
   ```

   Run `dt check` until it exits 0 (M011 also reports an element whose name clashes with a new generated name, such as
   `<Command><Aggregate>Params`).
4. **Regenerate** with `dt generate ts`, then type-check and fix the code:
   - **Command parameters are one object.** Callers and implementations name each parameter:

     ```ts
     // before (0.6.0)
     orderCommands.cancel(order, reason);
     orderCommands.place(id, customer);
     cancel: decide<Sales.CancelOrderDecision>(Sales.OrderShape, { Draft: (order, reason) => … }),
     // after (0.7.0)
     orderCommands.cancel(order, { reason });
     orderCommands.place({ id, customer });
     cancel: decide<Sales.CancelOrderDecision>(Sales.OrderShape, { Draft: (order, { reason }) => … }),
     ```

     The same holds for hand-written requirement checks and the examples given to contract tests
     (`[order, { reason }]`).
   - **IDs and primitives on `UUID` return a `Result`.** Handle it; a value that is a UUID by construction may be
     unwrapped, a failure being a bug. Fixtures and tests must use UUIDs:

     ```ts
     // before (0.6.0)
     const id = Sales.makeOrderId(crypto.randomUUID());
     // after (0.7.0)
     const made = Sales.makeOrderId(crypto.randomUUID());
     if (!made.ok) throw new Error(`not a UUID: ${made.error.value}`);
     const id = made.value;
     ```

     Rename an invariant of your own named `uuid` on such a type (M002).
   - **Invariants without an expression on an aggregate**: type their implementation (the `…DeclaredChecks` slot)
     with `<Aggregate>Common` instead of a state's type.
   - **Contract tests**: import `cases`, `suite`, `Suite` and `TestCase` from `domaintrail/testing` (no longer from
     the generated `tests/_testing.ts` or `tests/index.ts`); keep `domaintrail` and `fast-check` as dev dependencies.
     After every later upgrade of domaintrail, run `dt generate ts` again: the generated tests fail to load with
     another minor version.
5. **Readers of the model's JSON** (`dt show --format json`, or the Live View's payload) read the new shape:
   `contexts` and `elements` are lists (find an element by `name` and `context`, not by key), elements are told apart
   by `kind`, and an enum value is `{ name, label }`.

## [0.6.0] - 2026-10-28

### Added

- **Comparing the Live View with a git revision** (`docs/live-view.md`): the 比較対象 menu in the header, or the heading
  of the changes pane, picks what additions, changes and removals are shown against — the previous save (the default)
  or a git revision: a branch, a tag, one of the latest commits or any revision typed in. `dt view --base <ref>` starts
  with one. The diagrams mark the fields of their nodes, and the inspector marks the rows of its 構造, 状態遷移 and 振る舞い
  tabs (added, changed, removed struck through, with the former value of a changed one).
- **Getting started** in English and Japanese (`docs/getting-started.md`, `docs/getting-started.ja.md`), with the
  README reorganized around it.
- The changelogs are in the package (`node_modules/domaintrail/CHANGELOG.md`, `CHANGELOG.ja.md`), and `dt guide` tells
  agents to follow their Upgrading steps after an upgrade.

## [0.5.0] - 2026-10-24

### Added

- **Policies** (`dt guide reactions`, ADR 0022): `policy P when Event -> Aggregate.command` — when the event happens,
  the command of the policy's own context is eventually run. M023 checks the event, the aggregate and the command, and
  warns about the same reaction twice. Each policy generates the type of its handler, from the event to the command's
  input (`<Command><Aggregate>Input`). With `generate.ts.policies: "required"` (default `"optional"`, also per context
  in `generate.ts.contexts`), `<Context>PolicyHandlers` is generated and the contract tests take it and check that every
  event resolves to an input the command accepts. The context map counts a policy as an event dependency.
- **Verified types** (`dt guide verified`, ADR 0023): `verified X of T for C? errors E` — the evidence of a check made
  outside the aggregate (an email address nobody else uses). Only its async factory, `Make<Name>`, written by you, makes
  it; commands take it as a parameter. M024 keeps verified types to command parameters.
- **Payload names** (ADR 0021): M022 warns when an event or error field likely takes its value from a differently
  named source (a parameter, one of its fields, or a field of the aggregate before / after the command).
- **Zed extension** (`editors/zed`) and a **tree-sitter grammar** (`tree-sitter-domaintrail`): highlighting, outline and
  `dt lsp` in Zed; the grammar for other tree-sitter editors (`dt guide editors`).
- **Linting against casts** (`dt guide lint`): how to make every domain type without `as`, and how to enable
  `no-unsafe-type-assertion` with oxlint or typescript-eslint. `dt generate ts` prints a hint (`hints` in
  `--format json`) when no oxlint or ESLint config mentions the rule; `"lintHint": false` turns it off. The JSDoc of
  IDs, domain primitives and verified types names the way to make them.
- `parseDecimal(text)` in the generated runtime: the one place that makes a `Decimal`.
- `dt guide policies`: how to write rules that depend on a changeable policy.
- `examples/shop` is a complete project: every aggregate implemented, an application layer (use cases, repositories, an
  event store, policies, a verified type's factory), tests and a demo, described in its README.
- Language server: commands can be renamed.

### Changed

- Every command that collects the workspace's files (`check`, `generate`, `view`, `fmt`, `show`, `lsp`) skips what the
  `.gitignore` files (of the root, its subdirectories and its parents up to the repository's top) and
  `.git/info/exclude` ignore. `"respectGitignore": false` turns it off; files named on the command line are never
  skipped.
- When the language server finds no config file, the first `.dt` file opened below a config makes that config the
  workspace.

### Fixed

- A domain primitive over `Int` or `Decimal` can be compared with the numbers `count()` and `length()` compute.

### Upgrading

1. If `.dt` files of your model are in a directory that `.gitignore` ignores, they are no longer part of the
   workspace. Move them, or set `"respectGitignore": false` in `domaintrail.jsonc`. Run `dt check` and compare the
   file count with before.
2. M011: `parseDecimal` is now a runtime name. Rename an element of your model with that name.
3. Run `dt generate ts`. If it prints the lint hint, follow `dt guide lint` (or set `"lintHint": false`), and replace
   casts to domain types in your code with `make<Name>` / `parseDecimal`.
4. New warnings may appear: M022 (rename the event or error field after its source, or the source after the field).
   Warnings do not fail `dt check`.

## [0.4.0] - 2026-10-24

### Added

- **`requires`** on commands (`dt guide requires`, ADR 0017): `requires name { expr } else Error` — the command is
  accepted only if the expression holds, otherwise it returns the error (M019).
- **`changes`** on commands (`dt guide changes`, ADR 0019): the fields a command may change (M021).
- **`emits` with multiplicities and `when`** (`dt guide events`, ADR 0018): `X?`, `X[0..*]`, `X[1..*]`, `X[n..m]`, and
  `X when Draft ->` / `X when -> Completed` for events of some outcomes only.
- **`unique` and `contains`** in expressions, and invariants without an expression, stated in words only (M018; ADR
  0016).
- **Decisions and `decide`** (`dt guide decide`): each command is implemented as a `<Command><Aggregate>Decision` — per
  source state, the outcome's `set` and `events` — and `decide(<Aggregate>Shape, decision)` from the runtime makes the
  aggregate. The compiler names a missing event, an extra event, and a field the command may not set.
- **Generated checks and constructors** (ADR 0020): `check<Name>` / `check<Command><Aggregate>Requires` from the
  invariant and requirement expressions, and `make<Name>` for every ID and domain primitive.
- **Generated contract tests** (`dt guide tests`): with `generate.ts.tests` (`runner`: `bun`, `vitest`, `jest` or
  `node`; `out`), `dt generate ts` writes fast-check suites per context that check the constructors, the requirements,
  the invariants after each command, the events and purity. They need `fast-check` in your project.
- **`dt fmt`**: one canonical layout for `.dt` files, keeping every comment (`--check` for CI); also LSP formatting.
- **`dt show <name>`**: one element, state, command or context resolved, with who uses it (`--format json`).
- **`dt lsp`**: a language server with the diagnostics of `dt check`, definition, references, hover, outline,
  completion and rename.
- **Hints** on diagnostics (did you mean …, and what to change), and `--format json` for `check` and `generate ts`
  (schema in `schema/diagnostics.schema.json`).
- `@see <file>:<line>` on every generated declaration, pointing back to the DSL.
- Runtime helpers `outcome(value)` (`{ to, aggregate, events }`) and `eventList(events)` for code that handles any
  command.
- M020 (warning): a `create command` without a parameter of the aggregate's ID type.

### Changed

- **`emits X` means exactly one `X`** when the command succeeds (it meant "may emit"), and nothing on an error.
- **Command results are keyed by outcome**: `{ Confirmed: { aggregate, events: { OrderConfirmed } } }` instead of the
  tuple `[aggregate, events[]]`; events are keyed by name and have no order. A command without events has `NoEvents`.
- Commands are pure: IDs and times come in as parameters (factories take their ID).
- `ok` infers its type from the contract only, so an extra event in the literal is reported.
- Without `changes`, a command changes no common field.
- Generated modules export values (`<Aggregate>Shape`): import them as values, not with `import type`.
- `dt guide` prints a quick reference and the list of topics; `dt guide <topic>` one section, `dt guide <rule>` one
  rule, `dt guide --all` the whole guide.
- `[0..1]` is the same as `?` and `[1..1]` the same as no multiplicity.
- The Live View shows the multiplicity and `when` of each event, `requires` and `changes`, and hints in the problems
  pane.

### Removed

- `byState` and the `<Command><Aggregate>ByState` types (0.3.0): every command is implemented with `decide`.

### Upgrading

Change the model first, then generate, then the code. The full rules are in `dt guide events`, `dt guide changes` and
`dt guide decide`.

1. **Events.** `emits X` is now exactly one `X` on every success. For each `emits` entry, decide when the event
   happens and write it so:

   ```dt
   // before (0.3.0): "may emit"
   command changeNote(note: String?)
     Draft -> Draft, Confirmed -> Confirmed
     emits NoteChanged
   command cancel(reason: CancelReason)
     Draft | Confirmed -> Cancelled
     emits OrderCancelled, RefundRequested
   // after (0.4.0)
   command changeNote(note: String?)
     Draft -> Draft, Confirmed -> Confirmed
     changes note
     emits NoteChanged?                    // at most one; X[0..*] for any number
   command cancel(reason: CancelReason)
     Draft | Confirmed -> Cancelled
     emits OrderCancelled,
           RefundRequested when Confirmed -> // only from Confirmed
   ```

2. **Factories take their ID, commands take the time.** Add a parameter of the aggregate's ID type to each
   `create command` (M020 warns until you do), and a `Timestamp` parameter where the implementation read the clock:

   ```dt
   create command place(customer: CustomerId) -> Draft            // before
   create command place(id: OrderId, customer: CustomerId) -> Draft // after
   ```

   Callers make the ID (`make<Name>(crypto.randomUUID())`) and pass it in.
3. **`changes`.** Add `changes f1, f2` to every command that changes a field common to its source and target states
   (or any field of an aggregate without states). Without it, the generated decision does not let the command set the
   field.
4. **Optionally `requires`.** A check that returns an error before anything changes can become
   `requires name { expr } else Error`; the generated `check<Command><Aggregate>Requires` and the contract tests then
   check it.
5. **Reserved names (M011).** `decide`, `Decide`, `Shape`, `NoChanges`, `outcome`, `eventList`, `NoEvents`, `Outcome`,
   `EventOf`, `sameOptional`, `sameList` and `distinct` are runtime names, and `<Command><Aggregate>Decision`,
   `<Aggregate>Shape` are generated: rename elements whose names clash. Run `dt check` until it exits 0.
6. **Regenerate and rewrite every command with `decide`.** Return the outcome's `set` (the fields in `changes` and the
   target state's new fields; a factory sets every field, optional ones as `undefined`) and its `events`, keyed by the
   target state (by the aggregate's name without states). One handler per source state, also with one source; a
   factory is a single function:

   ```ts
   // before (0.3.0)
   import { byState, ok, type Sales } from '../generated/domain/index.js';
   export const orderCommands: Sales.OrderCommands = {
       place: (customer) => {
           const order: Sales.DraftOrder = { state: 'Draft', id: crypto.randomUUID() as Sales.OrderId, items: [], customer };
           return ok([order, [{ type: 'OrderPlaced', orderId: order.id }]] as const);
       },
       confirm: (order, at) =>
           ok([{ ...order, state: 'Confirmed', confirmedAt: at }, [{ type: 'OrderConfirmed', orderId: order.id, confirmedAt: at }]] as const),
       changeNote: byState<Sales.ChangeNoteOrderByState>({
           Draft: (order, note) => ok([{ ...order, note }, []] as const),
           Confirmed: (order, note) => ok([{ ...order, note }, []] as const),
       }),
   };

   // after (0.4.0)
   import { Sales, decide, ok } from '../generated/domain/index.js';
   export const orderCommands: Sales.OrderCommands = {
       place: decide<Sales.PlaceOrderDecision>(Sales.OrderShape, (id, customer) =>
           ok({ Draft: { set: { id, items: [], customer, note: undefined }, events: { OrderPlaced: { type: 'OrderPlaced', orderId: id } } } }),
       ),
       confirm: decide<Sales.ConfirmOrderDecision>(Sales.OrderShape, {
           Draft: (order, at) =>
               ok({ Confirmed: { set: { confirmedAt: at }, events: { OrderConfirmed: { type: 'OrderConfirmed', orderId: order.id, confirmedAt: at } } } }),
       }),
       changeNote: decide<Sales.ChangeNoteOrderDecision>(Sales.OrderShape, {
           Draft: (order, note) => ok({ Draft: { set: { note }, events: {} } }), // with `emits NoteChanged?`, give it when the note changes
           Confirmed: (order, note) => ok({ Confirmed: { set: { note }, events: {} } }),
       }),
   };
   ```

7. **Callers** read the keyed result: `result.value.Confirmed.aggregate` / `.events.OrderConfirmed`, or, in code that
   handles any command, `outcome(result.value)` → `{ to, aggregate, events }` and `eventList(events)`.
8. Type-check (`tsc --noEmit`). When the contract and the implementation disagree — an event that cannot always be
   emitted, a field that must change — change the DSL (`X?`, `changes`), not the implementation.
9. Optionally enable the contract tests (`generate.ts.tests`, `dt guide tests`) and run `dt fmt` once.

## [0.3.0] - 2026-10-19

### Added

- Handlers per source state: a command whose targets depend on its source state also gets
  `<Command><Aggregate>ByState`, implemented with `byState({...})` from the runtime (ADR 0015).
- The State View draws one edge per transition, and the inspector shows a row per transition.

### Changed

- **Commands list their transitions** instead of `from … to …` (ADR 0014): `Draft -> Confirmed`,
  `Draft | Confirmed -> Cancelled`, `Draft -> Draft, Confirmed -> Confirmed`; a factory has one transition without
  sources, `-> Draft`. A state is the source of one transition per command (M006). `from` and `to` are no longer
  keywords.
- The generated contract of a command whose targets depend on its source state is generic over the input state, so a
  `Draft` gives a `Draft` and a `Confirmed` a `Confirmed`.

### Fixed

- The `bin` paths of the package are written so that `npm publish` does not warn about them.

### Upgrading

1. Rewrite each command's `from … to …` as transitions:

   ```dt
   // before (0.2.0)
   create command place(customer: CustomerId) to Draft
   command confirm(at: Timestamp) from Draft to Confirmed emits OrderConfirmed
   command changeNote(note: String?) from Draft | Confirmed to Draft | Confirmed
   // after (0.3.0)
   create command place(customer: CustomerId) -> Draft
   command confirm(at: Timestamp) Draft -> Confirmed emits OrderConfirmed
   command changeNote(note: String?) Draft -> Draft, Confirmed -> Confirmed // say which source goes where
   ```

   `from A | B to C | D` becomes `A | B -> C | D` when every source may end in every target; prefer the precise
   transitions.
2. Run `dt check`, then `dt generate ts`. A command whose targets depend on its source state has a generic contract:
   implement it with `byState<Ctx.<Command><Aggregate>ByState>({ Draft: (…) => …, Confirmed: (…) => … })` instead of
   a type assertion.

## [0.2.0] - 2026-10-18

### Added

- **Field sets** (`dt guide field-sets`, ADR 0013): `fields Name { ... }` declares plain fields that aggregates,
  entities and events take on with `with A, B` (M016). Shared contexts may hold them. They generate an interface that
  the elements extend.
- Generated unions per context: `DomainEvent` (every event), `Aggregate` (every aggregate) and `<Aggregate>Event` (the
  events an aggregate's commands emit).
- M017 (warning): an event emitted by an aggregate's command has no field of that aggregate's ID type.
- The guide explains domain vs technical fields, and attaching technical metadata with envelopes.
- Live View: a filter bar in the catalog (text, kinds, contexts); field sets in the explorer, catalog, inspector and
  structure diagram.

### Changed

- Live View: catalog cards put the badges above the heading and the label over the name; the catalog's section links
  are gone (the filter finds a section).

### Upgrading

1. M011: `DomainEvent`, `Aggregate` and `<Aggregate>Event` are generated names now. Rename an element of a context
   whose name clashes with them, then run `dt check`.
2. `fields` and `with` are keywords; they are still allowed as field and parameter names.
3. Address the new M017 warnings by adding the aggregate's ID to its events (`orderId: OrderId`).

## [0.1.0] - 2026-10-18

The first published version.

### Added

- The DomainTrail DSL: bounded contexts, aggregates with states, entities, value objects, IDs, domain primitives,
  enums, unions, commands (`from … to …`), events (`persistent`), errors, shared contexts, labels and descriptions,
  and invariant expressions; rules M001–M015 and L001–L003.
- The `dt` CLI (also installed as `domaintrail`), on Node.js 22.12 or later: `dt check`, `dt generate ts` (TypeScript
  types and command contracts, one output directory per context with `generate.ts.contexts`), `dt view` and
  `dt guide`.
- `domaintrail.jsonc` (`sources`, `generate.ts`, `view`) with its JSON Schema in `schema/domaintrail.schema.json`.
- The Live View (`dt view`): the context map, the structure diagram (three levels), the catalog, the state diagram,
  the inspector with the source, problems and changes, updated on every save; in Japanese or English, light or dark.

[0.10.0]: https://github.com/hisamekms/domaintrail/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/hisamekms/domaintrail/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/hisamekms/domaintrail/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/hisamekms/domaintrail/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/hisamekms/domaintrail/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/hisamekms/domaintrail/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/hisamekms/domaintrail/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/hisamekms/domaintrail/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/hisamekms/domaintrail/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hisamekms/domaintrail/compare/b9f56885cde82f404bbf6b558f43b8ecb6254dfe...v0.2.0
[0.1.0]: https://github.com/hisamekms/domaintrail/tree/b9f56885cde82f404bbf6b558f43b8ecb6254dfe
