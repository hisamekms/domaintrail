# ADR 0025: M0 refactoring — functional areas as workspace packages, and the Live View split into ports

- Status: accepted. The maintainer decided the scope (R0–R5, all of it), the layout (the plan's §3 functional areas),
  how boundaries are enforced (Bun workspace packages), how it lands (one integration branch, one pull request) and the
  access check (one shared check, no authorization hook) (marked *Decided by the maintainer*).
- Date: 2026-10-31
- Input: the M0 refactoring plan ("DomainTrail M0 リファクタリング実行計画書"), written against `main` at 0.6.0, before
  Event Storming. Its §0.1 asks to prefer the actual code and to record the differences; this ADR does that against
  `main` with Event Storming merged (#14), and fixes the contract between the tasks that carry it out (T1–T8).

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

A Bun workspace with the isolated linker (`bunfig.toml`: `[install] linker = "isolated"`), so a package resolves only
what its `package.json` declares. *Decided by the maintainer* (instead of a test over imports, or TypeScript project
references). All packages are private, named `@domaintrail/<area>`, and expose their sources by subpath (`"exports":
{ "./*": "./src/*.ts" }`); nothing is built per package. `scripts/build.ts` still bundles one CLI and one page.

| Package | From | Depends on |
|---|---|---|
| `packages/modeling` | `src/language`, `src/core` (without the I/O files), `src/model`, `src/generator`, `src/format`, the modeling half of `src/dtes`, `langium-config.json` | — |
| `packages/workspace` | `src/core/files.ts`, `gitignore.ts`, `lint-hint.ts`, the loading half of `config.ts`, the watchers (new) | modeling |
| `packages/visualization` | `src/graph`, `src/layout`, the view half of `src/dtes`, the view service (from `session.ts`), `protocol.ts`, the git baseline (`git.ts`) | modeling |
| `packages/presentation` | `src/cli`, `src/lsp`, HTTP and WebSocket (from `server.ts`) | modeling, workspace, visualization |
| `packages/composition` | wiring per command, `bin/dt.ts` | all of the above |
| `web` (`@domaintrail/web`) | `web/` | modeling, visualization (types and pure functions only) |

Inside a package, `domain/`, `application/` and `infrastructure/` exist where they have content (plan §1.3); a layer
test (`test/architecture.test.ts`) checks what the package graph cannot: no `domain/` file imports `application/` or
`infrastructure/`, no `application/` file imports `node:*`, `chokidar`, `ws` or `elkjs`, and `web` imports no
`infrastructure/`. The root package depends on every package and keeps `test/` (the integration suite, the docs and
the example); tests import `@domaintrail/<area>/…`.

### Ports (only where there is I/O)

- `WorkspaceReader`: `readSources(): Promise<readonly SourceFile[]>` (scope, `.gitignore`, symlinks, root escapes as
  today).
- `WorkspaceWatcher`: `subscribe(onChanged: (event: SourceEvent) => void): Promise<Unsubscribe>`; the 80 ms burst
  debounce stays in the watcher. `GitRefWatcher` the same for the refs (200 ms).
- `LayoutStore`: `load(engine): Promise<LayoutCache>`, `save(cache): Promise<void>` (the symlink-safe write).
- `GitRevisions`: `resolveCommit`, `sourcesAt`, `listRefs` (today's `git.ts`).
- `LayoutEngine` stays as it is.

`createViewService(deps): ViewService` with `state()`, `refresh()`, `setBaseline(spec)`, `focusGraph(...)`; it holds
the caches and the serialization queue in a closure, imports no `node:http`, `ws` or `chokidar`, and keeps `previous`/
`git` baselines, ghosts, `stale` and the stormings' stale and incremental layout as they are.

### HTTP and WebSocket

- One access check, `checkAccess(headers): 'ok' | 'forbidden'` (today's Host allow-list and Origin rule), applied by
  one entry for every `/api/*` request and the `/ws` upgrade. *Decided by the maintainer:* no authorization hook or
  type now; a later authorization is added in that function.
- Route handlers per endpoint, the static assets (loaded up front), the WS hub (`publish`). `startViewServer` wires the
  service, the watchers and the transport, and `stop()` releases watchers, timers, sockets and the server.
- The WebSocket sends `type: 'update'` `ViewPayload`s only.

### Landing

*Decided by the maintainer:* like Event Storming, an integration branch `refactor/m0` from `main`, one worktree and
branch per task (`refactor/m0-tN`), merged into it, and one pull request to `main`. No behavior change in any task;
each task leaves `bun run typecheck && bun run lint && bun test && bun run build` passing and the R0 snapshots
unchanged.

## Task interfaces

**T1 (R0): baseline**
- Owns the new tests: HTTP `/api/*` rejected for a foreign Host or Origin (403), `/api/baseline` and `/api/git/refs`
  over HTTP, `stop()` releasing the port and the watchers, a `.dtes` save pushing an update, a git ref move refreshing a
  git baseline only, and snapshots of `dt generate ts` for `examples/shop` and of the `ViewPayload` keys.
- Owns the dependency map of this ADR (updated if T1 finds more).

**T2 (R1): workspace**
- Owns `src/workspace/` (to become `packages/workspace`): `WorkspaceReader`, `WorkspaceWatcher`, `GitRefWatcher`,
  `SourceScope`, `findDomainFiles`, `loadWorkspace`, `GitIgnore`, `loadConfig`/`findConfigFile`; and the changes to
  `src/server/server.ts` (use the watchers), `src/cli/main.ts`, `src/lsp/server.ts` (imports).
- `config.ts` splits: types, defaults and validation (`ResolvedConfig`, `parseJsonc`, `policyModes`, …) stay for
  modeling; file loading moves.

**T3 (R2): view service** (after T2)
- Owns `src/visualization/` (to become `packages/visualization`): `createViewService`, `LayoutStore` and its file
  adapter, `GitRevisions` and its adapter, `protocol.ts`, `src/graph`, `src/layout`, `src/dtes/project`, `src/dtes/view`
  and the render half of `src/dtes/ir.ts`.

**T4 (R3): HTTP, WebSocket, composition** (after T3)
- Owns `src/presentation/http`, `src/presentation/websocket`, `checkAccess`, `src/composition/view.ts`
  (`startViewServer`).

**T5 (R4): web** (after T1; parallel with T2–T4)
- Owns `web/`: `App.tsx` into an `AppShell`, a `ViewWorkspace` (view, navigation, selection, history), and hooks for
  the camera and the persisted panes; a composition point for a later panel, not the panel. `useViewSocket` keeps
  today's messages.

**T6 (R5a): modeling** (after T1; parallel with T2–T4, but not on `config.ts`, which is T2's)
- Owns `src/modeling/` (to become `packages/modeling`): the moves of `src/language`, `src/core`, `src/model`,
  `src/generator`, `src/format` and the modeling half of `src/dtes` (with the storming half of `ir.ts`), the Langium
  config and generated path. No change to diagnostics, codes or generated output.

**T7 (R5b): packages** (after T2–T6)
- Owns the root `package.json` (workspaces), `bunfig.toml` (isolated linker), each `packages/*/package.json`, the
  `tsconfig` changes, `scripts/build.ts`, `test/` imports, `test/architecture.test.ts`, CI.

**T8: docs** (last)
- Owns `CONTRIBUTING.md` (repository layout, setup), this ADR's status, and the plan's §8.6: the extension points for a
  session (composition, the access check, message routing, view update notifications, workspace operations) as a
  README section or ADR. No session feature.

Dependencies: T1 first. T2 → T3 → T4 in order (they change `server.ts`/`session.ts` in turn). T5 and T6 in parallel
with them. T7 after all of them, T8 last.

## Consequences

- Every source file moves once; `git log --follow` and `git blame -C` still find their history, and the move commits
  go into `.git-blame-ignore-revs`.
- Work in flight on `main` during M0 conflicts with the moves; T7 is the point after which every path is final.
- A future `dt session` adds a package (or a module of `presentation`/`composition`) and plugs into the ports, the
  access check and the WS hub, without touching `modeling`.
- Out of scope, as in the plan: sessions, requests, presence, agent runs, Cloudflare Access, revision snapshots; `.dt`
  definitions of the modeling core.
