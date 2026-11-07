# ADR 0034: Reviewing an AI run before it ends, in three stages by scope

- Status: accepted; stages 0 and 1 implemented (`feat/run-review`), stage 2 recorded for later. Decided by the
  maintainer: the three stages, their scopes and triggers, what stage 0 checks, what the agent is given in stage 1 and
  that it fixes what it finds in the same run, which knowledge it is given, and how the card shows it (marked *Decided
  by the maintainer*).
- Date: 2026-11-07
- Input: feedback from a live session of the first user. When a decision was written in the chat, the stickies were
  left half-corrected again and again: the event was fixed but the hotspot on it was not resolved (no resolution
  written), or the other way round (the resolution written, the sticky unchanged).
- Builds on: [ADR 0026](0026-collaboration-sessions.md) (runs, the agent API), [ADR 0030](0030-modes-triage-and-the-warm-agent.md)
  (the warm agent), [ADR 0031](0031-knowledge.md) (knowledge, conflicts), [ADR 0032](0032-dtes-design-level-grammar.md)
  (a hotspot `on` any sticky), [ADR 0033](0033-people-edit-stickies.md) (people's edits).

## Context

A run carries out requests by editing `.dt` and `.dtes` files. A decision in the chat usually touches two things at
once: the stickies it decides, and the hotspot that asked the question. Nothing checked that both changed; nor that a
label changed in one storming was changed where another storming says the same; nor that what the project decided
earlier (its knowledge) still agrees with the stickies the run left. People found these slips later, by reading.

A review costs: a model reading the whole workspace after every run would cost more than the run. The scope of a review
decides its cost.

## Decision

### Three stages by scope (*Decided by the maintainer*)

| Stage | Scope | When | Who | Cost | What happens |
|---|---|---|---|---|---|
| 0 | the run's diff of the stormings | every run, right after the agent's work | dt's rules | ~0 | findings, given to stage 1 and kept with the run |
| 1 | the neighbourhood of what the run changed | every run that changed stormings, at its end, inside the run | the agent of the run | one more turn | fixed in the same run, or kept with why |
| 2 | the sections changed since the last whole review | at the end of a journey's stage, at the session's end, by a button | a light model (Haiku) sifting, then a larger model | per review | proposals only |

Stages 0 and 1 are built now. Stage 2 is recorded here and built later: its scope is what changed since the previous
whole review (by section of the stormings), its triggers the end of a stage of the journey, the end of the session and a
button; a light model sifts what is worth a closer look, a larger model looks; its result is a list of proposals people
decide on (nothing is changed by it).

### Stage 0: the rules on the run's diff

`contexts/collaboration/src/domain/review.ts` (`reviewStormings`), pure, from the storming IR before (the run's base
revision) and after (the workspace now, or the result revision). Each rule looks at this run's changes only:

- **ResolvedUnchanged** 解決したが付箋はそのまま: a hotspot open before (or without a status) is resolved now, and the
  sticky it is `on` reads as before.
- **ChangedOpen** 付箋を変えたがホットスポットは開いたまま: a sticky the run changed has a hotspot `on` it that is open,
  and whose question, status and resolution the run did not touch.
- **StaleWording** 前のラベル・名前が残る: a sticky the run relabelled or renamed, whose label or name before is still
  another sticky's of the same kind, in any storming (and the run did not change that one).
- **DuplicateLabel** 同じラベルで別の ID: a sticky the run added has the label of another sticky of the same kind with
  another ID, in any storming.

A **rename** is a sticky removed and one added in the same storming, of the same kind, with the same label or the same
relations (the stickies it points at and that point at it, by the names they keep); only a one-to-one match counts.
When a run renamed a sticky, the knowledge items about it (ADR 0031: `about` names a sticky by ID) are corrected to
name the new ID once the run ends (`relinkRenamed`, by `dt`, a new version each). That is a repair of a broken link,
not a finding: it is done without asking. The `cloudflare` store needs no change (it is the existing `correct`).

### Stage 1: the neighbourhood, checked by the agent in the same run

**How it runs** (*Proposed*, chosen over the alternatives below). When the agent's work is done (outcome `done`, a
`.dtes` changed, nothing outside the sources), the subscriber asks the server for the review
(`POST /agent/runs/:id/review`, from the lease's holder): stage 0 on the base revision against the workspace now, the
neighbourhood, and the knowledge. When there is anything to check, the subscriber gives the agent **one more turn of
the same run**: a warm agent (ADR 0030) gets it as the next message of the same conversation (`continuedPrompt`: it
remembers what it did and read; the prompt cache holds the rest); an agent that starts afresh (`warm: false`, or the
warm process was replaced) gets the run's whole prompt, said done, then the review. Its reply has the run's shape (the
schema of the process stays, so the warm process is kept) with `review`: what it fixed, what it kept and why, and the
knowledge items at odds. Then `dt fmt`/`dt check` run once, and the run finishes as before; its result revision holds
the review's fixes too. Nothing changes in the run's states: the review is inside `Running`.

- **The neighbourhood**, decided mechanically: the stickies the run changed or added, the hotspots on them, one step of
  relations from them (who issues a command, what handles it, the events it emits, the policies on them, the read
  models fed from them, and back), and what stage 0 found; at most 80. The agent reads them in the files.
- **The knowledge given** (*Decided by the maintainer*): the items about the neighbourhood's stickies (and about a
  renamed sticky's old ID, which they still name), never AS-IS — what was is no reason to change what is decided —,
  decisions first, then rules, then the other kinds, each newest first, at most 12, their text cut to 600 characters.
  None when the session keeps no knowledge or its extraction is off: the review runs without it.
- **What the agent does**: fixes what is at odds with the requests and the decisions **within the requests' scope**
  (the run's rules still hold: `.dt`/`.dtes` only, people's wording kept); starts nothing new; says why for each
  finding it leaves.
- **Knowledge at odds with the stickies** (an old item says 14 days, the run made it 30): the item is never edited
  by the review. The agent may say it two ways, both only of the items it was given (the server checks):
  - **a retirement it proposes** (`review.retire`: the item, the reason — replaced, obsolete, wrong —, an explanation,
    and its evidence, a sticky this run changed or a decision): dt proposes it at once through
    `KnowledgeStore.propose`, as the review `run:<id>` (`proposedBy: { kind: 'Review' }`, ADR 0031 §12), and it shows
    in 廃止の候補 for people to approve or dismiss. The agent is told the extractor's rules
    (`RETIREMENT_PROPOSAL_RULES`), and the store refuses what it refuses for the extractor (an AS-IS item against the
    TO-BE, one already waiting, one dismissed on the same evidence). The review is never given an AS-IS item, nor a
    retired one (the store's lists leave them out);
  - **an item at odds** (`review.knowledge`): handed to the next extraction as a flag (`SessionExtraction.flag`), with
    the item among those given and `reviewFlags` in the job; the extractor records a `conflict` (ADR 0031) when the
    talk states the new decision. The flags are kept in memory and wait for the next extraction with new messages; a
    retirement proposed does not wait.

**The pair rule in the run's prompt** (*Decided by the maintainer*): a decision that answers a hotspot changes both the
stickies it decides and the hotspot (`status resolved`, `resolution`); doing only one needs a reason in the request's
note.

**Switched off** with `agent.run.review: false` (default on).

### What people see (*Decided by the maintainer*)

The run keeps its review (`AgentRun.Completed.review`, `RunReview`): what stage 0 found when the agent was asked
(`found`), what it still finds once the run ended (`left`, computed by the server from the base and result revisions),
what the agent says it fixed and kept, and whether it was asked. The card shows, under what the AI says, few words:
「見直し」, a line per kind — 「解決したが付箋はそのまま 1 件 · 直した」 or 「… · 残り 1 件」 —, ✓ what the AI fixed, – what
it kept: why. Nothing when nothing was found, fixed or kept. While something is left, the facilitator's 見直しを頼む
sends a message to the AI replying to the run (its card continues), with the stickies left as its targets. The
relinking of knowledge is not shown (it is a repair).

People's own edits (ADR 0033) get no review nor prompt now.

### Cost

Stage 0 is a diff of two analyses the server has anyway (the base revision's is kept). Stage 1 is one more turn per run
that changed stormings: with the warm agent, its context is in the prompt cache, and the turn reads only the
neighbourhood; its input is bounded (80 stickies, 50 findings, 12 items of 600 characters). A run that changed only
`.dt`, or nothing, has no review. A review that fails (the server's or the turn) never fails the run.

## Alternatives considered

- **The review as the last step of the run's own prompt**, with a tool that computes the neighbourhood: one turn
  instead of two, but the agent decides whether to call it, and the neighbourhood is known only after the work.
  Rejected: not reliable, and the agent's own reading is what the review is meant to check.
- **A separate review run** (queued after the run, a card of its own): clean in the states, but the context is lost
  (a fresh agent re-reads), people see two cards for one decision, and a person may edit in between.
- **Fixing the findings mechanically** (resolve the hotspot, copy the label): the rules find candidates, not certainties
  — a changed sticky may not answer its hotspot. Only the knowledge links of a rename are repaired mechanically.
- **The review only when stage 0 finds something**: misses what the rules cannot see (a decision of the knowledge, a
  relation). The neighbourhood is checked every time, its cost bounded.

## Consequences

- A run that changed stormings takes one more turn; its reply's schema has an optional `review`.
- The agent API has `POST /agent/runs/:id/review`; `finish` takes `review`. An older subscriber has no review; an older
  server answers the review 404, and the run finishes as before.
- `AgentRun.Completed` has `review`; the stored runs need no migration (JSON rows).
- The extraction takes flags (`reviewFlags`) and goes past the light model's "no" while it has some.
- A review proposes retirements to the store directly (ADR 0031 §12), never retires.
