# ADR 0025: M0 refactoring — functional areas as workspace packages, and the Live View split into ports

- Status: accepted, implemented (T1–T8 on `refactor/m0`). The maintainer decided the scope (R0–R5, all of it), the
  layout (the plan's §3 functional areas), how boundaries are enforced (Bun workspace packages), how it lands (one
  integration branch, one pull request) and the access check (one shared check, no authorization hook) (marked
  *Decided by the maintainer*).
- Date: 2026-10-31
- Input: the M0 refactoring plan ("DomainTrail M0 リファクタリング実行計画書"), written against `main` at 0.6.0, before
  Event Storming. Its §0.1 asks to prefer the actual code and to record the differences; this ADR does that against
  `main` with Event Storming merged (#14), and records what the tasks that carried it out (T1–T8) built.

## Context

The plan wants the responsibilities of the code separated so that a later `dt session` can be built on it: the I/O of
the workspace apart from the analysis, the Live View's state apart from HTTP and WebSocket, and the dependencies
checked. It is a refactoring only: the CLI, DSLs, diagnostics, generated TypeScript, HTTP and WebSocket messages and
the page stay the same.

## What the plan assumed, and what the code is (with Event Storming)

| Plan | Code | Consequence |
|---|---|---|
| Files moved behind re-export facades (§0.4) | The package publishes `dist` (the bundled CLI and page) and `schema` only, with no library entry point. | No facades: the contracts are the CLI, `schema/`, the generated code, HTTP, WebSocket and `.domaintrail/layout.json`. |
| `ViewSession`: analysis, layout, diff, state | 520 lines. Also: the git baseline's loading, the layout cache *and its file* (`loadLayouts`/`saveLayouts`, symlink-safe), the stormings' views with incremental layout (`renders`, `matchRenderNodes`), the stale stormings of a broken `.dtes`. | R2 has two infrastructure adapters (layout store, git) besides the engine, and the storming views are part of the view service. |
| `server.ts`: HTTP, WS, Host/Origin, chokidar, refresh | 295 lines. Also a second watcher on the git refs (200 ms) that refreshes only when a git baseline's commit moved, `MAX_BODY`, and the page loaded up front so no request path reaches the file system. | R1 owns both watchers; R3 keeps the asset rule and the body limit. |
| `web/useViewSocket.ts`: to separate | Already a 47-line hook with reconnection. `web/App.tsx` is one 589-line component. | R4 is the split of `App.tsx`. |
| `src/dtes` not mentioned | Modeling (`parse`, `validate`, `link`, `format`, `analyze`, `language/`) and visualization (`project/`, `view/`) in one directory; `src/dtes/ir.ts` holds both the storming IR and the render graph types. | Split by area; `ir.ts` into two. |
| `src/core/config.ts`: types vs loading | Also `src/core/files.ts`, `gitignore.ts`, `lint-hint.ts` do file I/O inside `core`. `config.ts` imports the generator for defaults. | These go to `workspace`; the config's types and validation stay in `modeling`. |
| `src/lsp` not mentioned | 684 lines; uses `SourceScope` and `analyze`. | Presentation, like the CLI. |
| R0 characterization tests | 666 tests. `test/live.test.ts` covers serving, the burst debounce, stale on a syntax error, Host/Origin on WebSocket, layout reuse and persistence; `test/baseline.test.ts` the git baseline on the session. | R0 adds only the gaps (below). |

Imports between areas today (counted with Event Storming): `graph → model`, `layout → graph`, `server → core, dtes,
graph, layout, model`, `web → core, dtes, graph, model, server` (types and pure functions only), `core ↔ model`,
`core ↔ generator`, `dtes → core, model, format, language`. The cycles are all inside what becomes `modeling`.

## Decision

### Packages

A Bun workspace (`workspaces: ["packages/*", "web"]`) with the isolated linker (`bunfig.toml`: `[install] linker =
"isolated"`), so a package resolves what its `package.json` declares from its own `node_modules`. *Decided by the
maintainer* (instead of a test over imports alone, or TypeScript project references). All packages are private and
named `@domaintrail/<area>`; nothing is built per package.

| Package | Holds (from) | Depends on |
|---|---|---|
| `@domaintrail/modeling` (`packages/modeling`) | `language/`, `core/` (analysis, diagnostics, checkers; the config's types, defaults and validation), `model/`, `generator/`, `format/`, `storming/` (the modeling half of `src/dtes`), `langium-config.json` | — |
| `@domaintrail/workspace` (`packages/workspace`) | `ports.ts` (`WorkspaceWatcher`, `GitRefWatcher`), `infrastructure/`: `files.ts` (`SourceScope`, `findDomainFiles`, `loadWorkspace`, `createWorkspaceReader`), `config.ts` (`loadConfig`, `findConfigFile`), `gitignore.ts`, `lint-hint.ts`, `generated-output.ts`, `watchers.ts` | modeling |
| `@domaintrail/visualization` (`packages/visualization`) | `domain/` (`graph/`: graph IR, build, diff, context map; `storming/`: the storming projection and view), `application/` (`view-service.ts`, `ports.ts`, `layout-engine.ts`), `infrastructure/` (`elk.ts` the ELK layout, `file-layout-store.ts`, `git.ts`), `protocol.ts` | modeling |
| `@domaintrail/presentation` (`packages/presentation`) | `cli/` (commands, `ports.ts`), `lsp/`, `http/` (`access.ts`, `routes.ts`, `assets.ts`, `server.ts`), `websocket/hub.ts` | modeling, visualization |
| `@domaintrail/composition` (`packages/composition`) | `cli.ts` (`runDt`, `cliDeps`), `view.ts` (`startViewServer`) | modeling, workspace, visualization, presentation |
| `@domaintrail/web` (`web`) | the page: `app/` (shell, top bar, socket), `view/` (the view's hooks and workspace), `shared/`, the panes | modeling, visualization (types and pure functions only) |

- Presentation does not depend on workspace: what the CLI and the language server need from the disk are ports on
  their side (`CliDeps`, `GeneratedOutput`, `LanguageServerFiles`), wired by composition.
- Each package under `packages/` exposes its sources by subpath, `"exports": { "./*": "./src/*.ts" }`. Imports across
  packages use the package name and no extension (`@domaintrail/modeling/core/analyze`); imports inside a package are
  relative with `.js`. `web` is imported by no package and has no `exports`.
- A package declares every third-party import too. Dev-only: `fast-check` in modeling (`generator/testing/_testing.ts`
  is type-checked and emitted as text into the generated contract tests), `@tldraw/tlschema` in web (types).
- The root package keeps the CLI's published `dependencies` (the bundle's externals), depends on every
  `@domaintrail/*` package (dev) and keeps `test/`; tests import `@domaintrail/<area>/…`. `bin/dt.ts` only calls
  `runDt` from `@domaintrail/composition/cli`. `scripts/build.ts` still bundles one CLI (`dist/dt.js`) and one page:
  the workspace packages are bundled in, the root's `dependencies` stay external.

The isolated linker does not close every hole: a lookup that misses a package's own `node_modules` walks up to the
root's, which holds the published dependencies and every `@domaintrail/*` package. So `test/architecture.test.ts`
checks, for every package in its `PACKAGES` table:

- the package is named `@domaintrail/<area>` and declares exactly the `@domaintrail/*` dependencies of the graph above;
- it imports only builtins, itself and what its `package.json` declares;
- relative imports stay inside the package (except the guide that the CLI embeds as text);
- no `domain/` file imports `application/` or `infrastructure/`; no `application/` file imports `node:*`, `chokidar`,
  `ws` or `elkjs`; only composition imports another package's `infrastructure/`; `web` imports no `infrastructure/`;
  presentation imports neither composition nor workspace; modeling imports no other `@domaintrail/*` package;
- a third-party dependency declared in several manifests (the root and the packages) has the same version spec in each.

### Ports (only where there is I/O)

Defined on the consumer's side, implemented structurally by the adapters:

- Visualization (`packages/visualization/src/application/ports.ts`): `WorkspaceReader` (`readSources()`),
  `GitRevisions` (`resolveCommit`, `sourcesAt`, `listRefs`, `gitDirs`; `UnknownRevisionError`) and `LayoutStore`
  (`load(engine)`, `save(engine, layouts)`, the symlink-safe `.domaintrail/layout.json`). `LayoutEngine` stays as it was.
- Workspace (`packages/workspace/src/ports.ts`): `WorkspaceWatcher.subscribe(onChanged)` reports a `SourceEvent` per
  file (`add`/`change`/`unlink`) and `settled` once a burst is over (80 ms); `GitRefWatcher.subscribe(onChanged,
  relevant)` reports a settled burst of ref changes (200 ms) and drops changes while `relevant()` is false. Both resolve
  with an `Unsubscribe` once the watcher is ready.
- Presentation: `CliDeps` and `GeneratedOutput` (`cli/ports.ts`) for `runCli(argv, io, deps)`, `LanguageServerFiles`
  (`lsp/server.ts`).

`createViewService(deps): ViewService` (visualization `application/view-service.ts`) has a `state` getter, `refresh()`,
`setBaseline(spec)` and `focusGraph(...)`; it holds the caches and the serialization queue in a closure, imports no
`node:*`, `ws` or `chokidar`, and keeps the `previous`/`git` baselines, ghosts, `stale` and the stormings' stale and
incremental layout as they were.

### HTTP and WebSocket

- One access check, `checkAccess(headers, allowedHost): 'ok' | 'forbidden'` (`presentation/src/http/access.ts`: the
  Host allow-list and the Origin rule, unchanged). The server's one entry applies it to the known API paths
  (`/api/state`, `/api/focus`, `/api/git/refs`, `/api/baseline`) and the `/ws` upgrade; not to the `/api/` prefix,
  which would turn today's 404s for unknown paths into 403s. *Decided by the maintainer:* no authorization hook or type
  now; a later authorization is added in that function.
- A route handler per endpoint (`routes.ts`, the body limit), the page loaded up front (`assets.ts`), and the WS hub
  (`websocket/hub.ts`: `handleUpgrade`, `publish`, `close`) with one `encode`, the only place a message becomes what
  goes over the wire. It sends `type: 'update'` `ViewPayload`s only.
- `startViewServer` (`composition/src/view.ts`) wires the adapters, the view service, the hub and the HTTP server and
  subscribes the watchers. `ViewServer.view` (renamed from `session`, which is kept free for a later collaboration
  session) is the `ViewService`; `stop()` releases watchers, timers, sockets and the server.

### Behavior

No change to the CLI, the DSLs, the diagnostics, the generated TypeScript, HTTP, the WebSocket messages or the page
(the R0 tests and snapshots are unchanged). The only intended differences, both in `stop()`: it also clears the git
refs' debounce timer (unsubscribing clears it), and it waits for each watcher to be ready before closing it (the
subscription resolves on readiness).

### Landing

*Decided by the maintainer:* like Event Storming, an integration branch `refactor/m0` from `main`, one worktree and
branch per task (`refactor/m0-tN`), each done by a worker and merged into `refactor/m0` after review, and one pull
request to `main`, squash merged. Each task left the type check, the lint, the tests and the build passing and the R0
snapshots unchanged.

## Tasks

Run in the order T1, T2, T5, T3, T4, T6, T7, T8: T2 → T3 → T4 → T6 in sequence (they change the server and the session
in turn, and T6's moves rewrite every import, so it came after T4), T5 (only `web/`) next to them.

- **T1 (R0):** the tests the refactoring keeps: access checks on every endpoint (HTTP and `/ws`), error answers, git
  refs, the `ViewPayload` keys, `.dtes` updates, `stop()`, and a snapshot of `dt generate ts` for `examples/shop`.
- **T2 (R1):** the workspace's file I/O and config loading out of `core`, `WorkspaceWatcher`/`GitRefWatcher`, and the
  view reading sources through a `WorkspaceReader`.
- **T5 (R4):** `web/App.tsx` into `AppShell`, a top bar and a `ViewWorkspace`, with hooks for the persisted settings,
  the panes, navigation, the graph and the camera; `useViewSocket` unchanged.
- **T3 (R2):** `src/graph`, `src/layout`, the storming projection and view, the session, protocol and git access into
  visualization; the render graph types out of `src/dtes/ir.ts`; `createViewService` over `LayoutStore`,
  `GitRevisions` and `WorkspaceReader`.
- **T4 (R3):** the server into presentation's `http`/`websocket` and `composition/view.ts`; `ViewServer.view`.
- **T6 (R5a):** the modeling sources into `modeling`, the CLI and LSP into `presentation`, and `runCli`'s deps wired by
  `composition/cli.ts` (with `GeneratedOutput`).
- **T7 (R5b):** `src/<area>` to `packages/<area>/src`, the workspace packages and the isolated linker, the build, and
  `test/architecture.test.ts`.
- **T8:** this ADR, `CONTRIBUTING.md`, the extension points below, and Dependabot.

## Extension points for a session

No session exists; this is where a `dt session` would plug in.

- **A package.** `packages/<x>` with its own `package.json` declaring every import (its `@domaintrail/*` dependencies
  and its third-party ones, at the same versions as elsewhere), an entry in `PACKAGES` in `test/architecture.test.ts`
  (and the rules there that name it), and its third-party runtime dependencies also in the root's `dependencies`, so
  that the bundle keeps them external and the published package installs them.
- **Composition.** A command wires its adapters in `packages/composition/src`: next to `startViewServer` (`view.ts`), a
  `start…` of its own, reached from `cliDeps` (`cli.ts`) through a new member of `CliDeps`
  (`packages/presentation/src/cli/ports.ts`).
- **Access.** `checkAccess` (`packages/presentation/src/http/access.ts`) is where authorization goes, for the API and
  the `/ws` upgrade alike; new endpoints are routes in `routes.ts` and are guarded by being in the routes' map.
- **Message routing.** The WS hub (`packages/presentation/src/websocket/hub.ts`) has one `encode` and one `publish`;
  today `ServerMessage` is the `type: 'update'` `ViewPayload`. Another message type widens `ServerMessage` (and the
  page's `web/app/useViewSocket.ts`); messages from the page would be read in `handleUpgrade`.
- **View update notifications.** `ViewService.refresh()` returns the new payload that composition publishes; the
  `WorkspaceWatcher`'s `settled` event (and its per-file events) and the `GitRefWatcher` tell when.
- **Workspace operations.** Reads go through the ports (`WorkspaceReader`, `GitRevisions`, `GeneratedOutput`); writes
  to the sources would get a new port on the consumer's side, implemented in `packages/workspace/src/infrastructure`.
- **The page.** `AppShell`'s `sidePanel` slot (`web/app/shell.tsx`) takes another side panel, with its own pane state.

## Consequences

- Every source file moved; `main` receives the refactoring as one squash commit, so the move commits do not exist
  there and are not listed in `.git-blame-ignore-revs`. A moved file's history is followed with `git log --follow`
  and `git blame -C -C`; the squash commit itself is not ignored in blame, because it also holds real changes.
- A third-party dependency is declared by each package that imports it and, for the CLI's run time, by the root, so
  its version is repeated. Dependabot's `bun` entry for `/` reads the workspaces of the root `package.json`, merges a
  dependency declared in several manifests into one and updates all of them in one pull request; the architecture
  test fails when the copies differ.
- Work in flight on `main` during M0 conflicts with the moves; T7 is the point after which every path is final.
- A future `dt session` adds a package and plugs into the ports, the access check and the WS hub (above), without
  touching `modeling`.
- Out of scope, as in the plan: sessions, requests, presence, agent runs, Cloudflare Access, revision snapshots; `.dt`
  definitions of the modeling core.
