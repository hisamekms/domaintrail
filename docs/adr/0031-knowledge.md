# ADR 0031: Knowledge — what a project learns in its sessions, kept apart from the model and read from the stickies

- Status: proposed (2026-11-05). The decisions below were taken by the maintainer in one design discussion (marked
  *Decided by the maintainer*); those marked *Proposed* fill in what the discussion left open. Nothing is implemented.
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
