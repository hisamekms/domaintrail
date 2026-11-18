# ADR 0036: Commands in any state

- Status: accepted, implemented
- Date: 2026-11-18
- Amends: [ADR 0019](0019-command-changes-and-decisions.md), [ADR 0035](0035-kind-specific-lifecycles.md)

## Context

A command's generated type takes only its source states (`CancelOrder` takes a `DraftOrder | ConfirmedOrder`). An
aggregate loaded from a store can be in any state, so the application narrows it before every call, and the branch
where the state is not a source state has nowhere in the model to go. One user wrote a dozen such checks by hand, each
returning an error the model does not declare (`RequestNotCancellable`, `CollectionNotAssignable`, …), so the error
catalog, the UI and the API could not be checked against the model. When the narrowing is bypassed (a cast, a value
decoded without checks), `decide` called `undefined` and threw a `TypeError`.

The model already holds the rule: the source states of each command (per kind, ADR 0035). What it lacks is a way to
call a command on an aggregate in any state and get the rejection back as a value.

## Decision

- **No new syntax.** For every command of an aggregate with states that is not a factory, the generator derives from
  the source states (per kind with a lifecycle selector):
  - `<Aggregate>Availability`: data without logic, the source states of each command per kind (`'*'` without a
    selector).
  - `can<Command><Aggregate>(aggregate)`: a type guard, narrowing to the command's input.
  - `<Command><Aggregate>Unavailable` and `<Command><Aggregate>FromAnyState`: the error of a call in another state,
    and the type of the command for an aggregate in any state (its result, or `Err` of the error).
  - `<Aggregate>CommandsFromAnyState`, `anyState<Aggregate>Commands(commands)` and `available<Aggregate>Commands`.
  The behaviour (`isAvailable`, `availableCommands`, `fromAnyState`) is in the runtime, the same for every model; the
  generated functions only pass it the aggregate's data and give the result its type (ADR 0011, 0019).
- **One error, `CommandUnavailable`**, of the runtime: `{ type: 'CommandUnavailable', aggregate, command, state,
  expected }`, with `kind` under a selector. `state` is the aggregate's state, `expected` the command's source states
  for its kind. Its `type` has no context prefix, so it cannot be a declared error's (those are `Context.Name`).
- **The state is checked before the requirements**: the requirements see the fields of the source states.
- **The strict entry stays strict.** The command's own type is unchanged. A state its decision has no handler for is a
  contract violation: `decide` throws an `Error` that names the state and the source states, no longer a `TypeError`.
  This is ADR 0035's "unavailable … is a contract violation" for the strict entry; only the any-state entry reports it
  as a value.
- **Kind and state are different.** A command with no source state for the aggregate's kind can never be called on
  it, since the kind is fixed at creation: through the any-state entry this throws (a caller's bug). Only a state that
  can still change gives `CommandUnavailable`. The guards and `available…Commands` return `false` / leave it out.
- **No generated wording.** Labels stay in JSDoc. Mapping `aggregate` and `command` to an API's error codes or a UI's
  messages is the caller's.
- **What a caller does with the error is not the model's.** A policy that finds its aggregate already moved on may skip
  it or fail; that is code the DSL does not describe (ADR 0022, L3). Because every state rejection has one `type`, such
  code tells them apart from the command's own errors without knowing their names.

## Rejected alternatives

- **`otherwise RequestNotCancellable` on a command**: adds only a name, which the command and the state already
  determine; one line per command that can be forgotten; and a named error is a plain `{ type }` that `requires … else`
  or a verified type may also return, so state rejections could no longer be told apart. It cannot express per-state
  results either (an idempotent cancel of a cancelled request), which would need a design of its own.
- **`state in [...]` inside `requires`**: already rejected by ADR 0017 (split the command by source state); it would also
  restate the transitions.
- **A business error per command, overriding the default**: has no place to fill its fields (the any-state entry is
  generated), and has the same distinguishability problem. It can be added later as a `reason` inside
  `CommandUnavailable` without breaking it.
- **A generic `<Command>Rejected`**, which ADR 0017 rejected because the reasons of requirements must be told apart:
  here there is one reason, carried by `state` and `expected`.
- **Generated messages from labels**: labels are not guaranteed to be verb phrases, and wording belongs to the UI.
- **Contract tests of the any-state entry**: it checks the data before calling the implementation, so they would test
  generated code against itself; the runtime and the generator are tested in this repository instead.
