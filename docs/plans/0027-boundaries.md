# Plan: carrying out ADR 0027 (domain and application boundaries)

The decisions are in [ADR 0027](../adr/0027-domain-and-application-boundaries.md); this plan says how they land. It was
written against `main` at `8a77a8d`; the large pull request in flight (#23) landed as `9f28344`, and T0 reconciled this
plan with the code there: **the input of the work is `main` at `9f28344`**. Where the code differed, the code won and
this plan was corrected (the code map, the notes of T1, T2, T6 and T12, [What #23 changed](#what-23-changed)).

## Landing

*Decided by the maintainer:* as for M0, one integration branch `refactor/boundaries` from `main`, one worktree and
branch per task (`refactor/boundaries-tN`), each done by a worker and merged into `refactor/boundaries` after review,
and one pull request to `main`, squash merged. `main` is merged into the integration branch whenever it moves.

Every task leaves:

- `bun run typecheck`, `bun run lint`, `bun test`, `bun run build` passing;
- the T0 baseline unchanged: generated TypeScript, `dt check` output, Live View payloads, HTTP and WebSocket answers
  (only T12 may change what a use case receives; it keeps every HTTP status and error body);
- the architecture test passing, with no exception added that the task does not list.

## Code map

From `main` at `9f28344` to the layout of ADR 0027. Paths are relative to each package's `src/`.

### `packages/modeling`

| Today | Goes to | Task |
|---|---|---|
| `language/domain.langium`, `language/generated`, `domain-module.ts`, `parser-messages.ts` | `contexts/modeling/src/infrastructure/syntax/` | T8 |
| `storming/storming.langium`, `storming/language/module.ts` | `contexts/storming/src/infrastructure/syntax/` | T8 |
| `model/` (`model.ts`, `build.ts`, `ids.ts`, `usages.ts`, `dependencies.ts`) | `contexts/modeling/src/domain/` (`build.ts`, the AST → model mapping, to `infrastructure/syntax/`) | T8, T9 |
| `core/checker/*` except `tsnames.ts` | `contexts/modeling/src/domain/rules/` | T8; onto the typed model in T10 |
| `core/checker/tsnames.ts`, `generator/naming.ts` | `capabilities/generation/src/core/` | T5 |
| `core/model-index.ts`, `core/types.ts`, `core/labels.ts` | AST helpers for the checkers: `contexts/modeling/src/infrastructure/syntax/` until T10, then removed or folded into the domain | T8, T10 |
| `core/diagnostics.ts`, `core/suggest.ts`, `SourceFile` (from `core/analyze.ts`) | `shared/kernel/` | T3 |
| `core/analyze.ts` (the rest), `isStormingFile` | `capabilities/analysis/` | T4 |
| `core/config.ts` | split by owner (T6); the `sources` section to `capabilities/analysis/`. Since #23 it also holds `session.agent.dt` (checked with `realpathSync`: the only I/O in the file), `session.agent.maxPreviousRunDiff`, `session.quickReactions` and `session.classifier`; see T6 | T6 |
| `core/emoji.ts` (new in #23: one emoji, its normal form, `DEFAULT_QUICK_REACTIONS`) | not Modeling's language: the rule of Collaboration's `Emoji` primitive (`model/mark.dt`) and of `session.quickReactions`. Proposed: `collaboration/src/domain/emoji.ts` in T6, with the `session.quickReactions` section (T8 then moves it with `collaboration/`); the alternative is `shared/kernel` (see Open in the tasks) | T6 |
| `format/format.ts` | `contexts/modeling/src/application/` (formatting) with its printer in `infrastructure/syntax/` | T8 |
| `generator/` (`typescript.ts`, `checks.ts`, `tests.ts`, `testing/`) | `capabilities/generation/src/core/` | T8 |
| `storming/` (`parse`, `validate`, `link`, `format`, `analyze`, `ir`) | `contexts/storming/src/` (`ir`, `validate`, `link` to `domain/`; `analyze` to `application/`; `parse`, `format` to `infrastructure/syntax/`) | T8 |
| `langium-config.json` | one per context (see T8) | T8 |

### Other packages

| Today | Goes to | Task |
|---|---|---|
| `visualization/domain/graph/diff.ts`: `ModelDiff`, `fingerprints`, `diffModels`, `isEmptyDiff` | `contexts/modeling/src/domain/diff.ts` | T7 |
| `visualization/domain/graph/build.ts`: `aggregateDependencies` | `contexts/modeling/src/domain/` (next to `model/dependencies.ts`) | T7 |
| `visualization/domain/storming/semantic.ts`, `trie.ts`: `timelineOccurrences` | `contexts/storming/src/domain/` | T7 |
| `visualization/domain/` (the rest) | `capabilities/visualization/src/core/` | T8 |
| `visualization/application/`, `infrastructure/`, `protocol.ts` | `capabilities/visualization/src/application/`, `adapters/`, `protocol.ts` | T8 |
| `collaboration/` | `contexts/collaboration/` (same inner layout) | T8 |
| `agent/application/`, `infrastructure/` | `capabilities/agent/src/core/`, `adapters/` | T8 |
| `workspace/` | `platform/workspace/` | T8 |
| `presentation/` (`cli`, `http`, `lsp`, `session`, `websocket`) | `apps/dt/src/` (`cli`, `lsp`, `server/{http,session,websocket}`) | T8 |
| `composition/` | `apps/dt/src/` (`main.ts` and the wiring) | T8 |
| `web/` | `apps/web/` (inner layout unchanged in this plan) | T8 |
| `scripts/session-seed.ts`, `scripts/session-seed/` (new in #23; `bun run session:seed`, `test/session-seed.test.ts`) | stays in `scripts/`; its deep imports (agent's application and infrastructure, `composition/subscriber`, collaboration's `domain/reply`, `domain/body`, `protocol`, `infrastructure/session-files`, modeling's `core/config`, workspace's `infrastructure/files`) go through public surfaces (T2) and new paths (T8) | T2, T8 |

## Tasks

```text
T0 → T1 → T2 → T3 → T4 → T5 ─┐
                  T3 → T6 ────┼→ T12 → T8 → T9 → T10 (one checker each) → T11 → T13
                  T3 → T7 ────┘
```

- **T0 — reconcile and baseline.** Check this plan against the code after the large pull request; correct the code
  map. Add what the baseline lacks: the generated TypeScript of `examples/shop` and of `collaboration`, the `dt check`
  output (diagnostics and exit code) over the test fixtures, Live View payloads for `examples/shop` with and without
  stormings. Most exists (`test/live-contract.test.ts` snapshot, `test/collaboration-contracts.test.ts`); add only
  the gaps.
- **T1 — the boundary map (P1).** The map table (kind, upstream, exceptions) for today's packages: `modeling` and
  `collaboration` as contexts, `visualization` and `agent` as capabilities, `workspace` as platform, `presentation`,
  `composition` and `web` as apps. `test/architecture.test.ts` derives its checks from the map and replaces the
  per-package rules; every current violation is an exception entry; a stale exception fails; failures name the rule,
  the ADR and the fix. Since #23 the test's agent rule is no longer "types only": agent imports collaboration's
  `domain/reply` and `domain/body` at run time (listed as exceptions in the test); and collaboration imports
  modeling's `core/emoji` (run time) and `core/config` (the type `ClefModel`), which are not Modeling's published
  language — exception entries until T6. *Found in T1:* the map is `test/architecture/map.ts`. Besides the deep
  imports (117 entries, T2) and `exports: ['./*']` (7 packages, T2), its exceptions are `workspace → modeling` (the
  platform depends on a context: `SourceFile`, the configuration's defaults, `GENERATED_MARKER`; T3, T6),
  `composition → presentation` (an app depends on no other app; T8 merges them) and one I/O import in `modeling/core`
  (`config.ts`: `node:fs`, T6; `node:path` and `node:url` count as pure). No package but an app imports another's
  `infrastructure/`.
- **T2 — public surfaces (P1).** An `index.ts` (and `protocol.ts` where there are wire types) per package; `exports`
  narrowed to `.` and `./protocol`; every deep import replaced. The architecture test checks the `exports`. Deep
  imports also come from outside the packages, which the architecture test does not read: `scripts/session-seed*`
  (see the code map) and the tests (79 files under `test/`, 117 distinct `@domaintrail/*` specifiers, many into
  `infrastructure/`); narrowing `exports` breaks them at typecheck (see Open in the tasks). New since #23 among the
  packages' own: collaboration's `domain/reply`, `domain/body`, `domain/marks` (agent, presentation, web, composition),
  `application/classifier` and `infrastructure/clef` (composition), agent's `application/ports` and
  `infrastructure/dt-shim` (composition), modeling's `core/emoji` (collaboration, presentation, web).
  **T2 (done).** Every package has `src/index.ts` (the `.` export) and `exports` lists only `.` and, for
  collaboration and visualization, `./protocol`; no deep import is left in the packages, web, `bin/`, `scripts/` or the
  tests. An index names what it exports, module by module, in sections: a context's published language first, then
  its use cases, then the adapters an app wires; what moves later is marked with its task (modeling's analysis T4, its
  configuration and emoji rule T6, the syntax for the language server and the generator T8; visualization's diff and
  storming semantics T7). `"sideEffects": false` in modeling, collaboration and visualization keeps what the page does
  not use (Langium, `node:sqlite`) out of its bundle (dist/web unchanged in size); presentation's `lsp/start.ts` keeps
  `dt lsp` loading the language server lazily, as composition's dynamic import of `lsp/server` did. `scripts/session-seed*`
  needed nothing beyond the entries (composition's `readCredential`, collaboration's `readServerAddress`, the agent's
  adapters are what the app wires anyway).
  *The cross-boundary imports that stay (T4, T6):* collaboration's use of modeling's `analyze`/`isStormingFile`,
  `isNormalEmoji` and `ClefModel` now goes through `.` like everything else, so the map gained `published` (the
  modules of modeling's index that are its published language) and the architecture test reads each index.ts to know
  which module an imported name comes from: a context importing a name from outside an upstream's `published` breaks
  `public-surface`, keyed by that module (`@domaintrail/modeling/core/emoji`, as before); a package that is not an app
  importing a name that comes from `infrastructure/` or `adapters/` breaks `foreign-infrastructure` the same way.
  Exceptions: `exports` 7 → 0, `public-surface` 117 → 3 (collaboration → `core/analyze`, `core/emoji`, `core/config`),
  `kinds` 2 and `pure-core-io` 1 unchanged.
  *Tests (decided by the maintainer: unit tests next to the code, integration tests in `test/`, CONTRIBUTING.md).*
  864 tests in 79 files are unit tests now (modeling 308, web 218, collaboration 165, visualization 78, workspace 67,
  agent 26, presentation 2); 385 in 47 files stay integration tests (the baselines, the architecture test, the CLI
  with the composition's adapters, the servers on a port, child processes — `tsc` in `test/typecheck/`, `dt`, `node`,
  `git`, the fake agent — the use cases over the workspace's real snapshot, the scripts). Feature files that tested
  several packages were split by whose code they test. 1234 → 1242 passing (7 todo): two tests that asserted two
  packages at once became two each (a keyword highlighted, and the diff of the change), and the architecture test has
  six more. The T0 baselines changed only their import lines; their snapshots are byte-identical. Some entries export
  a name only an integration or another package's unit test uses (listed in the T2 report); the session server's
  test no longer asserts the page's listing of participants (web/session/page.test.ts does).
- **T3 — the kernel (P2).** `Diagnostic`, `SourceFile`, `Location`, `didYouMean` and the other suggestions into
  `modeling/src/kernel/` (moved to `shared/kernel` in T8). Nothing in the kernel imports Langium.
  **T3 (done).** `core/diagnostics.ts` → `kernel/diagnostics.ts` (`Diagnostic`, `Position`, `Severity`, `RuleId`,
  `hasErrors`, `compareDiagnostics`, `formatDiagnostic`, `jsonDiagnostic`), `core/suggest.ts` → `kernel/suggest.ts`,
  and `kernel/source.ts` for `SourceFile` (from `core/analyze.ts`) and `Location` (from `model/model.ts`). The part of
  `core/diagnostics.ts` that reports on Langium nodes, `DiagnosticSink` (and its `FileResolver`), stays in core as
  `core/diagnostic-sink.ts`: it is the checkers' syntax side (T8: `infrastructure/syntax/`, until T10). Modeling imports
  the kernel relatively; the other packages take the same names from `.` as before, so nothing outside modeling changed
  but `test/guide.test.ts`, which reads the rule IDs from `kernel/diagnostics.ts`. The kernel's files import nothing at
  all today. *In the map:* modeling has `kernel: 'kernel'` (the directory of its sources that is the shared kernel until
  T8) and its `published` no longer lists `core/diagnostics` and `core/suggest`; a context may take what index.ts
  exports from the kernel as it takes an upstream's published language (collaboration takes `Diagnostic`, `RuleId`).
  Two architecture tests more: the rule `kernel` (a kernel file imports only kernel files and the pure builtins; no
  exception) and that index.ts exports every module of the kernel. The `kinds` exception workspace → modeling stays:
  the platform's `SourceFile` is the kernel's now, which a platform may take, but the kernel lies inside modeling until
  T8 makes it `shared/kernel`, and the platform still takes the configuration and `GENERATED_MARKER` (T6). Exceptions
  unchanged: `kinds` 2, `public-surface` 3, `pure-core-io` 1, `kernel` 0. The kernel's unit tests are next to it
  (`kernel/suggest.test.ts`: edit distance and the closest names; `kernel/diagnostics.test.ts`: a diagnostic's text and
  JSON); the hints the checkers give, which go through the analysis, stay in core as `core/hints.test.ts` (was
  `core/suggest.test.ts`). 1242 → 1244 passing (7 todo), the two architecture tests; T0 baselines byte-identical.
  *Left open:* `RuleId` lists Modeling's and Storming's rules (`M…`, `L…`, `S…`) but lives in the kernel because
  `Diagnostic.code` is typed with it (T8: keep it, or a plain code in the kernel and the rule IDs with their contexts).
  `camel` (T5) was not touched.
- **T4 — the analysis split (P2).** `core/analyze` into an analysis of `.dt` alone, the storming analysis taking the
  model, and an orchestrator (`modeling/src/analysis/`, moved to `capabilities/analysis` in T8) that runs both, links
  and adds the generation's checks. `core` no longer imports `storming`.
- **T5 — generation's side (P2).** `checker/tsnames` and `generator/naming` behind the generator; the orchestrator runs
  the TypeScript name check. `checker/events` stops importing the generator (`camel` to the kernel or to the model).
  `core/config` stops importing the generator (T6 takes the options).
- **T6 — configuration by owner (P2).** Each owner defines its section's type, defaults and validation; `composition`
  (later `apps/dt`) composes the schema of `domaintrail.jsonc`; `workspace` reads the file and receives what it needs
  (sources, ignored directories) as values. The resolved configuration and its errors stay as they are. The sections
  #23 added, with the owner proposed by T0 (to confirm in the task): `session.agent.dt` → agent (its adapter
  `infrastructure/dt-shim` runs it; the check that it lies outside the workspace uses `realpathSync` and moves out of
  the pure validation); `session.agent.maxPreviousRunDiff` → collaboration (its `domain/previous-runs` and the agent
  API apply it, despite the section's name); `session.quickReactions` → collaboration, with `core/emoji`;
  `session.classifier` → collaboration (`application/classifier`, `infrastructure/clef`, which imports `ClefModel`
  from `core/config` today). `schema/domaintrail.schema.json` is written by hand and no test compares it with the
  code.
- **T7 — domain knowledge out of visualization (P2).** The items of the code map marked T7. `markLineChanges`, the trie
  and rendering stay.
- **T12 — authorization.** Before T8, to keep the moves last. `Actor` in Collaboration; `dismiss` and the
  facilitator-only operations (confirm, restore, close) get role/participant parameters and `requires` in
  `collaboration/model/*.dt`; regenerate; the use cases build the `Actor` and pass it; the routes map the domain
  errors to the same statuses and bodies as today; the route role table stays as a hint. Since #23: there is no
  dismiss route any more (`POST /api/session/requests/:id/dismiss` answers 404; messages are chat), so the "author or
  the facilitator" rule is enforced nowhere, and the use case `dismissRequest` is called only by tests (see Open in
  the tasks). Two more rules of the work sit in route handlers: only the facilitator applies a message on sending it
  (`POST /requests` with `apply`, `FacilitatorOnly`) and the facilitator does not vote (`POST /marks`,
  `FacilitatorDoesNotVote`). The second is already modelled the way ADR 0027 asks — `Mark.place` takes
  `role: ParticipantRole` with `requires participantsVote … else FacilitatorDoesNotVote`, and `setMark` takes the role
  from the session — but the route answers first, with a `message` the domain error lacks; the bodies are pinned by
  `test/session-errors-contract.test.ts`. Facilitator-only routes today: queue and cancel runs, take, confirm and
  restore revisions, issue a facilitator link, close.
  **T12 (done).** `Actor` in `collaboration/src/application/actor.ts`, built by `actorOf` and passed by `apps/dt` to
  the use cases a person calls; `queue`, `cancel`, `confirm`, `restore` and `close` take the role and `requires` it
  (`FacilitatorOnly`); a manual snapshot is checked by `takeRevision`; votes, apply, the facilitator link, mentions and
  replies are unchanged; `dismiss` and `dismissRequest` are removed (the `Dismissed` state and `RequestDismissed` stay
  for older sessions). Statuses and bodies unchanged (`test/session-errors-contract.test.ts`,
  `test/session-authorization.test.ts`). Decisions per operation: ADR 0027, Authorization, amendment.
- **T8 — the move (P3).** The code map's T8 rows. `modeling` splits into `contexts/modeling`, `contexts/storming`,
  `capabilities/generation`, `capabilities/analysis` and `shared/kernel`; `presentation` and `composition` merge into
  `apps/dt`. Updated with it: `tsconfig.json`, `bunfig.toml` and the root `package.json` workspaces, `scripts/build.ts`,
  `scripts/tree-sitter.ts`, `.github/workflows/*`, `.github/dependabot.yml`, `editors/zed` if it points into
  `packages/`, the map's kinds. One commit per package moved, so that `git log --follow` keeps working.
  **Risk:** both grammars are generated by one Langium project (`packages/modeling/langium-config.json`, output
  `src/language/generated`), so `.dt` and `.dtes` share one generated `ast.ts`. Splitting them needs one Langium
  project per context, or the storming grammar importing the domain grammar's terminals; T8 chooses and records why.
  `docComment` (`core/labels.ts`) is used by both syntaxes; it goes where the grammars' shared parts go.
- **T9 — the typed model for the checkers (P4).** The typed model gains what the checkers read from the AST
  (source locations of every element, member and expression; the expression tree; resolved references), built in
  `infrastructure/syntax`. No checker moves yet.
- **T10 — checkers onto the typed model (P4).** One task per checker (13), any order; each removes its exceptions from
  the map. Diagnostics (rule, message, range, order) stay the same. Done when Langium is imported only under
  `infrastructure/syntax` and the exception list has no syntax entries.
- **T11 — Modeling in its own `.dt`.** `contexts/modeling/model/*.dt` for the typed model (not the AST and its
  mapping), generated code committed in `src/generated`, the domain built on it, a test that fails when generating
  again differs (as `test/collaboration-contracts.test.ts`), and the bootstrap steps.
- **T13 — wrap-up.** `CONTRIBUTING.md` (the package table, the boundary rules, the bootstrap steps), ADR 0027's status
  to implemented, this plan reconciled with what was built.

## What #23 changed

Found by T0 against `9f28344`; the code map and the task notes above carry them.

- New files: `modeling/core/emoji.ts`; collaboration's `domain/{body,marks,previous-runs,reply}.ts`,
  `application/classifier.ts`, `infrastructure/{clef,legacy}.ts`, `model/mark.dt`, migrations 4–6 (in
  `infrastructure/sqlite.ts`); agent's `infrastructure/dt-shim.ts`; most of `web/session/` and some of `web/view/`,
  `web/app/`; `scripts/session-seed*`.
- New cross-package imports: listed under T2. The architecture test gained exceptions for agent → collaboration
  `domain/reply` and `domain/body` (run time).
- `modeling` itself is unchanged apart from `core/config.ts` and `core/emoji.ts`: the cycles, the checkers and the
  rows of the code map hold.
- Configuration: four sections more (T6), and the first I/O in `core/config.ts`.
- Authorization: the dismiss route is gone; marks already use a role parameter and `requires` (T12).

## Baseline (T0)

Tests that every task keeps green; a deliberate change updates a snapshot with `bun test -u` and says why.

| What | Test |
|---|---|
| `dt check` (text and JSON, stream, exit code) over `.dt` only, `.dtes` only, both, broken refs, syntax errors in either language, `examples/shop` | `test/check-contract.test.ts` (fixtures in `test/fixtures/check/`, `test/fixtures/dtes/`) |
| every file `dt generate ts` writes for `examples/shop`, in full | `test/generate-contract.test.ts`; their hashes with `--out`: `test/live-contract.test.ts` |
| Collaboration's generated TypeScript | `test/collaboration-contracts.test.ts` (generating again gives the committed `src/generated`) |
| Live View payloads of `examples/shop` with and without stormings, and after a change | `test/live-payload-contract.test.ts` (readable parts and hashes; `DT_CONTRACT_DUMP=<dir>` writes the payloads to diff); the payload's keys over the server: `test/live-contract.test.ts` |
| HTTP: status and error body of the session routes' refusals; `statusOf` of every error type | `test/session-errors-contract.test.ts`; the rest of HTTP, the WebSocket and the agent API: `test/session-server.test.ts`, `test/session-access.test.ts`, `test/live-contract.test.ts` |

## Open in the tasks

- T5: where `camel` lives (kernel or model).
- T8: one Langium project per context, or a shared grammar part; where `docComment` goes.
- T8 (from T3): whether `RuleId`, the union of Modeling's and Storming's rule IDs, stays in the kernel.
- T11: how much of the typed model the `.dt` can express today; what stays hand-written is listed in the task.
- T6 (from T0): where `core/emoji.ts` goes — Collaboration's domain (proposed) or `shared/kernel` — and the owners of
  the sections #23 added.
- T2 (from T0): how the tests and `scripts/session-seed*` reach what is not public — *decided by the maintainer:* unit
  tests move next to the code and read it relatively; integration tests and the scripts use the entries only (done in
  T2).
- T12 (from T0): `dismiss` has no route since #23 — *decided by the maintainer:* removed (done in T12).
