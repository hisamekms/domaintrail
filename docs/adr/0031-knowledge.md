# ADR 0031: Knowledge — what a project learns in its sessions, kept apart from the model and read from the stickies

- Status: accepted (2026-11-06), implemented per [the plan](../plans/knowledge.md); retiring (section 12) added
  2026-11-07. The decisions below were taken by
  the maintainer in a design discussion and while trying the implementation (marked *Decided by the maintainer*);
  those marked *Proposed* fill in what was left open.
- Date: 2026-11-05
- Input: the design discussion of 2026-11-05 (held from the dmcore-prototype workspace, the first user), with two
  previews the maintainer answered in: the store's API and MCP, and the Live View. The plan is
  [docs/plans/knowledge.md](../plans/knowledge.md).
- Builds on: [ADR 0024](0024-event-storming-dsl.md) (`.dtes`), [ADR 0026](0026-collaboration-sessions.md)
  (sessions, Access), [ADR 0030](0030-modes-triage-and-the-warm-agent.md) (the answerer).

## Context

A storming says what happens; it does not say why, how often, who said so, or what the AI found when asked. During a
session that knowledge is spoken or asked about, and today it ends up in two places, neither of them durable:

- the chat and the answerer's answers live in `.domaintrail/session/session.db` on the facilitator's machine. Other
  people, later sessions and the Claude Code that implements the model never see them;
- what someone writes down by hand goes into a README. dmcore-prototype keeps twelve numbered findings in
  `domain/README.md`, joined to the model only by prose.

The `.dtes` has two places for text, and neither fits. A `///` description says what one element is, in a sentence.
A `hotspot` is an open or resolved question about at most one event. Knowledge is long, has images, concerns several
stickies of any kind, comes with a date and a source, and grows faster than the model.

The problem the maintainer named first: **some months later nobody can tell why the model is the way it is**, and
what the AI was asked to investigate is lost.

## Decision

### 1. The storming and the knowledge have different jobs

*Decided by the maintainer.*

| | Storming (`.dtes`) | Knowledge |
|---|---|---|
| What it holds | how the business flows: what happens, who does what, what reacts | what lies behind it: why, how concretely, who said it, what was found |
| Size | one short label per sticky | long, with numbers, exceptions, photos |
| Truth | the current agreement only; rewritten when it changes (history in git) | dated: what was said stays said, even when later overturned |
| Checked | yes (references, types, the link to `.dt`) | only that its references exist |
| Written by | the AI tidies, people correct | taken from what people say and what the AI answers |

The test for a piece of text: **if it were deleted, would the drawing change?** If so it belongs in the storming. If
the drawing stays the same, but reading or changing it correctly needs the text, it is knowledge.

Not built, as a trial: separate **decision records** (decisions are knowledge of the kind 決定), and **summaries** kept
in git. Either is added if the trial shows that knowledge items alone do not answer "why".

### 2. A knowledge item

*Decided by the maintainer*, the field names *Proposed*.

One item holds one finding. It has:

- `text` (Markdown; images by reference, `![…](image:img_…)`);
- four independent label axes, so that combinations stay expressible ("a pain expected in the TO-BE"):

  | Axis | Values | Required |
  |---|---|---|
  | `when` | `as_is` (AS-IS) / `to_be` (TO-BE) / none | yes (none allowed) |
  | `kind` | `rule` ルール / `flow` 流れ / `example` 例 / `term` 言葉 / `pain` 困りごと / `want` 要望 / `decision` 決定 | yes |
  | `origin` | `said` 発言 (one person, not confirmed) / `agreed` 合意 (several people present agreed) / `investigated` 調査 (the AI checked code or documents) / `inferred` 推測 (the AI's hypothesis, said by nobody) | yes |
  | `perspective` | a role (案件担当, 営業, 外注先 …), never a person's name | no |

- `about`: zero or more stickies, by `<Storming>.<LocalId>` (labels can be renamed in place without breaking it);
- `sources`: the session, message ID, time and **a short quote** of each message it came from. The session database
  stays on one machine, so the quote is what lets a reader check the AI's wording;
- `version`, with the earlier versions kept; `conflictsWith`: the items it contradicts.

A `term` is about the words of the business. The `.dt` `terms` keep defining the model's terms; the two are not
merged.

- *Decided by the maintainer* (after trying it): an item has a required **title**, one short line (the extractor
  writes it; a person corrects it), versioned with the text. A closed item shows its title and its labels' line only;
  an opened one shows the title and the text as Markdown. Items without a title (from before) are not read: the
  feature is still in development.

### 3. Taken from the chat automatically, deleted afterwards

*Decided by the maintainer.*

- The dt process that runs the session (`dt collab`, `dt open`) extracts knowledge **soon after the talk**: when 30
  seconds pass without a message after a person's message, right after the answerer replies, and when the session ends;
  at most once a minute. *Decided by the maintainer*: knowledge should show during the session, not minutes later. The
  input is the messages since the last extraction (people's messages and the AI's answers alike), with the talk just
  before them (about ten minutes) and the items made in this session as context. Later, the meeting transcript of
  [the listening plan](../plans/listening.md) is one more input to the same extraction. All numbers are settings.
- *Decided by the maintainer*: an extraction goes through **three stages**, like the triage of ADR 0030, so that the
  stronger model runs only when there is something to extract:
  1. **Mechanical**: at the times above, go on only if there are new people's messages or the AI finished work (an
     answer or a run) since the last extraction; messages that are surely nothing (empty, emoji only, fixed
     acknowledgements, the triage's list) do not count.
  2. **A light model** (Haiku by default, through Claude Code): given the new messages, the talk just before and the
     stickies' names (not the items), it answers whether there is a finding and in which messages. Unsure counts as
     yes; it stops the cascade only when sure.
  3. **The extractor** (the stronger model) extracts as described here, the messages the light model named first.
  Every extraction records each stage's outcome and cost, so that the light model's misses can be checked.
- *Decided by the maintainer*: extraction is **off unless enabled**: `knowledge.extraction.enabled` in the config gives
  the default, and the facilitator can switch it for the session in the Live View.
- Extracting this often must not jump to conclusions from a remark in mid-talk. *Decided by the maintainer*:
  - **add** and **addSource** apply at once: a wrong item costs a deletion.
  - **update** and **conflict** are held, unseen, and apply only when the next extraction, after the talk has moved
    on, makes the same call, or when the topic has been quiet for about two minutes; otherwise they are dropped.
    Those still held when the session ends are dropped (*decided by the maintainer*).
  - An item made in this session is rewritten in place, without a new version, until the session ends; versions are
    kept only for items from earlier sessions. *Amended by the maintainer* (after trying it): an update must carry
    the message(s) it rests on as new sources (an update without one is dropped), and an update that adds a source
    makes a new version even in the session that made the item, so that a correction ("14 days" → "30 days") can be
    followed from the item to the message; only a rewording that adds no source is rewritten in place.
  - A correction within the same stretch of talk is an update, not a conflict. A conflict needs both sides stated
    firmly at different times (another session, or well earlier), each with its source.
  - Questions, "maybe" and tentative ideas are not extracted, or get `origin` `inferred`. `agreed` is given only when
    the talk moved on without objection.
- **Nobody decides item by item what to keep.** Everything extracted is kept; what is wrong or unwanted is deleted
  afterwards. Items carry no "confirmed" mark: an item records what was said or found at a time. `origin` tells how far
  to trust it.
- *Decided by the maintainer* (after trying it: people seldom point at a sticky, so items had no `about`): both models
  are also given the workspace's stickies — those of the storming the facilitator's page has open (else one any page
  has open) and of the session's current journey; when neither is known, every storming's; at most a few hundred
  (300), stormings taken whole in that order. The extractor chooses `about` among them by meaning, preferring the
  stickies the talk points at; the list goes in the system prompt after the instructions, so that the prompt cache
  keeps it. The items given are those made in this session, those about the stickies pointed at, and those about the
  stickies the new messages name by label, bounded.
- The extraction compares with the existing items about the same stickies and decides, per finding, one of:
  **add**, **addSource** (the same finding again: one more source, and `said` may become `agreed`), **update** (more
  precise: a new version) or **conflict** (both kept, linked by `conflictsWith`).
- *Decided by the maintainer*: the extraction is a job of a third, read-only agent role beside the answerer and the
  runner of ADR 0030, the **extractor**. It has no file tools; its prompt holds the messages and the existing items, and
  it replies with the operations above. Its jobs come from an entry point of their own on the agent API and run in
  parallel with answers and runs; one extraction per session at a time. Making the answerer do it was rejected: answers
  would wait behind extractions, and the answerer's warm conversation would fill with extraction context. Calling
  Anthropic's API from dt directly was rejected: it needs an API key besides Claude Code's.
- The label axes and kinds of section 2 are fixed for now (not extendable by configuration), so that the extractor's
  prompt and the filters stay the same everywhere; they are revisited after the trial in dmcore-prototype.

### 4. Hotspots

*Decided by the maintainer.*

- A conflict is shown on the sticky and in the panel, both items side by side. People decide there whether it becomes
  a hotspot ("ホットスポットにする" sends a request to the runner) or is not a conflict.
- *Decided by the maintainer*: a conflict made a hotspot is handed over to it. While the request runs, the box shows
  that it is being made, kept in the session database. When the run ends, dt finds the hotspot the run added from the
  storming's diff before and after it; both items then get the hotspot in `about` and their conflict is unlinked, with
  the hotspot as the reason in the audit log. The box and the mark go; the hotspot's sticky lists the two items. If the
  run declines or fails, or added no hotspot or more than one, the box gets its two buttons back.
- *Decided by the maintainer* (after trying it): the hotspot is the one the run added, else the existing one it
  changed, else the one its reply names (the request asks the runner to reuse a hotspot that already asks the
  question, and to name it); exactly one candidate is handed over, otherwise the box gets its buttons back with a short
  reason. On the original sticky, the items that are also about one hotspot stay together in a calm box (not the
  conflict's red one) with a link to the hotspot instead of the buttons; this is derived from `about`, not stored.
- When a hotspot is resolved, its resolution is also kept as an item of kind `decision`. Whether the resolved hotspot
  stays in the `.dtes` follows ADR 0024 (only the important ones stay).

### 5. A store port, two adapters

*Decided by the maintainer.*

- `KnowledgeStore` is a port of dt. Only dt talks to it. The Live View and Claude Code go through dt, because only dt
  reads the workspace's `.dtes` and `.dt` and can turn a `.dt` element into the stickies that `ref` it.
- **`files`**: one Markdown file per item in the workspace's `knowledge/` (front matter: labels, `about`, sources;
  images in `knowledge/images/`), versions and audit left to git. The default, for those with no personal data to
  protect and for trying it out.
- **`cloudflare`**: a Worker with D1 (items, versions, sources, audit) and R2 (images), behind Cloudflare Access.
  DomainTrail ships it as a **template the user deploys**: as for sessions, dt creates nothing in Cloudflare.

### 6. Projects, workspaces and members

*Decided by the maintainer.*

- The shared unit that holds knowledge and members is a **project** (プロジェクト). A **workspace** stays the local
  root with `domaintrail.jsonc`. A workspace names its project in `knowledge.project`, so every clone and worktree of
  one repository reads and writes the same knowledge.
- Words on the pages: プロジェクト, ユーザー, グループ, メンバー; a person in a session right now stays a 参加者. In the
  API and data: `project`, `user`, `group`, `member`. ("Project" may collide with a modelled domain's own `Project`, as in
  dmcore-prototype; accepted.)
- Today every project is open to whoever passes Access. Prepared, not built:
  - members are users or groups attached to a project directly, groups defined in the store;
  - one `authorize(user, project, action)` that today allows everyone;
  - `visibility: "open" | "members"` on the project, switched explicitly. Adding a member does not narrow anything by
    itself;
  - when a project is narrowed, joining its sessions must be narrowed the same way. The AI reads knowledge and answers
    every participant, so a non-member in the session would read it through the AI.
- The audit log records the person (the Access e-mail) from now on.

### 7. Personal data and deletion

*Decided by the maintainer.*

- What must be protected is **personal data, which must be deletable on request**. Keeping knowledge on GitHub, showing
  it to developers or to every participant, and sending it to Anthropic's API are all acceptable. This is what rules
  out git as the store when personal data may appear: it cannot be deleted from git's history.
- Anyone who can open the project may correct and delete, in the Live View and on the Worker's read-only page alike.
- Deleting hides the item from everyone at once; the page offers 元に戻す for 10 seconds. The store's own sweep, every
  few minutes, then deletes every version and image of the item, so a deletion completes even when the page that made
  it is closed. Personal data stays for minutes at most.
- **Redaction of the source messages**: the sweep appends their IDs to the project's **redaction log**. Every dt of the
  project reads the log from where it left off, when it starts and during a session, and redacts the messages its own
  session database holds. Old sessions live on several machines, and the facilitator's dt may not be running when an
  item is deleted (from the Worker's page, for instance); the log reaches them all. It holds IDs only, so it is kept
  for good.
- D1's Time Travel keeps up to 30 days of history; that is accepted.

### 8. The store's HTTP API

*Decided by the maintainer* (its shape from the preview), details *Proposed*. Under `/v1/projects/:project`:

| Method and path | Used by | Does |
|---|---|---|
| `GET /knowledge` | dt | filter by `about`, `when`, `kind`, `origin`, `perspective`, `q` (full text), `session`; newest first, cursor |
| `GET /knowledge/:id` | dt | the latest version; `?history=1` adds the earlier ones |
| `GET /counts?storming=` | dt | per sticky: whether it has items, and its conflicts |
| `POST /extractions` | dt (extraction) | one extraction's operations, applied in one D1 batch; `Idempotency-Key` = session and extraction number |
| `PATCH /knowledge/:id` | dt (a person) | correct text, labels or `about`; a new version |
| `DELETE /knowledge/:id`, `DELETE /knowledge?session=` | dt (a person) | delete everything of the item (or of a session's items); returns the source message IDs |
| `POST /images` | dt | an image into R2 |
| `GET /audit` | dt | who changed or deleted what |
| `GET /redactions?after=` | dt | the redaction log from a cursor (section 7) |
| `POST /knowledge/:id/images` | dt (a person) | attach an image to an item (section 10) |
| `PUT /published/:storming` | `dt publish` | the published storming (section 11) |
| `DELETE /published/:storming` | `dt publish --prune` | removes a storming no longer in the workspace (section 11) |
| `POST /knowledge/:id/retire`, `POST /knowledge/:id/unretire` | dt (a person) | retire an item, or undo it (section 12) |
| `GET /proposals`, `POST /proposals` | dt | the proposals to retire waiting for a person; a review's proposal (section 12) |
| `POST /proposals/:id/approve`, `POST /proposals/:id/dismiss` | dt (a person) | decide a proposal (section 12) |

- **Extractions are sent as operations, not as resulting states.** An extraction takes a while. If a person deletes or
  corrects an item meanwhile, an operation on it is dropped and the person's change stands. Sending states would bring a
  deleted item, with its personal data, back. The operations and their reasons also stay in the audit log, which
  answers "why did this item change".
- Auth: Access service tokens, one for writing (the session's dt) and one for reading (MCP); a person's actions carry
  the participant's identity as `actor`.

### 9. MCP for Claude Code

*Decided by the maintainer.*

- `dt mcp`, a local stdio server over the same port, so it works with `files` too. **Read-only for now.**
- `knowledge_for_element({ element })`: a sticky (`Ordering.CreateSpecification`) or a `.dt` element
  (`dt:WorkProcess.WorkProcessSpecification.create`, resolved through the stickies that `ref` it). Returns the items
  as short text, with labels, date and ID. The tool to call before implementing.
- `knowledge_search({ query, about, when, kind, origin, perspective, limit })`, `knowledge_get({ id, history })`.

### 10. The Live View

*Decided by the maintainer* from the preview.

- A sticky with knowledge gets **a dot**, and **a mark** when it has a conflict; no count.
- Selecting a sticky lists its items in the side panel, **newest first by default, switchable to the order of kinds**.
  An item opens to its quotes, the other stickies it concerns (links), its versions, and 直す / 消す.
- A ナレッジ tab lists every item, with search and filters by `when`, `kind` and `origin`. Opening an item highlights
  its stickies on the canvas.
- Conflicts: side by side in the panel, with ホットスポットにする and 食い違いではない.
- Images: a person attaches them to an opened item (画像を付ける). *Decided by the maintainer*: images in the chat, and
  the extractor attaching them, come later with the listening plan.
- Deleting: at once, with 元に戻す for 10 seconds (section 7).

### 11. Reading outside a session: a page on the Worker, and `dt publish`

*Decided by the maintainer.*

- People from the business read knowledge at any time, **with the canvas**, on a read-only page served by the store's
  Worker behind the same Access.
- The Worker cannot read the repository. `dt publish` sends each storming's published form (stickies, links, layout,
  with a version), run **by CI when `main` changes**: readers see the drawing that was agreed and merged. The page reuses
  the Live View's canvas and panel in a read-only mode, shows the date of the drawing, and lists items about stickies
  missing from it apart.
- The drawing is assumed to hold no personal data (stickies carry the business's words only).

### 12. Retiring an item

*Decided by the maintainer* (2026-11-07), after trying knowledge in sessions: findings get overturned — a decision
replaces a rule, the way of working changes, an item turns out wrong — and an item that no longer holds misleads the
AI that reads it, while deleting it loses the record of what was said, which section 1 keeps on purpose.

- **Retiring is not deleting.** A retired item (廃止) keeps its text, sources and versions. Deleting (section 7) stays
  what it is: for personal data, every version gone and the source messages redacted. The two are separate: a
  retired item may still be deleted.
- **A person retires.** Anyone who can open the project retires an item (廃止する) or undoes it (廃止を取り消す), in the
  Live View and on the Worker's page, recorded in the audit log. Retiring shows 元に戻す for a few seconds, as deleting
  does.
- **Why, optionally.** One of three reasons, or none: replaced (置き換わった, with a link to the newer item),
  no longer holds (当てはまらなくなった), wrong (誤り).
- **The AI proposes, a person decides.** The extractor (an operation of its extraction) and the review of a run (a
  call of the store) propose to retire an item; the proposals wait in the knowledge list (廃止の候補 n, the count also
  on the list's icon), not in the chat, and anyone in the session approves or dismisses each one, recorded in the
  audit log. A proposal of the AI always has its reason and its evidence: which decision, which change of a sticky,
  which message.
- **A dismissal is remembered.** The same reason about the same item is not proposed again unless the evidence changed
  (a new decision, another sticky, another message).
- **Kept from the AI.** The answerer, the runner and the review are never given a retired item. Only the extractor is
  told of the retired items, by title and reason, so as not to make them again; it does not rest anything on their
  text. When it finds the topic of a retired item brought up anew, it proposes to undo the retirement instead of
  making the item again.
- **AS-IS stays AS-IS.** An AS-IS item is not proposed for retirement because the TO-BE stickies differ: the
  extractor's and the review's instructions say so, and the store refuses a proposal whose evidence is only the TO-BE
  (changes of stickies, TO-BE decisions).
- **Seen on request.** The knowledge list hides the retired items by default; 廃止も表示 shows them, faded, with their
  reason and a link to what replaced them. They give a sticky no dot (its link to the sticky stays, as history). The
  Worker's page hides them too, and `dt mcp`'s tools leave them out unless asked (`include_retired`).
- **Both stores.** The `files` store keeps the retirement in the item's front matter and the proposals in
  `knowledge/proposals/`; the Worker adds them with a migration, which users apply when they deploy the new template.

*Proposed*, the details: the retirement is a field of the item, not a state (a retired item is read, corrected and
deleted like a live one); a proposal is an aggregate of its own (open, approved, dismissed), its ID derived from what
it proposes (SHA-256), so that a retry is answered with the proposal made the first time and another proposal never
overwrites it. The audit record of a proposal holds its action and ID only: its explanation and evidence may quote
someone, and the sweep removes them with the item. An extraction's operation on a retired item is dropped (the
extractor was not given it).

## Alternatives considered

- **Knowledge inside the `.dtes`** (a `note` element with `about`, the text in `///`). Checked like the rest, but the
  volume and the images do not fit a DSL file. Rejected by the maintainer.
- **Markdown files in git as the only store.** Reviewable and read by Claude Code directly, but personal data could not
  be deleted from history. Kept as the `files` adapter.
- **The session's SQLite as the store.** On one machine only: no later reader, no Claude Code, no business reader.
- **A SaaS (Notion and the like).** Good for reading and images, but the references to stickies cannot be checked.
- **People choose what to keep** (a 残す button). Rejected: the maintainer does not want a decision per item; deletion
  afterwards suffices.
- **Decision records** beside knowledge, and **summaries** in git: postponed (section 1).
- **A project layer above workspaces, members on the project**, and **Access applications per path**: the first was
  replaced by naming the shared unit "project" with members on it directly. The second cannot see who reads through
  dt's service token.
- **Names for the shared unit**: ワークスペース reads as a whole company's container (Slack, Notion), and ドメイン
  collides with domain names and a code base's domain layer.
- **Sending resulting states**, and **an MCP server on the Worker**: see sections 8 and 9.
- **Extraction at pauses of minutes**: too late for the session. **Two stages** (a fast, cheap extraction that only
  adds, and a consolidation at pauses): faster and cheaper, but two jobs for the extractor and duplicates for a while.
  The maintainer chose one stage, run often, with the guards of section 3.
- **Keywords instead of a light model** for deciding whether to extract: cheaper, but a finding phrased otherwise
  waits or is missed. The maintainer chose a light model after the mechanical stage (section 3).

## Consequences

- A new context for knowledge (the items, their operations, the port), and a third agent role (the extractor).
- dt gains `dt mcp` and `dt publish`, a `knowledge` config section, and redaction in the session database.
- DomainTrail ships and versions a Worker template (D1 schema and migrations, R2, the read-only page), which users
  deploy and upgrade.
- The answerer and the runner read knowledge through the same read-only tools as `dt mcp` (*Decided by the
  maintainer*): an answer about "why", and a change of the model, can rest on it. What they read is shown to every
  participant (section 6).

## Open questions

- The extractor's prompt and its cost per extraction, when the stronger model runs: measured in the
  plan's task K4, with the input limited to the items of the stickies in the talk and the stable part kept in the
  prompt cache. The light model's rate of misses, from the recorded outcomes.
