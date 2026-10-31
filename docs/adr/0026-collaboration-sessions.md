# ADR 0026: Collaboration sessions (`dt session`) — M1

- Status: accepted, implemented (S1–S9 on `feat/session`). Decided by the maintainer: persistence on `node:sqlite` (Node ≥ 22.13), the agent's tools chosen
  by the facilitator in configuration, Cloudflare Access verified against mocks with the real end-to-end check done by
  a person from a runbook, and one integration branch with one pull request (marked *Decided by the maintainer*).
- Date: 2026-10-31
- Input: "DomainTrail M1 — Collaboration 実装計画書", written against `main` at `5ad296e` before the M0 refactoring
  (ADR 0025). Its paths and interfaces are reconciled here with the code as it is after M0 (#21); the plan stays the
  reference for goals, scope, the concepts and the test matrix.

## Context

A facilitator runs `dt session start` on their machine. Authenticated participants open the same Live View in a
browser, see each other, and send requests about elements of the `.dt` model or the `.dtes` stormings. The facilitator
bundles requests into agent runs; a local subscriber runs Claude Code on the workspace; the edits reach every browser
through the existing Live View; every run leaves a revision of the whole workspace that can be marked confirmed or
restored. `.dt` and `.dtes` are first-class from the start. `dt view` stays as it is.

## What the plan assumed, and what the code is after M0

| Plan | Code | Consequence |
|---|---|---|
| `src/server/session.ts`, `protocol.ts`, `src/cli/main.ts`, `web/storming.tsx` | `packages/visualization` (`createViewService`, `protocol.ts`), `packages/presentation` (`cli`, `http`, `websocket`, `lsp`), `packages/composition` (`startViewServer`, `cliDeps`), `web/app` (`AppShell` with a `sidePanel` slot) | Session is a new package plus composition/presentation additions at the extension points of ADR 0025. |
| "Session" for the collaboration | `ViewServer.view` (renamed from `session` in M0) | No name clash. |
| Occurrence targets on any canvas | The integrated canvas draws **one note per event** (spec §8.5); occurrences are drawn only in a timeline's view (`t:` render nodes). | `dtes-occurrence` targets and occurrence-precise presence exist only in a timeline view; on the integrated canvas a click targets the event definition. |
| SQLite | The CLI runs on Node (`dist/dt.js`, engines `>=22.12.0`); tests run on Bun. | `node:sqlite` works on both (checked). Engines become `>=22.13.0` (unflagged `node:sqlite`). *Decided by the maintainer.* |
| `Result` like the generated runtime | The generated `_runtime.ts` has `Result`/`ok`/`err`; `generate ts` writes per-context modules. | The collaboration contracts are a `.dt` model whose generated code is committed and checked in CI. |
| Agent permissions | — | The facilitator chooses the allowed tools in the session config; the default is read/edit/write/glob/grep plus `dt fmt` and `dt check`, nothing else. *Decided by the maintainer.* |

## Decision

### Packages

| Package | Holds | Depends on |
|---|---|---|
| `packages/collaboration` | `model/*.dt` (Session, Request, AgentRun, Revision) and its committed generated contracts (`src/generated`); `domain/` (pure decisions over the generated types: ADT states, transitions, run success rule, target staleness); `application/` (use cases and ports: `SessionRepository`, `RequestRepository`, `RunQueue`, `RevisionStore`, `WorkspaceSnapshot`, `SnapshotBlobs`, `ModelValidator`, `IdentityProvider`, `Clock`, `IdGenerator`, `EventOutbox`, `UnitOfWork`); `infrastructure/` (`node:sqlite` schema, migrations, transactions, outbox, queue/lease; the snapshot blobs; the validator; the Access/JWT identity adapter and the dev identity); `protocol.ts` (browser and agent messages) | modeling, visualization (types) |
| workspace | + `infrastructure/snapshot.ts`: the `WorkspaceSnapshot` port of collaboration, implemented structurally (ADR 0025: writes to the sources are a port on the consumer's side, implemented in workspace) | modeling (unchanged) |
| `packages/agent` | `dt session subscribe`: `application/` (the subscriber loop and the run pipeline over the ports `AgentApi`, `AgentRunner`, `DslTools`, `WorkspaceFiles`, `Clock`; the prompt), `infrastructure/` (the SSE client, the Claude Code adapter (child process, no shell interpolation), `dt fmt`/`dt check`, the workspace scan) — in place since S6 | collaboration (protocol and types only) |
| presentation | session HTTP routes (`/api/session/*`), the agent API on its own loopback listener, the WS message union | + collaboration (application, protocol, generated types) — in place since S4 |
| composition | `startSessionServer` (view + session in one HTTP process), `startSubscriber`, CLI wiring | + collaboration (infrastructure; since S4), agent (since S6) |
| web | the session panel in `AppShell`'s `sidePanel`, drafts in IndexedDB, presence overlay | + collaboration (protocol, types) — in place since S4 (`useViewSocket`) |

The architecture test gets both packages, the graph above and the layer rules (`domain` pure, `application` without
I/O; only composition imports infrastructure).

### Concepts (from the plan, adjusted)

- **ModelTarget**: `workspace` | `dt-element { elementId }` | `dtes-element { stormingId, localId }` |
  `dtes-occurrence { stormingId, timelineId, eventId, occurrencePath }`, each with `sourceRevisionId` and the label and
  source range at creation. An occurrence is targeted only from a timeline's view. A target whose path no longer
  matches is shown as stale; never re-bound. Render-node IDs are never stored.
- **Request**: immutable once sent; drafts only in IndexedDB; dismiss is a mark.
- **AgentRun**: `queued | running | completed | needs_clarification | failed | cancelled`; many-to-many with requests;
  frozen input at queueing; base revision taken at start; serial; a run without changes gets
  `resultRevision = baseRevision`.
- **Revision**: every source of the workspace (`sources` globs, `.dt` and `.dtes`) in one snapshot by content hash,
  with paths, bytes and validation summarized per DSL (`.dt` errors; `.dtes` errors and warnings; link warnings; stale).
  `confirmedAt/By` is a mark, not a gate. Restore writes a past snapshot as a new revision after a pre-restore snapshot;
  it refuses on symlinks, paths outside the root, and external changes since the last snapshot.
- **Run success rule** (decided here, from the plan's recommendation): the agent process exits 0, `dt fmt` and `dt
  check` ran, no new `.dt` error compared with the base revision, and every `.dtes` file still parses. Pre-existing
  diagnostics and `.dtes` semantic warnings are shown as a diff to the facilitator, not a failure. `dt generate ts` is
  not a criterion.
- **Recovery** (decided in S3): a run whose lease expired is never re-queued once it started: a `Running` run fails
  with `LeaseExpired` (the agent may have edited the workspace; a second execution on a changed base would be silent),
  while a run only claimed (still `Queued`) goes back to the queue. `expireLeases` applies it at startup and
  periodically; a run with a live lease keeps it across a server restart (its subscriber may still heartbeat). A
  completion (`finish`, `askClarification`, `fail`) is keyed by run ID and lease token: the same call again returns
  the same run without recording anything, a stale token gets `LeaseLost`.
- **Presence**: ephemeral, never stored. `ViewLocation` = `{ kind: 'dt', viewKey, layoutKey }` |
  `{ kind: 'dtes', stormingId, level, timelineId?, layoutKey }`, where `layoutKey` is the laid-out graph's ID and
  signature; cursors (tldraw world coordinates, ≤ 20 Hz) are drawn only for an equal `ViewLocation`.

### Server, transport, security

- `dt session start` = the view server plus session routes, in one HTTP process bound to loopback; `dt view` exposes
  no session route or message (checked by a test).
- One access check stays the gate (`checkAccess`), widened to an authorization result carrying the participant and
  role; it guards every view and session route and the `/ws` upgrade. Without an identity no source or payload is
  served in session mode.
- The WS keeps `type: 'update'` and adds a discriminated union (`presence.*`, `session.*`, `request.*`, `run.*`,
  `revision.*`) through the hub's `encode`; messages from the page are parsed and validated in `handleUpgrade`.
- The agent API listens on a separate loopback port with its own credential; never reachable through the public
  router. SSE with resumable event IDs from the outbox; atomic claim with a lease, heartbeat, idempotent completion; a
  workspace lock and file-state comparison so a run never executes twice even across restarts.
- Identity modes are explicit in config: `dev` (loopback only, local identities) or `access` (Cloudflare Access JWT
  verified with JWKS, issuer, audience, expiry; Identity API for `name`; avatar only when fetchable; initials
  otherwise; e-mail never shown to other participants). Facilitator is assigned locally, not derived from Access.
- Limits on body size, SSE queue, WS payload and participants; no tokens or personal data in logs.

## Tasks (workers, one worktree each, merged into `feat/session` after review)

- **S1 (M1-0)**: the API map (in this ADR's appendix if it differs) and baseline tests the matrix needs that do not
  exist: `.dt` only, `.dtes` only, mixed, broken `ref`, `.dtes` syntax error, several timelines, `dt view` exposes no
  session surface.
- **S2 (M1-1a)**: the collaboration `.dt` model and its committed generated contracts, with a CI/test check that
  regenerating gives no diff; engines `>=22.13.0`.
- **S3 (M1-1b)**: domain decisions and their unit tests; `node:sqlite` persistence (schema, migrations, transactions,
  outbox, queue/lease, recovery policy) and the snapshot store (path and symlink safety, `.dt` + `.dtes` together).
- **S4 (M1-2)**: `dt session start`, session config, the authorization result in `checkAccess`, session routes and WS
  union, the agent listener and credential, dev identity, the Access adapter contract with mocks.
- **S5 (M1-3)**, after S4: the session panel, drafts, targets (`.dt` element, `.dtes` element, occurrence in a timeline
  view), presence with `ViewLocation`, facilitator bundling.
- **S6 (M1-4)**, after S4, parallel with S5: `dt session subscribe --agent claude`, SSE/claim/heartbeat/result, the
  Claude Code adapter with the configured tools, the run pipeline (pre-run snapshot, fmt/check, diagnostics diff,
  result revision, success rule), serial runs.
- **S7 (M1-5)**, after S5 and S6: revision timeline and comparison, confirm, restore (stop or wait for the agent,
  hold watcher notifications, write, validate, resume), conflict and symlink tests.
- **S8 (M1-6)**, after S4: JWT/JWKS verification, Identity API, avatar and initials, WS revocation, role checks, all
  against mocks; a runbook for the real Tunnel/Access check, which a person runs.
- **S9**: README, a guide topic for sessions, this ADR's status; the matrix of the plan §9 checked off with the test
  that covers each row.

Each task: no change to `dt view`, `.dt`/`.dtes` semantics or the published CLI's existing commands; typecheck, lint,
format check, tests and build pass.

**As run.** S1, S2, S3 and S4 one after another; then S5, S6 and S8 in parallel (each from `feat/session` after S4);
then S7 (after S5 and S6); then S9. Each was reviewed and merged into `feat/session`, which becomes one pull request
to `main`. The appendices below record what each task decided beyond this ADR.

**Security fixes after the automated reviews**, each its own commit on `feat/session`:

- S4: in a session only the facilitator changes the shared baseline (`POST /api/baseline`); a closed session
  identifies no one, whatever the identity cache holds.
- S6: Claude Code loads the user's settings only (`--setting-sources user`), so the agent cannot widen the next run's
  tools through the workspace's `.claude/`; the scan after the agent runs on every way out and fails closed; the paths
  the agent chose are escaped and cut in the log; a change outside the DSL sources stops the subscriber.
- S7: a comparison bounds its work before doing it (blob size, lines and edits per file, a character budget), so no
  participant can exhaust the server.

## Consequences

- Node 22.12 users must upgrade to 22.13 to run any `dt` command (engines).
- Two new packages and their dependencies join the bundle; `dt view` gains nothing at runtime.
- The real Cloudflare Access check is manual until a test environment exists: a person runs
  [the runbook](../session-access.md).

## Test matrix

The plan's test matrix (§9) and completion checklist (§12), each with the tests that cover it (file › test name),
checked against the tests in S9. *Manual* marks what only a person can check, with where it is written down.

| Plan §9 | Covered by |
|---|---|
| Only a `.dt` changes → the Domain view updates, the revision holds it | `session-baseline` › .dt only: the model and its graphs, no storming; `session-subscriber` › a request about a .dt element → the agent edits .dt and .dtes → the Domain view has the new event; dt fmt formatted the agent’s edit; `session-server` › any participant compares two revisions: each file by DSL with a line diff, both validations; only the facilitator takes, confirms and restores; `collaboration-use-cases` › a session starts with a revision of every source, .dt and .dtes, and its events in the outbox |
| Only a `.dtes` changes → the Storming view updates, the revision holds it | `session-baseline` › .dtes only: the stormings, over an empty model (not `empty`, which is for no source at all); `session-subscriber` › two requests about .dtes elements → one run → the agent edits the .dtes → Big Picture and Design Level change; completed with a result revision |
| A `.dt` that a `.dtes` `ref`s changes → the link diagnostic shows, both sources stay | `session-baseline` › is a link diagnostic on the .dtes; both sources and the storming stay in the payload; `collaboration-domain` › the summary splits by DSL, with the link rules apart |
| One event in two timelines → separate occurrences; cursors and requests not confused | `session-baseline` › is one e:<eventId> note on the integrated canvas, and occurrence nodes with their timelines in each timeline view; `session-page` › an event in two timelines is two occurrences: their targets and keys differ, the element is the same (S9); `session-page` › cursors only on the same view: not across timelines, levels or into the catalog; `collaboration-domain` › targets resolve by model ID, storming and local ID, and timeline, event and step path |
| Big Picture ↔ Design Level → the session goes on; no cursors across layouts | `session-page` › a storming view is its storming, level and timeline; `session-page` › cursors only on the same view: not across timelines, levels or into the catalog; `session-server` › presence: sent to the others only, validated, at most ~20 Hz per participant with the last position kept (the page stays connected as its location changes). That the session goes on is by construction: the page's session state (`useSession`) sits above the views and no view change touches it; no React test switches views. |
| `.dtes` syntax error → stale, the snapshot keeps the source, recoverable | `session-baseline` › keeps the storming as last parsed, as stale, with the broken text in the sources; fixing it recovers; `collaboration-use-cases` › a .dtes with a syntax error is kept in the revision as written, counted as a .dtes error; restoring an earlier one recovers (S9); `collaboration-domain` › a target is unknown, not stale, when the sources it would be in do not parse; `session-subscriber` › a .dtes the agent leaves broken: dt fmt skips it, the run fails with an unparsed .dtes |
| An outside change to the files during a run → detected, never overwritten silently | `collaboration-use-cases` › an external edit during or after a run is never overwritten without the two-step; the two-step keeps it as a revision; `collaboration-use-cases` › restore refuses external changes since the last revision, symbolic links, and a running run; `session-server` › saves while a run is in progress make no revision; a restore is refused until the run ends or is cancelled; `session-server` › a restore reaches every page in one publish of the view; an external edit needs the two-step, and is kept as a revision |
| Three requests in one run → one agent invocation, each request kept | `session-subscriber` › three requests in one run → one invocation of the agent with all three; each request stays as it was sent (S9); `collaboration-use-cases` › a run freezes its requests at queueing, and a request bundled twice is refused |
| The queue restarts → resumes by lease expiry and the outbox, no double commit | `collaboration-use-cases` › recovery: an expired lease fails a running run (LeaseExpired) and frees a claimed one, across a restart; `session-subscriber` › a subscriber that dies leaves its run to the lease: after a restart of the server, Running → Failed (LeaseExpired); `session-subscriber` › a broken stream is resumed with Last-Event-ID; a run whose event was missed is claimed on reconnection; `session-subscriber` › a finish whose answer is lost is sent again and replayed by the server: the run completes once; `session-server` › claim, start, heartbeat and finish over HTTP; a repeated finish is a replay; SSE resumes with Last-Event-ID; `collaboration-store` › serial: a running run blocks claims, and the store refuses a second running run or lease of a session; `collaboration-store` › the outbox is written in the transaction of the aggregates: a failure rolls both back |
| Restore → `.dt` and `.dtes` from one snapshot | `collaboration-use-cases` › restore writes .dt and .dtes together from one snapshot; the older revisions stay; the operation is logged; `session-server` › a restore over HTTP runs behind the hold and leaves the workspace as the revision was; `collaboration-node` › a session runs from start to restore with node:sqlite under node, and a second process reads it back |
| Not signed in to Access → HTTP, WS and the source API refused | `session-access` › without a valid token nothing is served: page, assets, view API, session API, WebSocket; `session-server` › serves nothing without an identity: the page is the join form, the APIs and the WebSocket answer 401; `session-server` › is not reachable through the public port, with or without an identity. *Manual* against the real Cloudflare: [the runbook](../session-access.md), "Refused without Access". |
| Not the facilitator → queue management, confirm and restore refused | `session-server` › a participant cannot reach the facilitator routes; dismisses only their own requests; `session-server` › any participant compares two revisions: each file by DSL with a line diff, both validations; only the facilitator takes, confirms and restores; `session-server` › the baseline, shared by every page, is changed by the facilitator only; the view is read by any participant; `session-access` › Access lets the user in, not into the facilitator’s role: only the local link gives it |
| Plain `dt view` → no session feature, compatible | `session-baseline` › answers /api/session and anything below it with 404; `session-baseline` › sends only type "update" over the WebSocket and ignores messages from the page; `test/__snapshots__` unchanged from `main` (`live-contract`) |

| Plan §12 | Covered by |
|---|---|
| `dt view` unchanged | The last row above. |
| The Live View of `.dt` and `.dtes` in a session | `session-server` › serves the Live View to a participant, as dt view does; the two acceptance tests of `session-subscriber` (a run from the browser to the Live View) |
| Big Picture / Design Level and the timeline filter kept | `session-subscriber` › two requests about .dtes elements → one run → the agent edits the .dtes → Big Picture and Design Level change; completed with a result revision (both levels over the WebSocket); `session-page` › a storming view is its storming, level and timeline; the views are the Live View's own, served unchanged (`session-baseline`) |
| Event definition and occurrence not confused in targets and presence | `session-page` › an occurrence only in a timeline's view: the selected note's occurrence in that timeline; `session-page` › the integrated canvas, or a selection not drawn as that note, targets the element; `session-page` › an event in two timelines is two occurrences: their targets and keys differ, the element is the same (S9); `collaboration-domain` › an inserted step makes an occurrence stale: it is never re-bound; cursors as in the matrix |
| Two or more participants with names and avatars | `session-access` › a valid token is a participant: the name and avatar from the Identity API, else the e-mail’s local part; e-mail never sent; `session-access` › presence carries the participant ID, name and avatar only; `session-access` › an avatar only when https, without credentials or port, on an allowed host; else initials (none); `session-page` › initials, and updates throttled to the latest value; `session-page` › the participants once each: the facilitator’s holder is folded into the facilitator, under its name (S9); `session-server` › the state names the participant holding the role, and every page still connected is sent it when the role changes hands (S9). *Manual*: the panel as drawn, in the runbook's "Participants" and in [a first real run](../session-first-run.md). |
| Private drafts, several sent | `session-page` › kept per session and participant, replaced on save, removed by ID; `session-page` › editing changes one draft; only selected drafts with a text are sent, each on its own |
| The facilitator bundles several requests into one run | The "three requests in one run" row; `session-subscriber`'s acceptance with two requests |
| Claude Code: serial, reconnecting, no duplicates | `session-subscriber` › three queued runs run one after another without any confirmation; heartbeats keep a lease longer than it lasts; the stream and finish rows of the matrix; `session-subscriber` › on Node (dist/dt.js): --once runs the queued run with `claude` from the PATH, and dt fmt / dt check with itself (a fake `claude`). *Manual* with the real Claude Code: [a first real run](../session-first-run.md). |
| `.dt` / `.dtes` edits reach everyone at once | Both acceptance tests of `session-subscriber` (the edit over another participant's WebSocket); `session-server` › a restore reaches every page in one publish of the view; an external edit needs the two-step, and is kept as a revision; `session-server` › aroundWrite refreshes once after a write (not after a refusal) and takes the same sources afterwards as its echo |
| Workspace history, confirm, restore | The restore rows; `session-server` › any participant compares two revisions: each file by DSL with a line diff, both validations; only the facilitator takes, confirms and restores; `session-page` › newest first, numbered in the order taken, with the runs and revisions an origin refers to; `session-page` › what a restore that did not go through asks next; `collaboration-use-cases` › a write that fails midway keeps the pre-restore revision and reports a manual recovery; the two-step recovers |
| Cloudflare Access: authentication, roles, profile, WS protection | All of `session-access` (the JWKS verifier, the Identity API and the identity, a session in access mode against a mock of Cloudflare). *Manual* against the real Cloudflare: [the runbook](../session-access.md). |
| All tests pass | CI (`.github/workflows/ci.yml`): install, build, typecheck, lint, format check and `bun test`, all passing at the end of S9. |

## Appendix: code map (S1)

Checked against `feat/session` at the start of M1. The table above and ADR 0025's extension points hold; these are the
details S4–S7 need that neither states. `test/session-baseline.test.ts` pins down the payload facts.

- **Access is applied only to known API paths.** `createViewHttpServer` (`packages/presentation/src/http/server.ts`)
  guards a request when `api.has(pathname)` (the `ApiRoutes` map of `createApiRoutes`, `http/routes.ts`) and the `/ws`
  upgrade; any other path, `/api/session/*` included, is answered 404 without the check, and the page's assets are
  served to anyone. Session routes must be entries of the routes map (or the guard widened to their prefix), and the
  widened `checkAccess` result has one caller, `admitted` in `server.ts`, next to `hostAllowList(bind)`.
- **No seam inside `startViewServer`** (`packages/composition/src/view.ts`): it builds the routes, the hub, the HTTP
  server and both watcher subscriptions inline and returns only `{ url, view, ready, stop }`. `startSessionServer`
  composes the same parts (`createApiRoutes`, `createViewHttpServer`, `createWebSocketHub`, the watchers) itself, and
  holding watcher notifications during a restore (S7) needs a hook that does not exist yet.
- **The WebSocket reads nothing from the page.** `createWebSocketHub(current)` (`websocket/hub.ts`) sends `current()`
  on connect and never listens for messages; `ServerMessage = ViewPayload`. The page's `useViewSocket`
  (`web/app/useViewSocket.ts`) casts every message to `ViewPayload` without looking at `type`: it must switch on `type`
  before the server sends anything else, or a session message replaces the view.
- **CLI.** `dt view` is `program.command('view')` in `packages/presentation/src/cli/main.ts`; it calls
  `CliDeps.startViewServer(options): Promise<{ url }>` with the CLI's own `ViewServerOptions` (`cli/ports.ts`, distinct
  from composition's `ViewServerOptions` in `view.ts`).
- **Payload status by sources** (`createViewService`, `application/view-service.ts`): `.dtes` only is `status: 'ok'`
  with an empty `DomainModel` (`elements: {}`), not `null`; `'empty'` means no source at all. A `.dt` syntax error is
  `syntax-error` with the payload `stale` (the last model kept). A `.dtes` syntax error leaves the payload `stale: false`
  (`invalid`), and only that file's stormings are kept as last parsed with `StormingView.stale: true`. Diagnostics are
  one list; a per-DSL summary splits them by `file` with `isStormingFile` (`packages/modeling/src/core/analyze.ts`).
- **Selection IDs** (what the page selects and a `ModelTarget` can name): `.dt` elements by model ID
  (`elementId`/`stateId`/`commandId`, `packages/modeling/src/model/ids.ts`: `Sales.Order`, `Sales.Order#Shipped`,
  `Sales.Order:confirm`); storming elements `es/<Storming>/<Local>` and the storming `es/<Storming>` (`esElementId`,
  `packages/modeling/src/storming/ir.ts`), carried by graph nodes as `elementId`; files `file:<path>` (`fileSelection`,
  `web/model-utils.ts`). Selecting a note selects its element, never an occurrence.
- **Render node IDs and occurrences** (`packages/visualization/src/domain/storming/ir.ts`): `t:<step keys joined by
  '>'>` (step key `e:<eventId>` or `g:<sorted eventIds>`; `…/<eventId>` for an event inside a group), `e:<eventId>` for
  an event in no timeline, `n:<local ID>` for other elements. `RenderEventNode.occurrences` are `EventOccurrence {
  timelineId, eventId, stepPath }`: a target's `occurrencePath` is `stepPath`. In a timeline's view the laid-out graph
  keeps the render node IDs; on the integrated canvas (`stormingViewKey` `<level>|`) the laid-out `graph` has one
  `e:<eventId>` note per event while its `render` still has the `t:` nodes, so a note's occurrences are the render event
  nodes with that `eventId` (`renderToGraph`, `domain/storming/graph.ts`). The page's tldraw shape IDs
  (`web/render.ts`: `n:<graph node ID>`, `e:<graph edge ID>`) are another namespace.
- **ViewLocation sources.** The page's canvas is `View` (`web/view/navigation.ts`: `contextMap`, `structure`,
  `catalog`, `storming`); the storming, level and timeline are `StormingChoice` and `shownStorming`
  (`web/storming.tsx`). `layoutKey` is `LaidOutGraph.id` plus `signature` (`domain/graph/ir.ts`); storming graph IDs are
  `storming:<Storming>:<level>:<timelineId or *>` (`stormingGraphId`).

## Appendix: persistence and ports (S3)

- **Model changes.** `Revision.take`/`restore` require the content hash to match the files (`hashMatchesFiles`,
  declared, `ContentHashMismatch`); `AgentRun.finish` requires `changed` to agree with the result revision
  (`changedMatchesResult`, `ChangedMismatch`); `RevisionOrigin` gains `Manual { takenBy }` (a facilitator's snapshot,
  to accept external changes before a restore). The content hash is the SHA-256 of `path NUL fileHash LF` per file in
  path order (UTF-16 code unit order), computed in the domain without I/O.
- **Store.** `.domaintrail/session/session.db` (WAL, foreign keys, `busy_timeout`), a `.gitignore` of `*` beside it,
  migrations by `user_version`, transactions `BEGIN IMMEDIATE` queued one at a time per connection. Tables `sessions`,
  `requests`, `agent_runs` (lease owner, token, expiry in ms, `completed_with`), `run_requests`, `revisions`
  (`content_hash`, `origin`), `outbox` (`seq` is the SSE event ID). Unique partial indexes keep one `Running` run and
  one lease per session. The claim is one `UPDATE … WHERE id = (first queued without a lease) AND NOT EXISTS (running
  or live lease) RETURNING id`. Blobs are `.domaintrail/session/blobs/<2 hex>/<sha256>`, written through temporary
  files and read back only when their hash holds. Nothing is written through a symbolic link.
- **Restore.** Refused while a run is active, when a source path is a symbolic link or outside the root, or when the
  workspace differs from the session's last revision (`ExternalChangesSinceSnapshot`; `takeRevision` records it as
  `Manual`). Then a `PreRestore` revision, the write (checked again against it: links on the way, the re-scanned
  hashes), and a `Restored` revision of what is on disk.
- **Targets.** A `dtes-occurrence`'s `occurrence` is the step path joined by `.` (`3`, `2.1`); a target is `current`,
  `stale`, or `unknown` when the sources it would be in do not parse.

## Appendix: the session server (S4)

*Decided by the supervisor* for S4, and built so:

- **One open session per workspace.** `dt session start` resumes the open session (`currentSession`, the oldest open
  one) or starts one; the facilitator's participant is `local:facilitator` (named `Facilitator`), fixed at start.
- **Facilitator link.** `dt session start` prints a one-time link (`/session/facilitator?code=…`, 32 random bytes,
  single use, 10 minutes). Opening it while signed in binds that identity to `local:facilitator`; the previous holder
  loses the role and their pages are disconnected. Access never implies the role. `dt session link` issues another:
  the code is written (hashed) to the session database, the URL is read from `.domaintrail/session/server.json`.
  `POST /api/session/facilitator/claim {code}` does the same for a page.
- **Identity modes**, explicit in `session.identity`: `dev` refuses a non-loopback bind; the first visit gets a join
  form (no script) and a name; the server keeps a sign-in (the SHA-256 of an opaque 32-byte cookie `dt_session`,
  HttpOnly, SameSite=Strict, Secure when `publicUrl` is https) mapped to the identity `dev:<uuid>`. `access` takes the
  token from `Cf-Access-Jwt-Assertion` or `CF_Authorization` and asks the `IdentityProvider`
  (`application/identity.ts`); the adapter (`infrastructure/identity.ts`) checks issuer, audience and expiry of the
  claims an `AccessTokenVerifier` returns. Until S8 the only verifier was `createMockAccessVerifier`, and
  `dt session start` refused the access mode without a verifier (S8 lifts it; see below). An Access identity joins on first sight
  (`access:<sub>`); the e-mail is never sent to pages. Host and Origin: loopback names plus `allowedHosts`; an Origin
  of the same host when it is loopback, else one of `allowedOrigins` (nothing external without them).
- **Persistence**: migration 2 adds `facilitator_links`, `facilitators` and `sign_ins` (secrets only as SHA-256),
  behind `Stores.access` (`AccessStore`) and `application/access.ts` (`SessionAccess`). Closing the session revokes
  every sign-in.
- **Authorization result.** `checkAccess(headers, policy)` returns `forbidden | anonymous | participant {participant,
  role}`; `dt view`'s policy has no `identify`, so its answers are `forbidden`/`anonymous` exactly where they were
  `'forbidden'`/`'ok'`. In a session `createViewHttpServer` applies it to every request (page, assets, view API,
  `/api/session/*`, `/session/*`) and the `/ws` upgrade: anonymous gets the join form (dev) or 401 (access) for a
  page, 401 for an API or the WebSocket.
- **Agent API**: `createAgentApi` on 127.0.0.1 (`session.agent.port`, default any free port), bearer token from
  `.domaintrail/session/agent.json` (0600, renamed into place, never through a link; removed on stop), refuses any
  request with an `Origin` or a non-loopback Host. SSE `GET /agent/events`: `id:` = outbox seq, `Last-Event-ID` (or
  `?after=`) resumes; each stream reads the outbox from its cursor, 100 at a time, waiting for the socket to drain (the
  outbox is the queue); at most 8 streams. Leases last 60 s; `expireLeases` runs at start and every 5 s.
- **Watcher hold**: `SessionServer.watcherHold` (`hold()` → resume, `around(work)`, `held`): while held, a settled
  burst of file events or a moved ref is deferred; the last resume refreshes and publishes once. The restore route uses
  it.
- **Limits**: session API bodies 64 KiB (JSON only, `application/json`), join form 2 KiB, agent bodies 16 KiB, request
  text 10,000 characters, note and question 4,000, names 60, 100 requests per run, WS messages from a page 16 KiB
  (checked in the hub as well as by `ws`), presence 20 Hz per participant (a newer update replaces the waiting one),
  `session.maxParticipants` (default 50). Logs carry no token, cookie, code or e-mail.

## Appendix: Cloudflare Access (S8)

*Decided by the supervisor* for S8, and built so (`infrastructure/identity.ts`, `node:crypto` and `fetch` only). The
real Tunnel/Access check is a person's, with [the runbook](../session-access.md).

- **The token.** The `Cf-Access-Jwt-Assertion` header; the `CF_Authorization` cookie only with
  `session.access.acceptCookie: true` (default false; Cloudflare recommends the header), and never over a header that
  is present. A JWT of three base64url parts, at most 8 kB; the header is `alg: RS256` with a `kid` (`none`, `HS*`,
  `RS512`, a missing `kid` and a `crit` header are refused; `jku`/`x5u` are never followed). The claims: `iss` equal to
  `https://<teamDomain>`, `aud` (a string or a list) holding the AUD tag, `exp` after now and `nbf`/`iat` not after
  now, each within 30 s of skew, `sub` and `email` present. The claims are checked before the key is looked up, so a
  token of another team or application never makes the keys be fetched.
- **The keys.** The JWKS at `https://<teamDomain>/cdn-cgi/access/certs`, fetched at start (a failure is logged, not
  fatal), cached, fetched again after an hour, and on an unknown `kid` (rotation) at most every 30 s; one fetch at a
  time; 5 s timeout; RSA keys of 2048 bits or more, `use: sig` and `alg: RS256` when stated. A failed fetch keeps the
  keys known.
- **The identity.** `access:<sub>`. The display name is the Identity API's `name`
  (`https://<teamDomain>/cdn-cgi/access/get-identity`, asked server-side with the token as the `CF_Authorization`
  cookie, 5 s timeout, cached per subject for 5 minutes, a failure for 1 minute), else the e-mail's local part; at most
  60 characters. An avatar only when the identity's `picture` (or `oidc_fields.picture`) is an `https` URL without
  credentials or port on a host of `session.access.avatarHosts` (default none): else the page shows initials. The
  server never fetches the picture.
- **Privacy.** The e-mail stays on the server (`Identity.email`): it is sent to no page, not even the person's own
  `/api/session/me`, and never logged; presence and the session state carry the participant ID, the name, the role
  and the avatar URL.
- **Revocation.** Every HTTP request and every WebSocket upgrade verifies the token again (the profile is cached, the
  signature is not). A page's WebSocket is closed at the token's expiry (plus the skew), close code 4002; it
  reconnects with the token Access gives it then. `POST /api/session/leave` in access mode closes the person's pages
  (4001) and answers `{ left: true, logout: "/cdn-cgi/access/logout" }` for the page to end the Access session; the
  server cannot see an Access logout otherwise, so other pages of that person stay until their token expires. Closing
  the session revokes everyone: a closed session identifies no one, whatever is cached (a fix of S4's code).
- **Roles.** An Access identity is a participant; the facilitator only through the local link, as in S4. In a session
  `POST /api/baseline` (the view's baseline, shared by every page) is the facilitator's (403 `FacilitatorOnly`
  otherwise; a fix of S4's code); `dt view` is unchanged.
- **Start.** `dt session start` runs the access mode with `teamDomain` and `audience` (the team domain a host name,
  optionally with `https://`). A `publicUrl` must be https, with its host in `allowedHosts` and its origin in
  `allowedOrigins` (the tunnel's requests would all be refused otherwise); without `publicUrl` only the configured
  hosts and origins are allowed, as in S4. The bind stays `127.0.0.1` by default; another bind is allowed and logged.
  The agent API stays on 127.0.0.1.
- **Tests.** `test/session-access.test.ts`: RSA keys from `node:crypto`, a JWKS and `get-identity` on a local HTTP
  server, tokens signed in the test; `startSessionServer` takes `accessAdapter` (the endpoints and timings) for it.

## Appendix: the subscriber (S6)

*Decided by the supervisor's brief* for S6, and built so:

- **Package.** `@domaintrail/agent` takes only types from collaboration (`protocol`, `generated/index`; checked by the
  architecture test). `application/ports.ts`: `AgentApi` (session, participants, the SSE stream as `open` + events,
  claim, start, heartbeat, finish, clarification, fail, release; an HTTP error is a value `{status, type}`, a
  transport failure rejects), `AgentRunner` (prompt + allowed tools + abort signal → exit code, summary, optional
  question), `DslTools` (`format`/`check` → ran or not), `WorkspaceFiles` (`scan`, `sources`), `Clock` (`sleep`,
  `every`). `application/subscriber.ts` is the loop and the pipeline, `application/prompt.ts` the prompt and the
  outcome line. Composition's `startSubscriber` (`packages/composition/src/subscriber.ts`) wires the adapters and the
  workspace's `findDomainFiles`; `CliDeps.startSubscriber` is the CLI's port.
- **The agent API gains `GET /agent/participants`** (`AgentParticipantsBody`: IDs and display names, no e-mail), for
  the authors' names in the prompt; the frozen input only has participant IDs. Nothing else of S4 changed.
- **Credential.** `dt session subscribe` refuses `.domaintrail/session/agent.json` when it is missing, a symbolic link
  or not a regular file, not mode 0600 (POSIX), not a credential, written by a process that is gone, or for another
  session than the one the agent API serves, or when the session is closed.
- **Pipeline**, one run at a time: claim (`owner` = `claude@<host>`) → start (the server takes the base revision; a
  409/404 means cancelled or taken: nothing more; another error releases the run) → the participants' names, the DSL
  sources and a scan of the workspace → the agent, with a heartbeat every `leaseMs / 4` (15 s for the default 60 s
  lease) → a second scan → `fail AgentError` if anything other than a `.dt`/`.dtes` source (before or after, by the
  configured `sources` and `.gitignore`) was added, changed or removed, the paths in the log; the subscriber then
  claims no further run until it is restarted (the files stay on disk and a person reviews them first; a queued run is
  logged as not claimed). Once the agent was started, the second scan runs on every way out — cancel, lost lease,
  runner error, `Interrupted`, clarification, finish, an exception — and halts the subscriber whenever it finds such a
  change, whatever the run's outcome (a cancelled run still sends nothing); a scan that fails halts it too (`<scan
  failed>`, fail closed). The paths are the agent's choice: the log quotes each as JSON with control (C0, DEL, C1) and
  bidirectional characters escaped, cut to 200 characters and 20 paths, the same text in both log lines → `clarification` if the
  agent exited 0 with a question (no `dt fmt`/`dt check`: the files stay as the agent left them) → `dt fmt`, then `dt
  check` → `finish {exitCode, formatted, checked}`. "Ran" is exit 0 or 1 (`dt fmt` exits 1 when it skipped a file with
  syntax errors, `dt check` on errors), not 2 (configuration), a signal or a failure to start. An exception of the
  pipeline (a scan that fails) fails the run as `AgentError`. After a run the next queued one is claimed at once.
- **Scan.** Every entry below the root except `.domaintrail/`, `.git` and `node_modules` at any depth, by `lstat`
  (type, size, mode, mtime and ctime in nanoseconds; a link's target, never followed), at most 200,000 entries. Files
  inside ignored directories are scanned too: an agent writing a build output or an ignored note fails the run.
- **Cancellation and the lease.** `run.cancel_requested` for the run in hand, or a heartbeat answered 409/404 (the
  lease is gone: cancelled, expired, or taken), aborts the agent; nothing more is sent for that run. The agent is
  started detached as the leader of its own process group, and the group gets SIGTERM, then SIGKILL after 5 s (and
  SIGKILL once the agent exits after an abort), so the processes it started stop too. A completion that fails in
  transport is sent again (5 tries); the server replays a repeat (same run, same token) and answers 409 to a stale
  token, which ends it.
- **Stream.** `GET /agent/events` with `Last-Event-ID` = the last event's `id:`; each (re)connection is followed by a
  claim, so a run queued while the stream was down is taken even though its `run.queued` was missed. Reconnection
  waits 0.5 s doubling to 5 s; 401/404 or no stream for 60 s ends the subscriber (`lost`, exit 1); `session.closed`
  ends it (`closed`, exit 0). `--once` handles one run (waiting for one if none is queued) and exits 0.
- **Stop.** `stop()` (Ctrl+C and SIGTERM in the CLI, then exit 130): a claimed run not yet started is released; a
  running one's agent is killed and the run failed as `Interrupted`; a run already past its agent is finished. If the
  subscriber dies without that (SIGKILL), its run's lease expires: a `Running` run fails as `LeaseExpired` (S3).
- **Claude Code**, checked against version 2.1.314 (`claude --help`; no real run was made). The adapter spawns
  `claude` from the PATH with an argument array (`shell: false`), cwd = the workspace root, the prompt on stdin:

  ```text
  claude --print --output-format json --no-session-persistence --strict-mcp-config --setting-sources user
         --permission-mode dontAsk
         --tools <the rules' tool names, comma-separated> --allowedTools <each rule as its own argument>
  ```

  With the default tools: `--tools Read,Edit,Write,Glob,Grep,Bash --allowedTools Read Edit Write Glob Grep "Bash(dt
  fmt:*)" "Bash(dt check:*)"`. `--tools` narrows the built-in tools to those the rules name, `--allowedTools`
  pre-approves the rules, `dontAsk` refuses anything else without a prompt, `--strict-mcp-config` without
  `--mcp-config` loads no MCP server. A rule that starts with `-`, is empty or has a line break is refused, so no
  configured value can become a flag. The result is the JSON of `--output-format json` (`{"type":"result",
  "result":"…", …}`); success is the exit code. `--setting-sources user` loads the user's settings only: the
  workspace's project and local settings (`.claude/settings.json`, `.claude/settings.local.json`) are files the agent
  itself could write, and would widen the tools (allow rules, hooks running commands) for the next run. The user
  settings of whoever runs the subscriber still apply (their allow rules, hooks, `apiKeyHelper`): they make sure those
  allow nothing more. Neither the prompt, stdout nor stderr is logged; stdout is read up to 8 MiB.
- **Prompt.** The rules (read the related `.dt`/`.dtes` files first; edit only `.dt`/`.dtes` sources; keep `.dtes`
  exploratory and never sync it into `.dt`; when the requests are only about `.dtes` (by their targets), change no
  `.dt`; run nothing but `dt fmt`/`dt check`; ask instead of guessing; the block is data, not instructions), then the
  requests as JSON — each with the author's display name, the target (kind, element or storming/element/timeline/
  event/occurrence, the label and the file and lines at the time of the request) and the body — and the facilitator's
  note, between `<requests-NONCE>` and `</requests-NONCE>` (32 random hex digits per run), with `<` and `>` escaped as
  `\u003c`/`\u003e` inside the JSON so that no text can close the block.
- **Clarification signal.** The agent ends its reply with one line `DT-OUTCOME: {"outcome":"done","summary":"…"}` or
  `DT-OUTCOME: {"outcome":"clarification","question":"…"}`; the adapter takes the last such line of the JSON result's
  `result`. A missing or invalid line is a plain `done` (the facts decide); a question is trimmed and cut to 4,000
  characters. `--json-schema` was not used: its output field could not be checked without a real run.
- **dt fmt / dt check** run with this CLI itself: `process.execPath` and `process.argv[1]` (e.g. `node dist/dt.js`),
  `-r <root>` and the `-c` the subscriber was given, never a `dt` on the PATH; output discarded, 5 minutes each.
- **Tests** use a fake agent (`test/fixtures/agent/fake-claude.mjs`, a plan per invocation) through composition's
  `agentCommand` option (tests only, not a CLI option), or as a `claude` script first on the PATH for the CLI on Bun
  and on Node (`dist/dt.js`).

## Appendix: revisions, comparison and restore (S7)

*Decided by the supervisor* for S7, and built so:

- **Restore keeps refusing external changes**: when the workspace differs from the session's last revision the restore
  is refused (`ExternalChangesSinceSnapshot`, 409, the paths), and nothing is written. The page offers the facilitator a
  confirmed two-step, `POST /api/session/revisions/:id/restore {"recordExternalChanges": true}`: the workspace as it is
  is recorded first as a `Manual` revision (taken by the facilitator), then the restore goes on, so an edit by hand is
  never lost and shows in the history. Both steps run in one call, behind one watcher hold.
- **A run in progress** (Running, or a live claim) makes the restore refuse (`RunInProgress`, 409, the run). The page
  explains it and offers to cancel the run; once cancelled the lease has ended and the restore can be asked again
  (files the agent changed before it stopped are external changes: the two-step records them).
- **The operation log.** Every attempted restore is a row of `restore_operations` (migration 3, `Stores.operations`,
  `OperationLog`): the participant who asked, the identity acting as that participant (provider and subject: the
  facilitator's participant is `local:facilitator` whoever holds the role), the revision to restore, the Manual,
  pre-restore and restored revisions it recorded, the result (`Restored`, `Refused`, `Failed`), the reason (an error
  type) and, for a failure, the error's message. No token, cookie or e-mail. A table rather than the `.dt` model: the
  log keeps attempts the model never records (refused before anything was written, failed midway), it is an audit
  record of the server rather than a decision of the domain, and the `Restored` revision already carries what the
  domain needs (`restoredFrom`, `preRestore`). `restoreRevision` takes `by` and `identity`; `restoreOperations` reads
  the log (not served over HTTP in M1).
- **The restore's sequence**, behind `WatcherHold.aroundWrite`: hold → no active run → `RestorableRevision` (symbolic
  link, path outside the root, external changes; or the Manual revision first) → the blobs → `PreRestore` revision →
  write (the S3 writer, with its refusals) → read back and validate → the content hash must be the restored
  revision's → `Restored` revision → resume. A refusal of the writer leaves the workspace as it was (checked by reading
  it again) and is a plain refusal. Any failure after the write started (the write throws, refuses after a partial
  write, the read-back fails, the content differs, recording fails) is `ManualRecoveryNeeded` (500) with the
  pre-restore revision and the cause; nothing is recorded as restored, the server logs it, and the page tells the
  facilitator to check the files and restore that revision (the two-step, as the workspace now differs from the last
  revision).
- **One publish.** On resume after a write the view is refreshed and published once, whether or not the watcher has
  seen the write; the watcher's late events whose sources (paths and hashes) are those left by the write are absorbed
  for 5 s (`WatcherGate.echo`; `dt view` has no gate). Every page gets the restored model in one `update`, then the
  revision events.
- **Comparison.** `GET /api/session/revisions/:before/compare/:after`, any participant: every source of either revision
  by path with its DSL and status (`added`, `removed`, `changed`, `unchanged`), counts per DSL, both revisions (their
  validation summaries side by side), and for each file not unchanged a unified line diff (`domain/compare.ts`, Myers'
  O(ND) diff, three lines of context) from the blobs. Bounded before the work is done (a security review's finding):
  a side over 1 MiB is `tooLarge` without its blob being read; at most 10,000 lines and 1,000 edits a file (else
  `tooLarge`); a line is shown up to 1,000 characters; each emitted line counts against the comparison's 512 KiB budget
  (and 2,000 lines a file), the diff stops there (`truncated`) and the files after it get none (`diffsOmitted`).
- **Confirm** stays a mark: the facilitator's, on any recorded revision; it blocks nothing.
- **The page** (`web/session/revisions.tsx`, `timeline.ts`): the timeline newest first, numbered in the order taken,
  with the origin (session start; before/result of run *n*; manual, by whom; before restoring #*k*; restored from #*k*
  with its pre-restore), time, validation per DSL, the confirmed mark; two revisions chosen → the comparison in a
  modal dialog, `.dt` and `.dtes` together; for the facilitator *Mark as confirmed*, *Record the current state* and
  *Restore…* (hidden on revisions with the latest's content) with the confirmation, the two-step and the cancel-the-run
  path. Participants see everything read-only.
- **Saves during a run** make no revision: only the run's start (RunBase) and end (RunResult) do (checked by a test).

## Appendix: wrap-up (S9)

- **The facilitator listed once.** The identity that opens the facilitator link joined as a participant of its own
  (`dev:…`, `access:…`) before it claimed the role, so the panel showed the person twice. The session state
  (`SessionStateBody`) gains `facilitatorHolder`, that participant's ID, while someone holds the role; every page
  still connected is sent the state again when the role changes hands (the claiming and the previous holder's pages
  are disconnected as before); the panel folds that participant into the facilitator's entry, under its name, and a
  previous holder is listed as a participant again. Nothing else of the model or the protocol changed.
- **Tests** for the rows of the matrix that no test checked in full: three requests in one run, an event in two
  timelines as two targets, a `.dtes` syntax error kept in a revision and recovered by a restore; the guide's session
  configuration example is checked against the config's defaults.
- **Docs.** `dt guide session` (with `session-config`, `session-revisions`, `session-agent`), a README section,
  a paragraph in `docs/live-view.md`, and `docs/session-first-run.md` for a first run with the real Claude Code. The
  guide's list of topics grows by four lines, so its test allows `dt guide` 160 lines instead of 150. The changelogs
  record released versions only, so they are left for the release.
