# ADR 0030: Modes (`dt open` / `dt collab` / `dt agent`), messages addressed to the AI, triage and a warm agent

- Status: accepted (2026-11-03), not implemented; tasks M2–M7 of [the plan](../plans/modes.md). Every decision below
  was taken by the maintainer (marked *Decided by the maintainer*) except those marked *Proposed*, which the plan
  chose where the maintainer left the choice open; the plan's open questions are not decided here.
- Date: 2026-11-03
- Input: [the plan](../plans/modes.md) (M0: the measurements of a run, cold and warm, on `feat/modes` at 45bc5a8), and
  the maintainer's two rounds of decisions on it. The code is `feat/modes` at 182e037. ADR 0026's amendments made on
  `feat/collab-card` (revert and restore; no revision confirmation) and ADR 0029 (`feat/react-flow`) are not on this
  branch yet; this ADR assumes them.
- Amends: [ADR 0026](0026-collaboration-sessions.md); see [Amends](#amends).

## Context

The Live View (`dt view`) and the collaboration session (`dt session start`) are separate commands, and the AI runs
only in a session, started by hand in another terminal (`dt session subscribe --agent claude`). One person who wants to
ask the AI about their own model has to run a session for one, claim the facilitator link, send a message, then send it
again with 「AI に送る」. Every message in a session is a candidate change for the facilitator to apply; a question gets
an answer only by running a change run that happens to change nothing (measured: 14 s, 0.108 USD, the answer squeezed
into a 300-character summary, `dt fmt` and `dt check` run for nothing). Every run starts Claude Code anew (~1.3 s of a
~16 s run; a warm process measured 25 % faster over four runs).

Two questions shape the decision: who in a shared chat is talking to the AI, and whether a message asks for a change
or for an answer — without making the person say which, and without letting a question lead to writes nobody approved.

## Decision

### 1. Commands: `dt open`, `dt collab`, `dt agent`; the old ones removed

*Decided by the maintainer.*

- `dt open`: the Live View with the chat for **one person**: loopback only, the dev identity, the person signed in as
  the facilitator without a form, the agent started in the same process by default (`--no-agent` to not start it).
  `dt open --host <non-loopback>` serves the Live View read-only, as `dt view --host` did (*Proposed*).
- `dt collab` (and `dt collab link`): today's collaboration session, dev or Access identity, the agent in process by
  default (`--no-agent`).
- `dt agent`: the AI runner alone, for another machine or terminal, or to add one later.
- **Removed outright, no deprecated aliases**: `dt view`, `dt session start`, `dt session link`, `dt session subscribe`.
  Running one prints an error naming its replacement.
- `dt open` refuses on a workspace with an open collab session; `dt collab` continues a solo session, with its person
  as the facilitator. A session records its mode (`Solo` / `Collab`).

### 2. Config: `open`, `collab`, `agent`, `classifier`; `session` and `view` are errors

*Decided by the maintainer:* the section `session` is renamed `collab`, and the old key is an error at once, with a
message saying what to rename; the answerer's and the runner's settings are separate groups (decision 6). *Proposed*
(the maintainer left where the other settings go to the plan):

- `open.port`, `open.host` for `dt open` (was `view.*`; `view` is an error too, as `dt view` is gone).
- `agent.*`, top level, for everything the agent (`dt agent` or in process) reads, in both modes:
  - `agent.port`: the agent API (was `session.agent.port`);
  - `agent.run.*`: the runner — `allowedTools`, `dt`, `maxPreviousRunDiff` (were `session.agent.*`), and the new
    `model`, `effort`, `warm`, `restartAfter`, `idleTimeout`;
  - `agent.answer.*`: the answerer — `model`, `effort`, `warm`, `restartAfter`, `timeout` (new);
  - `agent.triage.model`: the light model of stage 3 (new).
- `classifier.*`, top level: Clef (was `session.classifier.*`), called by the server in both modes.
- `collab.*`: the rest of `session` (`port`, `host`, `identity`, `access.*`, `maxParticipants`, `quickReactions`).

The agent and the classifier serve both modes; under `collab` they would read as collab-only, the very reason round 1
hesitated to rename `session`. Since every config file breaks once anyway, they move now to sections that say what they
are. The error for `session` names each destination. A role's unset model or effort falls back to Claude Code's
settings, never to another role's.

### 3. The AI is addressed; other messages are talk between people

*Decided by the maintainer.*

- In **collab** the AI handles only messages **addressed** to it: a message mentioning **`@AI`** (the AI is a
  mentionable participant, offered first among the composer's `@` candidates), or a **reply to a message of the AI**
  (its answers, its runs). Other messages are human conversation: no model sees them.
- The facilitator can address any message (「AI に送る」, one or several): the rescue for a forgotten `@AI`.
- In **`dt open`** every message is addressed.

*Proposed:* the AI is a virtual participant with a reserved ID (`ai`), not stored among the session's participants and
not counted in `maxParticipants`; its answers are messages authored by it, so replying to one addresses it by the
existing `replyTo`.

### 4. A triage cascade decides 相談 / 依頼 / neither

*Decided by the maintainer.* The person never says whether a message is a consultation (相談) or a change request
(依頼). Each addressed message goes through stages that each answer 相談, 依頼, neither or unknown; unknown goes to the
next stage, and a stage ends the cascade with "neither" only when confident:

1. **Mechanical**, narrow: only sure "neither" (empty, emoji only, short fixed acknowledgements such as ありがとう,
   了解, OK). It never tells 相談 from 依頼 by keywords.
2. **Clef** (Cloudflare Clef, the existing classifier settings), only when configured; skipped otherwise.
3. **A light model** (e.g. Haiku; configurable) given the message, the recent chat and the open change proposals.
4. **相談** → answered at once by a **read-only agent** (Claude Code with `Read`, `Grep`, `Glob` only, enforced by the
   tools it is started with), in parallel with the change queue. The answer is a reply bubble; no revision.
5. **依頼** → from a **participant**: a **change proposal** (text: what, where, how; no diff preview) that the
   **facilitator** approves (possibly edited), or rejects — several at once allowed — and that then joins the queue as
   a normal run. From the **facilitator**, or in **`dt open`**: straight into the queue.

The final agents may correct the triage: the read-only answerer can say the message is a request and propose a change;
the run agent can say a queued request is a question and answer it without editing. *Proposed:* still unknown after
stage 3 is treated as 相談 (the side that writes nothing).

So `dt open` is a collab session whose only person is the facilitator: every message addressed, a 依頼 queued in one
step, no proposals.

Clef keeps one role, stage 2; its former role (showing the facilitator which rows offer 「AI に送る」) disappears. It is
the only provider; a generic interface for other classifier APIs is a later possibility.

### 5. Models per role

*Decided by the maintainer:* the agent gets optional model and effort settings with no default of ours (unset, Claude
Code's settings apply), and the triage (stage 3), the answers (stage 4) and the runs can each have their own model.
*Proposed:* stage 3 defaults to the alias `haiku`, since a light model is the point of the stage (an open question of
the plan).

### 6. Two roles: the answerer and the runner

*Decided by the maintainer and the supervisor* (later on 2026-11-03): the Claude Code execution for 相談 and for 依頼 is
separate, with separate settings and separate entry points.

- The **answerer** does stage 3, answers and proposals: read-only tools (`Read`, `Grep`, `Glob`) enforced by `--tools`
  and `--allowedTools`; no `dt fmt` / `dt check`; no claim or lease, no revisions; a short timeout
  (`agent.answer.timeout`); its own prompt and output (an answer, or "this is a request" → a proposal). Its jobs come
  from an entry point of their own on the agent API (`/agent/answers/events`, results by `POST /agent/answers/:job`),
  handed to one connected answerer each, in parallel with runs: an answer never blocks, nor is blocked by, the run
  queue.
- The **runner** is today's pipeline: write tools (`agent.run.allowedTools`), the queue (`/agent/events`), lease,
  revisions, the success rule.
- One `dt agent` (and the in-process agent of `dt open` / `dt collab`) holds both by default; `dt agent --role
  answer|run` starts one only, so that they can live on different machines (each still working on the workspace's
  files).
- Each role has its own warm process and restart policy; the answerer is told `changedSinceYourLastAnswer`, the runner
  `changedSinceYourLastRun`.

### 7. A warm agent, on by default

*Decided by the maintainer:* one long-lived Claude Code conversation per role of each agent, each job one turn, on by
default, with `agent.run.warm: false` / `agent.answer.warm: false` to turn it off. *Proposed* (the plan's design): Claude Code's
`--input-format stream-json` rather than the Agent SDK; restart after the role's `restartAfter` jobs, past 150k tokens of context,
after a revert or restore, a declined run, or a change of tools, models or `dt`; interrupt by the control request; fall
back to cold runs when the warm process misbehaves. *Decided by the maintainer* (M3b): a warm process of the runner
that takes no turn for `agent.run.idleTimeout` minutes (default 30; `0` = never) is ended to free its memory, never
during a turn; the next run starts a fresh one, which is not a failure.

### 8. The record of each triage

*Decided by the maintainer* (for debugging): each addressed message keeps a record of how it was addressed, which stages
ran, what each answered with its confidence and reason, which stage decided, and any override. *Proposed:* the
facilitator sees it from the message; participants see only the outcome; the log has one line per triage without the
text.

## Alternatives considered

- **The user marks 相談 or 依頼** (a choice at send time, or a prefix). The kind would be known for certain, but it is a
  question the person should not have to answer, and the wrong choice is common in a chat. Rejected by the maintainer.
- **Classify every message, human talk included.** The AI would react to talk between people (or at least read and
  pay for it), and the participants would not know when the AI is listening. Addressing with `@AI` makes it explicit
  and keeps talk private to the people; the facilitator's 「AI に送る」 covers a forgotten mention.
- **The facilitator gates everything** (today's model: only the facilitator sends to the AI). Safe, but a participant's
  question waits for the facilitator to notice it, and the facilitator becomes a relay. With triage, questions go
  straight to a read-only agent; only writes need the facilitator.
- **Clef only** (no stage 3). Clef is optional (an external account) and answers probabilities on fixed questions
  without the chat's context; it cannot read 「それでお願いします」 against an open proposal. It stays as an optional,
  cheaper stage before the model.
- **One heavy agent decides everything** (round 1 of the plan: every addressed message is a normal run with writing
  tools, and the agent decides whether to answer or edit). The simplest, but no hard read-only guarantee for a
  question, a participant's message could lead to writes without the facilitator, and every "ありがとう" costs a full
  run. The cascade puts cheap stages first and gives the writing tools only to approved or facilitator-sent requests.
- **One Claude Code process for answers and runs** (one role). Rejected by the maintainer and the supervisor: a process
  cannot be both read-only and writable (`--tools` is fixed per process, and the read-only guarantee is the process's
  tools); answers would queue behind runs (one turn at a time); and the two want different models, effort and
  timeouts.
- **Proposals with a diff preview** (the agent edits a copy and the facilitator approves the diff). Exact, but costs a
  full run per proposal before anyone agreed, needs an isolated workspace per proposal, and goes stale when another run
  changes the files. A text proposal (what, where, how) is cheap and enough to decide on; a preview is a later
  possibility.
- **Deprecated aliases for one release** (round 1). Rejected by the maintainer: the package is young; one clean break
  with a changelog entry is simpler than a release of warnings.
- **Keep `session` as the config section, or read it for a version.** Rejected by the maintainer: the name is the old
  command's; an immediate error with a message is clear and cheap to fix.

## Amends

- [ADR 0026](0026-collaboration-sessions.md):
  - Context and "Server, transport, security": `dt session start` is `dt collab`; `dt view` no longer exists (a session
    in `Solo` mode is `dt open`). Tasks S4 and S6 name `dt session start` and `dt session subscribe`: today `dt collab`
    and `dt agent`. Their text is not rewritten.
  - "Messages, apply, classification and the agent's dt": a message reaches the AI by being addressed (`@AI`, a reply
    to the AI, solo mode, or the facilitator's 「AI に送る」), then by the triage; `apply` on `POST
    /api/session/requests` is removed. The classification's role (the facilitator's hint, `session.classifications`)
    is replaced by stage 2 of the triage. `session.classifier` is `classifier`; `session.agent.port` is `agent.port`, the other `session.agent.*` keys are `agent.run.*`;
    the rest of `session` is `collab`.
  - The run (S6 and "Structured replies"): the reply gains `answer` and the status `answered`; the success rule needs
    `dt fmt` and `dt check` only when the run changed files. The subscriber of S6 becomes the runner role; the agent
    API gains a second entry point for the answerer role (triage, answer and proposal jobs, no lease), beside the
    serial run queue.
  - "Mentions of people": `@` also offers the AI, first; "Solo: in a session alone, `@` offers no one" becomes "offers
    only the AI".

## Consequences

- **Breaking** for users: four commands removed and the config sections `session` and `view` rejected. The release's
  changelog (en/ja) lists each with its replacement, and the errors say the same.
- **Cost per addressed message**: at least one light-model call unless stage 1 or 2 decides; a consultation also costs
  an answer (measured for a question on Opus: ~0.11 USD, ~14 s; less with a lighter `agent.answer.model`); a
  participant's request costs a proposal before its run. Messages that are not addressed cost nothing, which is a
  saving for chats that are mostly talk. A per-person limit is an open question.
- **Safety**: files are written only by runs, and a run is queued only by the facilitator (their own request, their
  approval of a proposal, their 「AI に送る」) or by the one person of `dt open`. A consultation runs with read-only
  tools enforced by Claude Code's `--tools`, not by the prompt. A misclassified question that reaches a run can still
  be answered without edits (the run agent's override), and every run's changes stay visible and can be reverted.
- **Deployment**: the roles can be split across machines (`dt agent --role`), each with the workspace's files; the
  default (both in one process) needs nothing new.
- **Latency**: a 相談 is answered without waiting for the change queue. Stage 3 adds a model call before anything
  else; it runs warm to avoid ~2.8 s of start. The warm agent saves ~1.3 s per run and fewer re-reads (25 % measured).
- **Privacy**: message text goes to Cloudflare only when `classifier` is enabled, and only for addressed
  messages (before, every message in a session with the classifier on).
- **Complexity**: two new aggregates in the collaboration model (the triage, the change proposal), a second entry point
  on the agent API, and two roles with a warm Claude Code process each (plus the answerer's small triage process). The triage record is what makes a misrouted message
  explainable.
- **Debugging**: every decision of the cascade is recorded with its stage and reason.
