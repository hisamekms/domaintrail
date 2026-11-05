# ADR 0032: The `.dtes` relations are Event Storming's design-level grammar

- Status: accepted (2026-11-06). The decisions marked *Decided by the maintainer* were his; the others were taken while
  implementing them (marked *Decided here*).
- Date: 2026-11-06
- Amends: [ADR 0024](0024-event-storming-dsl.md) (its relations, rules and Design Level drawing) and the spec
  [docs/dtes-v0.1.md](../dtes-v0.1.md) (§3.2, §3.8, §4, §9.1, §9.4, §11).
- Code: `contexts/storming` (grammar, IR, validator, formatter, `migrateStorming`), `capabilities/visualization`
  (`core/storming/chains.ts`, `filter.ts`, `stage-view.ts`), `apps/dt` (`dt migrate dtes`), the guide (`dt guide
  dtes-quick`, `storming-rules`) and the agent's prompts.

## Context

ADR 0024's amendment of 2026-11-05 redrew the Design Level along Event Storming's grammar (read model + actor →
command → aggregate → event → policy → command), but left the DSL as it was, and listed what still needed a DSL
change. Using it on a real storming (DSS, ~900 lines written by an AI from code and interviews) showed where the
relations of v0.1 deviate from the grammar people draw on the wall:

- **`emits` belongs to the command, with the aggregate a side relation.** In Event Storming the aggregate (or an
  external system) receives the command and *it* produces the events. `target` was optional (0..1), so a command with
  `emits` and no `target` was valid: an outcome produced by nobody.
- **`target` named aggregates only.** A command handled by an external system (a calculation API, a notifier) had no
  way to say so; the AI invented aggregates for them, or left `target` out.
- **The read model was the command's.** On the wall, a read model is what the *issuer* (the user, the batch) looks at
  to decide; `reads` was drawn read model → command, and nothing said where a read model's data comes from.
- **Nothing for events that arrive from outside** (an order from an external system), nor for questions about
  anything but an event (a hotspot was `on` events only, so "who handles this command?" could not be attached to it).
- **Incomplete designs were silent.** A command without issuer, handler or outcome, an aggregate nothing uses: no
  diagnostic. With an AI as the main author this is the worst mix: when the error is missing, the AI guesses quietly;
  when an error appears, the AI fills the gap with *something* to make it go away, an invented aggregate or actor.
- **Keywords that mean different things by kind** (`actor` as an element and as a relation) and relations an AI writes
  inconsistently (`actor` vs. `target` order, one clause per target).

The `.dtes` is written mainly by AI and read by people in the Live View. What the AI writes has to be the grammar, and
what is not decided has to show as an open question, not as a plausible guess.

## Decision

### 1. The relations are the grammar: `by`, `reads`, `handledBy`, `emits`, `on`, `issues`, `from`

*Decided by the maintainer.* A command's body holds its whole row:

```dtes
command BuildAllocation "配車を組む" {
  by Batch // who issues it: an actor or an external system
  reads UnassignedRequests // what the issuer looks at to decide (a read model)
  handledBy CarAllocationPlan // who receives and handles it: an aggregate or an external system
  emits CarAllocated, AllocationFailed // its outcomes, produced by the handler
}
```

- Policy: `policy P { on <event>… issues <command>… }`, unchanged. A command a policy issues has no `by`: the policy
  is its issuer.
- New: `readmodel R { from <event>… }` (a read model fed by events), `event E { from <external> }` (an event that
  arrives from an external system without a command of ours), `hotspot H { on <any sticky but a hotspot> }`.
- Exactly these seven keywords, no synonyms. A list is one clause: `emits A, B` is `emits A` and `emits B` (the IR
  keeps one clause per target, with the range of the whole clause and a range per target). `by`, `handledBy` and
  `from` become keywords: they are no longer IDs. `then <Event>` of an exception is unaffected.
- Kinds (`RELATION_RULES`): `by` → actor, external; `reads` → read model; `handledBy` → aggregate, external (one);
  `emits` → event; policy `on` → event, `issues` → command; read model `from` → event; event `from` → external;
  hotspot `on` → any node kind but a hotspot (one).
- The semantic graph's edge kinds follow: `by`, `reads`, `handledBy`, `emits`, `on`, `issues`, `readmodel-from`
  (event → read model), `event-from` (external → event), `hotspot-on`. `on`, `issues`, `emits`, `handledBy` and
  `event-from` are causal. Of a second `handledBy` or hotspot `on`, only the first is an edge.

### 2. Everything unnatural is an error at once, each with a concrete fix

*Decided by the maintainer* (no deprecation period: the AI follows errors). The existing rules take the new grammar,
and six rules are new:

| Rule | Condition | Hint |
|---|---|---|
| S003 | a relation to an element of the wrong kind | the relation that says what was meant: `by` an aggregate → `handledBy` it; `handledBy` an actor → `by` it; `reads` an event → a read model fed `from` it; `emits` a command → a policy between them; policy `issues` an event → the command's `emits`; policy `on` a command → `on` one of its events; read model `from` an external → an event `from` it; event `from` a command → that command's `emits`; … |
| S004 | a second `handledBy` (and, as before, `ref`, hotspot `on`, `status`, `resolution`, `level`) | keep one |
| S006 | a relation the element kind does not take | per case: a command's `issues` → a policy between; a command's `on` → a policy; a policy's `by`/`emits`/`handledBy`/`reads` → where it belongs; anything on an actor, external, aggregate → write it in the command |
| S008 | a policy without `on` or `issues` | add it, or (not decided) a hotspot `on` the policy |
| S023 | `actor X` or `target X` in a body (v0.1) | `write by X` / `write handledBy X` (`dt migrate dtes` rewrites them); outside a command: remove it |
| S024 | a command without its issuer (`by`, or a policy that `issues` it), without `handledBy`, or without `emits` | add what is decided; *don't guess*: add `hotspot <Id> "誰が処理する？" { on <command> }` |
| S025 | a command a policy issues that also has `by` | remove `by`; a manual path is another command |
| S026 | one relation written twice (`emits A` twice, `emits A, A`) | remove the second |
| S027 | an actor, external system, aggregate or read model that no relation names | name it where it takes part, or remove it, or (not decided) a hotspot `on` it |
| S028 | an event both emitted by a command and `from` an external system | `handledBy` the external system in that command, or two events |

The rules S024–S028 and the new hints are *Decided here*, as the "other unnatural constructs" the maintainer asked to
find; so is S027 (a sticky of no row). Considered and **not** made errors: a read model without `from` (often fed by
something not modeled yet; Big Picture completeness stays undiagnosed), a hotspot without `on`, a command `by` and
`handledBy` the same external system, the type-level cycles (S014 stays a warning: a retry is legitimate).

### 3. Incomplete design is an error, and an open hotspot is how to say "not decided"

*Decided by the maintainer* ("全部即時エラーでよい"), with this reading *Decided here*: at Design Level an incomplete
command (S024), policy (S008) or unused element (S027) is an error **unless an open hotspot is `on` it**. The hotspot
is the grammar-natural way to say "not decided yet": it is what people put on the wall for an open question. While it
is open (no `status resolved`), that element's incompleteness errors are off; resolving it turns them on again until
the relation is written. Every such error's hint says "don't guess" and gives the hotspot to write. Big Picture
(events, timelines, hotspots on events) is unaffected: no command, no error.

A hotspot turns off *all* the incompleteness errors of its element, not one missing relation: its question is free
text, which the checker does not read (spec §11), so it cannot tell which relation it asks about. The prompt asks the
AI to ask everything that is open in it.

### 4. AI-facing: one screen of syntax, and "never guess" in the prompts

*Decided by the maintainer.* `dt guide dtes-quick` is the syntax on one screen: a checked example (the guide's test
checks it with the workspace and `dt fmt`), the table of relations, the errors and the hotspot rule. The agent's
prompts embed it after the storming's way of working when a prompt is about `.dtes` (`Practice.stormingSyntax`, as
`dsl-quick` for `.dt`); the interviews, which write no file, do not. The runner's rule 3 says to write the relations
in the grammar and never to fill a relation nobody knows by guessing, but to mark it with a hotspot on the element.
`dt fmt` prints a body's clauses in one canonical order, each with its comments: `ref`, `by`, `reads`, `handledBy`,
`emits`, `on`, `issues`, `from`, `status`, `resolution`, `level`.

### 5. `dt migrate dtes`

*Decided by the maintainer*; the name follows the CLI's `<verb> <object>` style (`dt export sources`). It rewrites, in
place, `actor X` → `by X` and `target X` → `handledBy X` in every command (only the keyword token changes, comments
and layout stay), lists what it cannot rewrite (a removed keyword in another kind of element; a file that does not
parse, e.g. an ID that is now a keyword) and then the errors that remain for `dt check` (decisions, not rewrites). It
exits 1 only when something is left unrewritten. On DSS it rewrote 122 keywords in 5 files with nothing left; 6 S024
remain (commands without `handledBy`), and no S025, S027 or S028.

### 6. Rendering

*Decided by the maintainer*; the drawing of ADR 0024's 2026-11-05 amendment, in the new semantics, in both layouts:

- **Copies per use**: issuers (`by`), read models (`reads`) and handlers (`handledBy`: an aggregate *or an external
  system*) beside each command note, `n:<element>@<command note>`; an external system an event comes `from` beside each
  note of that event, `n:<external>@<event note>` (`RenderElementNode.use` is a command note's key or an event note's
  ID). Every copy now has a slot of its own.
- **Edges**: read model → each issuer copy of the command note when it has `by`, else → the command (`reads`,
  undirected); issuer → command (`by`, undirected); command → handler (`handledBy`, causal); handler → event (`emits`,
  causal); event → read model (`readmodel-from`, a new edge kind `esFeeds`: dotted *with* an arrowhead, in the legend
  「イベントがリードモデルに反映される」), from the event's note at the nearest slot at or before the copy; external →
  event (`event-from`, causal); hotspot → its sticky, one hotspot note per note of the sticky.
- **ELK**: an issuer is stuck on its command only when nothing else leads to it, so a read model reads read model →
  issuer → command → handler → event as layers; a hotspot is stuck on whatever sticky it is on.
- **Grid** (`placeChains`): sub-columns read model, command, *handler*, event, policy. A chain is: its hotspots above
  it (in the sub-column of their sticky), the issuers above the command, the read models from the issuers' first row
  down (so a read model is on the row of the issuer looking at it), the handler on the command's row. An external
  system an event comes from is a chain of its own (a handler without a command) above that event. A policy's hotspots
  stand above its policies.
- **Big Picture**: a hotspot on a sticky of Design Level (a command, a policy, …) is not drawn there.
- **Focus** (`apps/web/scene.ts`): the handler may be an external system; a cause's issuer brings the read model it
  looks at.

## Alternatives

- **An arrow chain** (`UnassignedRequests -> Batch -> BuildAllocation -> CarAllocationPlan -> CarAllocated`): rejected
  by the maintainer. One line reads well for one row, but rows branch (several issuers, several outcomes, a read model
  for two issuers) and the AI then writes the same row in several inconsistent chains; the named clauses say each
  relation once, and the validator can name exactly what is wrong.
- **Warnings and a deprecation period for `actor` / `target`**: rejected by the maintainer. The AI follows errors and
  ignores warnings; a period with both grammars valid would leave files half-migrated. `dt migrate dtes` makes the
  switch mechanical.
- **Incompleteness as warnings, or a `tbd` keyword**: warnings are ignored for the same reason; a `tbd` keyword would be
  a second, non-Event-Storming way to say what a hotspot already says on the wall.
- **Keep `emits` on the aggregate** (the aggregate emits, the command only reaches it): the events are the command's
  outcomes, and `.dt` commands own their `emits` (ADR 0018); keeping them on the command keeps the `ref` contract
  (S013) and the per-command drawing, while the drawing starts them at the handler.

## Consequences

- Every `.dtes` file of v0.1 with a command relation is invalid until migrated (`dt migrate dtes`); the shop example,
  the fixtures, the site's examples and the tests are migrated. The migrated files may then show S024/S027: decisions
  for people, which the AI marks with hotspots rather than guesses.
- A storming at Design Level reads on the canvas as on the wall, and a gap is visible as a hotspot on the sticky it
  concerns.
- The grammar now has the words `by`, `handledBy` and `from` as keywords: an element named so must be renamed (the
  migration lists such files).
- The tree-sitter grammar and the Zed extension cover `.dt` only; nothing to change there.
- The rule IDs go up to S028; the guide's rules table and its one-problem examples cover each.
