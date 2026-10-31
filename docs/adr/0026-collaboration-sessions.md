# ADR 0026: Collaboration sessions (`dt session`) — M1

- Status: accepted. Decided by the maintainer: persistence on `node:sqlite` (Node ≥ 22.13), the agent's tools chosen
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
| `packages/agent` | `dt session subscribe`: the SSE client, claim/heartbeat/result, the Claude Code adapter (child process, no shell interpolation) | collaboration (protocol and types) |
| presentation | session HTTP routes (`/api/session/*`), the agent API on its own loopback listener, the WS message union | + collaboration (application, protocol, generated types) — in place since S4 |
| composition | `startSessionServer` (view + session in one HTTP process), `startSubscriber`, CLI wiring | + collaboration (infrastructure; since S4), agent |
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

## Consequences

- Node 22.12 users must upgrade to 22.13 to run any `dt` command (engines).
- Two new packages and their dependencies join the bundle; `dt view` gains nothing at runtime.
- The real Cloudflare Access check is manual until a test environment exists.

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
  claims an `AccessTokenVerifier` returns. Until S8 the only verifier is `createMockAccessVerifier`, and
  `dt session start` refuses the access mode without a verifier. An Access identity joins on first sight
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
