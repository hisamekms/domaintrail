# Plan: implement ADR 0035

This plan lands [ADR 0035](../adr/0035-kind-specific-lifecycles.md) on integration branch `feat/kind-lifecycles`, based on `origin/main` at `3e56cd52`. The supervisor (SV) owns the integration branch. Each worker starts a branch and worktree from it; the SV reviews and merges the worker branch into the integration branch. This task does not merge into `main`.

## Scope and acceptance

The current generator target is TypeScript. The shared typed model and expression semantics must permit a future Rust generator without deriving lifecycle rules from TypeScript source. No Rust generator is added in this task.

The implementation is done when the CollectionRequest example parses, validates and generates types and contract tests; each kind's GUI graph is reviewable; the generation gate rejects unexpressed decisions and enforces annotated external checks; the existing examples and generated repository models are migrated; typecheck, lint, tests and build pass. The generated `restore` API takes trusted input and does not claim to validate persistence or version migration.

## Tasks

| Task | Owner | Branch | Scope | Dependency |
|---|---|---|---|---|
| T0 | SV | `feat/kind-lifecycles` | ADR and plan, baseline, integration setup | none |
| T1 | WORKER 1 | `feat/kind-lifecycles-t1-model` | grammar, parser, source and typed model, readonly/initial/group/outcome/choice rules, semantic validation, model tests | T0 |
| T2 | WORKER 2 | `feat/kind-lifecycles-t2-generation` | TypeScript contract/runtime/check/test generation, named outcomes, kind-state types, mandatory external slots, restore signature, generator tests | T1 |
| T3 | WORKER 3 | `feat/kind-lifecycles-t3-gate` | `dt check --for-generation`, automatic gate in `dt generate`, target semantic checks, CLI and integration tests | T1 |
| T4 | WORKER 1 | `feat/kind-lifecycles-t4-view` | visualization per kind, outcome and verification display, `dt show`, editor grammar/highlighting, user guide | T1 |
| T5 | SV | `feat/kind-lifecycles` | migrate repository `.dt` models and generated artifacts; integrate worker branches; resolve cross-cutting issues; final verification | T2–T4 |

Workers must commit their changes on their task branches. The SV merges only after reviewing the diff and running the task's focused checks. A worker may report that a task is blocked by a design contradiction; the SV resolves it in ADR 0035 before the worker proceeds. Changes to another task's files are coordinated with the SV. No worker merges into the integration branch.

## Verification

- T1: parser and semantic tests for common and selected transitions, multiple initial states, duplicate names, invalid pairs, choice coverage, and external annotations.
- T2: generated TypeScript type tests and contract tests for both kinds, same-target distinct outcomes, kind preservation, events, required external checks and trusted restore.
- T3: CLI text/JSON diagnostics, exit codes, generation blocked before writes, and a target capability failure.
- T4: graph/protocol tests with and without a selected kind, `dt show` output, editor fixture parsing.
- T5: `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`, then inspect changed generated files and confirm a clean integration worktree.

The SV records any unavoidable limitation in the ADR and the final report rather than presenting it as a completed guarantee.
