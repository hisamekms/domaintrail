# Plan: knowledge taken from sessions, kept in a store, read from the stickies

The decisions are in [ADR 0031](../adr/0031-knowledge.md). This plan orders the work. It is a first cut, to be refined
when the work starts; the tasks are sized for one worker each.

## Landing

- One integration branch (`feat/knowledge`) from `main`, one worktree and branch per task, merged into it after
  review, one pull request to `main`, squash merged, as for the earlier plans.
- The `files` adapter comes first, so everything above the port can be built and tried without Cloudflare. The
  `cloudflare` adapter and the Worker come after.
- Every task leaves typecheck, lint, fmt, tests and build passing.

## Tasks

| # | Task | Depends on |
|---|---|---|
| K1 | The knowledge context: the item, its labels, `about`, sources, versions, conflicts; the operations (add, addSource, update, conflict, correct, delete) as pure decisions; the `KnowledgeStore` port | — |
| K2 | The `files` adapter (`knowledge/*.md`, front matter, images); `dt check` reports `about` that names no sticky | K1 |
| K3 | The `knowledge` config section (`store`, `project`, `url`) | K1 |
| K4 | The extractor role: its job on the agent API, prompt, structured reply of operations; the timing (30 s quiet, after an answer, session end, at most once a minute); the guards (held update/conflict, in-place rewrite of this session's items); the extraction checkpoint in the session database; measuring the cost per extraction | K1, K3 |
| K4b | The three stages before the extractor (mechanical, a light model through Claude Code, the extractor; each stage's outcome and cost recorded); extraction off unless `knowledge.extraction.enabled`, switched per session by the facilitator (`POST /api/session/extraction`, kept in the session database, `knowledge.extraction` to the pages); held update/conflict dropped at the session's end | K4 |
| K5 | The Live View: the dot and conflict mark, the panel list (newest first, switchable), opening an item, the ナレッジ tab with search and filters, highlighting; correcting and deleting with undo; conflicts → ホットスポットにする; redaction of source messages after deleting | K2, K4 |
| K6 | `dt mcp`: `knowledge_for_element` (with `.dt` → stickies), `knowledge_search`, `knowledge_get` | K2 |
| K7 | The Worker template: D1 schema and migrations, R2, the HTTP API of ADR 0031 section 8, `authorize()` allowing everyone, `visibility`, the audit log; the `cloudflare` adapter in dt | K1 |
| K8 | `dt publish` and the read-only page on the Worker (the Live View's canvas and panel, read-only; the date of the drawing; items about missing stickies) | K5, K7 |
| K9 | Docs: the guide's section on knowledge, the Worker's deploy and upgrade runbook, the changelog (en/ja) | all |

## Trying it in dmcore-prototype

After K5 and K6, with the `files` adapter: move the findings of `domain/README.md` into items by hand, run a session,
and check whether the items answer "why" without decision records or summaries (ADR 0031 section 1). After K7 and K8,
switch dmcore-prototype to `cloudflare`, with `dt publish` in its CI on `main`.
