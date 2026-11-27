# ADR 0041: `check`/`verify` boundary, result schema, and exit codes

- Status: proposed
- Date: 2026-11-28
- Amends: [ADR 0024](0024-event-storming-dsl.md) (exit code 1 on any error), [ADR
  0032](0032-dtes-design-level-grammar.md) (severity info and `summary.infos`)

## Context

Today `dt check` uses exit 1 for syntax and content errors, leaving no distinct code for operational errors or required
formal skips. Adding `dt verify` also needs static and formal outcomes in one stable result contract. These exit
changes break scripts that interpret existing codes.

## Decision

Keep `dt check` static, fast, deterministic, and dependency-free. Put bounded and exhaustive model checking in
`dt verify`; it runs `check` first and does not explore after static errors. Both commands use the shared version 2
schema, with `static` or `formal` origin on each diagnostic and result. `verify` may return both origins.

Assign F001–F008 per [Rule code audit and check-kind
codes](../plans/formal-verification/results-schema.md#rule-code-audit-and-check-kind-codes): F001 creation
invariant violation, F002 command invariant violation, F003 unexecutable command, F004 unsatisfiable `requires`,
F005 state or outcome unreachable within scope, F006 reserved, F007 contradictory `ensures`, F008 deadlock.
Codes name the problem and remain stable if a check moves between commands.

Exit codes are 0 (success), 1 (static content error or formal failure/unsupported/inconclusive), 2 (required
skip), and 3 (syntax, I/O, usage, configuration, translation, checker, or result error). Full precedence is 3 >
1 > 2 > 0. `--allow-skip` makes a skip non-failing only when no other failure exists. Static content errors also
exit 1. `verify` runs `check` first and does not explore after static errors.

## Rejected alternatives

- Add `dt check --formal`.
- Add a backend-named command such as `dt tla`.
- Maintain separate schemas and exit codes.
- Treat raw checker process exit codes as result classes.

## Consequences

`SYNTAX` changes from exit 1 to 3; J001 and K001 remain 1; `noCounterexample` exits 0. See [Rule code audit and
check-kind codes](../plans/formal-verification/results-schema.md#rule-code-audit-and-check-kind-codes), [Exit
codes and error reporting](../plans/formal-verification/results-schema.md#exit-codes-and-error-reporting), and
[Architecture and command boundary](../plans/formal-verification.md#architecture-and-command-boundary).
