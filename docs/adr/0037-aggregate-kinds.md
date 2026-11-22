# ADR 0037: Aggregate kinds

- Status: accepted, implemented
- Date: 2026-11-22
- Supersedes: [ADR 0035](0035-kind-specific-lifecycles.md) (its lifecycle selector: `readonly` enum field and
  `transitions for`; its named outcomes, choice rules, `initial`, `@externalCheck` and restore boundary stay)
- Amends: [ADR 0036](0036-commands-in-any-state.md) (a command not for the aggregate's kind)

## Context

An aggregate often comes in kinds fixed at creation whose fields, rules, commands or lifecycles differ: a pickup site
is a store (store code, closing time) or a distribution center (dock count). The DSL has three partial ways to say so,
and none holds the whole kind:

- `union` holds the fields of each kind, but only as a value: its variant fields are invisible to the aggregate's
  invariants and requirements, a command cannot change one field of a variant, and a variant has no commands.
- A `readonly` enum field with `transitions for` (ADR 0035) holds the lifecycle of each kind, but no fields.
- `state` holds fields, but of a lifecycle that commands move through, not of a kind fixed at creation.

A model whose kinds differ in both fields and lifecycle keeps the kind twice (an enum field and a union) and an
invariant that keeps them equal. Adding a kind touches the enum, the union and every `transitions for`. A command that
only one kind has can only be written as a `requires` on the kind, checked at run time and invisible to the types.

Three AI agents (0.14.0, learning the DSL only from `dt guide`, given a pickup site with a store and a distribution
center, a common suspend and a closing-time change for stores only) found the best the language allows, and its
limits:

- Two kept the kind twice (`readonly kind` for `transitions for`, a `union` for the fields) with an invariant keeping
  them equal, and changed the closing time with `changes details`: the whole union is replaced by a command whose only
  parameter is the new time, and `dt check` cannot tell where the rest of the value comes from.
- One split the site into two aggregates for that reason, repeating the common lifecycle and losing one ID for
  "either site".
- None wrote optional fields guarded by the kind, but all three weighed it. That shape passes `dt check` and
  generates a type of optional fields that no caller can narrow.

AI agents write the DSL (see the AI-first goal): they find the right construct when it is one construct named in the
aggregate's grammar, and when `dt check` points from the wrong shape to it.

## Decision

### `kind`: the aggregate is a discriminated sum of its kinds

`kind` is not inheritance. An aggregate with kinds is a discriminated sum type with a common part: the common fields,
invariants, states and commands hold for every kind; each kind adds its own. Nothing a kind declares overrides,
replaces or narrows something common. Kinds do not nest or extend each other.

```dt
aggregate PickupSite "集荷先" {
  id: PickupSiteId
  name: String
  state Active
  state Suspended
  initial Active

  command suspend() // its outcomes are in every kind's `on suspend`

  kind Store "出荷店舗" {
    storeCode: StoreCode
    closingTime: TimeOfDay
    // its invariants see the common fields and this kind's fields
    create command registerStore(id: PickupSiteId, name: String, storeCode: StoreCode, closingTime: TimeOfDay) {
      outcome registered: -> Active
        emits StoreRegistered
    }
    command changeClosingTime(closingTime: TimeOfDay) { // for this kind only
      outcome changed: Active -> Active
        changes closingTime
    }
    on suspend {
      outcome suspended: Active -> Suspended
    }
  }

  kind DistributionCenter "配送センター" {
    dockCount: Int
    invariant docksPositive { dockCount > 0 }
    create command registerCenter(id: PickupSiteId, name: String, dockCount: Int) {
      outcome registered: -> Active
        emits CenterRegistered
    }
    on suspend { // a kind's requirement, after the common ones
      requires noOpenDocks { ... } else DocksInUse
      outcome suspended: Active -> Suspended
    }
  }
}
```

- **Kind and state are independent.** A kind is fixed when the aggregate is made and never changes; a state changes
  through commands. The rule an author applies is one question: does it change during the aggregate's life? Then a
  `state`; otherwise a `kind`.
- **States are common.** States are declared on the aggregate only. A kind's states are those reachable from its
  initial states through its commands, derived as ADR 0035 derives them per kind. Kind-specific states and invariants
  over a kind and a state together are out of scope until a model needs them.
- **Fields.** A kind's fields exist in every aggregate of that kind. Its invariants, its commands and its `on` cases
  see the common fields and its own; common invariants and commands see the common fields only. A kind's field may not
  share its name with a common field or a state's field. Two kinds may declare fields of the same name (they are
  different fields).
- **The kind is fixed.** Only a create command determines it: the create commands are declared in the kinds, and an
  aggregate with kinds has no common `create command`. No `changes` names the kind. A business change of kind ends one
  aggregate and makes another (a `policy` may link them), or is a `state`. The events of a create command should carry
  enough to tell its kind; the kind is not a field to restate.
- **`initial`** on the aggregate applies to every kind; inside a kind, to that kind (ADR 0035's rule, with the kind
  block as the selector). It is optional with kinds: a kind also starts where its create commands end. A kind of an
  aggregate made elsewhere (no create command, no initial state) may be in any state.
- **Kind names** are told apart from state names: a kind is not named like a state (the generated kind–state types
  join the two names).

### Commands: common or of one kind, behaviour in exactly one place

- A command declared in a kind belongs to that kind only. It needs no common declaration, and its name is unique in
  the aggregate (it cannot also be declared in another kind or in common).
- A common command declares the signature: its parameters, its common `requires` and its declared errors. Its
  behaviour (outcomes, with their transitions, `changes`, `emits` and choice rules) is in **exactly one** place:
  - in the common command: the same behaviour for every kind, and no kind may have an `on` case for it; or
  - in an `on` case in **every** kind: the common command then has no outcomes.
- Mixing the two, or leaving a kind without its `on` case, is an error. There is no fallback from a missing `on` to a
  common behaviour: a new kind must decide every such command, and `dt check` says which. Repeated `on` cases are the
  price; a shorthand for several kinds can be added when models need it.
- The common command's `requires` apply in every kind, before the requirements of the kind's `on` case (ADR 0035's
  order); the first failing requirement decides the error.
- ADR 0035's `transitions for` groups and the `readonly` enum selector are removed: `kind` replaces them. Its named
  outcomes and choice rules (`select`, `@externalCheck`) are unchanged. Two kinds' cases may name an outcome alike;
  outcome names are unique per kind.
- With kinds and states, commands name their outcomes; the shorthand `A -> B` is an error there. Without states, an
  `on` case has nothing to hold (its outcomes need states): a common command's behaviour is common, and what differs by
  kind is a command of that kind (in the form of an aggregate without states: `changes`, `emits`).

### Values and aggregates

`union` and `kind` divide the work:

- `union`: polymorphism of a **value** (compared by its fields; no identity, lifecycle or commands).
- `kind`: polymorphism of an **aggregate** (one identity, states, invariants and commands per kind).

A `union` held by an aggregate remains valid for a value that varies (a payer, a payment method); it is the wrong
tool for what the aggregate itself is.

### Generated TypeScript

- The aggregate is a union over its kinds and, for an aggregate with states, over its kinds and states, discriminated
  by `kind` (the kind's name) and `state`. An aggregate with kinds cannot have a common field named `kind`.
- A command of one kind, and the `on` case of a common command, take the aggregate of that kind (and of the source
  states): the strict entry constrains the kind at compile time.
- A common command decided in the kinds' `on` cases has a contract generic over the input, whose result is that of the
  input's kind (`{ Store: …; Center: … }[S['kind']]`), and a decision with one function per kind, implemented with the
  runtime's `decideByKind` (as `decide` keys its handlers by state). A decision of several kinds as one function would
  have a conditional type no implementation could satisfy without a cast.
- The kind's fields are in the aggregate's shape (`kinds`); the runtime puts the kind on the aggregate a decision
  makes: from `set` for a create command (whose decision names its kind there), from the input otherwise.
- The generated `is<Kind><Aggregate>` guards narrow an aggregate of unknown kind; the generated per-kind types support
  an exhaustive `switch` over `kind`, so a new kind is a compile error in every switch that does not handle it.
- **Two entries.** The strict entry (the command's own type) takes the narrowed aggregate. The any-state entry of
  ADR 0036 (`<Command><Aggregate>FromAnyState`) also takes an aggregate of any kind.
- **Runtime checks.** The types do not make the runtime safe (a cast, data decoded without checks), so both entries
  check the kind before the state and the requirements:
  - The any-state entry returns, as values, `CommandNotForKind` when the command does not exist for the aggregate's
    kind, and `CommandUnavailable` when it exists but not in the aggregate's state.
  - The strict entry throws an `Error` naming the kind and the kinds of the command, as ADR 0036's strict entry throws
    for a state that is not a source state: a call through the strict type with another kind is a contract violation.
- **`CommandNotForKind`**, of the runtime: `{ type: 'CommandNotForKind', aggregate, command, kind, expected }`, where
  `expected` lists the kinds that have the command. It differs from `CommandUnavailable` in meaning, so in type:
  `CommandUnavailable` may succeed later, when the state has changed; `CommandNotForKind` never succeeds for this
  aggregate. Like `CommandUnavailable`, its `type` has no context prefix and it has no generated wording.
- `<Aggregate>Availability` lists the source states of each command per kind; a command missing from a kind is
  absent from it there.

### `dt check`

Errors (M030 unless noted):

- a common command with outcomes and an `on` case in some kind; a common command without outcomes and a kind without
  its `on` case;
- an `on` case for a command that is not a common command of the aggregate;
- a kind without a create command; a `create command` in the common part of an aggregate with kinds;
- a command name declared twice in the aggregate (in common, in kinds, or both);
- a kind's field named like a common field or a state's field; a common field named `kind`;
- a kind named like a state; the transition shorthand with kinds and states;
- a field of a kind in `changes` of a common command or outcome, or in a rule outside its kind (M021, M028, M010).

Warnings (M031):

- a state no kind can reach;
- kinds of which none declares a field, an invariant, a command or an `on` case: a `readonly` enum field says the
  same (as M026 says for a union without fields);
- a field declared with the same name and type in every kind: it is common;
- `on` cases of a common command that are alike in every kind: its behaviour is common (agents wrote the same case in
  every kind in trials; the rule leads them to the common form);
- an optional field required by an invariant only for some values of an enum field
  (`<field> == E.V implies exists(f)`): the shape of a kind; the message names `kind` and `dt guide kinds`.

The exhaustiveness of code over the kinds is the target language's (the generated types and `never`), not the DSL's.

### Guide

`dt guide` gets a `kinds` topic (replacing `kind-lifecycles`). The aggregate grammar in `dsl-quick` and `aggregates` lists `kind` next to `state`;
`modeling-practice` states the one-question rule (changes: `state`; fixed at creation: `kind`; a varying value:
`union`; kinds that share almost nothing: separate aggregates, with a field set for what they share). The `unions`
topic points to `kinds` for what an aggregate is.

## Migration

A beta breaking change. `readonly kind: E` with `transitions for kind == E.X { on c { … } }` becomes `kind X { on c
{ … } }`; the enum stays only if something else uses it. A common command whose outcomes are added by groups and by
its own outcomes (ADR 0035's composition) is rewritten into one of the two forms above: its common outcomes are copied
into each kind's `on` case. A create command becomes one create command per kind, or stays common only when the
aggregate has no kinds. An `owns` union that describes the aggregate's kind moves its variant fields into the kinds.
A migration tool may perform the mechanical rewrites; splitting a create command or moving fields it reports for the
author to do.

## Rejected alternatives

- **A `union` held by the aggregate, with a lint pointing to it**: keeps the kind in a value that the aggregate's
  invariants cannot read and that has no commands; kinds that differ in lifecycle still need a second enum.
- **Stronger unions only** (narrowing with `is`, `transitions for profile is X`): the shape stays split between the
  union and the aggregate, and commands of one kind still cannot be typed.
- **A kind's `on` case overriding a common behaviour, falling back to it otherwise**: inheritance under another name;
  a new kind silently gets behaviour nobody decided for it.
- **Kind cases adding to common outcomes** (ADR 0035's composition): reading what a kind does takes two places.
- **Changeable kinds**: the kind's fields, invariants and the history of its events would need migration rules in the
  model; a state, or a new aggregate, says it instead.
- **One error for state and kind** (`CommandUnavailable` with a `kind`, as ADR 0036 had it): a caller cannot tell a
  rejection that may pass later from one that never will.
- **A kind mismatch only as a thrown error** (ADR 0036): an aggregate loaded by ID has a kind the caller does not know
  before loading; a request for a command of another kind is input to reject, not a bug.
- **Separate aggregates per kind**: right when kinds share almost nothing; otherwise the common commands are repeated
  per aggregate and a reference to "either" needs a union of IDs.
