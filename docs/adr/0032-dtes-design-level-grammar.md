# ADR 0032: The `.dtes` relations are Event Storming's design-level grammar

- Status: accepted (2026-11-06). The decisions marked *Decided by the maintainer* were his; the others were taken while
  implementing them (marked *Decided here*).
- Date: 2026-11-06
- Amends: [ADR 0024](0024-event-storming-dsl.md) (its relations, rules and Design Level drawing, and its "the formatter
  never reorders clauses") and the spec [docs/dtes-v0.1.md](../dtes-v0.1.md) (§3.2, §3.3, §3.6 on `dt fmt`, §3.8, §4,
  §5.2 on a command without `emits`, §9.1, §9.4, §11).
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
  is its issuer. The policy is the only link from an event to a command (amended by §14: a command issued `by` an
  actor may be `on` the events that person reacts to).
- New: `readmodel R { from <event>… }` (a read model fed by events), `event E { from <external> }` (an event that
  arrives from an external system without a command of ours), `hotspot H { on <any sticky but a hotspot> }`.
- Exactly these seven keywords, no synonyms. A list is one clause: `emits A, B` is `emits A` and `emits B` (the IR
  keeps one clause per target, with the range of the whole clause and a range per target). `by`, `handledBy` and
  `from` become keywords: they are no longer IDs. `then <Event>` of an exception is unaffected.
- Kinds (`RELATION_RULES`): `by` → actor, external; `reads` → read model; `handledBy` → aggregate, external (one);
  `emits` → event; policy `on` → event, `issues` → command; read model `from` → event; event `from` → external;
  hotspot `on` → any node kind but a hotspot (one); command `on` → event (§14).
- The semantic graph's edge kinds follow: `by`, `reads`, `handledBy`, `emits`, `on`, `issues`, `readmodel-from`
  (event → read model), `event-from` (external → event), `hotspot-on` (and `command-on`, event → command, §14). `on`,
  `issues`, `emits`, `handledBy` and `event-from` are causal (and `command-on`). Of a second `handledBy` or hotspot `on`, only the first is an edge.

### 2. Everything unnatural is an error at once, each with a concrete fix

*Decided by the maintainer* (no deprecation period: the AI follows errors). The existing rules take the new grammar,
and six rules are new:

| Rule | Condition | Hint |
|---|---|---|
| S003 | a relation to an element of the wrong kind | the relation that says what was meant: `by` an aggregate → `handledBy` it; `handledBy` an actor → `by` it; `reads` an event → a read model fed `from` it; `emits` a command → a policy between them; policy `issues` an event → the command's `emits`; policy `on` a command → `on` one of its events; read model `from` an external → an event `from` it; event `from` a command → that command's `emits`; … |
| S004 | a second `handledBy` (and, as before, `ref`, hotspot `on`, `status`, `resolution`, `level`) | keep one |
| S006 | a relation the element kind does not take | per case: a command's `issues` → a policy between; a command's `on` → a policy (amended by §14: a command takes `on` when an actor issues it); a policy's `by`/`emits`/`handledBy`/`reads` → where it belongs; anything on an actor, external, aggregate → write it in the command |
| S008 | a policy without `on` or `issues` | add it, or (not decided) a hotspot `on` the policy |
| S023 | `actor X` or `target X` in a body (v0.1) | `write by X` / `write handledBy X` (`dt migrate dtes` rewrites them); outside a command: remove it |
| S024 | a command without its issuer (`by`, or a policy that `issues` it), without `handledBy`, or without `emits` | add what is decided; *don't guess*: add `hotspot <Id> "何が処理する？" { on <command> }` |
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
the relation is written. Every such error's hint says "don't guess" and gives the hotspot to write. A storming with no
command and no policy is at Big Picture: none of S024, S027 or S029 applies there (a storming with only events, actors
and read models has no gap).

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
`emits`, `on`, `issues`, `from`, `status`, `resolution`, `level` (a policy's per §9.5, a command's per §14).

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
- **A handler shared by converging chains** (*Decided by the maintainer*, a later commit): the commands whose chains
  end at the same event note and that are handled by the same element (the same aggregate, or the same external
  system) go through one handler note before it, `n:<handler>@*<event note>` (on the integrated ELK canvas, which draws
  an event once, `@*e:<event>`): each command → that handler (`handledBy`), and one handler → event edge for all their
  `emits` (`RenderEdge.merged` lists the semantic edges it stands for; its tooltip names the commands). Merging is per
  event note: never across event notes (an event at two steps gets one before each), never between different
  handlers, and the issuers stay per command; a command note keeps a handler of its own for the events it does not
  share (A emits E1 and E2, B emits E1: one shared handler before E1, A's own before E2). The node carries the command
  notes it stands for (`RenderElementNode.commands`; `GraphNode.commands`, their element IDs), so that a change to the
  `handledBy` of any of them can mark it. In the grid the chains converging on one handler are next to each other and
  the handler stands at the middle of their command rows (a free row of the handlers' column nearest it); in ELK it is
  just the shared node. Selecting it keeps all its commands; selecting one command keeps only its own path through it.
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

### 7. After the review (2026-11-06)

*Approved by the maintainer* after an independent review:

- **Gaps only at Design Level, and what takes part.** S027 runs only when the storming has a command or a policy. An
  element's own relations count as taking part: a read model fed `from` events and read by nobody (one people only
  look at) is valid.
- **The hotspot S024 suggests** asks everything that is missing (「誰が発行し、何が処理する？結果は？」; 「誰が処理」 until 2026-11-08: a handler is an aggregate or an external system, not a person) under an ID no
  declaration has (`<Command>Open`, else `<Command>Open2`, …), so that following the hint never makes an S001.
- **A hotspot asks about its first `on` only** (the one that is an edge; a second is S004).
- **Silenced gaps stay visible** (`designGaps` / `openGaps` in `contexts/storming`): `dt check` prints
  「n element(s) incomplete under open hotspots: …」 before its summary, and the Live View draws, beside each note of
  the command, the empty slot of an undecided issuer or handler (`RenderGapNode`, a dashed note 「何が処理する？」 whose
  selection selects the hotspot).
- **A policy may be `by` an actor** (a rule a person applies by hand), drawn as a command's issuer is, above the policy.
  A command a policy issues still has no `by` (S025). (Amended by §12: when the policy has a `reads`, the actor looks at
  the read model, read model → actor → policy, as a command's issuer does.)
- **From outside, and on a schedule**: `event E { from Ext }` when we only record a fact the outside system decided; a
  command `by Ext` when our aggregate decides something on what it sends. A schedule is a time event and a policy `on`
  it, not an external "batch". The examples follow it.
- **S029 (info)**: at Design Level, an event no command emits and that comes `from` no external system — except an
  event a policy reacts to, which is a trigger (a time event). `Severity` gains `info` (the kernel's model, the JSON
  schema's `severity` and its `summary.infos`, the LSP's Information); an info changes no exit code and marks no note.
- **`dt fmt` merges** repeated relations of one keyword into one list (`by A` + `by B` → `by A, B`) unless a comment
  is on one of them; `handledBy` and a hotspot's `on`, which take one, are left for S004.
- **Near misses of keywords** (`handledby`, `readModel`, `emit`) get a `did you mean` in the syntax error.
- **The merged handler** (§6) is part of the rendering decision: commands converging on one event note through the
  same handler share one handler note before it.
- **No event → event lines at Design Level** (*Decided by the maintainer*): there the placement shows the time order
  (the steps left to right), so the time order is laid out but not drawn (`GraphEdge.hidden`), except where the
  placement cannot show it: the edge into a lane that branches off (an exception's branch) and a `then`. Big Picture
  keeps its time order lines. (Amended by §15: the edge into a lane is not drawn either when the design's lines
  already join its two events; its label stays.)

### 8. Three looks of lines, each explained (2026-11-06)

*Decided by the maintainer* (from a preview of 「2種類＋選ぶと説明」): a storming's lines have three looks. **流れ** — a
thin solid arrow in one colour — for every relation between stickies (read model → issuer or command, issuer →
command, command → handler, handler → event, event → policy, policy → command, event → read model, external → event,
a policy's actor); it replaces the causal, related and feeding looks. **時間** — a dashed arrow in the same colour — for
the time order where the placement cannot show it (at Design Level an exception's branch and its `then`; at Big
Picture the time order lines), with no red for exceptions. **問い** — a thin quiet line without a head — from a hotspot
to its sticky, quieter when resolved. The edge kinds stay apart (`esCausal`, `esRelated`, `esFeeds`, `esSequence`,
`esException`, `esRejoin`, `esHotspot`): the grid routes and the focus still tell them apart; only their look is shared
(the canvas's CSS, the portable SVG, the legend's three rows). Every line carries what it means in plain words, without
the DSL's keywords (`GraphEdge.tooltip`, e.g. 「配車を組む は 配車組 が処理する」「定期バッチ が 未割当の依頼 を見て判断する」
「例外 自動配車の失敗 はここから分かれる」「元の流れの 担当を割り当てた へ戻る」): hovering shows it as a tooltip, selecting
shows it at the line's middle and keeps the two stickies in full view while the rest dims. Issuers and hotspots stay
near their sticky (stacked above it in ELK, in their cells in the grid), joined by their line.

### 9. `reads` is on the row of whoever decides (2026-11-06)

*Decided by the maintainer*, after a report that a policy's read model was drawn read model → command: §1 made `reads`
the command's, so a command a policy issues (no `by`) "read" its read model itself, which no wall shows. With an AI as
the main author, the rule has to be plain and a violation an error at once, as S023–S028 are:

1. **`reads` is written on the row of whoever decides.** A command issued by a person or an external system keeps its
   `by` and `reads` (§1). A command a policy issues is decided by the policy, so the policy has the `reads`:

   ```dtes
   policy AutoReassign "欠員が出たら組み直す" {
     on DriverCancelled
     reads AvailableDrivers
     issues ReassignDriver
   }
   ```

   A policy with `by` (a rule a person applies by hand, §7) has the `reads` too: what that person looks at.
2. **A command a policy issues takes no `reads` (an error).** The `reads` of a command without `by` that a policy
   `issues` is an error; its hint says to move it to the `reads` of the policy that issues it, by name.
3. **A policy issues one command (an error).** `issues` naming two or more commands is an error; the hint says to split
   the policy, one per command. It is Event Storming's usual shape, and it keeps a policy's `reads` from mixing what it
   looks at for different commands. One command issued by several policies stays valid: each has its own `reads`.
4. **A policy's `reads` names read models only**, as a command's does (S003): `reads` an event gets the hint to declare
   a `readmodel { from … }`. S027 counts a policy's `reads` as a use of the read model.
5. **`dt fmt`'s order is per kind.** A policy's clauses go `on`, `reads`, `issues`, `by` (read aloud: when this happens,
   looking at that, issue this); a command's stay as in §4.
6. **Drawing.** A policy's `reads` is read model → the policy's note (with copies per step, the note of the same step),
   in ELK and in the grid (amended by §12: read model → the actor's copy when the policy is `by` one). There is no read model → command line any more: a command without `by` cannot have `reads`.
   In the grid a policy's read models stand just before it, as a command's stand before the command.
7. **The lines' words** (`Messages.lines`, `apps/web/i18n.tsx`). Read model → whoever decides (an actor, an external
   system, a policy) is one sentence, 「「{B}」は「{A}」を見て判断する」 (“{B}” looks at “{A}” to decide): the colour box of
   the kind in front of each name tells which kind decides. The relation read model → command (`readsWhen`) is gone.
8. **`dt migrate dtes` covers the files of 0.8 too.** Besides §5's rewrites, it moves the `reads` of a command a policy
   issues (without `by`) into that policy's `reads` when exactly one policy issues it, keeping its comments and the
   layout, as §5's rewrites do. When several policies issue the command, it does not copy the `reads` to each: it lists
   the command as a decision to make. A policy issuing several commands is listed as well, unchanged (no name for the
   policies it splits into can be made up). A second run changes nothing.
9. The AI-facing texts follow: `dt guide dtes-quick` and `storming-rules`, the agent's prompt, `docs/live-view.md`'s
   lines and the examples (each passes `dt check`).
10. The two errors are **S030** (`reads` on a command a policy issues) and **S031** (a policy issuing more than one
    command), reported as the others are (the LSP's diagnostics, `dt check --format json`).

*Decided here*, while implementing it:

- S030 is reported per read model, at its name. A command a policy issues *and* `by` someone is S025, not also S030:
  removing `by` comes first. With several policies issuing the command, the hint names them all, to pick the one that
  looks at it.
- S031 is reported at each command named after the first (a command named twice is S026, not S031).
- The semantic graph's `reads` edge now also runs read model → policy. The drawing leaves out a command's `reads` with
  no issuer to go to (in an invalid file, the read model is drawn without that line).
- In the grid a policy's read models have a sub-column of their own between the event and the policy; a policy takes as
  many rows as it has read models, the first on its own row and the others above it.
- The migration puts the moved clause after the policy's `on` clauses (where `dt fmt` puts it), in the policy's
  indentation, with the comments on its lines; when the policy already reads that read model, it only removes it from
  the command. A policy that issues several commands keeps its commands' `reads` where they are, listed with it.

### 10. 「解決済みを表示」, and what a reader hides as one set (2026-11-06)

*Decided by the maintainer*, after asking for 「解決済みを表示」 in the storming's 絞り込み (a band of hotspots across a
sticky's top was tried in a preview and dropped: hotspots stay as §8 draws them):

1. **Hiding the resolved hotspots moves nothing.** A resolved hotspot stays in the layout (in ELK stacked above its
   sticky, in the grid in its cell) whatever is shown. 「解決済みを表示」 off, its note and its 問い line are only left out
   of the drawing, their place left empty: the layout is not made again. A hotspot on nothing drawn is hidden the same
   way.
2. **The stickies keep a check.** Each sticky a hidden hotspot is `on` (each copy of it, as drawn per step) shows a
   resolved hotspot's check in its corner (§3.5's `RESOLVED_MARK`; left of its 「k/n」 when its copies are numbered),
   also when open hotspots on it are still drawn. Hovering tells what was agreed (「解決済み: …」); pressing it selects
   the hotspot (the one on that copy), whose detail tells the question and the agreement. No new words. A sticky's
   detail lists every hotspot on it, open and resolved, whatever is hidden.
3. **What a reader hides is one set** (`Hideable`, `HIDDEN_BY` in `core/storming/ir.ts`; amended by §11: the exceptions
   are toggled as a layer beside the breadcrumb, not in the 絞り込み): `exceptions` and
   `resolvedHotspots`, each with how it is hidden. `layout`: the view is laid out without it — another graph, keyed by
   `ViewOptions.hidden` (`-exceptions`, as before), laid out by the server. `drawing`: the same layout is drawn without
   it (`hideInDrawing`): in the page alone, and the same way by `dt export svg --resolved-hotspots hide` (beside
   `--exceptions hide`). A new kind is one more entry; only a `layout` one adds graphs to lay out, so the views do not
   double with each switch. The page keeps the set per reader (`StormingChoice.hidden`; an earlier `exceptions: false`
   is read as the exceptions hidden): a facilitator hiding them changes nothing for the others. Each kind hidden counts
   as one in the 絞り込み's count.
4. **Moving to a hidden element shows what hides it first**, whatever the kind (`revealIn`, `apps/web/storming.tsx`):
   the palette and `#select=` links, the knowledge's links, the detail's links, a chat's reference and a turn's marks
   (`marksView`) choose the view, then show again the kinds that hide the element — one kind when that is enough, else
   all of them — then select it. The rule is written once, for every kind; the exceptions go through it too.

### 11. The canvas carries a flow; the exceptions are a layer over it (2026-11-07)

*Decided by the maintainer* 2026-11-07, after reviewing the view bar from zero with a preview of the states and how
they change (every recommendation approved). The view bar mixed what is looked at and how: its second picker listed
すべて（統合）, each stage 「…（例外を含む）」 and every timeline, exceptions among them, while 「例外を表示」 in the
絞り込み could hide the exceptions of a stage the picker said included them. The mental model is now one sentence:
**the canvas carries the flow chosen, and the exceptions are a layer laid over it.**

1. **The breadcrumb is what the canvas carries**: the storming › its timeline — すべて, or one main flow; never an
   exception. The trunk (the first main flow of each stage, one straight row through every stage) is one main flow,
   every other main flow of a stage another, after the trunk before it (`mainFlows`); a storming with one main flow has
   no second picker. **A stage has no view of its own any more**: it stays a frame in the drawing, and its row in the
   navigator brings that frame into view.
2. **One main flow is drawn in the layout of すべて** (`flowInDrawing`): the other main flows, and the exceptions
   branching off them, are left out where they stood, so no sticky moves; a stage with nothing drawn keeps its frame,
   dashed. The timeline view of one-hop causal paths is no longer what the canvas shows; only the canvas of every
   flow, with and without the exceptions, is laid out.
3. **The exceptions are a layer** with a toggle apart from the breadcrumb in its look (round, in the exceptions' pink):
   ↳, 例外 and how many it lays over the canvas (those branching off the main flow shown). Its left part includes them
   (the default) or not — 「例外を表示」 leaves the 絞り込み, which keeps 「解決済みを表示」 only; the layer stays one of
   `HIDDEN_BY`'s `layout` kinds (§10), toggled from the bar —; its ▾ emphasizes one. A storming without exceptions has
   no toggle.
4. **Three states**: excluded (the main flows only), included (every lane, the default), and included with one
   exception emphasized (「↳ 例外: 取消 ×」): everything drawn as when included, the exception's path — the main flow
   before it branches off, its steps, from where it returns onwards — dark, the other exceptions and the notes off the
   path faint. What is drawn does not change and nothing moves. (A case drawn without the other exceptions, tried
   first, was dropped: everything is drawn, the rest faint.)
5. **Entering the emphasis**: from the ▾, from **the label of an exception's lane on the canvas**, or from its row in
   the navigator. Excluded, the exceptions are included first; when the main flow shown does not have the exception,
   the timeline goes back to すべて.
6. **The emphasis is close to a selection**: its ×, Escape and a press on the canvas's empty space end it, back to
   included. It is kept apart from the stickies' selection (selecting a sticky keeps it): Escape ends the selection
   first, then the emphasis; a press on the empty space ends both. It is never remembered (a reload ends it), never
   followed (who follows gets the timeline and the layer, not the emphasis), never printed nor exported. Pressing the
   emphasized lane's label again ends it.
7. **The camera** moves to the path only when the emphasis comes from the ▾ or the navigator; a press on a label leaves
   it where it is (what was pressed is in view).
8. **A lane's label**: hovering it deepens its lane's band, so that what a press emphasizes shows first; the lane
   emphasized has its label filled and its band outlined.
9. **The navigator** keeps the stormings › stages › timelines. A stage's row brings its frame into view on the same
   canvas; an exception's row emphasizes it (5); a main flow's row puts its main flow on the canvas, and the rows of one
   main flow under several stages (the trunk's) are all shown selected.
10. **An earlier state is read, not migrated**: `exceptions: false` and `hidden`'s `exceptions` → excluded; a stage's
    place (`@<stage>`) → すべて; an exception's timeline → すべて, included (the emphasis is not kept, so none); a main
    flow's timeline → that main flow. A trial of this version's flow is read the same way.
11. **Following** stops at every move of the breadcrumb and the toggle (the reader's own), and a location carries the
    storming, the level, the timeline (`timelineId`, the main flow) and the layer (`exceptions: false` when excluded) —
    no stage, no emphasis. **Moving to a sticky not drawn** includes the exceptions first, then shows すべて, then what
    the 絞り込み hides, one rule as in §10. **`dt export svg`** takes `--timeline <main flow>` and
    `--exceptions include|exclude` (`show` and `hide` still taken as their earlier names; `--stage` is gone); the heading
    reads 「… › storming › timeline · level · 例外を含む / 例外なし」, and the AI is told the timeline and the layer.

*Decided here*, while implementing: the trunk's main flow is named and identified by its first stage's timeline (any
of its timelines' IDs reads as it); the bands of the lanes are drawn by the page in the canvas's layer, behind the
notes, and not printed nor exported; a caption naming several exceptions (a lane they share) emphasizes them in turn.

### 12. Whoever applies a policy looks, and the trigger through a read model (2026-11-07)

*Decided by the maintainer* 2026-11-07, after a real storming (DSS 出退勤) drew two lines for one trigger: the policy
「チェックが済んだら点呼する」 is `on` 「アルコールが検知されなかった」 and `reads` 「アルコールチェック結果」, which is fed
`from` that event, so the canvas had event → read model → policy and, beside it, event → policy. §9 put the policy's
`reads` on the policy's row, but drew it to the policy even when a person applies the rule. Both are drawing changes:
the `.dtes`, its errors, `dt fmt` and the semantic graph do not change.

1. **Whoever applies a policy looks at its read model.** When a policy is `by` an actor (a rule a person applies by
   hand, §7), its `reads` is read model → the actor's copy beside the policy's note → the policy: event → read model →
   actor → policy, as a command's is read model → issuer → command (§6). A policy without `by` keeps read model → the
   policy (§9.6). The actor is stuck on its policy only when no read model leads to it, as an issuer is on its command
   (§6, ELK).
2. **The trigger through a read model is not drawn twice.** When an event a policy is `on` feeds a read model the
   policy `reads` (`readmodel { from … }`), and the drawing has the line from that event's note to the read model's
   copy beside the policy's note and from there to the policy (directly, or through the actor applying it), the
   policy's `on` line from that event note is left out: the path through the read model says the trigger. The `on`
   lines from the events that feed none of its read models stay. Only the line is left out: the semantic edge, the
   timeline filter (which follows `on`) and the layout's input otherwise are unchanged. Policies are drawn at Design
   Level only, so Big Picture does not change.
3. **The lines' words** do not change: read model → actor is §9.7's 「「{B}」は「{A}」を見て判断する」, now also for the
   actor applying a policy.

*Decided here*, while implementing it: the `on` line is left out per policy note (with copies per step, the note
after an event fed into its read model loses the line from that event, a note after another event keeps its own),
after every line of the view is drawn (`drawChains`), so that it is left out only where the path through the read model
is drawn.

### 13. Alternatives at one step share their notes (2026-11-07)

*Decided by the maintainer* 2026-11-07, on the same storming as §12: 「検知結果を取り込む」 emits 「アルコールが検知
されなかった」 (the main flow) and 「アルコールが検知された」 (an exception branching off at the same step), and
「チェックが済んだら点呼する」 is `on` both. Copies per step (ADR 0024, amendment of 2026-11-05) drew the command, its
handler, the policy, its read model and its actor once for each lane: two identical chains that differ only in the
event, which reads as two things happening.

1. **Copies are per position in time, not per lane.** A command whose events, or a policy whose triggers, stand at
   several slots at the same position (lanes side by side at one step: the alternatives of that step) has one note
   there, standing for all those slots. Slots at different positions keep a note each, as before.
2. **The shared note stands in the band of the topmost lane** (the main flow before its exceptions, §11), and its lines
   join the event notes of every lane it stands for: the handler's `emits` to each outcome, each trigger's `on` (or
   `readmodel-from`, §12) into the policy. The issuer, read model, actor and handler beside it are shared with it. The
   lower lane's band is left empty there.
3. **A hotspot on an event stays on each note of that event**: it is about the event, which is still drawn in each lane.

*Decided here*, while implementing it: the projection gives each event note its lane's row (`EventPlace.lane`, views
with lanes only), and the notes are made per position (`notesAt` in `chains.ts`; `Note.slots` lists the slots a shared
note stands for, its `slot` the topmost one, where the grid places it). A view without lanes (a timeline's view, the
integrated canvas of a storming without stages) has one slot per position and does not change.

### 14. A person who notices an event issues the command: a command's `on` (2026-11-07)

*Decided by the maintainer* 2026-11-07, on the DSS storming of §12 and §13: 「出勤した」 is the delivery staff's own act,
which no system records, and on it 「配達員」 issues 「検知結果を取り込む」. §1 left a policy as the only link from an
event to a command, so the AI either wrote a policy for what is no rule (nobody can state it as 「出勤したら必ず…」:
the person decides, on noticing it) or left the event unconnected (S029). At Design Level an event may now lead to an
actor who issues a command, without a policy: **event → actor → command**.

1. **Grammar.** A command issued `by` an actor may say which events it reacts to with `on`, the keyword a policy and a
   hotspot already use (no new keyword); a list as for the other relations, `on A, B`:

   ```dtes
   command ImportAlcoholResults "検知結果を取り込む" {
     by DeliveryStaff
     on ClockedIn // the issuer issues it on noticing this event
     reads AlcoholCheckSheet // optional, as before
     handledBy StaffAlcohol
     emits AlcoholChecked, AlcoholDetected
   }
   ```

2. **A rule or a judgement.** A rule you can state in one sentence (「〜したら必ず〜する」) is a policy, `policy { by
   <actor> }` when a person applies it by hand (§7); a person's judgement on noticing an event is the command's `on`;
   unsure which, a hotspot on the command, never a guess (§3).
3. **Errors**, each with a concrete fix: `on` on a command without `by` (if a policy `issues` it, the hint names that
   policy and says to put the event in its `on`; otherwise to add `by <actor>`, or to put a policy between for a
   rule); `on` on a command whose `by` is (also) an external system (an external system reacting to our event is a
   policy issuing a command handled by it, or addressed to it); `on` naming anything but an event is S003, with a hint
   of the relation meant.
4. **Meaning.** An event a command is `on` is a trigger, as a policy's is: no S029 for it. The actor takes part through
   `by` (S027) as before.
5. **`dt fmt`** orders a command's clauses `by`, `on`, `reads`, `handledBy`, `emits` (who, on noticing what, looking
   at what, handled by whom, with which outcomes), and merges repeated `on`s as the other relations (§7).
6. **Drawing.** The line runs from the event's note to the issuer's copy beside the command's note, and the `by` line
   from there to the command: event → actor → command, as read model → actor → command. With `reads` too, the read
   model still goes to the actor. The timeline filter keeps the one-hop path event → actor → command → event when both
   events are in view, as event → policy → command → event.
7. The AI-facing texts follow, as in §9.9: `dt guide dtes-quick` and `storming-rules`, the agent's prompt, the spec and
   `docs/live-view.md`'s lines.

*Decided here*, while implementing it:

- **The edge kind is `command-on`** (event → command), not `on`. Like `hotspot-on`, `readmodel-from` and `event-from`,
  a keyword whose meaning depends on its owner gets an edge kind of its own: every place that reads `on` as event →
  policy (the timeline filter's paths, a policy's notes per step, §12's trigger through a read model, the elements of
  the exceptions only, an event's reactions in the detail) stays right without a check of the target's kind, and the
  drawing, which goes into the actor and not the command, has its own case. It is causal (`isCausal`: drawn as 流れ like
  any relation, §8). The semantic graph has it only when an actor, and no external system, issues the command (an
  invalid one is left out, as other invalid relations are).
- **The diagnostics are S032** (`on` on a command without `by`; reported at the `on` clause, besides S024 when nothing
  issues it) **and S033** (`on` on a command `by` an external system, also when an actor is `by` it too). A command a
  policy issues *and* `by` someone is S025 only, as for §9's S030.
- **Copies per step**: a command's notes stay anchored by its `emits` events (`notesAt`); the `on` line comes from the
  event's note at the nearest position at or before the command's note (`feeding`, as for `readmodel-from`), to each
  actor copy beside it. In ELK the actor then has two lines and is no longer stuck on its command (`attach`), with no
  change to it.
- **The timeline filter** keeps a command's `command-on` when its event is in view and the command is kept (it emits
  an event in view), which also keeps the one-hop path.
- **§12.2 applies to a command's `on` too** (a later commit, *decided by the maintainer*): when the event a command
  is `on` feeds a read model the actor issuing it looks at (`reads`), and the drawing has event → that read model's
  copy → the actor's copy, the `command-on` line from that event note is left out: the path through the read model says
  the trigger. The `on` lines from events that feed none of the command's read models stay. Only the line is left out
  (the same post-pass of `drawChains` as for a policy's `on`).
- **The line's words**: a relation `notices`, ja 「「{A}」を受けて「{B}」が動く」, en “{B}” acts on “{A}”. An event's
  hidden connections in the detail (Big Picture) list such a command beside the policies reacting to it.

### 15. The line into a lane, when the design already joins its events (2026-11-07)

*Decided by the maintainer* 2026-11-07, on the DSS storming of §12–§14: the exception 「点呼で運行不可」 branches off
after 「点呼を依頼した」 into 「点呼で運行を認めなかった」. At Design Level the drawing already joins the two: 「点呼を
依頼した」 → 「点呼依頼」 (read model) → 「現場管理者」 → 「点呼する」 → 「点呼」 (handler) → 「点呼で運行を認めなかった」;
beside it, the dashed line into the lane (§7) joined them a second time, and read as one more step.

1. **At Design Level, the line into an exception's lane is not drawn when the drawn lines of the design already join
   its two events**: a path along the lines, from the note of the event it branches off to the note of the lane's
   first event, through no other event. It is laid out as before (`GraphEdge.hidden`), so nothing moves.
2. **When no such path is drawn, the line stays**: it is then the only thing showing where the exception branches off.
3. **The lane's label stays**, where it was, and pressing it still emphasizes the exception (§11.5): on the canvas, in
   print and in `dt export svg` alike.
4. `then` lines, Big Picture, and the timeline's and integrated views (which already draw no time order at Design
   Level) do not change.

*Decided here*, while implementing it:

- **Every semantic line counts but a hotspot's `on`** (`joinedByLines` in `graph.ts`): not only the causal ones (§8's
  流れ: `on`, `command-on`, `issues`, `handledBy`, `emits`, `event-from`) but also `by`, `reads` and `readmodel-from`,
  which the DSS path needs and which are drawn along the flow. A hotspot's `on` is a question, not a step, and the
  path goes through no hotspot and no open hotspot's empty slot. It goes through the notes as drawn (a shared handler,
  §6, is one note) and stops at any other event note, so a chain through a later event of the main flow does not count.
- **Only the two ends that are events**: a lane branching off a group step (its source a group) keeps its line.
- **The label is kept by a flag beside `hidden`**: `GraphEdge.labelDrawn` (an edge laid out, its line not drawn, its
  label drawn). The scene keeps such an edge with `EdgeProps.lineless`, and the canvas, the print and the portable SVG
  draw its label alone, where it is laid out — no line, no head, no hit path nor selection outline (there is no line
  to point at or explain: the label's button over the canvas, §11, is what is pressed). Other hidden edges (the time
  order, a stage's `after`) still draw nothing, their labels included.

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
- The rule IDs go up to S033 (§7, §9, §14); the guide's rules table and its one-problem examples cover each.
- §9 makes the `.dtes` of 0.8 with a `reads` on a policy's command invalid until migrated (`dt migrate dtes` moves it
  when one policy issues the command); a policy issuing several commands has to be split by hand.
