# ADR 0017: Command requirements (`requires`)

- Status: accepted
- Date: 2026-10-23

## Context

ADR 0016 deferred command preconditions. Invariants say what always holds in a state; nothing said when a command is
accepted at all ("the person is one of the policy's approvers", "the order has lines"). Such conditions were written
as comments, or folded into an error name listed in `errors` without saying when it is returned.

Both kinds of condition stay within "structure and contracts": Bool-valued, side-effect-free judgments over the
element's own data, documented and not checked by generated code (ADR 0011). What differs is the data a requirement
sees: the command's parameters and the aggregate as it is before the command.

## Decision

### Form

```dt
command accept(person: PersonId) "受入"
  Reviewing | Escalated -> Accepted
  requires authorizedApprover "承認者である" {
    contains(policy.approvers, person)
  } else NotApprover
  requires noOpenBlocker "未解決の阻害がない" else Blocked   // without an expression
  emits Accepted
  errors Conflict
```

- Grammar: `'requires' name=ID label=STRING? ('{' expr=Expression '}')? 'else' error=[ErrorDecl:QualifiedName]`,
  any number per command, after the transitions and before `emits` / `errors`. The same shape as `invariant`, so the
  expression language, labels, `///` descriptions and the form without an expression carry over.
- Allowed on factories (`create command`) too.
- Names are unique within the command (M002). Without an expression a requirement needs a label or a `///`
  description (M018, extended from invariants). It must be Bool (M008).
- `requires` and `else` are keywords; they are added to `FeatureName` (ADR 0016), so fields and parameters may still
  be named `requires` and `else`.

### `else`

- Required. It names the error the command returns when the requirement does not hold; an unknown error is M007,
  like those of `errors` (both are references to errors of the command).
- The error joins the command's errors. Listing it again in `errors` is allowed; several requirements may share one
  error. The Typed Model's `CommandModel.errors` is the listed errors, then those of `else`, each once, so every
  consumer (generated error type, Live View, dependencies) sees the full set. `CommandModel.requires` holds the
  requirements with their expression (`source`, absent without one) and `error`.

### Scope

The expression sees:

- the command's parameters, always;
- the aggregate's common fields, including those of field sets;
- the fields that **every** source state of the command has, with the same name and the same type (with one source
  state, all its fields);
- for a `create command`, the parameters only (there is no aggregate yet); for an aggregate without states, all its
  fields.

Any other field of the aggregate is M010, with a message that says which states have it. Other aggregates cannot be
referenced (as in invariants, an ID gives no access to the aggregate's state); what a requirement needs from them is
passed as a parameter.

### M019: one meaning per name

A parameter named like a field its command's requirements see is an error, so that a name in `requires` never has
two meanings. The rule applies only to commands with requirements: elsewhere a parameter named like a field
(`changeEmail(email: EmailAddress)`) is common and harmless, since parameters and fields are never mixed in one
expression, and reporting it everywhere would reject existing models for a conflict they cannot have. Adding a
requirement to a command can make M019 appear; the message says to rename the parameter.

### Generated TypeScript

- The command type and its `…ByState` type get one JSDoc line per requirement:
  `@requires authorizedApprover (承認者である) else NotApprover: contains(policy.approvers, person)`; without an
  expression, `…: not expressed in the DSL`.
- The command's error type is the union of `CommandModel.errors` (listed errors, then those of `else`, each once).
- No checks are generated; the hand-written implementation returns the error (ADR 0011).

### Live View

The inspector's 振る舞い tab lists each command's requirements (name and label, the expression or
「DSL では表現していない」, and the `else` error as a link), on the command cards of the aggregate and states and on
the command itself. They are not drawn on the state diagram. The change list sees a changed requirement as a change of
its command. `requires` and `else` are highlighted as keywords.

### Invariant or requirement

- An invariant holds whenever the aggregate is in that state: it describes the state after a transition (an accepted
  review has all required confirmations).
- A requirement decides whether the command is accepted, from its parameters and the current state (the person is
  among the approvers).
- Application-level authorization (the logged-in user's role) is not a requirement. Only when the policy is part of
  the aggregate's state is it a domain precondition.

### Not included

- **Requirements for some source states only** (`requires x in State`): split the command so that each has the
  source states its requirements apply to.
- **A generated generic `<Command>Rejected` error**: every requirement names its error, so that callers can tell the
  reasons apart and the error can carry a payload.
- **Requirements on the state diagram**: the diagram shows transitions; requirements are in the inspector.

## Consequences

- Preconditions are part of the model, the Live View and the generated contract, and their errors are always in the
  command's error type.
- `CommandModel.errors` now includes the errors of `else`; that an error is returned by a requirement is read from
  `requires`.
- Commands with requirements may need a parameter renamed (M019).
- In ADR 0011's direction for generating checks, requirements with an expression are candidates for generated check
  functions over the parameters and the source state, and those without one for slots, like invariants.
