# ADR 0035: Kind-specific lifecycles and named outcomes

- Status: accepted, not implemented
- Date: 2026-11-09
- Amends: [ADR 0014](0014-command-transitions.md), [ADR 0016](0016-collection-constraints-and-declared-invariants.md), [ADR 0017](0017-command-requirements.md), [ADR 0018](0018-command-events-contract.md), [ADR 0019](0019-command-changes-and-decisions.md), [ADR 0020](0020-generated-checks-and-contract-tests.md)

## Context

One aggregate can have several lifecycles selected by a value fixed at creation. Expressing that choice through `requires kind == …` hides the lifecycle from the model and GUI. Existing `A -> B | C` identifies outcomes by target state, so two outcomes ending in the same state cannot differ in events or changes.

AI agents write the DSL; people review its GUI views. Generated code and tests must expose violations of the DSL. Its meaning must be independent of TypeScript so that Rust and other generators can follow. This is a beta breaking change. It adds no independent `workflow` and does not split the aggregate.

## Decision

### Discriminator and start states

- One required, `readonly` enum field per aggregate may select a lifecycle. Create commands set it; later commands cannot change it. The selector names the field explicitly. Supporting several independent discriminators is outside this extension.
- `initial State` at aggregate level applies to every kind; inside `transitions for` it applies to the selected kinds. Each kind needs at least one applicable initial state. Applicable declarations form a set, so several creation states are possible. A new enum value does not silently inherit branch-specific declarations.
- For each kind, start from its initial states and follow common and matching transitions. The reachable closure is the set of valid kind–state pairs for **new creation and command results**. A create outcome must end at an applicable initial state. A normal outcome must have a valid source and target pair for its kind. A transition from an invalid pair cannot make its target valid.
- States are still declared once on the aggregate; a state may be valid for several kinds. An aggregate may declare an initial state without defining a create command, for example when its creation is modeled elsewhere. Every create outcome that is defined must use an applicable initial state.

### Commands, groups and outcomes

- A command has one declaration and one name per aggregate. The declaration owns its parameters, `create` status, common requirements and declared errors. Duplicate declarations in different groups are errors; they are not implicitly merged.
- A `transitions for` group adds `on CommandName` cases to declared commands. Each case contributes outcomes and may add requirements for its selected kinds. Common requirements run first, then applicable case requirements in source order; the existing first-failing-requirement rule decides the error.
- Outcomes directly inside the command apply to every kind. Outcomes in matching groups are added. A command with no applicable outcome for a kind and source state is unavailable there. Calling it is a contract violation, distinct from a failed `requires` precondition.
- Selectors are `transitions for kind == CollectionKind.COLLECT` and `transitions for kind in CollectionKind.COLLECT | CollectionKind.DROP_OFF`. Repeated and overlapping groups compose. Duplicate outcome names within one command are errors.
- A create command may have outcomes in a group: the selector checks the created readonly kind. A normal command's selector checks the input kind. A create outcome must set its kind to one admitted by its group.
- Each success outcome has a command-local name, independent of its target state. It has one target, zero or more sources (none for `create`), its own `changes`, `emits`, and optional choice rule. Two outcomes may share source and target but differ in changes or events. Generated results, tests, `dt show`, and GUI use the outcome name as identity.
- `emits … when Source -> Target` is replaced by `emits` on the outcome. Command-level `changes` is replaced by outcome-level `changes`. `A -> B | C` is replaced by separately named outcomes.

### Choice rules

For each kind, source state and command, one applicable outcome needs no choice rule. If several outcomes apply, **each** needs one. A rule is either a Boolean DSL expression over the pre-command aggregate and parameters or a natural-language declaration with an explicit external-check annotation. For every valid input satisfying the command's requirements, exactly one applicable choice rule must hold. Declaration order is not priority.

The generated decision checks that the chosen outcome satisfies its rule and, when all applicable rules are executable, that exactly one holds. Generated contract tests check the same property. Static checks may prove simple cases, but an unproved property is never displayed as proved. An external rule has a required, typed check slot; its check must be pure, deterministic and total over its inputs. The DSL and GUI distinguish a DSL expression, a user-supplied external check, and an unexpressed declaration. Passing an external check does not prove that it implements the natural-language intent.

### Canonical syntax

```dt
aggregate CollectionRequest {
  readonly kind: CollectionKind "回収の種類"

  state Unassigned
  state Assigned
  state CollectDone
  state Holding
  state Delivered
  state Cancelled

  initial Unassigned

  create command open(kind: CollectionKind, id: RequestId) {
    outcome opened: -> Unassigned
      emits CollectionOpened
  }

  command assign(assignee: Organization.DriverId) {
    outcome assigned: Unassigned | Assigned -> Assigned
      changes assignee
      emits CollectionAssigned
  }

  command cancel() {
    outcome cancelled: Unassigned | Assigned -> Cancelled
      emits CollectionCancelled
  }

  command complete()

  transitions for kind == CollectionKind.COLLECT {
    on complete {
      outcome collected: Assigned -> CollectDone
        emits Collected
    }
  }

  transitions for kind == CollectionKind.DROP_OFF {
    on complete {
      outcome received: Assigned -> Holding
        emits ReceivedForDropOff

      outcome delivered: Holding -> Delivered
        emits DroppedOff
    }
  }
}
```

Two outcomes for the same input need explicit rules:

```dt
command inspect(result: InspectionResult) {
  outcome accepted: Inspecting -> Accepted
    select { result.passed }
    emits InspectionAccepted

  outcome rejected: Inspecting -> Rejected
    select { not result.passed }
    emits InspectionRejected
}

// An irreducible judgement can instead use:
// select "審査担当者が却下と判断した場合" @externalCheck("外部の審査規程に従う")
```

`@externalCheck("reason")` is an annotation on a particular decision rule, not a general warning suppression. The reason explains why it cannot be expressed in the DSL. Existing `requires name "label" { expression } else Error` and `invariant name "label" { expression }` remain; their expression-free forms accept this same annotation. Labels and comments are descriptive, not decision rules.

An aggregate invariant or external check can inspect only the aggregate and its explicit command inputs. A constraint over other aggregates or concurrent transactions belongs at the storage/application boundary; an `@externalCheck` on one aggregate cannot establish it. The existing `Triage.onePerRequest` and `AgentRun.serial` declarations are therefore removed from the aggregate model during migration; the store's unique indexes and transaction tests remain responsible for them. A future storage-level DSL contract would need its own scope and semantics.

### Validation and generation

`dt check` reports expression-free decision rules without the annotation while allowing an incomplete model during editing. `dt check --for-generation` makes them errors. The gate applies to `select`, `requires`, and `invariant`. Empty reasons, annotations without a natural-language rule, or invalid attachments are errors. Annotated rules are reported as external obligations, distinct from expressed rules.

`dt generate <target>` always runs this generation gate before writing files. The gate runs on the shared typed model, not on a TypeScript-specific representation. Generated code has mandatory typed external check slots with no permissive default. Where an external obligation exists, its contract tests are mandatory: generation fails if that target's contract tests are disabled; an unchecked `todo` is not sufficient. `dt check` sees only the DSL, so binding the supplied checks and running generated tests are separate verification steps. The GUI shows an external obligation as unverified unless it has evidence from a test run; it does not infer verification from the annotation or generated files alone.

Expression semantics are target-independent. String length counts Unicode scalar values, Decimal comparison is exact, Timestamp comparison is by instant, and regexes use a documented portable subset. A generator that cannot reproduce a used expression's semantics fails for that target. Shared conformance examples cover all generators.

### Restore boundary

DomainTrail generates an aggregate `restore` function only. The caller validates and decodes persisted data, migrates versions, and checks invariants and kind–state pairs before calling it. The function accepts trusted input and does not claim that restored instances satisfy the new-creation reachability contract. There is no `entry` syntax or implicit restore root; DomainTrail does not prescribe a storage format.

## Migration

This is a deliberate beta breaking change for ambiguous multi-target transitions. Rewrite `A -> B | C` as named outcomes; move each `emits … when` entry and `changes` entry to the applicable outcomes. A legacy single-target command remains accepted as a compatibility shorthand whose implicit outcome name is its target state, so existing generated API keys do not change merely because the source is migrated. Explicit named outcomes are the canonical form for new models. Merge same-named command declarations into one declaration and `on` cases. Move kind-based lifecycle `requires` to `transitions for`; retain genuinely business-related `requires`. Add `initial` for create targets. Give each expression-free `invariant` and `requires` an expression or a reasoned `@externalCheck` before generation. A migration tool may perform mechanical rewrites, but must not invent a choice rule or an external-check reason.

The typed model carries command identity, selectors, initial states, named outcomes, choice-rule kind and external obligation without target-language types. Validation derives applicable outcomes and reachable pairs there. Visualization displays per-kind graphs, common edges, outcome names and verification status. Each generator consumes this shared contract.

## Rejected alternatives

- Split the aggregate or introduce `workflow`: one aggregate boundary and one selector suffice.
- Implicitly merge duplicate commands: parameters and requirements could diverge silently.
- Use the target state as outcome identity: distinct results can end in the same state.
- Keep bare multi-target transitions: generated tests cannot know which outcome is correct.
- Let an annotation suppress a warning without a required check: implementation could silently omit the decision.
- Validate restored histories in DomainTrail: persistence and migration are caller responsibilities.
