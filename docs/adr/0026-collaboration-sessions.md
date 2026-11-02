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
| web | the chat in `AppShell`'s `conversation`, the session panel in its `dockAlternative`, drafts in IndexedDB, presence overlay | + collaboration (protocol, types) — in place since S4 (`useViewSocket`) |

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
  allow nothing more. Neither the prompt, stdout nor stderr is logged; stdout is read up to 8 MiB. *Amended by
  "what a running run is doing": the output is now `--output-format stream-json --verbose`, read line by line.*
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
  characters. `--json-schema` was not used: its output field could not be checked without a real run. *Superseded by
  the appendix "Structured replies": the reply is now Claude Code's structured output; this line is still read.*
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

## Appendix: requests with several targets (amendment)

A request was about one target (the whole workspace, a `.dt` element, a `.dtes` element or an occurrence). People in
a meeting talk about several things at once ("give 注文 the 顧客's address"), so a request now has **0 to 20 targets**.

- **Model** (`model/request.dt`, `agent-run.dt`). `Request.targets: TargetSnapshot[0..20]`; the frozen copy in a run's
  input (`FrozenRequest.targets`) and `RequestSent.targets` carry the list too. **No target means the whole
  workspace**: the `Workspace` kind of `ModelTarget` is no longer used in a request's list (`noWorkspaceTarget`), so
  "the workspace" has one spelling and a list never mixes it with elements. `Workspace` stays in the union, for the
  presence's selected target and for rows written before. Invariants of Request: `atMostTwentyTargets`
  (`count(targets) <= 20`; the multiplicity's bounds are JSDoc only), `distinctTargets` (`unique(targets, t =>
  t.target)`, by union value), `noWorkspaceTarget`; `send` requires the same, else `TooManyTargets`,
  `DuplicateTarget`, `WorkspaceTarget`. `TargetSnapshot`'s `workspaceHasNoRange` is kept (it still holds for every
  snapshot) though a request's snapshots are never the workspace's now.
- **Persistence.** No migration: rows are stored whole as JSON, and a row written before (a request, a run's frozen
  request, a `RequestSent` in the outbox with one `target`) is read as the list it stands for — none when the target
  was the whole workspace, else that one target (`infrastructure/legacy.ts`). Nothing is rewritten; a row saved again is
  written with `targets`. A running session's database keeps working after the upgrade (tested on a fixture of former
  rows, and by hand on a copy of a live session).
- **API.** `POST /api/session/requests` takes `{ targets, body }`: 0–20 targets, each a target snapshot as before, each
  once (`targets[i].target`), none the whole workspace (`targets[i].target.kind`), every `sourceRevision` a revision of
  the session (`UnknownRevision` names `targets[i].sourceRevision`). The former `{ target, body }` is still taken as a
  list of one, or none for the workspace's target; both at once is refused. `GET /api/session/targets` answers a status
  per target, in the request's order: `statuses: { [request]: TargetStatus[] }` (empty for the whole workspace).
- **Mentions.** (Amended: elements are now written `#name[n]`, and `@` mentions people — see "mentions of people"
  below.) The body stays plain text. A mention is `@name[n]`: `n` is the number of one of *that request's*
  targets, from 1; the name has no spaces, brackets or `@` and is only what the writer saw (the target's label or
  name). A mention of a number the request does not have is text. The page renders mentions as links to their target
  (named in the current display setting), never as markup; the agent's prompt lists each request's targets numbered
  from 1 (`targets: [{ number, kind, … }]`, or `"the whole workspace"`) and its rules say that `@name[n]` means target
  n of the same request, whatever the name says.
- **The composer** (`web/session/mentions.ts`): the chips under the text are the targets (none: the whole workspace).
  Typing `@` (or the IME's `＠`) offers every element, state and command of the model and every note of the stormings
  (not timelines or groups; occurrences only through the selection), matched loosely on the label, the name and the
  qualified name, shown with their kind and context or storming; ↑↓, Enter/Tab, Esc; while an IME composes
  (`isComposing` or key code 229) no key picks or sends. Picking writes `@name[n] ` and adds chip n (or reuses it);
  deleting every mention of a chip that came from a mention removes it (a chip added otherwise stays); removing a chip
  turns its mentions into plain text; numbers follow the chips. (Amended: the text shows each mention as an inline chip and
  the chips have no numbers — see "the composer's editor" below.) (Amended: the selection is no longer suggested as
  dashed chips — see "the selection added only through 💬" below.) The canvas's 💬 next to the selection, or `C`
  outside text inputs (no tldraw or app binding of a plain `c`), adds the selection as chips and focuses the
  composer. The app has no
  context menus (tldraw's UI is hidden), so none was added. Formerly `選択中: … [+]`. A selection
  of several shapes adds each targetable element, and an occurrence is added from a timeline's view. The unsent text
  and chips stay in the browser (the composer's draft, IndexedDB).

## Appendix: structured replies (amendment)

The agent's reply was one `DT-OUTCOME:` line, and the session kept only a clarification's question as text (the
summary of a done run was dropped). People in a meeting want to see, per request, what the AI says it did, what it
assumed, and to answer its questions by choosing. The reply is now structured data; the facts stay measured.

- **Principles.** Facts are never the AI's: success or failure, the files changed, `dt fmt`/`dt check` and the
  diagnostics are measured by the pipeline and the server as before. The reply is untrusted input: validated against
  its shape and limits on the subscriber and again on the server, stored only when valid, and shown as plain text (no
  HTML, no markdown). A reply that is missing or invalid never fails a run: what can be read is kept (the outcome, a
  summary within the limit, a clarification's question text), else nothing.
- **Shape** (what the AI returns): `{ outcome: done | clarification | declined, summary, requests: [{ request,
  status: done | partial | skipped | question, note? }], questions?: [{ id, text, requests?, options: [{ id, label,
  detail? }], multiple }], assumptions?: [{ text, requests?, alternatives?: [{ id, label }] }] }`. `request` is the
  request's number in the prompt (the prompt now numbers requests from 1, `number`, instead of showing their IDs); the
  subscriber maps the numbers back to the frozen input's request IDs. A note is required for partial and skipped; a
  clarification asks 1–3 questions, the other outcomes none; the AI never offers "other" (the page always adds it).
  Unknown fields are refused. Keys (`id`) are letters, digits, `_` and `-`.
- **Limits in one module**: `packages/collaboration/src/domain/reply.ts` (`REPLY_LIMITS`: summary 300, request note
  200, questions 3, question 500, options 5, label 80, detail 300, assumptions 5, assumption 300 (not given by the brief;
  chosen here), alternatives 3, alternative label 80, key 40, the facilitator's own words in an answer 500). The JSON
  schema given to the agent (`replyJsonSchema(requests)`), the prompt's description of the reply, the validation of
  both sides (`readReply`, `readAnswer`), and the page all take them from it; the model holds what is not a number
  (`noteExplains`, the questions of each ending, keys unique, the requests named are the run's). The module is pure (it
  imports only the generated model), so `@domaintrail/agent` may import it as values — the one exception to "only types
  from collaboration", allowed by name in the architecture test.
- **Claude Code** 2.1.316, checked with real calls (a tiny schema, `--tools ''` and `--tools Read,Glob` with
  `--permission-mode dontAsk`): `claude --print --output-format json --json-schema '<schema>'` answers
  `{"type":"result", "result":"<the object as JSON>", "structured_output":{…}, …}` (the structured output is a tool of
  Claude Code's own: `stop_reason` is `tool_use`, one turn more, no permission prompt or denial under `dontAsk`). The
  adapter passes `--json-schema` (the schema is ours, no person's text) and reads `structured_output`, else `result` as
  JSON, else the last `DT-OUTCOME:` line of `result` (the former protocol, still read; the fake agent of the tests uses
  both). The prompt describes the reply in a few lines (limits interpolated) to keep the Q&A loop fast.
- **Declined is a state of its own**, `Declined "辞退"` (`baseRevision`, `startedAt`, `reply`, `resultRevision`,
  `finishedAt`), reached by `decline(reply, resultRevision, finishedAt)` from `Running`, emitting `RunDeclined`
  (`run.declined` for pages and the agent stream). Not `Completed`: completing runs `dt fmt`/`dt check` and the success
  rule, and `dt fmt` alone may change files, while a declined run, like a clarification, ends with the files as the
  agent left them; and it is not waiting for an answer, so it is not `NeedsClarification`. Its reason is the reply's
  summary. If the agent changed files anyway, the result revision records it and the page shows the measured count. A
  decline without a readable reason is read as `done` (the facts decide).
- **Model** (`model/agent-run.dt`, generated code regenerated). Values `AgentReply` (`summary`, `requests:
  RequestReply[]`, `questions: ReplyQuestion[]`, `assumptions: ReplyAssumption[]`), `RequestReply` (`request:
  RequestId`, `status: RequestProgress`, `note?`), `ReplyQuestion`, `ReplyOption`, `ReplyAssumption`,
  `ReplyAlternative`, the primitive `ReplyKey`. `Completed.reply?` (no questions), `NeedsClarification.reply?` (at least
  one question; `question: Text` stays, the plain text: the questions one per line, or the former question),
  `Declined.reply`; each holds that the requests its reply names are the run's. `finish` and `askClarification` take an
  optional reply and refuse one that breaks those (`InvalidReply`, checked before a result revision is recorded); a
  failed run keeps no reply (the facts decide). `RunInput.answer?: Answer` — the facilitator's answer, frozen.
- **The answer** (API, model and prompt now; the panel's controls later). `POST /api/session/runs` takes `answerTo` (a
  run of the session) and `answer: { answers: [{ question, options, text? }] }` together. The use case checks the
  answered run is `NeedsClarification` with a structured reply (else `NothingToAnswer`, 409), every question and
  option ID is its (single choice: at most one option), each question once, an option or own words for each
  (`InvalidAnswer` with the field, 400), and freezes `Answer { answerTo, answers: [AnsweredQuestion { question, text,
  chosen: ReplyOption[], freeText? }] }` into the new run's input, so the prompt is still built from the frozen input
  only: the block gains `answersToYourQuestions: [{ question, chosen: ["label (detail)"], inTheirOwnWords }]`, and rule
  6 says to follow it.
- **Agent API.** `finish` takes `reply?` (outcome `done`), `clarification` `question` and `reply?` (outcome
  `clarification`), and the new `POST /agent/runs/:id/decline` takes `reply` (outcome `declined`); each validates with
  `readReply` (requests by UUID, the outcome matching the route; `InvalidInput` with the field) and the model checks the
  requests are the run's (`InvalidReply`, 400). The agent API's body limit grows from 16 KiB to 256 KiB (a reply at its
  limits in Japanese). The subscriber sends a clarification or a decline only when the agent exited 0, otherwise runs
  the checks and finishes, dropping a reply that is not `done`.
- **Persistence.** No migration: a run is stored whole as JSON and the new fields are optional, so rows written before
  (a clarification with only its question, a completed run with no reply, an input with no answer) load as they are and
  keep their invariants (tested on a fixture copied in shape from a real database, and by starting this build on a copy
  of a live session's directory). `Declined` is a new value of the `state` column, which has no constraint.
- **Pages.** `RunNeedsClarification` and `RunDeclined` do not carry the reply: a page fetches the state again. The chat
  (`web/session/reply.tsx`, shared with the panel): a completed run shows `反映しました (n ファイル)` small (n counted
  from the base and result revisions' files), the summary, a line per request (✓ ◐ – ? with the author, the head of its
  body and the note) and the assumptions with their alternatives as read-only chips; a clarification shows the summary
  and each question with the requests it is about and its options as disabled radio buttons or checkboxes, plus
  "その他…"; a declined run a neutral bubble with its reason. A run without a structured reply is shown as before.
- **Element references in the reply.** In any text of the reply (summary, request notes, questions, option labels and
  details, assumptions, alternative labels) the agent names an element by its identifier, never its label, as a token:
  `@{<model ID>}` for a `.dt` element, state or command (`@{Sales.Order}`, `@{Sales.Order#Draft}`,
  `@{Sales.Order:confirm}`: the `element` of a `DtElement` target) and `@{es:<storming>/<local>}` for a `.dtes`
  element (`@{es:Returns/ReturnRequested}`: the `storming` and `local` of a `DtesElement` target, the identifiers of
  the `.dtes` source). The identifier has no whitespace, braces or `@` (at most 200 characters); `\@{` is a literal
  `@{`. A request body's mention is `@name[n]`, without braces, so neither reads as the other; reply text is never
  parsed for mentions. Tokens count as written toward the limits (unchanged). The prompt gives the format in one rule
  with one example each. The page (`web/session/references.ts`, pure, unit-tested) resolves a token against the model
  and stormings now and shows it as `targetName` does in the name display setting, as a link that navigates like a
  target chip; one that does not resolve shows its identifier (without braces or `es:`) as plain text. Replies without
  tokens are unchanged.


## Appendix: messages, apply, classification and the agent's dt (amendment)

- **Data model: a message is a `Request`.** Option (a) of the two weighed: everything posted in the chat — the
  facilitator's own posts too — is a `Request` as before (author, 0–20 targets, body; it never changes), shown as a chat
  message. *Applied* is not a state of its own: a message is applied when a run's frozen input holds it, so nothing is
  migrated and every existing row (including those with the old `Dismissed` state) loads unchanged; the run input, the
  prompt and the numbering of requests in it (`@name[n]`) are untouched. A new `Message` entity was rejected: it would
  have duplicated `Request`'s targets, invariants and events for no state the model needs. `POST /api/session/requests`
  takes `apply` (`true` or `{ note }`, the facilitator's only): the message is queued as a run of its own in the same
  call — what a later solo chat under `dt view` will use to apply the facilitator's messages at once.
- **Dismiss is dropped from the product.** Messages are talk, not a queue to clear: the page has no 見送る and the
  `POST /api/session/requests/:id/dismiss` route is gone. The model keeps the `Dismissed` state, its event and the use
  case so that older sessions load and replay; such requests show as messages. (ADR 0027, T12: the `dismiss` command
  and the `dismissRequest` use case are removed; the state and the event stay, for the older sessions.)
- **The facilitator works in the chat.** The right-side `SessionPanel` (and the inspector menu's switch to it) is gone.
  ⤓ applies one message at once (runs stay serial: it waits as 実行待ち); ▾ adds a note first or enters selection; Shift/⌘
  chooses several, and まとめてアプライ queues them as one run; 取り消す (a few seconds) cancels the run while it is still
  queued. A clarification card offers the reply's options (radio or checkbox, plus その他 in own words) and 答えて再実行
  queues the same requests with `answerTo` + `answer` at once. **An assumption's alternative** is asked for in the
  run's **note** (`前提「…」は採らず、「…」としてやり直してください。`): `answer` is reserved for a run that asked
  (`NothingToAnswer` otherwise), and a note needs no change to the model (*amended*: the pick is now recorded as
  `input.pick` too — see "Picks are recorded" below). Cancel is ✕ on the status (head) and on queued
  or running cards; confirm, restore (asked first) and compare (the existing dialog) are in a card's ⋯; recording, a new
  facilitator link (`POST /api/session/facilitator/link`, what `dt session link` does) and closing the session in the
  head's ⋯.
- **Cards.** One card per change unit, updated in place (`web/session/history.ts`, `cards.ts`, pure and unit-tested). A
  run joins the unit of the run its `answer.answerTo` names, else the latest unit whose latest run asked or completed
  with exactly the same requests (an alternative picked, the same messages applied again); after a cancel, a failure or
  a decline it starts a card of its own. Each run of a card quotes the messages it applied with the reply's status for
  each (✓ ◐ – ?) and note — the reply's per-request lines, no longer repeated below — and an applied message shows its
  latest run's mark and number (`✓ #3`) to everyone. 履歴 shows the same cards, compact.
- **Classification (opt-in).** `session.classifier` (`enabled` false by default, `provider` `cloudflare-clef`, `model`
  `clef-flash` | `clef`, `accountId`, `apiTokenEnv` — the *name* of the variable holding the token —, `threshold` 0.5).
  A `MessageClassifier` port in the collaboration application (`application/classifier.ts`), the Clef adapter in its
  infrastructure (`infrastructure/clef.ts`, plain `fetch`), a fake in the tests. Verified against Cloudflare's Workers
  AI docs for `@cf/cloudflare/clef-flash` (developers.cloudflare.com/workers-ai/models/clef-flash/, its
  `schema-input.json` and `schema-output.json`): `POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/{model}`
  with `{ model, state, questions: { <id>: { type: "noul", instructions, criteria: { true, false } } } }`, answered
  `{ answers: { <id>: { type: "noul", noul: <probability of yes> } }, usage }` inside Cloudflare's `{ result, success }`.
  Each message is asked once, in the background after it is sent (8 s timeout); a failure, a timeout or a probability
  within 0.1 of the threshold leaves it applicable (the decision falls back to the human), and a message read as talk
  can still be applied from ▾. Results are kept in memory and sent to the facilitator's pages only
  (`session.classifications` on connect, `session.classification` as they come); participants never see them. Neither
  the message nor the token is logged. Message text goes to Cloudflare only when enabled; Workers AI's data usage page
  states that customer content is not used to train models. `DOMAINTRAIL_CLASSIFIER_URL` points the adapter at a local
  mock (tests, demos).
- **The agent's `dt`.** A real run's reply said `dt` was not on the agent's `PATH`. The subscriber now puts a `dt` shim
  first on the agent's `PATH` for each run, so the prompt and `allowedTools` stay `dt fmt` / `dt check`. What it runs is
  `session.agent.dt` or, unset, the running `dt` itself; the same command runs `dt fmt` / `dt check` after the agent.
  Since the agent can write in the workspace during a run (and the check for non-DSL changes only runs after it), the
  rules are positive and few, after three rounds of security review: (1) only `["node" | "bun" | "deno", "<script>"]` or
  `["<dt executable>"]`, paths relative to the config file, refused at config load when inside the workspace (symbolic
  links followed, compared by path segments: `<root>/..evil` is inside); (2) pinned once when the subscriber starts —
  never re-read from the config file, which is in the workspace — to absolute real paths (the runtime found on the
  `PATH`), refused inside the workspace, fingerprinted (SHA-256 of the runtime and the script) and checked before each
  run; (3) the shim never parses words with a shell: `dt` / `dt.cmd` only starts the runtime on a launcher that holds
  the command as JSON and spawns it with `shell: false`; (4) the agent's `dt` takes `fmt` or `check` and then `.dt` /
  `.dtes` files of the workspace only — any option (`--prefix`, `-r`, `--config`, …) or other argument is refused with a
  message to the agent — and the launcher always adds `-r <workspace>` itself; (5) the shim lives in a private (0700)
  temporary directory outside the workspace, and `dt` (the agent's and the pipeline's) runs with a private working
  directory, never the workspace, so no runtime picks up a config of it.
- **Inspector width.** Until the reader drags it, the inspector on the right takes about a third of the room beside
  the left pane and the chat (300–420 px), so that the canvas keeps its share when the chat is open.

## Appendix: votes and reactions (amendment)

*Decided by the maintainer*: participants signal a preference on a question's options and an assumption's choices
(votes, ♡), anyone reacts to a message or an AI turn with an emoji (see "Reactions are emoji" below: at first four
named reactions); the facilitator decides. Both are **one mechanism**: a mark is who (a participant) marked what (a target) with which sign.

- **Model** (`model/mark.dt`, generated code regenerated). Aggregate `Mark` (`participant`, `target: MarkTarget`, `sign:
  MarkSign`, `placedAt`; `Placed` → `Removed { removedAt }`), the union `MarkTarget` — `Message { request }`, `Turn
  { run }`, `QuestionOption { run, question, option }` (the reply's keys), `AssumptionChoice { run, assumption,
  alternative? }` (the assumption's index in the reply, which has no key; no alternative = keep it as it is) —, the
  union `MarkSign` (`Vote`, `Reaction { emoji }`; at first an enum of `Vote` and four named reactions), events `MarkPlaced` / `MarkRemoved`. The invariant `fitsTarget`
  (the vote on options and assumptions, the reactions on messages and turns) and the requirement `participantsVote`
  (`FacilitatorDoesNotVote`; the role is the session's, never the caller's word) are the DSL's; `place` and `remove` take
  the verified `OpenMarkTarget` (`MarkTargetNotFound`, `MarkTargetClosed`), made in `application/verifications.ts`. A
  removed mark is kept; placing it again is a new mark. Not a field on `Request`/`AgentRun`: those never change once
  sent or ended, and a mark is many people's.
- **Rules per kind of target** (`domain/marks.ts`, pure, over plain shapes so that the page decides the same way):
  exclusive groups — one vote per participant in a single-choice question and in an assumption group (the assumption
  and its alternatives), moved by voting another; any number in a multiple-choice question; each emoji on its own.
  **Closing is derived, never stored**: a reaction never closes. A vote is open while its run is the latest run to have
  handled its requests — no later run (in queue order) answers it (`input.answer.answerTo`) or bundles any of its
  requests, a run cancelled before it started (no base revision) not counting — and the run is `NeedsClarification` (a
  question's option) or `Completed` (an assumption's choices). So the facilitator's answer, an alternative picked (a
  run of the same requests with a note), the same messages applied again, or a re-run of an overlapping set all close
  it; cancelling that run before it started (the undo after applying) opens it again. "Overlapping" rather than "the
  same set": a later run that took over any of the requests has the newer say on them. Closed votes are frozen.
- **Use case** `setMark { session, participant, target, sign, placed }`: setting a mark to what it is changes nothing
  (idempotent, so a page sends the state it wants, not a toggle); placing a vote removes the participant's vote of the
  same group in the same transaction (both events, the removal first). Refused while the session is not open, for a
  stranger, a missing or closed target, a sign that does not fit, a vote of the facilitator.
- **Persistence.** Migration 4 adds `marks` (`target_key` = `markKey(target)`, `sign`, `state`, JSON `data`) with a
  unique partial index: one placed mark per session, participant, target and sign. Nothing else changes, so a session
  database of the version before is upgraded in place (tested on a database built with the former migrations, and by
  starting this build on a copy of a live session's directory).
- **Transport.** `POST /api/session/marks { target, sign, placed }` (any participant; 64 KiB body as the other routes;
  each field checked at the boundary: `target.*`, `sign`, `placed`) → `{ placed?, removed }`; errors 400
  `MarkNotForTarget`, 403 `FacilitatorDoesNotVote` (also refused before the use case), 404 `MarkTargetNotFound`, 409
  `MarkTargetClosed`. The outbox events reach the pages as `mark.placed` / `mark.removed`; the agent's SSE stream does
  not carry them (not in `AGENT_EVENT_TYPES`), and the agent API is unchanged. `session.state` and `GET
  /api/session/state` carry `marks` (the placed ones), so a late joiner or a reload sees them.
- **Page** (`web/session/marks.ts`, pure and tested; `mark-controls.tsx`). Within the chat's decoration budget: counts
  small and muted, no pills; my own vote in the clickable violet (a filled ♥), never red; reactions as below. Who
  marked is never always shown: the count's tooltip names them, and a click on a vote's count opens a small list (for
  touch). A reaction's click toggles mine, so its names are in its tooltip and, for touch, in the ☺+ popover, which
  lists who placed each reaction under the choices. Participants see a clarification's questions as rows
  with ♡ (no "other": they write in the chat); the facilitator's answer form shows the counts and never preselects.
  After closing, the answer line's tooltip (and the note line of an alternative picked) keeps the counts and names.
  No optimistic change: the server broadcasts the change before it answers; a mark being set is not clickable again
  until then. Votes and reactions are not unread items and notify no one.

### Reactions are emoji (amendment)

*Decided by the maintainer*: the four named reactions (賛成, 疑問, いいね, 了解) gave the app a vocabulary people did not
choose. A reaction is now **any one emoji the participant picks; the app assigns none a meaning** and shows no names.

- **Model.** `MarkSign` is the union `Vote | Reaction { emoji: Emoji }`. The primitive `Emoji` is bounded in the DSL
  (1 to 64 UTF-16 units) and has the declared check `singleEmoji`, implemented by `@domaintrail/modeling/core/emoji`
  (shared by the config, the server and the page): exactly one grapheme (`Intl.Segmenter`), made only of
  `\p{Emoji}` / `\p{Emoji_Component}` characters, with a pictograph (`\p{Extended_Pictographic}`, so ZWJ sequences,
  skin tones and tag sequences), a flag (two regional indicators) or a keycap; at most 64 UTF-8 bytes. Text, a lone
  component, a digit and two emoji are refused at the boundary (400 `sign.emoji`).
- **Normalization.** An emoji is kept NFC and **fully qualified**: every VS16 (U+FE0F) is dropped, then added back after
  each emoji character whose default presentation is text (`\p{Emoji}` without `\p{Emoji_Presentation}`) unless a
  skin tone follows. So ❤ and ❤️ (and 1⃣ / 1️⃣, 🏳‍🌈 / 🏳️‍🌈) are the same reaction, kept in the form the emoji pickers
  insert and every platform draws as an emoji. The route normalizes what it is sent; `Emoji` accepts only the kept
  form, so two forms never reach the store.
- **Limit.** At most `MAX_REACTION_EMOJI` (20) different emoji on one message or turn: a new 21st is refused by
  `setMark` with `ReactionLimitReached { limit }` (409); joining an emoji already there always works, and taking the
  last of one off makes room. The page disables the choices that would not fit.
- **Wire.** `sign` is `{ "kind": "Vote" }` or `{ "kind": "Reaction", "emoji": "👍" }` — the generated union as JSON,
  like `target` — in `POST /api/session/marks` and in `mark.placed` / `mark.removed`. `session.state` also carries
  `quickReactions`.
- **Persistence.** The `sign` column holds `signKey(sign)`: `Vote` or the emoji, so the unique partial index is one
  placed mark per participant, target and emoji. Migration 6 (after the replies' 5) rewrites a database's marks and
  its outbox's `MarkPlaced` / `MarkRemoved`: Agree → 👍, Doubt → 🤔, Like → ❤️, Seen → 👀, a vote's `"Vote"` → `{ "kind":
  "Vote" }`; the mapping is one to one, so the index holds (tested on a database built with migrations 1 to 4).
- **Config.** `session.quickReactions`: the emoji ☺+ offers first, 1 to 8, each one emoji, distinct after
  normalization; default 👍 👀 🤔 🎉 ❤️ 🙏. Any other emoji can be typed or pasted in ☺+'s ＋ field (no emoji-picker
  library: the OS picker works in the field); Enter adds it, Escape closes the field.
- **Page.** Reactions are drawn as colored emoji — an exception to the decoration budget, since the emoji is the
  content — each with a small muted count and no pill, in the order each first appeared. Mine, which colour can no
  longer say, has its count in violet and a faint violet outline and background. The tooltip is the emoji and the
  names.

## Appendix: replies to runs (amendment)

*Decided by the maintainer*: people answer what the AI did by replying to its turn, and the agent sees what it is
answered about. Until now a run's input held only the request texts, the facilitator's note and an answer's question
and choices — never the previous run's reply or changes, even when answering.

- **A reply is a message.** `Request.replyTo?: AgentRunId` (`references … -> AgentRun`), copied into the frozen input
  (`FrozenRequest.replyTo?`) and `RequestSent.replyTo?`. `send` takes the verified `ReplyableRun` (made in
  `application/verifications.ts`: `RunNotFound`, `RunOfAnotherSession`, `RunNotReplyable`): a run of the same session
  that ended — `Completed`, `Failed`, `Declined`, `Cancelled` (`REPLYABLE_STATES`). Not `Queued` or `Running` (nothing
  to reply to yet) and not `NeedsClarification`, which has its answer form and votes. Anyone may reply; whether a reply
  runs is decided as for any message: classified (a thank-you reads as talk), applied by the facilitator (one at once,
  several as one run; the facilitator's own reply like the participants' in collab mode). No new state or entity.
- **API.** `POST /api/session/requests` takes `replyTo` (a UUID, `InvalidInput` with the field; 404 `RunNotFound` /
  `RunOfAnotherSession`, 409 `RunNotReplyable`), with `apply` too.
- **Persistence.** Migration 5 adds `requests.reply_to` (a foreign key to `agent_runs`, indexed when set): the database
  refuses a reply to a run it does not hold. Rows written before have `NULL` and load unchanged (the JSON field is
  optional); tested on a database built with the first four migrations.
- **Previous runs** (`domain/previous-runs.ts`, pure). The runs a run continues are those its requests reply to, then
  the run its answer answers (`previousRunIds`, each once, in the input's order): the input names them only, frozen at
  queueing. What they changed is measured when the run starts: the use case `previousRuns({ run, maxDiff })` compares
  each one's base and result revisions with `compareRevisions` (its bounds apply) and `boundChanges` gives, in order, a
  run whose whole unified diff (`--- a/…`/`+++ b/…` per file) fits what is left of the budget its diff, any other its
  changed files with the lines added and removed (`diffOmitted`); a run without a result revision (cancelled, failed
  before its end) is `unrecorded`; missing blobs give the files without diff. The budget is
  `session.agent.maxPreviousRunDiff` (default 20480 characters, all previous runs of one run together), next to the
  agent's other settings.
- **Agent API.** `POST /agent/runs/:id/start` answers `previousRuns: [{ run, changes }]` (`AgentStartedBody`) with the
  running run and its base revision: the subscriber needs no blob or revision access, and the API stays on its loopback
  listener with its credential.
- **Prompt.** The block gains `previousRuns` — each `{ number, requests (numbered, as its prompt numbered them),
  facilitatorNote?, outcome, failure?, yourReply? { summary, requests: [{ request, status, note? }], questions?,
  assumptions? }, yourQuestion?, changes }` with `changes` the `{ files, diff }`, `{ files, linesAdded, linesRemoved,
  diffOmitted }`, `"no file changed"` or `"not recorded …"` — and a request that replies gets `inReplyToPreviousRun: n`,
  an answer `questionsAskedInPreviousRun: n`. Rule 9 says they are context, that the current files are the truth and
  other runs may have happened since, and never to re-apply an old diff. Everything stays in the delimited JSON block as
  data (`<` and `>` escaped).
- **Cards.** A run joins the unit of the run its answer answers, else of a run its requests reply to (the latest such
  unit when they reply to several), else as before (`history.ts`); the unit keeps its place and its "updated" pill. The
  votes of a run close when a later run bundles a reply to it (`laterRunOf`), consistent with the card it continues.
- **Page** (`web/session/replies.ts`, pure and tested). ↩ at the far right of an AI turn (after ☺+), on hover or focus,
  faint on touch, for the turn's latest run when it is replyable; a click puts `↩ AI #3 への返信 ✕` above the composer
  (✕, or Esc on an empty text, cancels) and adds the run's requests' targets to the composer's chips. The posted reply
  shows `↩ AI #3: <head of the summary>` on one muted line at its top (plain text, cut to the room), a click jumping to
  the card and flashing it. The continuation quotes the replies like other applied messages.

### Picks are recorded (amendment)

*Decided by the maintainer*: the card showed a picked alternative (✓, `選択 name · time → #n`) by matching the later
run's note against the page's note template in each language — a guess that breaks when the template changes or the
note is written by hand. The pick is now part of the frozen input.

- **Model.** `RunInput.pick?: AlternativePick { pickOf: AgentRunId, assumption: Tally, text, alternative:
  ReplyAlternative }`: the assumption by its index in the reply (a reply is immutable once stored; assumptions have no
  key) and the alternative by its key, as `MarkTarget.AssumptionChoice` names them; its text and the alternative are
  copied at queueing, as an answer copies its questions. New errors `RunNotPickable` (the run is not `Completed`, or
  its reply has no assumptions), `AlternativeNotFound` and `PickMismatch` (the requests are not exactly the run's).
- **Use case.** `queueRun` takes `pick { pickOf, assumption, alternative }`: the run must be the session's
  (`RunNotFound`, `RunOfAnotherSession`), and `resolvePick` (`domain/reply.ts`, pure) checks the rest and freezes it.
  The note stays: the agent and the people read it as before.
- **API.** `POST /api/session/runs` takes `pick` (the facilitator only, as any queueing; each field checked:
  `pick.pickOf`, `pick.assumption`, `pick.alternative`); 404 `RunNotFound` / `RunOfAnotherSession`, 409
  `RunNotPickable`, 400 `AlternativeNotFound` / `PickMismatch`.
- **Previous runs and prompt.** `previousRunIds` adds `pick.pickOf` after the runs replied to and the run answered
  (each once), so the agent gets the run it assumed in with its reply and changes; the block gains `pickedAlternative {
  insteadOfYourAssumption, alternative, assumedInPreviousRun? }` and rule 6 says to redo the requests with it.
- **Cards and votes.** `pickedAlternative` (`web/session/decisions.ts`) reads `input.pick` of the run that took over;
  a note is never read as a pick. A pick run joins the unit of `pick.pickOf` (`history.ts`) and closes its votes
  (`laterRunOf`; it bundles the same requests, so this changes nothing but says it).
- **No migration, no fallback.** Run inputs are stored as JSON, so the optional field needs no schema change; a run
  stored before loads unchanged (tested, and on a copy of a live session's database). Runs picked through the note
  only (between the messages appendix and this one, never released) show no ✓: their note line still says what was
  asked.

### Assumptions approved (amendment)

*Decided by the maintainer*: an assumption the AI made had two outcomes, an alternative picked (a run) or nothing. The
facilitator can now also approve it: it stands as the AI made it. An approval sends nothing to the AI; it records who
approved and when, and the card shows it as it shows a pick. An assumption has one decision, never both: approved, or
one of its alternatives picked.

- **Where it belongs.** Four places were weighed. A **mark** (a sign `Approval` on `AssumptionChoice`) reuses the
  table and the events, but a mark is anyone's preference, removable at will, and refused as a vote to the facilitator
  (`FacilitatorDoesNotVote`) precisely because the facilitator's act is the decision; a decision closes the votes, it is
  not one of them. A **field of the run** is ruled out because a run never changes once it ended (the reason `Mark` is
  not on `AgentRun` either). The **input of a run**, where a pick lives, holds what a run is asked; an approval queues
  no run. So an approval is an **aggregate of its own**, `AssumptionApproval`: outside the run as a mark is, the
  facilitator's with who and when as a pick is. It is final, as a pick is: there is no command to withdraw it.
- **Model** (`model/approval.dt`, generated code regenerated). Value `AssumptionRef { references run: AgentRunId ->
  AgentRun, assumption: Tally }` (the assumption by its index in the reply, as `AlternativePick` and
  `MarkTarget.AssumptionChoice` name it). Aggregate `AssumptionApproval { id, session, assumption: AssumptionRef,
  approvedBy, approvedAt }` with one state, `Approved`; `create command approve(id, session: ActiveSession, assumption:
  DecidableAssumption, approvedBy, approvedByRole, approvedAt)` requires `facilitatorApproves` (`FacilitatorOnly`) and
  emits `AssumptionApproved { approvalId, session, assumption, approvedBy, approvedAt }`.
- **One decision per assumption.** The verified `DecidableAssumption` (of `AssumptionRef`, for the session; its factory
  in `application/verifications.ts`) is the evidence that the assumption can still be decided: the run is the
  session's (`RunNotFound`, `RunOfAnotherSession`), completed with assumptions (`RunNotApprovable`, as
  `RunNotPickable`), the index is in its reply (`AssumptionNotFound`), and it is not decided (`AssumptionClosed`): not
  approved, and no later run took over the run's requests (`laterRunOf`: a pick of any of its alternatives is such a
  run). The other way round, `queueRun` refuses a `pick` of an approved assumption with `AssumptionClosed`. The store
  keeps one approval per run and assumption (a unique index), so two facilitator pages racing get one approval and a
  refusal. Approving one assumption leaves the run's other assumptions as they were.
- **Votes.** An approval closes the votes of its assumption (the assumption and its alternatives), as an answer or a
  pick closes theirs: `markTargetStatus` reads the scope's `approvals` (`domain/marks.ts`, the server and the page
  alike).
- **Use case and API.** `approveAssumption { session, actor, run, assumption }` → `POST /api/session/approvals { run,
  assumption }` (the facilitator; each field checked: `run` a UUID, `assumption` an integer ≥ 0) → 201 `{ approval }`;
  403 `FacilitatorOnly`, 404 `RunNotFound` / `RunOfAnotherSession`, 409 `RunNotApprovable` / `AssumptionClosed`, 400
  `AssumptionNotFound`. The event reaches the pages as `assumption.approved`; the agent's stream does not carry it (not
  in `AGENT_EVENT_TYPES`) and the prompt is unchanged. `session.state` and `GET /api/session/state` carry `approvals`.
- **Persistence.** Migration 8 adds `approvals` (`run_id` a foreign key to `agent_runs`, `assumption`, JSON `data`),
  unique on `(run_id, assumption)`. Nothing else changes: a database of the version before is upgraded in place and its
  sessions have no approvals; a page given a state without `approvals` reads none.
- **Page** (`web/session/decisions.ts`, pure and tested). `assumptionDecision(run, index, runs, approvals)`: open,
  approved (who, when) or picked (the alternative, who, when, the run it queued). The card shows each assumption as the
  AI's text; the facilitator approves it (✓ 承認) or sends it again with an alternative (送り直す in the alternative's
  card, as a pick did). Once decided: ◉ on what was chosen, the rest muted, and `承認 name · time` or `送り直し name ·
  time` (the time a link to the run it queued).

## Appendix: mentions of people (amendment)

*Decided by the maintainer*: in the composer `#` names elements (what `@` did) and `@` names people, so that a
participant can call someone's attention to a message. Run references by `#3` were considered and dropped.

- **Tokens** (`domain/body.ts`, pure, read the same way by the page, the prompt and the classifier). `#name[n]` is
  target n of the request; `@name[n]`, as bodies were written before, still reads as target n — nothing stored is
  rewritten, and a legacy body renders as the new one does. `@name[pN]` is the N-th person of the request's `mentions`.
  The full-width `＃` and `＠` count; a name has no spaces, brackets, `#` or `@`; a token whose number the request does
  not have is text. A person written with `#` is not a token.
- **Model.** `Request.mentions: ParticipantId[0..20]` and `RequestSent.mentions`, invariants `atMostTwentyMentions`
  and `distinctMentions`. `send` takes the verified `MentionableParticipant` (`MentionedNotAParticipant`): anyone who
  joined the session, online or not, the facilitator too. Not frozen into the run's input: the agent only reads the
  name. **No migration**: requests are stored as JSON; a request and its `RequestSent` written before read as
  `mentions: []` (`infrastructure/legacy.ts`, tested on the fixture of former rows).
- **API.** `POST /api/session/requests` takes `mentions` (participant IDs): 400 with the field when it is not a list
  of at most 20 distinct IDs, 400 `MentionedNotAParticipant` (also `TooManyMentions`, `DuplicateMention` from the
  command).
- **Prompt and classifier.** Rule 1 says `#name[n]` (`@name[n]` in older requests) means target n and that a plain
  `@name` is a person; the request's body is given with each person as `@name` (`peopleAsNames`), inside the JSON block
  as before. The classifier is given the body with its mentions as names (`plainBody(…, true)`: `#注文[1]` → `注文`).
- **Composer** (`web/session/mentions.ts`). `#` offers the elements as `@` did and writes `#name[n] `. `@` offers the
  others in the session (`mentionablePeople`: online first, then away, by name; the facilitator included; never me,
  nor the facilitator's row while I hold the role), with avatar and name; with no one else (or no session) it opens
  nothing. Picking writes `@name[pN] ` and adds the person to the composer's `people` (kept in the draft); deleting
  every mention of a person forgets them and renumbers the rest, as chips do. The list is capped to the room above the
  text, so it never covers the chat's header however tall the composer is.
- **Stream.** An element reads `#注文` (a link, as before); a person `@佐藤` by their name now, a violet link (it does
  something: it opens the participants at their row, the offline part opened when they are away, the row flashed),
  kept on one line. A message that mentions me (`mentionsMe`: it names me, or the facilitator while I hold the role;
  never my own) has a faint `--blue-wash` background with a thin `--blue-tint` edge in my stream only — not violet,
  which is what can be clicked, nor amber, which is a question waiting for an answer. While the chat is closed, its
  launcher shows `@ n` (`unreadMentions`: messages since the chat was last shown that mention me) in place of the count
  of new items, and its label says so. Nothing else notifies.
- **Solo.** Without a session there is no chat; in a session alone, `@` offers no one.

## Appendix: cards named, not numbered (amendment)

*Decided by the maintainer*: participants read a card — a run and the runs that continue it (answers, picks, replies,
the same messages applied again) — as one chunk of change. Run numbers meant nothing to them (`#1–2` in 履歴,
`AI #1–2 · 19:21 · name`, `✓ #2`, `↩ AI #3: …`, `→ #5`).

- **The AI names its runs.** `AgentReply.title?: Text` (`model/agent-run.dt`, generated code regenerated): a short
  title of what the requests are about. `REPLY_LIMITS.title` (30 characters) bounds it, `REPLY_LIMITS.titleAim` (20) is
  what the prompt asks for ("about 20 characters, in the requests' language"); `readReply` takes it optional, trimmed,
  on one line (no line breaks, no control characters); `replyJsonSchema` requires it of the agent; what is kept of an
  invalid done or declined reply includes the title, whitespace folded to one line and cut to the limit. Replies stored
  before have none: no migration (replies are JSON in the run).
- **A card's name** (`unitName`, `web/session/history.ts`): the title of the card's first run that has one — runs that
  continue it never rename it — else the head of the first message its first run applied, on one line, mentions as the
  names they were written with. The stream's AI turn shows `AI · <title> · 19:21` (only a real title: the quotes under
  it already show the message), who queued it in the time's tooltip; continuation runs show their time alone, the
  number in its tooltip.
- **履歴's heading**: the outcome icon, the name and the time span (first run queued → latest change); then, muted, whose
  messages the first run applied (up to two names, else 「佐藤 ほか 2 人の依頼」), how many runs and how many files;
  then the files the card changed (the first three by name and 「ほか n」), a violet link that opens the comparison of the
  revisions before its first run and after its last. The page knows each revision's files and hashes, not its elements,
  so the changes are listed by file; listing the changed elements would need the server to analyse both revisions (a
  follow-up). The comparison's dialog moved out of the チャット tab so that 履歴 opens it too.
- **Elsewhere**: an applied message's mark is the glyph alone (`✓`), the card's name and the state in its tooltip — a
  name on every applied message would crowd the side column and repeat the card's name for each of its messages; the
  reply chip and reference line name the card (`↩ 「請求書の税区分」への返信`, `↩ 請求書の税区分: …`); the "updated"
  pill names the card; a pick's `選択 name · time` links its time to the run it queued (same card), with no number; the
  undo bar says 「実行に入れました」. Revision numbers stay where precision is the point (the card's ⋯, the comparison,
  the restore box).
- **The collab's end summary** titles each change with the same name (`unitTitle` of `web/session/collab.ts` takes
  `unitName`, cut at 60 characters).


## Appendix: replies to messages (amendment)

*Decided by the maintainer*: only an AI turn could be replied to. People answer each other in the chat too ("that's
wrong", "same here"), so a message can now reply to another message: a reader follows which message an answer is
about, and the AI, when such a reply is sent to it, gets the original's words.

- **Model.** The reply target is one value that is exactly one of two, a union (`model/request.dt`): `ReplyTarget {
  Run { references run: AgentRunId -> AgentRun }, Message { references request: RequestId -> Request } }`.
  `Request.replyTo?` and `RequestSent.replyTo?` are a `ReplyTarget`, so a reply cannot name both. `send` takes the
  verified `ReplyableTarget` (of `ReplyTarget`, for the session), which replaces `ReplyableRun`: a command takes one
  value, and a union's variant cannot hold a verified type (M024), so the evidence is of the union. Its factory
  (`application/verifications.ts`) checks a run as before — `RunNotFound`, `RunOfAnotherSession`, `RunNotReplyable`
  (`REPLYABLE_STATES`: ended, not waiting for an answer) — and a message with `RequestNotFound` and
  `RequestOfAnotherSession`: any message of the same session, one's own included, whatever its state.
- **Frozen input** (`model/agent-run.dt`). `FrozenRequest.replyTo?` is a `FrozenReplyTarget { Run { run }, Message {
  request, author, body } }`: a reply to a message copies, at queueing, the original's author and body as they were
  then, so the run's input holds what the agent is told whatever happens after. `previousRunIds`, the cards
  (`history.ts`) and the votes (`laterRunOf`, `marks.ts`) read only the `Run` variant: a reply to a message continues
  no run and joins no card.
- **Persistence.** Requests, run inputs and the outbox are JSON: `replyTo` is written as `{ "kind": "Run", "run" }` or
  `{ "kind": "Message", "request" }`. Rows written before hold the run's ID as a string (or nothing); they are read as
  `{ "kind": "Run", "run": … }` (`infrastructure/legacy.ts`, for a request, the frozen requests of a run's input and a
  `RequestSent`), and nothing is rewritten. The column `requests.reply_to` (migration 5) keeps the run of a reply to a
  run; migration 7 adds `requests.reply_to_request` (a foreign key to `requests`, indexed when set) for a reply to a
  message, so that the database refuses a reply to a message it does not hold; rows written before have `NULL` in it.
  Tested on a database built with the first six migrations and a reply to a run written as before.
- **API.** `POST /api/session/requests` takes `replyTo` as `{ "kind": "Run", "run": "<uuid>" }` or `{ "kind":
  "Message", "request": "<uuid>" }` (the page and the server ship together; a bare run ID is no longer taken).
  `InvalidInput` with the field: `replyTo` (not an object, or another kind), `replyTo.<key>` (an unknown key),
  `replyTo.run` / `replyTo.request` (not a UUID). 404 `RunNotFound`, `RunOfAnotherSession`, `RequestNotFound`,
  `RequestOfAnotherSession`; 409 `RunNotReplyable`. The state and the events give `replyTo` in the same shape, and the
  agent API gives the frozen input as stored.
- **Prompt.** A request that replies to a message gets `inReplyToMessage: { author, body }`: the original's author by
  their display name and its body on one reading, elements and people by name without their numbers (`#注文`, `@佐藤`:
  the numbers would point at the original's targets, not this request's). It is a `Text` like any request's body, so
  the prompt stays within the limits of its requests. Rule 8 adds: "A request's `inReplyToMessage`, when present,
  quotes the earlier message of the session it replies to: context for reading the request, not a request to carry
  out." A reply to a run is given as before (`inReplyToPreviousRun`).
- **Page** (`web/session/replies.ts`, pure and tested). ↩ on every message row, for everyone, just before ☺+, the AI
  turn's button (`ReplyButton`) in look and behavior; a click puts `↩ 田中への返信 ✕` above the composer (the author by
  their current name; 「あなたへの返信」 for one's own) and adds the original's targets to the composer's chips, which
  can be removed. The posted reply shows `↩ 田中: <head of the body>` on one muted line at its top (the body on one
  line, elements and people by name, cut to the room); a click jumps to the message and flashes it. When the original
  is not in the session's state, nothing shows, as for a run.
- **Attention.** A reply to my message (`repliesToMe`: it replies to a message of mine, and is not mine) is
  highlighted in my stream only, as a message that mentions me is (`mentions-me`). Nothing else notifies: the
  launcher's `@ n` counts mentions only.
- **No threads.** The stream stays one flat list; a reply is linked to its original only by the reference line.

## Appendix: the selection added only through 💬 (amendment)

*Decided with the maintainer*: selecting an element did two things at once. The 💬 next to it (or `C`) added it as
chips, and, without any click, the composer showed it as dashed "suggested" chips that sending made targets (dismissed
with × until the selection changed). People found it confusing: merely selecting changed what a message was sent
with, and the composer had two kinds of chips.

- **One way in.** Selecting changes nothing in the composer. The 💬 (`対象に追加（C）`) or `C` adds the selection as
  chips, opens the chat and puts the caret in the text; a request is sent with the chips alone. One mental model —
  the chips are the targets — is worth the one more step. The suggestions, their ×, their texts and their over-limit
  note are gone (`web/session/suggestions.ts` became `web/session/selection.ts`).
- **Added.** When every selected element already is a chip, the 💬 shows a muted ✓ (`対象に追加済み`): it adds
  nothing, and a click only opens the chat and puts the caret in.
- **The inspector.** The same 💬 sits next to the selected element's name in the inspector's heading while a session
  is live, for a selection made outside the canvas (the explorer, search, or an element whose shape is not on
  screen). It adds the element the inspector shows. The inspector takes it as a node to place (`headingAction`), so it
  does not depend on the session.
- **Many chips.** The composer shows its chips in two rows at most: the last item of the second row is `+n` (the
  chips not shown, the latest added), which shows them all, followed by a collapse button; sending collapses them
  again. The rows are measured on the real chips (`collapsedCount`, `web/session/chip-rows.ts`). No count such as
  `1/20` is shown (the chips' aria label keeps it).

## Appendix: the composer's editor (amendment)

*Decided with the maintainer*: the composer was a `<textarea>`, so its text showed the tokens as they are stored
(`#請求書.未払い[7] のとき … @田中[p1] 確認して`), and the chips under it carried numbers to match `[n]`. People read the
tokens as noise and had to match numbers by eye.

- **Inline chips.** The text shows each mention as an atomic chip: an element as `#` and its own name (`ownTokenName`,
  its whole name in the tooltip and as its accessible name), a person as `@name`. The caret steps over a chip as over
  one character, and one Backspace or Delete removes it. The chips under the text lose their numbers (nothing in the
  text shows `[n]` any more); everything else about them stays, the two rows behind `+n` included.
- **The stored text does not change.** `ComposerValue` stays the source of truth and the wire format: the server, the
  model, the drafts, `parseBody` and `bodyText` are untouched. The editor reads a value into lines of text and
  mentions and writes them back to the same text (`web/session/composer-text.ts`, pure, tested for the round trip).
  A mention keeps what it names (the target, or the participant), not its number: the numbers are given when the text
  is written back, so undo and redo bring a deleted mention back with its chip. Deleting the last mention of a chip
  that came from a mention still removes the chip (`editText`).
- **Lexical.** The field is text plus atomic tokens, but a `contenteditable` of our own would have to get IME
  composition, undo and paste right in every browser. [Lexical](https://lexical.dev) (MIT, Meta) handles those and is
  used widely; its plain-text mode is exactly this field. Only its core packages are used: `lexical`,
  `@lexical/plain-text` (which brings `@lexical/clipboard`, `@lexical/selection`, `@lexical/utils`, `@lexical/dragon`,
  `@lexical/extension`, `@lexical/html`, `@lexical/list` and `@preact/signals-core`, all MIT) and `@lexical/history`.
  Not `@lexical/react`, which brings tables, yjs, floating-ui and more: the page binds the editor to React itself in a
  small component (`createEditor`, `setRootElement`, plain text, history, an update listener). Lexical is 0.x, so its
  versions are pinned exactly (0.53.0) and an upgrade is checked by hand (typing, IME, chips, undo, paste) before it
  lands. A mention is an inline `DecoratorNode` whose DOM the node draws itself (no React portal).
- **Kept.** The `#`/`@` candidates and their keys, Enter for a new line and ⌘/Ctrl+Enter to send (`composerKey`),
  the placeholder, the caret put at the end by 💬, `C` and a reply, the drafts, the resizer (the field's height is in
  rows of its line height), the limit of 10,000 characters. While an IME composes, no key picks or sends and the
  candidates do not follow the composing text. Paste inserts plain text only. The field is `role="textbox"`,
  `aria-multiline`, labelled as the textarea was.

## Appendix: what a running run is doing (amendment)

*Decided with the maintainer*: while a run was running, the page could say only 実行中 and the time since it started.
People waited without knowing whether the AI was reading, writing or stuck. The agent now tells, as it goes, what it
is doing, and the page shows it in one line.

- **A small vocabulary, owned by the protocol.** A run's current activity is one of four phases — `reading`,
  `editing`, `checking`, `finishing` — with an optional short subject: a file's path relative to the workspace, or a
  command such as `dt check` (`RunActivity` in `protocol.ts`; the phases and the check of an activity in
  `domain/activity.ts`). Four phases are what a person can follow at a glance, and they are true of any agent: the
  protocol owns them, every agent adapter maps its own events onto them, and the page never sees an agent's raw output
  (nor depends on Claude Code). Anything an adapter cannot map changes nothing. A subject is at most 200 characters on
  one line, without control or bidirectional characters; a path outside the workspace is never reported (the phase
  is, without its subject). The phases are not ordered: a run reads, edits, checks and edits again.
- **Transient.** Like presence, an activity is not part of the model: it is not persisted, makes no event and is not
  in the outbox. The server keeps the latest one per running run in memory (`createRunActivities`, the collaboration
  application) and drops it when the relay reads the event that ends the run (completed, a question, declined, failed —
  a lease that expired too — or cancelled). A page gets every activity held when it connects
  (`session.activities`) and each change as it comes (`run.activity`), all participants alike; it shows the line only
  for a run that is `Running`. A server started again knows none.
- **Reported with the lease, on its own call.** `POST /agent/runs/:id/activity { token, phase, subject? }` → 200 `{}`,
  refused unless the token is the run's live lease and the run is `Running` (`LeaseLost`, `NotAllowed`, 409). It does
  not extend the lease and writes nothing to the database. It is not folded into the heartbeat: the heartbeat runs on
  a timer (a quarter of the lease, 15 s) and renews the lease in the store, while an activity changes at the agent's
  pace and should show within about a second; carrying it there would either delay it by up to 15 s or make each
  change renew the lease. The subscriber reports a change only (the same activity again is not sent), at most once a
  second (the latest waiting one replaces an older one), never waits for it, and logs and ignores a failure; once the
  agent has returned, nothing more is reported for the run.
- **Claude Code** runs with `--output-format stream-json --verbose` (checked against 2.1.316 with a real run): one
  JSON event per line. The adapter reads them as they come and maps the `tool_use` blocks of `assistant` events —
  `Read`, `Grep`, `Glob`, `LS`, `NotebookRead` → `reading` with the file (or the searched path); `Edit`, `MultiEdit`,
  `Write`, `NotebookEdit` → `editing` with the file; a `Bash` command that runs `dt <command>` (the shim) →
  `checking` with `dt <command>`; `StructuredOutput` (the reply of `--json-schema`) → `finishing` — and the `result`
  event → `finishing`. Text blocks are not mapped: an assistant often writes a sentence before its next tool call, so
  only the structured reply marks the end. The result (`structured_output` and `result`) is taken from the stream's
  last `result` event, as before from the single JSON object; output that is not a stream (a JSON object or text, as
  older or fake agents print) is still read as before. stdout is no longer kept whole: only the result event, and up
  to 8 MiB of what is not a stream. Everything else — the arguments, the exit code, cancellation, the shim, the scans,
  no logging of the prompt or the output — is unchanged.
- **The page.** One small line under the quoted messages of the running AI turn in the chat, and under the facts line
  of the running unit in AI の作業: an icon of the phase in the accent color, the phase (`読んでいます`, `書き換えています`,
  `確かめています`, `まとめています`) at strong weight, then the subject in monospace, muted — a file by its last segment,
  its whole path in the tooltip. A change replaces the line with the page's small fade (none with reduced motion).
  There is no line before the first activity, and the status stays `実行中 m:ss`.

## Appendix: changes in the model's words (amendment)

*Decided with the maintainer*: the main users are domain experts. They think in the model and the event storming, not
in files, and `リビジョン #3 → #5` or a line diff of `.dt` files is for engineers. This amends S7's comparison and "cards
named, not numbered".

- **Revisions stay internal words.** The chat and AI の作業 word what they do by the unit of work: a card's ⋯ reads
  この作業の結果を確認済みにする, この作業の前に戻す… and 変更を見る; the restore box, the stream's notices (`… がこの作業の
  結果を確認済みにしました`, `作業の前に戻しました`) and the AI's done line (`完了しました。モデルを変更しました。`) carry no
  revision and no number. A revision's number stays in tooltips and in the engineers' source diff. The revisions, their
  numbers and the API are unchanged.
- **The changes are model elements first.** What a unit changed is listed as the elements it added, changed and
  removed: under a run's text and under a unit in AI の作業, up to three chips (`＋` added, `✎` changed, `−` removed, in
  green, amber and red on a faint wash, then `#` and the element's own name, its whole name in the tooltip; a removed one
  muted and struck through, not a link), `ほか n` for the rest and 変更を見る. A chip goes to the element. 変更を見る opens
  この作業の変更: the unit's name, requesters and time, then 追加 / 変更 / 削除 with each element and what it is
  (`返品 の状態`, `集約`, `返品 のイベント`), a click closing the dialog and going to it; at the bottom, collapsed, ソースの差分
  （技術者向け）, S7's comparison unchanged (validations, files, line diffs). When a side's sources do not parse, the dialog
  says the model could not be compared and opens the source diff.
- **Where they come from.** `GET /api/session/revisions/:before/changes/:after` (any participant) → `ModelChangesBody`:
  each change with its DSL, its target (a `.dt` model ID, or a storming and local ID), its kind, its own name and label,
  its whole name and its owner (the aggregate of a state or a command, the storming of a storming element), and whether
  the comparison is complete. A sibling of the comparison rather than a part of it: every card's line needs the element
  changes, and the comparison carries up to 512 KiB of line diffs. The use case `modelChanges` validates both revisions
  from their blobs (the validator of `dt check`) and keeps the results per revision pair (revisions never change), so a
  card asks once; the page keeps them per pair too.
  - `.dt`: Modeling's `diffModels` on the two models — elements, states and commands by stable ID. A field, a
    parameter, an invariant, a label or a description is not addressable: its change is a change of the element (the
    state, the command) it is in. An aggregate whose own parts did not change is not listed as changed when only its
    states or commands did (those are listed).
  - `.dtes`: every declaration of a storming (events, commands, policies, actors, external systems, aggregates, read
    models, hotspots, timelines, groups) by its storming and local ID, which are stable as `.dt` IDs are; it changed when
    anything but its source ranges did (a timeline not because of its groups' own changes).
  - A side whose `.dt` sources do not parse gives no `.dt` changes, and one where a `.dtes` file does not parse no
    storming changes; the list is then marked incomplete.
