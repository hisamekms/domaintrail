# Plan: carrying out ADR 0027 (domain and application boundaries)

The decisions are in [ADR 0027](../adr/0027-domain-and-application-boundaries.md); this plan says how they land. It was
written against `main` at `8a77a8d`; the large pull request in flight (#23) landed as `9f28344`, and T0 reconciled this
plan with the code there: **the input of the work is `main` at `9f28344`**. Where the code differed, the code won and
this plan was corrected (the code map, the notes of T1, T2, T6 and T12, [What #23 changed](#what-23-changed)).

**Status: done.** Every task, T0–T13, is carried out on `refactor/boundaries`; ADR 0027 is implemented, and its
Implementation notes say what differs from its text. The code map below gives where each piece went; the task notes
say how each step went and are kept as written; [Open in the tasks](#open-in-the-tasks) lists every question with its
decision. The packages and the rules as enforced are in `CONTRIBUTING.md` (Boundaries).

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

From `main` at `9f28344` to the layout of ADR 0027, as carried out. Paths are relative to each package's `src/`.

### `packages/modeling`

| Today | Goes to | Task |
|---|---|---|
| `language/domain.langium`, `language/generated`, `domain-module.ts`, `parser-messages.ts` | `contexts/modeling/src/infrastructure/syntax/` | T8 |
| `storming/storming.langium`, `storming/language/module.ts` | `contexts/storming/src/infrastructure/syntax/` | T8 |
| `model/` (`model.ts`, `build.ts`, `ids.ts`, `usages.ts`, `dependencies.ts`) | `contexts/modeling/src/domain/` (`build.ts`, the AST → model mapping, to `infrastructure/syntax/`; `ids.ts`'s `elementIdOf`, which walks the AST, to `infrastructure/syntax/element-id.ts`); the Typed Model's types generated from `contexts/modeling/model/*.dt` into `src/generated` (T11), the helpers by hand in `domain/model.ts` | T8, T11 |
| `core/checker/*` except `tsnames.ts` | `contexts/modeling/src/domain/rules/`, reading the model as written (`domain/source-model.ts`, T9) | T8, T10 |
| `core/checker/tsnames.ts`, `generator/naming.ts` | `capabilities/generation/src/core/` (since T5 `generator/tsnames.ts` next to `generator/naming.ts`; T8 moves them with the generator) | T5, T8 |
| `core/model-index.ts`, `core/types.ts`, `core/labels.ts`, `core/diagnostic-sink.ts` | `contexts/modeling/src/infrastructure/syntax/` (T8); after T10: `model-index.ts` the AST index of the language server and the builders, `labels.ts` its `LabelResolver` (the rules' in `domain/labels.ts`); `types.ts` removed (the static types are `domain/types.ts`); `diagnostic-sink.ts` became `site.ts` (`siteOf`, `FileResolver`), `DiagnosticSink` removed (the rules report through `domain/diagnostics.ts`'s `RuleSink`) | T8, T10 |
| `core/diagnostics.ts`, `core/suggest.ts`, `SourceFile` (from `core/analyze.ts`) | `shared/kernel/` (`modeling/src/kernel/` in T3, `shared/kernel/src/` in T8) | T3, T8 |
| `core/analyze.ts` (the rest), `isStormingFile` | `capabilities/analysis/src/application/analyze.ts` (since T4 `analysis/analyze.ts`); `isStormingFile` to Storming's `domain/files.ts` (T8); Modeling's analysis of `.dt`, `analyzeDomain`, to `contexts/modeling/src/application/analyze.ts` (T8) | T4, T8 |
| `core/config.ts` | split by owner (T6): `capabilities/analysis/src/core/sources.ts`, `capabilities/generation/src/core/config.ts`, `contexts/collaboration/src/application/config.ts`, `capabilities/agent/src/adapters/config.ts`, composed in `apps/dt/src/config/` (T8). Since #23 it also holds `session.agent.dt` (checked with `realpathSync`: the only I/O in the file), `session.agent.maxPreviousRunDiff`, `session.quickReactions` and `session.classifier`; see T6 | T6 |
| `core/emoji.ts` (new in #23: one emoji, its normal form, `DEFAULT_QUICK_REACTIONS`) | not Modeling's language: the rule of Collaboration's `Emoji` primitive (`model/mark.dt`) and of `session.quickReactions`: `contexts/collaboration/src/domain/emoji.ts` (T6, *decided*; T8 moved it with `collaboration/`) | T6 |
| `format/format.ts` | `contexts/modeling/src/infrastructure/syntax/format.ts` (T8: the whole file is the printer, which works on the CST; no use case is left for `application/`) | T8 |
| `generator/` (`typescript.ts`, `checks.ts`, `tests.ts`, `testing/`, `config.ts`) | `capabilities/generation/src/core/` | T8 |
| `storming/` (`parse`, `validate`, `link`, `format`, `analyze`, `ir`, `semantic`) | `contexts/storming/src/` (`ir`, `validate`, `link`, `semantic`, `rule-ids`, `files` to `domain/`; `analyze` to `application/`; `parse`, `format` to `infrastructure/syntax/`) | T8 |
| `langium-config.json` | one per context (see T8) | T8 |

### Other packages

| Today | Goes to | Task |
|---|---|---|
| `visualization/domain/graph/diff.ts`: `ModelDiff`, `fingerprints`, `diffModels`, `isEmptyDiff` | `contexts/modeling/src/domain/diff.ts` | T7 |
| `visualization/domain/graph/build.ts`: `aggregateDependencies` | `contexts/modeling/src/domain/` (next to `model/dependencies.ts`) | T7 |
| `visualization/domain/storming/semantic.ts`, `trie.ts`: `timelineOccurrences` | `contexts/storming/src/domain/` | T7 |
| `visualization/domain/` (the rest) | `capabilities/visualization/src/core/` | T8 |
| `visualization/application/`, `infrastructure/`, `protocol.ts` | `capabilities/visualization/src/application/`, `adapters/`, `protocol.ts` | T8 |
| `collaboration/` | `contexts/collaboration/` (same inner layout; `infrastructure/validator.ts` to the app, `apps/dt/src/wiring/validator.ts`) | T8 |
| `agent/application/`, `infrastructure/` | `capabilities/agent/src/core/`, `adapters/` | T8 |
| `workspace/` | `platform/workspace/` | T8 |
| `presentation/` (`cli`, `config`, `http`, `lsp`, `session`, `websocket`) | `apps/dt/src/` (`cli`, `config`, `lsp`, `server/{http,session,websocket}`) | T8 |
| `composition/` | `apps/dt/src/` (`cli.ts` → `main.ts`; `view.ts`, `session.ts`, `subscriber.ts`, `validator.ts`, `process.ts`, `watcher-hold.ts` → `wiring/`) | T8 |
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
  *Tests (decided by the maintainer: unit tests next to the code, integration tests in `test/`, CONTRIBUTING.md; then
  amended: a unit test may spawn processes and open localhost ports when it tests its package's own adapter or
  output — the numbers below are before that amendment, see "T2 follow-up").*
  864 tests in 79 files are unit tests now (modeling 308, web 218, collaboration 165, visualization 78, workspace 67,
  agent 26, presentation 2); 385 in 47 files stay integration tests (the baselines, the architecture test, the CLI
  with the composition's adapters, the servers on a port, child processes — `tsc` in `test/typecheck/`, `dt`, `node`,
  `git`, the fake agent — the use cases over the workspace's real snapshot, the scripts). Feature files that tested
  several packages were split by whose code they test. 1234 → 1242 passing (7 todo): two tests that asserted two
  packages at once became two each (a keyword highlighted, and the diff of the change), and the architecture test has
  six more. The T0 baselines changed only their import lines; their snapshots are byte-identical. Some entries export
  a name only an integration or another package's unit test uses (listed in the T2 report); the session server's
  test no longer asserts the page's listing of participants (web/session/page.test.ts does).
  *T2 follow-up.* With the amended definition, the tests of one package's own adapter or output that spawn processes
  or serve localhost moved into the packages: the agent's `dt` shim and runner (`infrastructure/dt-shim.test.ts`),
  the JWKS verifier and the Identity API against a local stand-in (collaboration's `infrastructure/identity.test.ts`),
  `tsc` over the generated TypeScript (`test/typecheck/` → modeling's `*.typecheck.test.ts`), and from the integration
  tests what tests Presentation alone (`dt guide`'s topics, the routes' error answers). The use cases over the
  workspace's real snapshot stay integration tests: their symbolic-link and external-change cases exercise the
  workspace's adapter. No entry exports a name only for tests any more: the tests read the diff and the render graphs
  from what the view service sends (over in-memory ports), a storming's IR from `analyze`, the docs' JSONC with Bun's
  reader, each session's database through `openSessionDatabase`, and state the comparison's limits as values. Left
  exported and used only by tests: collaboration's `AccessClaims` and the agent's `AgentApi`, `StreamItem` and
  `WorkspaceFiles` (types in the signatures of exported adapters and of `startSubscriber`), and presentation's
  `statusOf` (imported by the T0 baseline `test/session-errors-contract.test.ts`, which is not changed). Unit tests:
  900 passing and 7 todo in 93 files; integration tests: 352 in 39 files (1252 passing in all, with T3's and T4's).
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
  **T4 (done).** `core/analyze.ts` is Modeling's analysis of the `.dt` sources alone: `analyzeDomain` → `DomainAnalysis`
  (files, documents, index, diagnostics sorted and deduplicated, `syntaxOk`, the model, and `resolveFile`, the document
  URI → path map the later checks report with). `storming/analyze.ts` already took the model (`analyzeStormings(sources,
  model)`) and is unchanged. The project analysis is `analysis/analyze.ts` (`analyze`, `Analysis`, `isStormingFile`, the
  sources by language): `.dt`/`.dtes` by extension → `analyzeDomain` → `analyzeStormings` with its model → the
  generation's checks (`checkTsNames`, M011, run over the index when the `.dt` sources parse; the file stays in
  `core/checker/` until T5) → the diagnostics combined, sorted and deduplicated into the same `Analysis` as before
  (identical results: M011 is reported only by that check and the `.dtes` diagnostics lie in other files, so the order
  of equal keys does not change). `dedupe` went to the kernel (`dedupeDiagnostics`). The cycle `core/analyze → storming →
  core` is gone: `core` imports nothing of `storming/` (Storming still imports Modeling: the model, `core/labels`'
  `docComment`, the grammar, `FormatError`; T8). *In the map:* modeling has `inner` (as `kernel`, the directories that
  are modules of their own until T8): `storming` (becomes contexts/storming; upstream none; `never: ['core/analyze']`)
  and `analysis` (becomes capabilities/analysis; upstream `storming`); the new rule `inner-modules` rejects an import of
  an inner module by the rest of the package (index.ts, the entry, aside), one between inner modules that `upstream`
  does not list, and one of a `never` module (no exception). Collaboration's `public-surface` exception is re-keyed
  `@domaintrail/modeling/core/analyze` → `@domaintrail/modeling/analysis/analyze` (until T8: the validator behind its
  port). Exceptions unchanged: `kinds` 2, `public-surface` 3, `pure-core-io` 1, `kernel` 0, `inner-modules` 0.
  *Tests:* the orchestration's tests (both languages, the shop example with its stormings, M011) are
  `analysis/analyze.test.ts` (was `storming/analyze.test.ts`); `storming/analyze.test.ts` tests `analyzeStormings` with
  a model given and without one; `core/analyze.test.ts` checks that Modeling's analysis takes `.dt` alone and leaves
  M011 to the project analysis. Modeling's `test-helpers.ts` (`check`) and the checker and generator tests that analyze
  `examples/shop` still use the project analysis (T8: per package). 1244 → 1251 passing (7 todo); T0 baselines
  byte-identical. *For T5:* the orchestrator's `generationChecks` is where the generator's checks run; T5 moves
  `checkTsNames` behind the generator and calls it from there (it reads the AST index and reports through
  `DiagnosticSink` with `DomainAnalysis.resolveFile`, both still `core/`'s).
- **T5 — generation's side (P2).** `checker/tsnames` and `generator/naming` behind the generator; the orchestrator runs
  the TypeScript name check. `checker/events` stops importing the generator (`camel` to the kernel or to the model).
  `core/config` stops importing the generator (T6 takes the options).
  **T5 (done).** `camel` is the kernel's (*decided by the maintainer*): `kernel/names.ts`, exported by index.ts like the
  rest of the kernel and taken by `core/checker/events.ts` (the M017 hint) and the generator (`checks.ts`, `naming.ts`'s
  `aggregateParamName`); `naming.ts` keeps `pascal` and the generated names. `core/checker/tsnames.ts` →
  `generator/tsnames.ts` (`checkTsNames`, M011, unchanged), the generator's check that the project analysis's
  `generationChecks` (`analysis/analyze.ts`) calls; nothing in `core/checker/` is generation's any more. Since T6 the
  generator's section of the configuration is `generator/config.ts`, inside the inner module, so no module of the
  package but the analysis (and index.ts) imports the generator. *In the map:* `generator` is an inner module (`becomes:
  'capabilities/generation'`, upstream none, `never: ['core/analyze']`), and `analysis.upstream` gains `generator`; the
  rule `inner-modules` now rejects an import of the generator by the checkers or the rest of `core/`. *The T10
  dependency:* the name check and `naming.ts` read the AST (`language/generated/ast`, `core/model-index`) and report
  through `core/diagnostic-sink`, Modeling's syntax side. The rule lets an inner module import the rest of its package,
  so this is no exception entry (it would be stale); it is written as a comment on the map's `generator` entry: T10 puts
  the check onto the typed model, and T8 leaves generation importing only Modeling's `.`. Exceptions unchanged
  (`inner-modules` 0). *Tests:* the M011 tests moved with the check (`generator/tsnames.test.ts`, through the project
  analysis like the other checker tests until T8); the analysis keeps that the generation's checks run once the `.dt`
  sources parse and not before; `kernel/names.test.ts` is new. The checker tests that call `generateTypeScript` are
  tests and stay (the architecture test does not read tests' imports for `inner-modules`). 1332 → 1333 passing (7 todo;
  unit tests 980 → 981, integration tests 352); T0 baselines byte-identical.
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
  **T6 (done).** *Decided by the maintainer:* the owners proposed above, `session.agent.dt`'s `realpathSync` check out
  of the pure validation into the agent's adapter, and `core/emoji.ts` into Collaboration's domain. `core/config.ts`
  is gone. Each owner exports its section's file type, resolved type, keys (by where they sit in the file),
  `validate…(section, fail)` (`fail` throws; the owner knows no `ConfigError`) and `resolve…(section)`: the analysis
  `sources` and `respectGitignore` (`analysis/sources.ts`, with `DEFAULT_SOURCES`, `IGNORED_DIRS`, `sourceMatcher` and
  `sourceSelection`); the generation `generate` and `lintHint` (`generator/config.ts`, with `RUNNERS` and
  `POLICY_MODES` from the generator itself, `policyModes`, `staysInside` and `unknownTsContexts`; so nothing in `core`
  imports the generator for the configuration any more); Collaboration `identity`, `access` (but its hosts and origins), `maxParticipants`,
  `quickReactions`, `classifier` (`ClefModel` with it) and `agent.maxPreviousRunDiff`
  (`collaboration/src/application/config.ts`; `domain/emoji.ts`, exported from its `.`, which web and presentation now
  use); the agent `agent.allowedTools` (`DEFAULT_AGENT_TOOLS`) and `agent.dt` (`agent/src/infrastructure/config.ts`:
  the settings of its adapters, and the architecture test keeps `node:*` in the agent to `infrastructure/`, which
  `dt`'s paths need; the check that `dt` lies outside the workspace is `checkDtOutsideWorkspace` in `dt-shim.ts`, on the
  shim's `inside`); the app `view`, `session.port`, `session.host`, `session.agent.port` and — *decided by the
  maintainer:* the Host and Origin connection guards are the app's (ADR 0027, Authorization) —
  `session.access.allowedHosts` and `allowedOrigins` (`presentation/src/config/server.ts`; Collaboration and the app
  export their checks of `session.access` by key, run in one order). The composition is `presentation/src/config/` (`config.ts`, `session.ts`):
  the keys merged from the owners, the checks in the former order (the top level's unknown keys, the analysis, the
  generation, `view`, then the session: its keys, port and host, identity and access, the agent's keys, port, tools,
  `dt`, the previous runs' diff, the classifier, the participants, the quick reactions; then the disk check of `dt`),
  `ConfigError` with the file name, `parseJsonc` (not exported: the documentation's tests use `Bun.JSONC` and
  `resolveConfig`), `CONFIG_FILES`, `defaultConfig`, `resolveConfig`, `checkTsContexts`
  and `CONFIG_FILE_FORMAT`. It is in presentation, not composition, because the CLI and the language server read
  `ResolvedConfig` and catch `ConfigError` and an app imports no other app (composition → presentation is the existing
  exception); both become apps/dt in T8. Presentation now declares `agent` (its config section and the adapter's
  check). The workspace receives values: `loadConfig(opts, format)` and `findConfigFile(start, files)` with the
  format from the app, a `SourceSelection` (`matches`, `ignoredDirs`, `respectGitignore`; the app builds it with the
  analysis's `sourceSelection`) for `SourceScope`, `findDomainFiles`, `loadWorkspace`, `createWorkspaceReader`,
  `createWorkspaceSnapshot` and `createWorkspaceWatcher`, and `createGeneratedOutput(marker)` (the app passes
  `GENERATED_MARKER`; the manifest's `staysInside` is the workspace's own). It imports from modeling only the kernel's
  `SourceFile` type. The resolved configuration (values and key order) and every message are unchanged.
  `schema/domaintrail.schema.json` stays hand-written; `presentation/src/config/config.test.ts` checks that it
  describes exactly the composed keys at every level (`generate.ts.contexts.*` included). *In the map:* `public-surface`
  3 → 1 (collaboration → `analysis/analyze`, T8), `pure-core-io` 1 → 0, `kinds` 2 unchanged (workspace → modeling now
  only for the kernel's `SourceFile`, until T8; composition → presentation), `kernel` 0, `inner-modules` 0;
  presentation's upstream gains `agent`. *Tests:* each owner's cases are next to it (`analysis/sources.test.ts`,
  `generator/config.test.ts`, collaboration's `application/config.test.ts` and `domain/emoji.test.ts` — the emoji rule's
  cases, from `domain/marks.test.ts` —, the agent's `infrastructure/config.test.ts` and the `dt` check in
  `dt-shim.test.ts`); the composition's (defaults, key order, the first error across owners, the file name, the schema)
  in `presentation/src/config/config.test.ts`; finding and reading the file in workspace's `config.test.ts` (a format
  of its own); workspace's unit tests give a selection of their own (`test-helpers.ts`). The integration tests take
  `DEFAULT_AGENT_TOOLS` from agent, `ResolvedSessionConfig`, `resolveConfig`, `ConfigError` from
  presentation and pass `sourceSelection()` to the workspace; Modeling's `core/emoji.test.ts` (T2 follow-up) is folded
  into collaboration's `domain/emoji.test.ts`. 1252 → 1330 passing (7 todo); T0 baselines unchanged.
- **T7 — domain knowledge out of visualization (P2).** The items of the code map marked T7. `markLineChanges`, the trie
  and rendering stay.
  **T7 (done).** Into modeling, in the published language (`published` in the map) and exported by its index.ts:
  `model/diff.ts` (`ModelDiff`, `EMPTY_DIFF`, `fingerprints`, `diffModels`, `isEmptyDiff`; T8: `contexts/modeling/src/
  domain/diff.ts`); `model/aggregates.ts`, next to `model/dependencies.ts` (`aggregateDependencies`,
  `AggregateDependency`, and the `owningAggregates` and `soleOwner` it needs, which the Structure View also uses to put
  an entity inside its aggregate's boundary); `storming/semantic.ts`, in the inner module `storming` (imports only
  `storming/ir`; T8: Storming's domain): the semantic graph (`SemanticGraph`, `SemanticEdge`, `SemanticEdgeKind`,
  `semanticEdgeKey`, `firstDeclarations`, `stormingTimelines`, `buildSemanticGraph`) and the occurrences
  (`EventOccurrence`, `timelineOccurrences`). *Judged rendering, kept in visualization:* `markLineChanges` (the rows of
  a drawn node marked against the baseline's graph; `graph/diff.ts` renamed `graph/line-changes.ts`), the prefix trie
  (`trie.ts`: `buildTrie`, its node IDs and sort order) with the step comparison it is keyed by (`Step`, `StepKey`,
  `stepKey`, `stepOf`), `isCausal` (solid or dotted, spec §9.4), `ViewOptions`/`LEVEL_KINDS` (what each level shows) and
  the render graph; visualization's `HELD_KINDS` stays a local copy for its own edges. Visualization's index no longer
  exports `ModelDiff`, `EventOccurrence`, `SemanticEdgeKind`, `buildSemanticGraph`, `firstDeclarations`,
  `stormingTimelines`, `timelineOccurrences` (`diffModels` already left it in the T2 follow-up); visualization
  (`protocol.ts`'s `ModelDiff` too) and web take them from modeling's `.`. Exceptions unchanged (none was T7's): `kinds`
  2, `public-surface` 1, `pure-core-io` 0, `kernel` 0, `inner-modules` 0. *Tests:* the model diff's (`model/diff.test.ts`, from visualization's `graph/diff.test.ts` and
  `graph/build.test.ts`), the aggregates' dependencies (`model/aggregates.test.ts`, from `graph/structure-levels.test.ts`,
  its fixture copied) and the semantic graph's and occurrences' (`storming/semantic.test.ts`, from
  `storming/project.test.ts`, its hand-built IR helpers copied) are modeling's unit tests; two tests that asserted the
  semantic graph and the views at once (R09, R13) became two each. 1330 → 1332 passing (7 todo); T0 baselines
  byte-identical.
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
  **T8 (done).** *Decided by the maintainer:* one Langium project per context, `docComment` in each context's
  `infrastructure/syntax`, `RuleId` split per context, Collaboration's validator behind its port in the app. Eleven
  packages, all `@domaintrail/<name>`:

  | Package | Path | Kind | Upstream |
  |---|---|---|---|
  | `modeling` | `contexts/modeling` | context | kernel |
  | `storming` | `contexts/storming` | context | kernel, modeling |
  | `collaboration` | `contexts/collaboration` | context | kernel, modeling, storming |
  | `analysis` | `capabilities/analysis` | capability | generation, kernel, modeling, storming |
  | `generation` | `capabilities/generation` | capability | kernel, modeling |
  | `visualization` | `capabilities/visualization` | capability | analysis, kernel, modeling, storming |
  | `agent` | `capabilities/agent` | capability | collaboration |
  | `workspace` | `platform/workspace` | platform | kernel |
  | `kernel` | `shared/kernel` | kernel | — |
  | `dt` | `apps/dt` | app | agent, analysis, collaboration, generation, kernel, modeling, storming, visualization, workspace |
  | `web` | `apps/web` | app | analysis (its unit tests only, a devDependency), collaboration, kernel, modeling, storming, visualization |

  *Inside:* Modeling: `domain/` (typed model, dependencies, usages, aggregates, diff, stable IDs, `rule-ids.ts`),
  `domain/rules/` (the checkers), `application/analyze.ts` (`analyzeDomain`: parse, link diagnostics, the rules, the
  model; it still uses Langium's documents, which no rule forbids in `application/`), `infrastructure/syntax/` (grammar,
  generated AST, scoping, parser messages, AST index and `types.ts`, labels and `docComment`, the diagnostic sink, the AST
  → model mapping `build.ts`, `element-id.ts` with `elementIdOf` split from `domain/ids.ts`, and `format.ts`: the
  printer, whole, since formatting has no use case of its own). Storming: `domain/` (`ir`, `validate`, `link`,
  `semantic`, `rule-ids`, `files` with `isStormingFile`, which Collaboration and the analysis take from Storming),
  `application/analyze.ts`, `infrastructure/syntax/` (grammar, parser, printer with its own `FormatError`, its copies of
  the parser messages and `docComment`). Analysis: `application/analyze.ts`, `core/sources.ts`. Generation: `core/` (the
  generator, its config, naming, the name check behind `checkGeneratedNames(domain)`, so the analysis handles no AST).
  Visualization and the agent: `domain/`/`application/` → `core/`, `infrastructure/` → `adapters/` (visualization keeps
  `application/`). `apps/dt`: presentation's `cli/`, `config/`, `lsp/`, its servers under `server/{http,session,
  websocket}`, composition's `cli.ts` → `main.ts` and the rest → `wiring/`.
  *Langium:* `contexts/modeling/langium-config.json` (project `Domain`) and `contexts/storming/langium-config.json`
  (project `EventStorming`), each generating into its own `infrastructure/syntax/generated/`; `bun run langium:generate`
  runs both. The storming grammar keeps its copy of the five `.dt` terminals; `test/grammars.test.ts` (IT) compares the
  two `.langium` files, and Storming's parser test checks its own terminals. The language server's shared services take
  one `AstReflection` merging both generated ones (`DomainTrailAstReflection`; Storming's types all start with `Es`).
  *RuleId:* the kernel's `Diagnostic.code` is `RuleCode` (a string); `ModelingRuleId` (SYNTAX, M…, L…) in Modeling's
  `domain/rule-ids.ts`, `StormingRuleId` (SYNTAX, S…) in Storming's, both published; the diagnostic sink and Storming's
  diagnostics are typed with their own; Collaboration's `LINK_RULES` is a set of `StormingRuleId`; `test/guide.test.ts`
  joins both unions for the rules table and the S examples. Diagnostics text and JSON byte-identical.
  *Collaboration's validator:* `createModelValidator` (the project analysis) is the app's (`apps/dt/src/wiring/
  validator.ts`), implementing `ModelValidator`, now exported by Collaboration's `.`; Collaboration's unit tests analyze
  with Modeling's and Storming's analyses (exported by their `.` as use cases).
  *The kernel* is a kind of its own in the map: every kind may depend on it, it depends on nothing, the rule `kernel`
  applies to the package and the test checks that its index exports every module. `inner` and the rule `inner-modules`
  are gone with the last inner module. A new rule `syntax`: a file under `domain/` or `core/` imports neither Langium nor
  `infrastructure/syntax/` (keyed by the file; `pure-core-layers` leaves those imports to it). `node:path/posix` counts
  as pure, like `node:path`.
  *The T10 exceptions*, the only ones left: `syntax` of modeling, one per checker file that still reads the AST
  (`domain/rules/{commands,events,expressions,field-sets,labels,names,payloads,policies,shared,structure,unions,
  verified}.ts`); generation's `syntax` `core/naming.ts` (Langium's `AstNode`) and `foreign-infrastructure` for what its
  name check and naming take through modeling's `.` (`infrastructure/syntax/generated/ast`, `.../model-index`,
  `.../diagnostic-sink`): *decided in T8*, Modeling exposes them on its `.` until T10 puts the name check on the typed
  model. Removed: `kinds` 2 → 0 (composition → presentation, workspace → modeling), `public-surface` 1 → 0
  (Collaboration → the analysis). *`statusOf`:* still exported by `@domaintrail/dt` for the T0 baseline
  `test/session-errors-contract.test.ts`, unchanged.
  *Tests:* before the moves, each future package's unit tests stopped importing the others': the checkers' tests use
  Modeling's analysis, what they asserted of the generated TypeScript and M011 moved next to the generator (two mixed
  tests became two each), `isStormingFile`'s test to Storming; Storming's terminal comparison with `.dt` became the IT
  above. *Commits:* one per package moved (`git mv`, so `git log --follow` works), plus wiring commits: the tests' split,
  the rule IDs, the validator; Modeling's move is two commits (the move with `domain/ids.ts` as a temporary `syntax`
  exception, then `elementIdOf` to the syntax) so that `domain/ids.ts` keeps its history. `bunfig.toml`, the root
  workspaces, `tsconfig.json`, `scripts/build.ts` (the page at `apps/web`), the lint and format ignores, dependabot's
  comment follow; `scripts/tree-sitter.ts`, the workflows and `editors/zed` name no package path. The tree-sitter
  grammar's comment still names `src/language/domain.langium`: it is hashed by `build-stamp.json` (`bun run tree-sitter`
  rewrites the stamp). 1333 → 1336 passing (7 todo; unit 981 → 983, integration 352 → 353); T0 baselines byte-identical.
- **T9 — the typed model for the checkers (P4).** The typed model gains what the checkers read from the AST
  (source locations of every element, member and expression; the expression tree; resolved references), built in
  `infrastructure/syntax`. No checker moves yet.
  **T9 (done).** *What the checkers read* (the 13 of `domain/rules/` and generation's name check): `names` (M002) the
  duplicates by qualified name and every scope's members, `changes` by index; `shared` (M014) the fragments' `shared`,
  each element's kind and every type reference in it with its target's context; `structure` (M003–M005, M012, M013) the
  fields of owners, states, variants, payloads and parameters with their kind, type target (by identity), `references`
  aggregate, multiplicity and the identity field, `lookupVisible`; `unions` (M015) variants, fields, discriminator and
  the bound enum's values; `field-sets` (M016) members' kinds, the `with` references by index, the fields taken; `verified`
  (M024) `of`/`for` targets and chains, every field; `commands` (M006, M020, M021) transitions and `when` as written and
  resolved, `transitions`/`from`/`to` by index, `changes`, the identity type, `sameField` (types); `events` (M017) emits'
  targets, events' fields with the taken ones; `payloads` (M022) parameters, a parameter's struct fields, the aggregate's
  and its states' fields by outcome, the requirements' and `errors`' references by index; `policies` (M023) the three
  references and `isShared`; `expressions` (M001, M008–M010, M018, M019) the trees with a site for every part
  (`collection`, `operand`, `pattern`, `keys` by index, `left`, `right`, `member`, `body`), a key's text, the regular
  expression as written, invariants' labels and `///`, the scopes and the lookups, the types; `labels` (M002, L001–L003)
  the fragments' labels and terms, every inline label and the term or type a label comes from; generation's M011 the
  generated names per context (elements in order, policies' command by identity, invariants and requirements with or
  without an expression) at `name`, `fieldSets` by index and `event`. Every report is a node plus a property and index
  (`DiagnosticSink`, with the CST fallbacks) and the node's element ID.
  *Added:* `domain/source-model.ts`, **the model as written**: `SourceModel` (fragments with their terms, every element in
  order with duplicates, `byName`, contexts, shared contexts), the twelve element kinds and their members (fields of kind
  `field`/`owns`/`references`, parameters, invariants, states, commands with transitions, requirements, `changes`, emits
  with `when`, `errors`; enum values; variants), `TypeRef`, `Multiplicity`, `Ref<T>` (text as written, the declaration
  it resolves to, its site) and `Expr` (the tree of `ExprModel` with sites and text); a `Site` (file, 1-based `start`
  and `end` of the kernel's `Position`, element ID) for each declaration (`at`), its `nameAt`, `labelAt` and every
  property a rule reports on (`typeAt`, `exprAt`, `baseAt`, `forAt`, `whenAt`, `transitionsAt`, ...); the lookups and
  member helpers of the AST index over it (`lookup`, `lookupVisible`, `duplicates`, `fieldsOf`, `includedFields`,
  `identityField`, `primitiveInvariants`, `typeRefsIn`, ...). `domain/types.ts`: the static types (`Ty`, `baseType`,
  `memberType`, `sameType`, `multiplicityText`, `cardinality`, ...) over it. `domain/diagnostics.ts`: `RuleSink`,
  reporting at a site with the fields of `DiagnosticSink` in the same order and able to share its list. Built by
  `infrastructure/syntax/build-source.ts` (`buildSourceModel`); `siteOf` (`diagnostic-sink.ts`) is what the sink and
  the builder both use; `DomainAnalysis.sourceModel` carries it when the sources parse (built before the rules run).
  Modeling's `.` exports its types and `RuleSink` (not published language).
  *Decisions:* a second model next to the Typed Model, not new fields in `DomainModel`: the Typed Model is the Live View
  payload (a T0 baseline) and the input of `fingerprints`, deduplicated and resolved to names, while the rules need
  duplicates, references as written, declarations by identity and a range per property. `ElementModel.location` is
  unchanged; the kernel's `Location` (lines only) is not a diagnostic's range, so a `Site` is built on its `Position`,
  and the kernel is unchanged. References are the declarations themselves (references resolve to the first of a name,
  as Langium links; the model may have cycles and is never serialized). Two names differ from the grammar because they
  would clash: a verified type's `context` is `for` (`forOptional`, `forAt`), a `references` field's `target` is
  `aggregate`. The helpers are ported now, not by the first checker that needs them, so that the T10 tasks share
  nothing but `analyze.ts`, where each changes its own line; until the last one moves, the AST index's helpers and
  `infrastructure/syntax/types.ts` exist twice. The helpers are not on `.` (the syntax's of the same names are, for the
  language server and generation).
  *Tests:* `infrastructure/syntax/build-source.test.ts` (over examples/shop and a fixture with every construct: every
  AST node but terms blocks, lambda parameters and multiplicities has a site at its range; every reference is a `Ref`
  at its name's range resolved to the declaration at the target's range, 70 in examples/shop; the expression trees
  equal the Typed Model's; the sites of names, labels, `with`, `changes`, `errors` and their element IDs; duplicates and
  unresolved references); `domain/source-model.test.ts` (the helpers); `infrastructure/syntax/types.test.ts` (both
  static types agree for every field and parameter); `infrastructure/syntax/diagnostic-sink.test.ts` (`RuleSink` and
  `DiagnosticSink` give the same JSON); and Modeling's `check` (test-helpers) now fails a rule test when the model as
  written has no site for one of the rules' diagnostics. 1336 → 1354 passing (7 todo; unit 983 → 1001, integration 353);
  T0 baselines byte-identical; exceptions unchanged.
  *For T10:* a checker takes `SourceModel` and a `RuleSink` (`new RuleSink(sink.items)` in `analyzeDomain`, at its
  place in the order) instead of `ModelIndex` and `DiagnosticSink`; `sink.error(code, m, node, 'p', i, hint)` becomes
  `rules.error(code, m, decl.pAt or ref.at, hint)` (a property without index is index 0: `fieldSets[0].at`,
  `from[0].at`). `regexSource` (it reads the CST) is in `rules/expressions.ts` and both builders import it: the
  expressions task moves it into `infrastructure/syntax`. `LabelResolver` (`termFor`, `fieldLabel`) is the labels
  task's to port; `storedTypeText` the verified task's. Generation's task exports the helpers it needs from `.` without
  clashing with the syntax's (the language server keeps `commandsOf` of the AST) and gives `GeneratedName` a site. The
  last task removes `test-helpers`' site check, `infrastructure/syntax/types.ts` and the AST index's helpers the rules
  used; whether the Typed Model is then built from the model as written is open (T11: the model as written is the
  shape of the language, which ADR 0027 keeps out of `.dt`).
- **T10 — checkers onto the typed model (P4).** One task per checker (13), any order; each removes its exceptions from
  the map. Diagnostics (rule, message, range, order) stay the same. Done when Langium is imported only under
  `infrastructure/syntax` and the exception list has no syntax entries.
  **T10 (done).** Four groups in parallel, each moving its checkers in its own commits and changing only its own
  lines of `analyzeDomain` (a checker takes `SourceModel` and a `RuleSink` sharing the analysis's list, at its place in
  the order): *a* `names` (M002), `shared` (M014), `structure` (M003–M005, M012, M013), `unions` (M015); *b*
  `field-sets` (M016), `verified` (M024), `commands` (M006, M020, M021), `events` (M017); *c* `payloads` (M022),
  `policies` (M023), `expressions` (M001, M008–M010, M018, M019), with `regexSource` (it reads the CST) moved to
  `infrastructure/syntax/regex-source.ts`, where both builders put the regular expression as written on their model;
  *d* `labels` (M002 for terms, L001–L003), `LabelResolver`'s `termFor` and `fieldLabel` ported to `domain/labels.ts`
  (a field takes the context it is declared in; one from a field set, that of the field set), and generation's M011:
  the name check and the generated names read the model as written and report through a `RuleSink`,
  `GeneratedName.at` is a `Site` instead of an AST node, Modeling's `.` exports the model's lookups and member helpers
  as the namespace `written` (`written.commandsOf`; flat names would clash with the syntax's `commandsOf` that the
  language server reads), and `DiagnosticSink`, `FileResolver` and the AST index's helpers only generation used left
  `.` (`ast`, `ModelIndex`, `commandsOf`, `LabelResolver`, `docComment`, `elementIdOf` stay for the language server).
  The groups were merged one after the other; each worker compared the diagnostics of its rules side by side, on the AST
  and on the model as written: 0 differences. Every `syntax` exception and
  generation's `foreign-infrastructure` ones are gone: the map has no exceptions left.
  *The cleanup:* parsing, the diagnostics of the syntax and of the links (their hints, M023) and the AST index moved
  from `application/analyze.ts` to `infrastructure/syntax/parse.ts` (`parseDomain`); the analysis imports no Langium
  (`DomainAnalysis.documents` is typed by the syntax's `DomainDocument`) and runs the rules with one `RuleSink` over its
  own list, after the syntax's and the links' diagnostics. The rule `syntax` now also rejects Langium in a non-app
  module outside `infrastructure/syntax/` (an app's language server may use it). Removed, with no users left (grep and
  the typecheck): `DiagnosticSink` (`diagnostic-sink.ts` became `site.ts`: `siteOf` and `FileResolver`, which the
  builders and the parser take; build.ts's copy of `FileResolver` went), `infrastructure/syntax/types.ts` (the Typed
  Model's builder takes `cardinality` and `multiplicityText` from `domain/types.ts`), the AST index's `lookupVisible`,
  `elementsOf`, `duplicates`, getters by kind but `aggregates`, `variantFields` and `identityField` (the helpers it
  uses itself are no longer exported), and the test helpers' site check (`sitesOf`, `ruleDiagnostics`,
  `unsitedDiagnostics`: a rule can only report at a site of the model now). The diagnostics of every analysis the
  tests run (316 distinct, 174 with diagnostics) are the same before and after the cleanup. *Tests:* the labels' port
  added three (`domain/labels.test.ts`); the cleanup removed the site test of `build-source.test.ts`, the two of
  `RuleSink` against `DiagnosticSink` and the comparison of both static types (the test of the static types alone moved
  to `domain/types.test.ts`). 1354 → 1357 → 1353 passing (7 todo; unit 1001 → 1004 → 1000, integration 353); T0
  baselines byte-identical. *Left:* `DomainAnalysis` still carries `documents`, `index` and `resolveFile` (the
  analysis's `Analysis` passes the first two on; `dt generate` reads `documents.length`, the syntax's tests the rest);
  whether the Typed Model is built from the model as written is T11's question.
- **T11 — Modeling in its own `.dt`.** `contexts/modeling/model/*.dt` for the typed model (not the AST and its
  mapping), generated code committed in `src/generated`, the domain built on it, a test that fails when generating
  again differs (as `test/collaboration-contracts.test.ts`), and the bootstrap steps.
  **T11 (done).** *Decided by the maintainer:* T11 may change the Typed Model's shape (it is the Live View payload),
  deliberately and in one commit with every consumer; three DSL additions come first, each in its own commit with
  tests. *The DSL:* (1) the declaration keywords (`context`, `event`, `error`, `errors`, `emits`, `aggregate`,
  `command`, `state`, `owns`, `references`, `enum`, `union`, `entity`, `primitive`, `create`, `shared`, `terms`,
  `invariant`) name fields, parameters, terms, commands and discriminators (`FeatureName`); enum values, variants and
  members after `.` may be any word, the words of expressions and the primitive types included (`ValueName`: a value is
  read only after a `.`, and `BinaryOp`'s `and`, `or`, `implies` and `PrimitiveName`'s values need it). Both grammars
  follow (the tree-sitter test checks both lists); `parser-messages.ts` says "a name" or "a type" instead of every
  keyword that may be one, a keyword read neither way is one error at the keyword saying what may follow (the parser's
  recovery after it is dropped, `parse.ts`), a declaration keyword read as a field's name says that a `}` may be
  missing; the T0 snapshot of `dt check` over a syntax error changed on purpose (two errors became one). (2) M012 lets
  value objects and unions be recursive when each has a finite value (through `?`, a list that may be empty, or a
  union's variant out of the cycle); cycles through entities and aggregates stay errors. The contract tests generate no
  values of recursive types yet (planned: `tests.maxRecursionDepth`): they leave out those arbitraries, those of the
  types holding them and the cases that need one, and `dt generate ts` warns. The walks over nested values already stop
  at a type seen before (a test of the views over a recursive model). (3) value objects take field sets (`with`; M016,
  M014 for shared contexts, M012 through their fields).
  *The Typed Model:* `contexts/modeling/model/*.dt` (`context.dt`: `ElementId` (`id` on String), `QualifiedName`,
  `ContextName` (`primitive`), `Location` (a structural copy of the kernel's: *a later feature imports the kernel's
  context instead*), the field set `Described`; `model.dt`: `DomainModel { contexts, elements }`, `ContextModel`,
  `ElementModel` as a union by `kind` (each kind exactly its parts; the common parts written in every variant, as a
  union takes no `with`), the members; `expressions.dt`: `ExprModel` (recursive), `BinaryOp`, `Quantifier`;
  `analysis.dt`: `ModelDiff`, the dependency types, `ModelingRuleId`), generated into `contexts/modeling/src/generated`
  (committed, `.gitignore` exception; `domaintrail.jsonc` without tests). The domain imports it with `import type` only:
  the map's new `generated` entry and rule (generated code imports only its own files, the rest of its package only its
  types). `test/modeling-contracts.test.ts` (clean, formatted, generating again gives the committed files);
  CONTRIBUTING's Bootstrap. *Hand-written in `domain/`:* the helpers (lookups by ID and name with a cached index, the
  per-kind accessors, `allFieldsOf`, `outcomeFields`, emits, policies, `BINARY_OP_TEXT`), the ID builders
  (`domain/ids.ts`: the one cast to the branded types), the dependencies, the aggregates' dependencies and owners, the
  diff, the usages (`FieldUse` and `Named` stay TypeScript types: they hold references to model values); the Typed
  Model is still built from the AST (`infrastructure/syntax/build.ts`), the model as written stays out of `.dt`.
  *Consumers:* generation, visualization, storming's link, collaboration's targets, `dt show` (its JSON embeds the new
  element shape), the language server (the syntax's `commandsOf` left `.`), the Live View page. Generated TypeScript of
  examples/shop and Collaboration byte-identical; every graph hash of the Live View payload unchanged; the T0 payload
  snapshots changed on purpose (the model's hash only). 1353 → 1372 passing (7 todo; unit 1000 → 1015, integration
  353 → 357). *For T13:* the package table and the boundary rules in CONTRIBUTING (the rule `generated`), ADR 0027's
  status; `editors/zed`'s grammar `rev` points at a commit before the keyword change (point it at the merged commit).
- **T13 — wrap-up.** `CONTRIBUTING.md` (the package table, the boundary rules, the bootstrap steps), ADR 0027's status
  to implemented, this plan reconciled with what was built.
  **T13 (done).** `CONTRIBUTING.md`: a Boundaries section with the package table (path, kind, upstream; a new
  architecture test compares it with the map), the kinds and what each may depend on, and every rule by the name a
  failure gives; Adding a keyword as its own section (every place a keyword lives); the Zed `rev` at a commit of
  `main`. ADR 0027: accepted, implemented, with Implementation notes (what differs from the text: the model as written,
  the kernel as a kind, one Langium project per context, the rules added, the DSL additions, the reshaped Typed Model;
  what is left). This plan: the status above, the code map as carried out, the Open list. Stale comments (the
  tree-sitter grammar's path to the Langium grammar, its stamp rewritten; the subscriber's owner) fixed; the Live View's
  highlighter reads a keyword after `.` as a name. The changelogs have no Unreleased section (`docs/releasing.md`): the
  entries for the next release are listed in [For the next release](#for-the-next-release). *After the merge:*
  `editors/zed/extension.toml`'s `rev` still points at `235dd77`, before the keyword change; point it at the squash
  merge commit on `main` in a follow-up.

## For the next release

The changelogs are written when releasing (`docs/releasing.md`); what this work changes for users, to write then:

- *Added:* the declaration keywords (`context`, `event`, `error`, `errors`, `emits`, `aggregate`, `command`, `state`,
  `owns`, `references`, `enum`, `union`, `entity`, `primitive`, `create`, `shared`, `terms`, `invariant`) may name
  fields, parameters, terms, commands and discriminators, and any keyword (the words of expressions and the primitive
  types included) may name an enum value or a variant and follow a `.` (`Op.and`). A keyword read neither way is one
  syntax error that says what may follow (two errors before).
- *Added:* value objects and unions may be recursive when each has a finite value (through `?`, a list that may be
  empty, or a variant out of the cycle; M012); cycles through entities and aggregates stay errors. The contract tests
  generate no values of recursive types yet, and `dt generate ts` warns about what they leave out.
- *Added:* value objects take field sets (`with`; M016, M014, M012).
- *Changed:* the model in the Live View payload and the elements in `dt show --format json` have a new shape:
  `{ contexts, elements }` lists in declaration order, each element a variant by `kind` with exactly its parts, enum
  values as `{ name, label }`, binary operators as names (`eq`, `and`, ...). Only for anyone reading that JSON; the
  generated TypeScript is unchanged. (*Upgrading* step for readers of the JSON.)
- *Fixed:* the Live View's source highlights a keyword after `.` as a name.
- Internal, one line at most: the code is split into contexts, capabilities, the platform, the shared kernel and apps
  (ADR 0027), with boundaries checked by the architecture test; contributors see `CONTRIBUTING.md`.

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

- T5: where `camel` lives (kernel or model) — *decided by the maintainer:* the kernel (done in T5).
- T8: one Langium project per context, or a shared grammar part; where `docComment` goes — *decided by the maintainer:*
  one project per context, `docComment` in each context's syntax (done in T8).
- T8 (from T3): whether `RuleId`, the union of Modeling's and Storming's rule IDs, stays in the kernel — *decided by the
  maintainer:* split per context, a plain code in the kernel (done in T8).
- T11: how much of the typed model the `.dt` can express today — *decided by the maintainer:* all of what Modeling
  publishes, with three DSL additions and a reshaped Typed Model; what stays hand-written is listed in the task (done
  in T11).
- T6 (from T0): where `core/emoji.ts` goes — Collaboration's domain (proposed) or `shared/kernel` — and the owners of
  the sections #23 added — *decided by the maintainer:* Collaboration's domain, and the owners proposed (done in T6).
- T2 (from T0): how the tests and `scripts/session-seed*` reach what is not public — *decided by the maintainer:* unit
  tests move next to the code and read it relatively; integration tests and the scripts use the entries only (done in
  T2).
- T12 (from T0): `dismiss` has no route since #23 — *decided by the maintainer:* removed (done in T12).
- T9, T10: whether the Typed Model is built from the model as written — left as it is (the Typed Model is still built
  from the AST); recorded in ADR 0027's Implementation notes, Left for later.
- T11: the contract tests and values of recursive types — left out for now, with a warning of `dt generate ts`;
  `tests.maxRecursionDepth` is planned (ADR 0027, Implementation notes).
- T13: the Zed extension's grammar `rev` — set after the merge, at the squash merge commit on `main` (a branch's commits
  are gone once it is squash merged).
