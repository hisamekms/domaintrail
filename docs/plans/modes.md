# Plan: open / collab / agent modes, messages addressed to the AI, triage and a warm agent

Today the Live View (`dt view`) and the collaboration session (`dt session start`) are two separate commands, and the AI
runs only in a session, started by hand in another terminal (`dt session subscribe --agent claude`). One person who
wants to talk to the AI about their own model has to run a session for one, join it, claim the facilitator link, send a
message and then send it again with 「AI に送る」. Every run starts Claude Code anew. This plan:

- splits the product into two modes, **non-collab** (`dt open`) and **collab** (`dt collab`), with the AI runner as
  its own command (`dt agent`), started in the same process by default; the old commands go;
- makes the AI a participant one **addresses** (`@AI`, or a reply to the AI); in `dt open` every message is addressed
  to it;
- **triages** each addressed message, without the person saying which it is, into a **consultation** (相談: answered
  at once by a read-only agent), a **change request** (依頼: queued, or first proposed to the facilitator when it comes
  from a participant) or neither;
- keeps one Claude Code conversation alive per agent (a **warm agent**), after measuring where a run's time goes.

It was written in two rounds. The first (M0) recorded the maintainer's first decisions, the measurements, a first design
and open questions. The second round (2026-11-03, the maintainer's answers and a new design for who talks to the AI)
supersedes parts of the first; those parts are marked *Superseded* and kept short so that the reasons stay readable.
The decisions are recorded in [ADR 0030](../adr/0030-modes-triage-and-the-warm-agent.md).

## Landing

- Starts on `main` after `feat/collab-card` and `feat/react-flow` are merged (see [Collisions](#collisions)); the
  agent task M3 may start earlier, as it touches neither.
- As for the earlier plans: one integration branch (`feat/modes`) from `main`, one worktree and branch per task, each
  done by a worker and merged into the integration branch after review, one pull request to `main`, squash merged.
- The decisions that change ADR 0026 (collaboration sessions) are written down first (M1): **ADR 0030** (0029 is taken
  by `feat/react-flow`).
- **Breaking, without aliases**: `dt view`, `dt session start`, `dt session link` and `dt session subscribe` are removed,
  and the config sections `session` and `view` are errors. The release says so in the changelog (en/ja) with what to
  run and write instead.
- Every task leaves typecheck, lint, fmt, tests and build passing.

## Decisions

### Round 1 (maintainer, 2026-11-03, morning)

| # | Point | Decision | Status |
|---|---|---|---|
| 1 | Modes | Two: **non-collab** and **collab**. Commands from zero (plan A): `dt open`, `dt collab` (+ `dt collab link`), `dt agent` | Kept |
| 2 | `dt open` | The Live View with the chat, for one person: loopback only, dev identity, no invite, hand-over or leave. Absorbs `dt view` | Kept |
| 3 | `dt collab` | Today's `dt session start`, Access mode included; `dt collab link` is today's `dt session link` | Kept |
| 4 | `dt agent` | The AI runner alone (today's `dt session subscribe`): on another machine or terminal, or added later | Kept |
| 5 | Agent in process | `dt open` and `dt collab` start the agent **in the same process by default** when Claude Code is usable; `--no-agent` does not start it. With no agent connected the page says so (AI: 接続なし / n 件待ち) | Kept |
| 6 | Old commands | ~~Deprecated aliases for one version~~ | *Superseded* by round 2: removed outright |
| 7 | Non-collab send | ~~One step with an agent, a memo without one~~ | *Superseded*: every message is addressed to the AI and triaged; with no agent it waits (no memos) |
| 8 | Collab send | ~~Unchanged (the facilitator's 「AI に送る」)~~ | *Superseded*: `@AI` and replies to the AI address it; 「AI に送る」 stays as the facilitator's rescue |
| 9 | Consultation | ~~Every message through the same run; the agent decides; no read-only guarantee~~ | *Superseded*: a triage cascade decides before any agent runs; consultations go to a **read-only** agent. Kept from it: the person gives no instruction, and the run agent may still answer instead of editing |
| 10 | Latency | Receiving runs is already push (the agent API's SSE `/agent/events`). Plan a **warm agent**: one long-lived Claude Code conversation per agent, each run one turn | Kept |

### Round 2 (maintainer, 2026-11-03)

| # | Point | Decision |
|---|---|---|
| 11 | Removed commands | `dt view`, `dt session start`, `dt session link`, `dt session subscribe` are removed, **no deprecated aliases** |
| 12 | Config | The section `session` is renamed `collab`; the old `session` key is **an error at once**, with a message saying what to rename. Where `dt open`'s and the agent's settings live is left to this plan: see [Config](#config-domaintrailjsonc) |
| 13 | Q2 | `dt open` refuses on a workspace with an open collab session; `dt collab` continues a solo session with its person as facilitator |
| 14 | Q5 | The agent gets optional model and effort settings; no default of ours (unset, Claude Code's settings apply) |
| 15 | Q6 | The warm agent is on by default, with a switch to turn it off |
| 16 | Who talks to the AI | In **collab** only messages **addressed to the AI** are handled: a message mentioning `@AI` (offered first among the composer's `@` candidates, as a person), or a reply to a message of the AI. Other messages are talk between people; the AI does not react. The facilitator can still send any message to the AI (「AI に送る」), the rescue for a forgotten `@AI`. In **`dt open`** every message is addressed to the AI |
| 17 | Triage | The person never says whether a message is a 相談 or a 依頼. An addressed message goes through a cascade of stages, each answering 相談 / 依頼 / neither / unknown; "unknown" goes on to the next stage; a stage ends the cascade with "neither" only when confident. 1 mechanical (sure "neither" only), 2 Clef (when configured), 3 a light model, then 4 相談 → a read-only agent answers, 5 依頼 → a change proposal (a participant's) or the queue (the facilitator's, or in `dt open`). See [Triage](#triage) |
| 18 | Overrides | The final agents may correct the triage: the read-only answerer can say "this is a request" and propose a change; the run agent can say "this is a question" and answer without editing |
| 19 | Clef | Serves stage 2 only; its former role (showing the facilitator which rows offer 「AI に送る」) disappears. Clef only for now; a generic classifier provider interface is a later possibility |
| 20 | Models | Separate model settings for stage 3 (triage), stage 4 (answers) and runs |
| 21 | Two roles (maintainer and supervisor, later the same day) | The Claude Code execution of 相談 (answers) and 依頼 (runs) is **separate**: two roles in the agent — the **answerer** (read-only, no lease, no revisions) and the **runner** (today's pipeline) — with separate settings (`agent.answer.*`, `agent.run.*`), separate entry points on the agent API, a warm process each with its own restart policy, and `dt agent --role answer\|run` to run one only. See [Two roles](#two-roles-the-answerer-and-the-runner) |

So `dt open` is a collab session whose only person is the facilitator: every message addressed, a 依頼 queued in one
step, no proposals.

## Measurements

Taken on 2026-11-03 on this machine (macOS 25.6, Apple silicon, Node 22, Claude Code 2.1.316, `feat/modes` at 45bc5a8,
built), on a git-initialised scratch copy of `examples/shop` as in [A first real run of a session](../session-first-run.md).
`dt session start --port 4391` and `dt session subscribe --agent claude` ran the four requests below, each sent and
queued through the session's REST API as `scripts/session-seed` does (one run per request, sent after the previous
ended). The subscriber found a wrapper named `claude` first on its `PATH` (in the scratch directory only, not committed)
that started the real `claude` with the same arguments and wrote every stream-json event with a timestamp; the
subscriber's and the server's output lines were timestamped by the driver. No product code was changed.

The user's `~/.claude/settings.json` (read, not changed) gives the agent runs **`"model": "opus[1m]"`** and
`"effortLevel": "medium"` (the runs reported `claude-opus-5-5`), allows `Bash(git *)`, `WebFetch`, `WebSearch` (not
reachable: `--tools` narrows the built-in tools to the session's), and has `Notification`, `Stop` and `PostToolUse`
hooks: they run on every run. The Slack hooks exit at once without their variables, which the driver removed from the
environment.

Requests (Japanese, no targets):

1. `Billing の集約 Invoice のラベルを「請求書」から「請求」に変えてください` (a `.dt` label)
2. `ストーミング Returns に、顧客が返品を取り消したときのイベント ReturnCancelled「返品が取り消された」を追加してください` (a `.dtes` event)
3. `注文が確定したあとでも、注文を取り消せますか？今のモデルではどうなっていますか？` (a question)
4. `Sales の集約 Order のラベルを「注文」から「受注」に変えてください` (a `.dt` label)

### A run's time, split (ms)

| Segment | Run 1 (.dt label) | Run 2 (.dtes event) | Run 3 (question) | Run 4 (.dt label) |
|---|---:|---:|---:|---:|
| Queued → started (claim, start: base revision taken) | 31 | 29 | 27 | 29 |
| Started → `claude` spawned (prompt, workspace scan, `dt` shim) | 575 | 82 | 89 | 80 |
| Spawned → `system/init` (process start) | 489 | 528 | 522 | 519 |
| `init` → first assistant message (model's first reply) | 2,724 | 1,366 | 1,818 | 1,843 |
| Spawned → `result` | 15,187 | 15,090 | 12,804 | 15,657 |
| of which Claude Code's `duration_api_ms` (the model) | 12,029 | 10,590 | 12,036 | 11,531 |
| of which file tools (Read, Grep, Glob) | 39 | 32 | 58 | 34 |
| of which edits (Edit) | 112 | 93 | 0 | 115 |
| of which the agent's own `dt` (Bash) | 0 | 886 (`dt fmt && dt check`) | 0 | 605 (`dt check`) |
| `result` → process exit | 850 | 806 | 756 | 765 |
| Exit → scan of changed files | 7 | 4 | 4 | 7 |
| Subscriber's `dt fmt` + `dt check` + `finish` (revision capture, analysis) | 531 | 506 | 481 | 477 |
| Finished → the page's state shows it ended | 23 | 65 | 43 | 54 |
| **Queued → ended** | **17,204** | **16,582** | **14,204** | **17,069** |
| Model turns | 5 | 6 | 6 | 6 |
| Cost (USD) | 0.075 | 0.063 | 0.108 | 0.083 |
| Files changed | 1 | 1 | 0 | 1 |

All four completed. Run 3 changed nothing: it **completed with `changed: false` and `resultRevision` = `baseRevision`**
(no new revision), with the answer squeezed into the reply's `summary` (at most 300 characters); `dt fmt` and `dt check`
still ran (`finished (0 file(s) changed; dt fmt ran, dt check ran)`).

Separately, on the same machine:

| What | Time |
|---|---:|
| `claude -p 'say ok'` (wall, 3 runs) | 2.94 s, 2.76 s, 2.80 s |
| … in stream-json: spawn → `init` / → `result` / → exit | 0.42 s / 1.65–2.6 s / 3.1–3.8 s (1.0–1.3 s from `result` to exit) |
| `claude --version` | 0.03 s |
| `dt fmt` on the workspace (3 runs) | 240, 236, 234 ms |
| `dt check` on the workspace (3 runs) | 205, 203, 206 ms |
| `node -e 0` | 35 ms |

### Cold vs warm, the same four requests

A scratch script built each run's prompt with the agent's own `buildPrompt` and `claudeArguments` (the same tools, the
same JSON schema), and ran the four prompts on a fresh copy, first **cold** (one `claude` per prompt, as today), then
**warm** (one `claude --input-format stream-json` process, each prompt one user message, waiting for its `result`),
twice each. Times from writing the prompt to `result` (warm) or to process exit (cold), in seconds.

| | Run 1 | Run 2 | Run 3 | Run 4 | Total | Turns |
|---|---:|---:|---:|---:|---:|---|
| Cold, round 1 | 13.8 | 14.7 | 14.1 | 12.6 | 55.2 | 5, 6, 6, 6 |
| Warm, round 1 | 12.3 | 12.5 | 9.2 | 7.2 | 41.1 | 5, 5, 4, 3 |
| Cold, round 2 | 14.7 | 15.5 | 17.8 | 14.9 | 62.9 | 5, 6, 6, 5 |
| Warm, round 2 | 13.0 | 13.8 | 10.1 | 10.5 | 47.3 | 5, 5, 4, 4 |

- Every warm turn returned its structured output (`--json-schema` holds for every turn of the process).
- Warm context grows: cache reads per turn 22k → 58k → 55k → 44k tokens (round 1), 30k → 66k → 60k → 74k (round 2);
  a cold run reads 40–48k per run. Cost: cold 0.315 / 0.202 USD (round 2 profited from the server-side prompt cache
  that round 1 left), warm 0.288 / 0.267 USD. Not cheaper, not dearer at this length.
- Later warm turns needed fewer model turns: the agent remembered files it had read in an earlier turn (round 1, run
  4 read nothing before editing). That is most of the saving, and it is also the risk (a file changed meanwhile).
- `/compact` sent as a user message in stream-json input works (a `compact_boundary` event; 5.9 s on a tiny
  conversation). An interrupt sent as `{"type":"control_request","request_id":…,"request":{"subtype":"interrupt"}}`
  ended the running turn in 10 ms (`result/error_during_execution`) and the process took the next message.

### What the numbers say

- **The model is the cost**: 10.6–12.0 s of 14.2–17.2 s (70–85 %). Claude Code's own time inside the turn adds
  0.4–4.2 s (`duration_ms` − `duration_api_ms`). The file tools take under 0.2 s in all.
- **Starting Claude Code per run costs ~1.3 s**: 0.5 s from spawn to `init` and 0.75–0.85 s from `result` to exit (the
  adapter waits for `close`), out of ~16 s: about 8 %.
- **`dt fmt` / `dt check` cost ~0.45 s** after each run (plus the agent's own, 0.6–0.9 s when it chooses to run them:
  2 of 4 runs). The protocol around a run (claim, start, finish, the page's update) is under 0.2 s.
- **A warm agent saved 25 % (round 1) and 25 % (round 2)** over four runs: the fixed ~1.3 s per run, plus fewer tool
  rounds in later turns. The first warm turn is no faster than a cold run.
- The biggest lever is the model and effort the user's settings choose; round 2 adds our own optional settings for
  them, per role (decisions 14 and 20).
- For the triage (round 2), not measured yet: a cold `claude -p` costs ~2.8 s before any model work, which is why the
  triage model runs in a warm process too (see [Stage 3](#stage-3-a-light-model)). M7 measures the cascade.

## Commands, flags and config

### Commands

| Command | What it does | Replaces (removed) |
|---|---|---|
| `dt open [--port] [--host] [--base <ref>] [--no-agent] [--agent claude]` | Live View with the chat, one person, loopback, dev identity, the person is the facilitator; starts the agent in process | `dt view` |
| `dt collab [--port] [--host] [--base <ref>] [--no-agent] [--agent claude]` | Collaboration session (dev or Access identity), agent in process | `dt session start` |
| `dt collab link` | Another one-time facilitator link | `dt session link` |
| `dt agent [--agent claude] [--once]` | The AI runner alone, against the server running on the workspace (`agent.json`) | `dt session subscribe` |

- `--agent claude` stays the only agent and the default; it is accepted so that later agents fit.
- "Claude Code is usable" (decision 5): `claude` is on the `PATH`, `claude --version` answers within 5 s, and
  `claude --help` lists the flags the adapter needs (`--setting-sources`, `--strict-mcp-config`, `--tools`,
  `--allowedTools`, `--input-format`, `--model`, `dontAsk`). Otherwise `dt open` / `dt collab` start without the agent
  and print one line why (`AI: not started (claude not found on PATH); start it later with dt agent`). `--agent claude`
  given explicitly turns that into an error.
- The agent in process is the same subscriber as `dt agent`, talking to the agent API over loopback HTTP with the
  credential of `agent.json` (one code path; the measured protocol cost is ~30 ms a run). It stops with the server
  (Ctrl+C fails its run as `Interrupted`, as today).
- **Two roles** (decision 21), both in one `dt agent` (and in the in-process agent) by default: the **answerer** (stage
  3's triage, answers, proposals: read-only, no revisions) and the **runner** (today's run pipeline). `dt agent --role
  answer` or `--role run` starts one only, so that they can live on different machines or be restarted apart;
  `dt open --no-agent` / `dt collab --no-agent` start neither. See [Two roles](#two-roles-the-answerer-and-the-runner).
- A second agent (`dt agent` while the in-process one runs) is allowed: runs are claimed with leases; answer jobs are
  handed to one connected answerer each. The page shows how many of each role are connected.
- `dt open --host <non-loopback>` serves the Live View **read-only** (no chat, no agent, nothing written to
  `.domaintrail/session/`), as `dt view --host` does today, with a line saying so: the chat and the agent are
  loopback-only in non-collab mode. It is what remains of `dt view`'s read-only use (open question Q8).
- Running a removed command prints an error naming its replacement (`'dt session start' was removed; use 'dt collab'`)
  and exits 2; there is no alias that runs it. The help does not list them.

### ~~Deprecated aliases~~ (superseded)

Round 1 kept the old commands one version as aliases with a warning. Round 2 (decision 11) removes them outright; Q3
(what the `dt view` alias shows) no longer arises.

### Config (`domaintrail.jsonc`)

Four top-level sections, by what they configure rather than by the command that reads them:

| Section | Keys | Used by | Was |
|---|---|---|---|
| `open` | `port`, `host` | `dt open` | `view.port`, `view.host` |
| `collab` | `port`, `host`, `identity`, `access.*`, `maxParticipants`, `quickReactions` | `dt collab`, `dt collab link` | `session.*` (the same keys) |
| `agent` | `port` (the agent API, both modes) | the server | `session.agent.port` |
| `agent.run` | `allowedTools`, `dt`, `maxPreviousRunDiff`, `model`, `effort`, `warm`, `restartAfter`, `idleTimeout` | the runner | `session.agent.allowedTools`, `.dt`, `.maxPreviousRunDiff`; the rest new (`session.agent.run.*` until M5) |
| `agent.answer` | `model`, `effort`, `warm`, `restartAfter`, `timeout` (all new) | the answerer | — |
| `agent.triage` | `model` (new) | the answerer's stage 3 | — |
| `classifier` | `enabled`, `provider`, `model`, `accountId`, `apiTokenEnv`, `threshold` (Clef) | the server's stage 2, both modes | `session.classifier.*` |

- **Why `agent.*` holds every Claude Code setting.** It is what `dt agent` reads, whichever machine it runs on, and
  `agent.run` / `agent.answer` / `agent.triage` say which role's process each key configures (decision 21: separate
  settings per role). The old single `agent` keys of round 1 (`model`, `effort`, `warm`, `restartAfter`) and the old
  `session.agent.*` keys map into `agent.run`.
- **Why `classifier` is top-level and not `collab.classifier` or `agent.triage.classifier`.** It is called by the server
  (not the agent) and serves `dt open` as much as `dt collab`; under `collab` it would read as collab-only, which round
  1's Q4 already found misleading for `session`. Moving it now costs nothing more: every file breaks once anyway
  (decision 12).
- **Why `open` and not `view`.** `dt view` is gone; the section is named after the command that reads it, as `collab`
  is. `view` becomes an error like `session`.
- **Old keys are errors**, at load, with a message saying where each key goes: `'session' was renamed: move
  session.agent.port to agent.port, session.agent.{allowedTools,dt,maxPreviousRunDiff} to agent.run,
  session.classifier to classifier, the rest to collab`; `'view' was renamed to 'open'`. An unknown key in a new
  section that was valid in its old place (`collab.agent`, `collab.classifier`, `agent.allowedTools`, …) gets the same
  hint.
- **Models** (decisions 14 and 20). `agent.run.model` / `effort` are the runs' (`--model` / `--effort` when given);
  `agent.answer.model` / `effort` the answerer's; `agent.triage.model` stage 3's. Each unset falls back to Claude
  Code's settings — never to another role's, so that a role's cost is what its own keys say. No default of ours for
  the runs and the answers; for stage 3 a light model is the point of the stage: its default is the alias `haiku`
  (open question Q4).
- **Warm** (decision 15), per role: `agent.run.warm`, `agent.answer.warm` (`true` by default; `false`: one process per
  job, today's) and `restartAfter` (jobs before a warm process is replaced; default 20 for runs, 50 for answers).
  `agent.run.idleTimeout`: minutes without a run before the warm process is ended to free its memory (a few hundred
  MB); default 30, `0` = never (M3b; `session.agent.run.idleTimeout` until M5 moves the run role's keys).
  `agent.answer.timeout`: the most an answer may take (default 120 s; a run has no such limit beyond today's).
- The answerer's tools are **not** configurable (`Read`, `Grep`, `Glob`): that is the guarantee. The facilitator's
  `agent.run.allowedTools` are the runner's only.

### State in `.domaintrail/` per mode

- Both modes keep their state in `.domaintrail/session/` (`session.db`, `blobs/`, `agent.json`, `server.json`), one
  session per workspace, as today. **`dt open` keeps the chat history and the revisions across restarts**: the person
  sees yesterday's answers and can still restore the workspace before a run. A session records the mode it was started
  in (`Solo` / `Collab`; a new field on the session, default `Collab` for the existing ones).
- Decision 13: `dt open` on a workspace with an open **Collab** session refuses with a line naming both ways out
  (`dt collab` to resume it, or end it from its collab menu); `dt collab` on an open **Solo** session continues it as a
  collab session (the solo person is its facilitator; its history stays; the mode becomes `Collab`).
- `dt open` signs the local person in without a form: one participant, the facilitator, named from `git config
  user.name` or the OS user (changeable in the page). No facilitator link is printed.
- Users of `dt view` get a `.domaintrail/session/` directory they did not have (it ignores itself through its own
  `.gitignore`, as today).

## Who talks to the AI

### Addressed messages

A message is **addressed to the AI** when, at send time:

- it **mentions `@AI`**: the AI is a mentionable participant; the composer's `@` list offers it first (before the
  people, also when no one else is in the session), and picking it writes `@AI[pN] ` like a person;
- it **replies to the AI**: to one of the AI's answers (a message whose author is the AI) or to a run (the existing
  `replyTo` of kind run);
- the session is **solo** (`dt open`): every message.

Later, the facilitator can address any message, their own or a participant's, with 「AI に送る」 (one, or several
selected: まとめて送る) — the rescue for a forgotten `@AI`. It does what the mention would have done (the message goes
through the triage), recorded as addressed by the facilitator. A message that is not addressed is talk between people:
no triage, no Clef call, nothing sent to any model.

### The AI as a participant

- A reserved participant ID (`ai`), with the display name `AI` (not translated: it is what one types) and an avatar of
  its own. It is part of every session without joining (no `ParticipantJoined`, not stored in `Session.participants`,
  not counted in `maxParticipants`); the verified `MentionableParticipant` accepts it; its presence on the page is the
  agent's (connected or not). Open question Q9 weighs storing it instead.
- The AI's answers are messages (`Request`s) whose author is `ai` and whose `replyTo` is the message answered; so a
  reply to an answer is addressed by the existing `replyTo`. Only the server writes them (no route lets a person send
  as `ai`).
- Runs stay runs: their replies (summary, clarification, assumptions) are drawn on the run's card as today; a reply
  to a run is addressed.

## Triage

### The cascade

For each addressed message, a **triage** record is opened and the stages run in order. Each stage answers one of
**相談** (a consultation: a question, an opinion, an explanation), **依頼** (a change request), **neither** (nothing
for the AI to do: thanks, an acknowledgement) or **unknown**. A stage ends the cascade when it is confident of its
answer; "unknown" (or an answer below the stage's confidence) passes the message to the next stage.

| Stage | Where | What | May end with |
|---|---|---|---|
| 1 Mechanical | server | Empty body, emoji only, a short fixed acknowledgement from a closed list (ありがとう, ありがとうございます, 了解, 了解です, 承知しました, OK, おk, 👍 …, normalised: width, case, trailing punctuation) | neither only; never decides 相談 vs 依頼 by keywords |
| 2 Clef | server | `classifier` (Cloudflare Clef) when enabled; skipped otherwise | 相談, 依頼, neither — each only above its confidence |
| 3 A light model | agent (answerer role) | `agent.triage.model` (default `haiku`) with the message, the recent chat and the open change proposals | 相談, 依頼, neither |
| — | — | Still unknown after stage 3 | treated as **相談** (the safe side: nothing is written; the answerer can turn it into a proposal) |

Then:

- **相談** (stage 4) → the **read-only answerer** answers it at once, in parallel with the change queue; the answer is
  the AI's reply bubble under the message. No revision.
- **依頼** (stage 5) → from a **participant**: the answerer writes a **change proposal** that the facilitator approves,
  edits or rejects; approved, it is queued as a normal run. From the **facilitator**, or in **`dt open`**: straight
  into the queue as a run (today's apply).
- **neither** → nothing; the triage record says which stage decided it and why. The facilitator can still use
  「AI に送る」 again, which then skips the cascade's "neither" (open question Q6).

### Stage 1: mechanical

Pure and in the domain (`domain/triage.ts`), unit-tested on a table. Narrow on purpose: it only catches what is sure to
need no answer, so that a common "ありがとう" costs nothing. It never reads keywords such as 「？」 or 「してください」 to
tell 相談 from 依頼.

### Stage 2: Clef

The existing `MessageClassifier` port and Clef adapter (`infrastructure/clef.ts`), asked new questions: three `noul`
questions in one call (is it a question about the model, is it a request to change it, does it need no answer at all),
on the body with its mentions as names. A probability at or above `classifier.threshold` (default raised to a
confident value, open question Q5) on exactly one question decides; anything else is unknown. Failures and timeouts are
unknown. In `dt open` too, when enabled (the text leaves the machine only when the user configured it). Its former role
— the `session.classifications` sent to the facilitator's pages, the 「AI に送る」 button shown on requests only — goes.
A generic provider interface (other "JEV-compatible" classifier APIs) is a later possibility; today Clef is the only
provider, as `CLASSIFIER_PROVIDERS` already says.

### Stage 3: a light model

A job of the agent's answerer role (the server has no model): the answers entry point sends a `triage` job with the message (its body with
mentions as names, its targets' labels), the last messages of the chat (up to 20, or 4000 characters), and the open
change proposals (so that 「それでお願いします」 after a proposal reads as a 依頼, and 「やっぱりやめて」 as one too). The
model answers with a JSON schema: `{ kind: 相談 | 依頼 | neither | unknown, confidence: 0..1, reason: short text }`.

It runs in a **small warm process of its own** inside the answerer role: `claude --print --input-format stream-json
--output-format stream-json --model <agent.triage.model> --tools ""` (no tools: it reads only what it is given),
restarted with the answerer's `restartAfter`. Each
triage job is self-contained; the carried context is not wanted, only the saved start (~2.8 s cold, measured for
`claude -p 'say ok'`). Through Claude Code, not an API key: the user's sign-in is the only credential, as for runs.

### Stage 4: the read-only answerer

- A Claude Code process with **`--tools Read,Grep,Glob`** and `--allowedTools Read,Grep,Glob` (and the existing
  `--setting-sources user --strict-mcp-config`): no edit, write or shell tool exists in it, whatever the prompt or the
  message says. The answerer role's warm process (separate from the runner's), `agent.answer.model` / `effort`,
  `agent.answer.timeout`. No `dt fmt` / `dt check`, no lease, no revision: an answer changes nothing to record.
- Its own prompt (not the runs' `buildPrompt`): answer about the model as it is in the files; never claim to have
  changed anything; when the message asks for a change, say so (the override) instead of describing the edit as done.
- An `answer` job carries the message, its targets, the recent chat and the runs it replies to (as `previousRuns`
  today). The reply schema: `{ kind: 'answer', answer }` or `{ kind: 'proposal', proposal: { what, where, how } }`
  (override: it was a request after all) or `{ kind: 'neither' }`. Its data has `changedSinceYourLastAnswer: [paths]`
  (the files changed since the answerer's previous job ended, the runner's `changedSinceYourLastRun` for answers).
- In parallel with the change queue: an answer never waits for a run, nor a run for an answer. It reads the workspace
  as it is; the answer records the latest revision at its start, and the bubble says when a run was running meanwhile
  (open question Q10).
- The same process writes the **proposals**: a `propose` job (a participant's 依頼) answers
  `{ what, where, how }` grounded in the files it read (open question Q1).

### Stage 5: change proposals and the queue

- A **change proposal** (変更案) is a card in the chat, under the message it came from, shown to everyone: what to
  change, where (elements as `#name` links) and how, as text. No diff preview yet (decision; a later possibility).
- The **facilitator** approves it (as is or after editing the text), or rejects it (with an optional note to the
  author). Several open proposals can be approved together; approved together they are one run (as まとめて送る), open
  question Q2. An approved proposal is queued as a run whose input carries the message and the approved text; the run
  agent follows the approved text.
- A participant sees their proposal's state (承認待ち, 承認済み → the run's card, 却下 with the note). They may withdraw
  it while it waits.
- The **run agent** may still decide a queued 依頼 was a question (decision 18): it answers (`answer`, status
  `answered`) and changes nothing; the run completes as an answer (result = base, no revision), drawn as a reply bubble.
  The prompt's rules from round 1 stay for that: never edit on a guess; when unsure, answer or ask.

### The triage record (for debugging)

One record per addressed message, written as the stages go, kept in `session.db`:

- how it was addressed (`mention` | `reply` | `solo` | `facilitator`), and by whom;
- each stage that ran: the stage, its answer, its confidence (Clef's probabilities, the model's confidence), its reason
  (stage 1: the rule; stage 3: the model's reason; the answerer's or the run agent's override: their reason), the
  model, the time taken, and errors;
- the final kind, the stage that decided it, and the outcome (answer message, proposal, run).

The facilitator sees it from a message's ⋯ (「仕分けの記録」); the server's log prints one line per triage at the
debug level, without the message text. Participants see only the outcome.

### With no agent connected

Stages 1–2 run on the server; a message that needs stage 3 waits (the triage is `Pending`), and the chat header shows
「AI 接続なし（n 件待ち）」 counting waiting triages, answers and runs. When an agent connects it claims them in order.
Round 1's memos are gone: a message in `dt open` without an agent is simply waiting.

## Two roles: the answerer and the runner

Decision 21: the Claude Code execution for 相談 and for 依頼 is separate. One `dt agent` (or the in-process agent) holds
both roles by default; `--role answer` or `--role run` starts one only.

| | Answerer | Runner |
|---|---|---|
| Does | stage 3 (triage), answers (stage 4), proposals | runs (today's pipeline): approved proposals, the facilitator's and `dt open`'s requests |
| Tools | `Read`, `Grep`, `Glob` (fixed, enforced by `--tools` and `--allowedTools`); stage 3: none | `agent.run.allowedTools` (the facilitator's; default edit tools plus `dt fmt` / `dt check`) |
| Entry point | `/agent/answers/events` + `POST /agent/answers/:job`; handed out, no lease | `/agent/events`; claim, lease, heartbeat, start, finish |
| Workspace | reads it as it is | base revision, scan, outside-sources guard, `dt fmt` / `dt check` when files changed, result revision, success rule |
| Concurrency | in parallel with runs; one job at a time per answerer | serial per session |
| Prompt and output | its own prompt; `{ answer }` \| `{ proposal }` \| `{ neither }` | `buildPrompt`; today's reply plus `answer` / `answered` (the override) |
| Settings | `agent.answer.{model, effort, warm, restartAfter, timeout}`, `agent.triage.model` | `agent.run.{model, effort, warm, restartAfter, idleTimeout, allowedTools, dt, maxPreviousRunDiff}` |
| Warm processes | the answerer (and the small triage process) | the runner |
| Memory hint | `changedSinceYourLastAnswer` | `changedSinceYourLastRun` |
| Restart | after `restartAfter` jobs, past 150k tokens, after a revert / restore, after a model change | as for answers, plus after a declined run and a change of tools or `dt`; ended after `idleTimeout` minutes without a run |

- **Why separate** (the alternative was one process for both): a process cannot be both read-only and writable —
  `--tools` is fixed per process, and the read-only guarantee is the process's tools; answers would queue behind runs
  in one process (one turn at a time); and the roles want different models, effort and timeouts.
- **On different machines**: each role works on the workspace's files, so a role on another machine needs the same
  workspace (a shared checkout or file system), as `dt session subscribe` did; `agent.json` gives the API's address and
  credential. Running the answerer on a laptop next to the session and the runner beside the workspace is the main use.

## Protocol and model changes

In `contexts/collaboration` (the `.dt` model, its generated code, use cases, persistence) and `protocol.ts`:

- **Session**: `mode: Solo | Collab` (migration: existing rows `Collab`); a command to turn a Solo session into a
  Collab one (decision 13).
- **The AI participant**: the reserved `ParticipantId` `ai`; `MentionableParticipant` accepts it; `Request.author` may be
  `ai` only through the server's `answer` use case.
- **Request (message)**: unchanged and immutable; *addressed* is not a state of the message but the existence of a
  triage for it (as *applied* is the existence of a run that holds it, ADR 0026). The model's Japanese label 依頼 for
  `Request` now clashes with the triage's 依頼: the triage's kinds are named `Consultation` (相談), `ChangeRequest`
  (変更依頼) and `NotForAi` (AI 宛てでない) in the model; renaming `Request`'s label to メッセージ is left to M2.
- **Triage** (new aggregate, 仕分け): `request`, `addressedBy` (`Mention` | `Reply` | `Solo` | `Facilitator`) and
  `addressedByParticipant`, `steps: TriageStep[]` (`stage`: `Mechanical` | `Clef` | `Model` | `Answerer` | `Runner`;
  `verdict`; `confidence?`; `reason`; `model?`; `durationMs`; `error?`); states `Pending` → `Decided { kind, by stage,
  at }`; `override` adds a step from the answerer or the run agent and changes the kind (`Consultation` ↔
  `ChangeRequest`).
- **ChangeProposal** (new aggregate, 変更案): `request(s)`, `triage`, `what`, `where`, `how` (text, `REPLY_LIMITS`-like
  limits), states `Open` (承認待ち) → `Approved { by, at, editedText?, run }` | `Rejected { by, at, note? }` |
  `Withdrawn { at }`. `approve` takes several proposals at once and queues one run (use case).
- **Run**: the input gains `proposals` (the approved texts) beside `requests`; the reply gains `answer` (up to
  `REPLY_LIMITS.answer` = 2000 characters) and the request status `answered` (round 1, kept for the override); the
  success rule: exit 0, no new `.dt` error, every `.dtes` parses, and — **when the run changed files** — `dt fmt` and
  `dt check` ran (`formatted` / `checked` become `'ran' | 'failed' | 'skipped'`; `agent-run.dt`, `validation.ts`,
  regenerated). Revert runs from `feat/collab-card` stay in the same queue.
- **Answer**: a use case `answer(triage, text, readRevision)` that writes the AI's message and decides the triage.
- **Agent API: two entry points** (decision 21). The **runs** keep today's: `/agent/events` (SSE, resumable from the
  outbox), claim with a lease, heartbeat, start, finish; runs (and `feat/collab-card`'s reverts) stay serial for the
  session. The **answers** get their own: `GET /agent/answers/events` (SSE) hands each `triage`, `answer` or `propose`
  job to one connected answerer (no claim, no lease, no workspace lock), and `POST /agent/answers/:job` returns its
  result; a job not answered within its timeout, or whose answerer disconnects, is handed to another answerer or, with
  none, waits (the triage stays `Pending`). Answer jobs never wait for the run queue and never hold it. `GET
  /agent/session` gives each role its settings (the runner its tools and `dt`, the answerer nothing to configure). A
  connection says its role, so the page counts answerers and runners apart.
- **State and WebSocket**: the state body gains `mode`, `agent: { connected, waiting }`, the open proposals, and per
  message the triage's outcome (to everyone) and its record (to the facilitator); messages `triage.*`, `proposal.*`,
  `agent.presence`. `session.classifications` / `session.classification` go.
- **Routes**: `POST /api/session/requests` addresses by its mentions and `replyTo`; `POST
  /api/session/requests/:id/address` (the facilitator's 「AI に送る」, several ids allowed); `POST
  /api/session/proposals/approve` (ids, optional edited text per id), `…/:id/reject`, `…/:id/withdraw`. Addressing is
  the one path to the AI for every message, the facilitator's own included: the route's `apply` is removed (the model
  keeps what older sessions need to load).

### As built in M2

M2 landed the model, the use cases, the store and the protocol types above, with these details settled or changed:

- **Session**: `mode: SessionMode` (`Solo` | `Collab`); `collaborate` turns an open Solo session into a Collab one
  (`SessionCollaborated`); `join` refuses everyone else in a Solo session (`SoloSession`). The use case `openSession`
  applies decision 13 (`CollabSessionOpen` for `dt open` on an open Collab session). `startSession` takes the mode
  (Collab when not given) until M5 moves the CLI to `openSession`.
- **The AI**: `domain/ai.ts` (`AI_PARTICIPANT` = `ai`); its answers are written by a create command `Request.answer`
  (author `ai`, a reply to the answered message); `sendRequest` / `sendMessage` refuse `ai` as the author. `Request` is
  labelled メッセージ.
- **Triage**: the stages are `Mechanical`, `Clef`, `Model` (the cascade, `record`), `Answerer`, `Runner` (overrides,
  `override`) and `Facilitator` (`readdress`: the facilitator sends a "neither" again, plan Q6, recorded as a step and
  turning the triage into one addressed by the facilitator). The outcome is a field of `Decided`, set once by
  `conclude`: `Answer { answer, readRevision? }`, `Proposal { proposal }` or `Run { run }`. The answerer overrides only
  a 相談 it has not answered. Verdicts and confidences are recorded as each stage judged them; the thresholds (Q5) are
  applied before recording (`clefVerdict`, `modelVerdict` with `TRIAGE_THRESHOLDS`). Stage 1 runs in the transaction
  that opens the triage. Stage 2 is recorded by the server even when Clef is not configured (a `Clef` step `Unknown`
  with that reason): a triage job for the answerer is due once a `Clef` step is recorded (`answerJobOf`).
- **ChangeProposal**: `content { what, where, how }` (`PROPOSAL_LIMITS`: 300 / 500 / 2000), `requestedBy`; `Approved
  { approvedBy, approvedAt, edited?, run }`, `Rejected { rejectedBy, rejectedAt, note? }`, `Withdrawn { withdrawnAt }`
  (by the requester only, `NotTheRequester`).
- **Run input**: the approved proposals are `proposals: ApprovedProposals?` (`{ approved: ApprovedProposal[1..*] }`): the
  DSL has no optional list, and the runs stored before keep loading as they are.
- **Success rule**: `RunReport.formatted` / `checked` are `ToolOutcome` (`Ran` | `Failed` | `Skipped`); a run succeeds
  when neither failed and, if it changed files, both ran. The agent API's finish body takes `'ran' | 'failed' |
  'skipped'` and still the booleans of today's subscriber. The runs stored before are read with `Ran` / `Failed`
  (`legacy.ts`), as a session without a mode is read as `Collab`; migration 11 adds only the tables `triages` (one per
  message) and `proposals`.
- **Queueing**: a decided 依頼 that goes to the queue (the facilitator's, Solo, addressed by the facilitator) is queued in
  the transaction that decides it; a run that answers a request (`answered`) overrides its triage as `Runner` when it
  finishes.

### As built in M5

M5 landed the commands and the config, with these details settled or changed:

- **Commands**: `dt open`, `dt collab` (+ `dt collab link`), `dt agent [--role answer|run] [--once]`; `dt view` and
  `dt session start|link|subscribe` are hidden commands that fail with the replacement's name (exit 2). `--no-agent`
  and `--agent claude` share one option (`--agent claude` makes an unusable Claude Code an error, after which the
  server is stopped). `dt open --host <non-loopback>` serves the read-only Live View (`--agent claude` with it is an
  error).
- **`dt open`'s sign-in** (security review): not "every loopback request is the facilitator". `dt open` prints a
  one-time link (`/session/open?code=…`: a facilitator link's code, single use, 60 minutes) in place of the plain
  address; opening it signs that browser in as the Solo identity (`dev:solo`) with the dev mode's cookie (`dt_session`,
  HttpOnly, SameSite=Strict, stored in `session.db`, so it survives restarts) and redirects to the Live View. Without
  the cookie a request is not identified (401; a page says to open the printed link, no join form), so another local
  process or OS user is not the facilitator. The link is the only step. When `dt collab` continues the session, that
  browser stays its facilitator (the claimed role is the Solo identity's).
- **Loopback only**: `dt open` never reads `collab` beyond `quickReactions` (`open.port` / `open.host`, the dev
  identity); its host policy admits loopback Hosts and Origins only, whatever `collab.access` allows.
- **Fail closed and one server per workspace**: the Solo identities identify no one once the session is not open and
  Solo (`dt collab` continuing it); `startSessionServer` refuses to start while another live server (`server.json`
  with its process alive, or a server of the same process) serves the workspace, so a session's mode never changes
  under a running server.
- **The agent in process**: `checkClaudeCode` decides; the subscriber is the same as `dt agent`'s (loopback HTTP with
  `agent.json`'s credential); Ctrl+C stops the agent before its server.
- **Roles**: `--role` is parsed and passed on, both by default; the answerer is not in the agent yet (M4), so the
  wiring takes on the runner only, and `--role answer` alone is an error until M4's answerer is connected there
  (`wiring/subscriber.ts`).
- **Config**: `agent.answer` also has `idleTimeout` (default 30) and `agent.triage` has `warm` (default false, Q12);
  `agent.answer.timeout` is in seconds (default 120). The session server is given a `SessionSettings` composed from
  `collab`, `agent.port`, `agent.run.{allowedTools,maxPreviousRunDiff}` and `classifier`.
- **The seed** runs `dt collab --no-agent` (its scripted agent plays the runs); its requests are still queued with
  the facilitator's runs route, until M4's addressing routes land.

## The page

- **Mode**: in solo the collab menu, invite, hand-over, leave, participants and reactions-of-others are hidden; the chat
  is the person and the AI.
- **AI status**: the chat header shows 「AI: 接続済み」, 「AI: 接続なし」 or 「AI 接続なし（n 件待ち）」.
- **Composer**: `@` offers `AI` first; a message that will be addressed (it mentions `@AI`, replies to the AI, or solo)
  shows a small AI mark before sending, so the person knows whether the AI will read it.
- **Messages**: an addressed message shows its triage's progress (仕分け中 → 回答中 / 承認待ち / 待機中 / —); the
  facilitator has 「AI に送る」 on every message not yet addressed, and 「仕分けの記録」 on addressed ones.
- **Answers**: the AI's reply bubble under the message, its text with element links; replying to it addresses the AI.
- **Proposals**: a card under the message (what / where / how); for the facilitator 承認, 編集して承認, 却下, and
  selection for 「まとめて承認」; for the author 取り下げ.
- **Runs**: the cards of `feat/collab-card` (its names 中止 / 打ち消し / 復元); a run that answered instead of editing
  is a reply bubble; a run whose request is `answered` but which changed files is flagged
  (「質問への回答ですが、ファイルを変更しました」).

## ~~Consultation~~ (superseded)

Round 1 sent every message through the same run with the same (writing) tools and let the agent decide whether it was
a question; it had no hard read-only guarantee, and the classifier kept only its 「AI に送る」 hint. Round 2 replaces
it with the triage above: the kind is known before the agent that acts starts, so a consultation runs with read-only
tools enforced by Claude Code, and writes happen only after a 依頼 is queued (by the facilitator, or approved by them).
Kept from round 1: the person gives no instruction; the run agent's `answer` / `answered` for a misread request; no
`dt fmt` / `dt check` when nothing changed; the prompt's rule that the agent does not run `dt` itself unless it needs
the output to fix its edit.

## The warm agent

### CLI stream-json input, not the Agent SDK

Two ways keep one Claude Code conversation open:

- **`claude --print --input-format stream-json --output-format stream-json`**: user messages are written to stdin as
  JSON lines, events read from stdout as today. Measured above: structured output per turn, `/compact`, and an interrupt
  control request all work with 2.1.316. The CLI reference documents `--input-format stream-json` and
  `--replay-user-messages` ([CLI reference](https://code.claude.com/docs/en/cli-reference)); the stdin message shape is
  documented only through the SDK's `SDKUserMessage`
  ([streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)).
- **The Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) with streaming input: `query({ prompt:
  AsyncIterable<SDKUserMessage>, options })` returns a `Query` with `interrupt()`, `setPermissionMode()`, `setModel()`,
  `close()` (only in streaming input mode), options `tools`, `allowedTools`, `permissionMode`, `settingSources`,
  `canUseTool`, `hooks`, `outputFormat: { type: 'json_schema', schema }`, `persistSession`, `cwd`, `env`. It spawns the
  Claude Code CLI as a subprocess and bundles a native binary as an optional dependency per platform
  ([TypeScript SDK](https://code.claude.com/docs/en/agent-sdk/typescript)); streaming input mode is "a long lived
  process that takes in user input, handles interruptions, surfaces permission requests, and handles session
  management" ([streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)).

**Recommendation: the CLI.** `capabilities/agent` already speaks stream-json output to the `claude` the user installed
and signed in to, through ports (`AgentRunner`) with a fake agent in the tests. The SDK would add a dependency with a
platform binary to an npm package that has few, a second Claude Code (the bundled one) beside the user's, and an env
that replaces rather than merges. What it adds that we need — interrupt — works over the CLI's control request. The
risk of the CLI route is that the stdin protocol is documented through the SDK only: the runner checks the `init`
event and falls back to cold runs (today's adapter) when the warm process does not answer as expected, and the fake
agent of the tests speaks the same protocol. If a later Claude Code breaks it, `agent.run.warm: false` / `agent.answer.warm: false` are the switches. With
round 2 the read-only guarantee does not need per-turn permissions either: the answerer is its own process with its
own `--tools`.

### Design

- **`AgentRunner` is unchanged**; a new adapter `createWarmClaudeRunner` implements it. The subscriber's pipeline does
  not change: base revision at start, scan before and after, outside-sources guard, the success rule, the finish.
- **One warm process per role and agent** — the runner's and the answerer's (decision 21), plus the answerer role's small triage process — each started on its first job (not at subscribe time:
  no idle process with no work), with the arguments of today's `claudeArguments` for its role plus `--input-format
  stream-json`. `--json-schema` is fixed per process: the runs' uses `replyJsonSchema(MAX_REQUESTS)` (the session's
  limit of requests per run), and `parseReply` keeps checking the numbers against the run's real count, as it does now.
  `--allowedTools` is fixed too: a change of the facilitator's tools (`GET /agent/session`) replaces the runs' process.
- **A job is one turn**: the prompt as one user message; the turn's `result` event is the job's result. The run's
  `onActivity` reads the turn's events as now.
- **What changed since the last turn**: the warm agent remembers file contents (measured: it skipped reading). Each
  run's and answer's data gains `changedSinceYourLastRun: [paths]` — the subscriber compares the scan at this job's
  start with the scan at the previous job's end of that process (files edited by a person, another agent, a run, or a
  revert/restore) — and rule 9 says to re-read them. The prompt already says "the current files are the truth".
- **Cancellation mid-turn** (中止): the interrupt control request; if no `result` comes within 5 s, the process group
  is killed (today's path) and the next job starts a fresh process. A cancelled run's edits stay on disk as today; the
  server has already ended the run.
- **Crash**: the process exiting during a turn fails the job (`AgentError`, the exit code in the report); between
  jobs it is noted and the next job starts a fresh one. No retry.
- **Restart (a fresh process, no carried context)**: after the role's `restartAfter` jobs (default 20 for runs, 50 for answers); when a turn's context
  (`usage` of the result: input + cache read + cache creation) passes 150k tokens; after a revert (打ち消し) or restore
  (復元) of a revision; after a run is declined (rule 7: the turn may have carried an attempt to break the rules, and it
  should not stay in the context); after the agent's `dt`, tools or models change; and after `session.closed`.
- **Idle stop** (M3b, the runner): a warm process that takes no turn for `idleTimeout` minutes (default 30; `0` =
  never) is ended to free its memory (a few hundred MB), by the same clean retire as a restart (end of input, SIGTERM,
  SIGKILL after the grace), with one log line. The timer starts when a turn ends and is cleared when one starts, so it
  never ends a process during a turn. The next run starts a fresh process with the plain prompt; an idle stop is not a
  failure and does not count towards the fall-back to cold runs.
- **Context growth**: measured +10–15k tokens a run. Restarting is cheap (~1.3 s plus the files read again), so the
  plan restarts instead of compacting; `/compact` (measured to work) is kept as a later option.
- **Cross-job influence**: the answerer's memory helps a follow-up question ("なぜ？", "それならどう変える？"). In collab
  the context mixes several people's messages; each job's data still says who asked what. `previousRuns` stay in the
  prompt: they are the record, the memory is a bonus and is lost on restart.
- **User settings**: `--setting-sources user` stays; the user's `Stop` and `PostToolUse` hooks now run once per turn
  instead of once per process (measured: the user's `Stop` hook reports an error notification on every turn here).
  `--bare` would skip them but also ignores OAuth sign-in, so it is not an option for signed-in users. The first-run
  page keeps its warning about `~/.claude/settings.json`.
- **What it saves**: ~1.3 s of process start and exit per run (~8 %), plus the files the agent need not read again:
  25 % over four runs measured. Plus ~0.45 s on an answer given by a run (no `dt fmt`/`dt check`), and 0.6–0.9 s on runs
  where the agent no longer runs `dt` itself. For triage, ~2.8 s of start per message.

## Cost per addressed message

Every addressed message costs at least a stage-3 call unless stage 1 or 2 decides, and a 相談 costs an answer (the
measured question run: 0.108 USD and 14 s on Opus with effort medium; less on `agent.answer.model` if set lighter). A
participant's 依頼 costs a proposal before any run. Messages that are not addressed cost nothing. M7 measures the
cascade (time and cost per stage, how often stages 1 and 2 decide) on a sample of real messages.

## Related branches

- **`feat/collab-card`** removes confirming a revision and reworks the run card's undo: a **revert** (打ち消し) is queued
  like a change and runs in the same serial queue as runs; a queued or running run is **中止** (cancelled); a revision
  is **復元** (restored). This plan uses those names (round 1 said 取り消す / 実行前に戻す). Consequences here: the
  change lane holds runs and reverts; an approved proposal waits behind a revert like any run; answers and triages do
  not wait for either; a revert or a restore restarts the warm processes (they may remember the old files) and enters
  `changedSinceYourLastRun`. Its amendments to ADR 0026 (revert and restore; no revision confirmation) are the base ADR
  0030 amends.
- **`feat/react-flow`** replaces tldraw with React Flow and adds ADR 0029. This plan does not touch the canvas; M6
  shares `styles.css` and maybe `app/App.tsx` (the chat's place). Element links in answers and proposals (`#name`) use
  the existing navigation, whatever draws the canvas.

## Collisions

- **`feat/collab-card`** touches `contexts/collaboration/src/domain/commands.ts`, `application/use-cases.ts`,
  `model/revision.dt`, the generated `Collaboration.ts`, `protocol.ts`, `infrastructure/sqlite.ts` (a migration),
  `apps/dt/src/server/session/routes.ts`, and `apps/web/session/{card,chat,collab,collab-menu,revisions,state,stream,api}.ts(x)`,
  `apps/web/i18n.tsx`, ADR 0026, `docs/guide.md`, `docs/live-view.md`, `docs/session-first-run.md`. This plan's M2
  (model, use cases, migration), M4 (routes, agent API) and M6 (the chat and cards) collide with it: **start M2, M4 and
  M6 after it is merged**; the session migration number is taken after its migration.
- **`feat/react-flow`** touches `apps/web/view/*`, `shapes.tsx`, `states-canvas.tsx`, `styles.css`, `theme.ts`,
  `bun.lock`, one comment in `protocol.ts`, ADRs 0001/0024/0026 and adds ADR 0029. M6 shares `styles.css` and maybe
  `app/App.tsx`: small; **start M6 after it is merged** too.
- M5 (CLI and config) touches `apps/dt/src/config/*`, `contexts/collaboration/src/application/config.ts`, the CLI and
  composition: not the files of either branch except the config's tests; it may start after M2's model lands.
- `scripts/session-seed` parses `dt session start`'s output and starts it: M5 moves it to `dt collab` (same output),
  and its requests to `@AI` messages or the facilitator's addressing.
- Within this plan, M2 renames nothing that M3 uses: M3 touches only `capabilities/agent`.

## Tasks

| Task | What | Depends on | Parallel with |
|---|---|---|---|
| M1 | ADR 0030 (modes, addressing, triage, proposals, warm agent, config; amends ADR 0026); this plan updated | — | M3 |
| M2 | Collaboration model and use cases: session `mode` (migration) and Solo → Collab; the AI participant `ai` (mentionable, author of answers); the `Triage` aggregate (steps, decided, override); the `ChangeProposal` aggregate (open, approve several/edited → one run, reject, withdraw); run input `proposals`; reply `answer` + status `answered`; the success rule with ran/failed/skipped (`agent-run.dt`, `validation.ts`, regenerate); stage 1 (`domain/triage.ts`); persistence and migration; `protocol.ts` types | M1, `feat/collab-card` merged | M3 |
| M3 | Agent, warm processes: `createWarmClaudeRunner` (stream-json input, interrupt, crash, restart rules, `changedSinceYourLastRun`), reusable by both roles with their own tools, model/effort, `warm` / `restartAfter` as options (wired to config in M5), the fake agent speaking stream-json input, the usability check of `claude` | M1 | M1, M2 |
| M3b | Agent: the warm process ended after `session.agent.run.idleTimeout` minutes without a run (default 30, `0` = never), not counted as a failure | M3 | M2 |
| M4 | Triage and answers end to end: the server's cascade (stage 1, stage 2 Clef with the new questions and threshold, dispatch), the agent API's answers entry point (`/agent/answers/events`, `POST /agent/answers/:job`, hand-out and timeout, no lease) beside the runs' `/agent/events`, the answerer role (stage 3 with no tools, the read-only answerer with `Read,Grep,Glob`, its own prompt and schema, `changedSinceYourLastAnswer`, `agent.answer.timeout`), overrides both ways, the run prompt's rules (answer instead of editing; no `dt` unless needed), skipping `dt fmt`/`dt check` when nothing changed, the routes (address, proposals) and WebSocket messages, presence and waiting counts; server and subscriber tests with the fake agent | M2, M3 | M5 |
| M5 | CLI and config: `dt open` / `dt collab` / `dt collab link` / `dt agent` (with `--role answer\|run`); removal of `dt view` and `dt session *` (errors naming the replacement); the in-process agent and `--no-agent`; the solo sign-in; decision 13's rules; `dt open --host` read-only; config sections `open` / `collab` / `agent` (`port`, `run.*`, `answer.*`, `triage.model`) / `classifier` with `session` and `view` as errors and hints; the seed moved to `dt collab`; CLI and config tests | M2, M3 | M4, M6 |
| M6 | Web: mode (solo hides the collab parts), AI status, `@AI` first in the composer and the addressed mark, the facilitator's 「AI に送る」 on any message (and several), triage progress and 「仕分けの記録」, answers as reply bubbles, proposal cards (approve / edit / reject / select several; withdraw), the "answered but changed files" flag; i18n | M4's API, `feat/react-flow` and `feat/collab-card` merged | M5 |
| M7 | Docs and a real run: README, `docs/guide.md` (open / collab / agent, addressing, triage, proposals, config), `docs/live-view.md`, `docs/session-first-run.md` and `docs/session-access.md` with the new commands, the changelogs (en/ja: the breaking changes — removed commands, renamed sections — and what to do); then a real run with `dt open` and `dt collab`, the warm measurement repeated and the cascade measured (time and cost per stage, a sample of messages to set the thresholds) | M5, M6 | — |

M3 can start at once (it touches only `capabilities/agent`); M2 waits for `feat/collab-card`.

## Open questions

Round 3 (maintainer, 2026-11-03) decided the questions this plan left open:

| # | Question | Decision |
|---|---|---|
| Q1 | Who writes a participant's change proposal? | The read-only answerer (a `propose` job), as recommended |
| Q2 | Proposals approved together: one run or one each? | One run; approving one at a time gives separate runs |
| Q3 | The facilitator's 「AI に送る」 on a participant's message that triages as 依頼 | Straight to the queue: the sending is the approval |
| Q4 | Stage 3's model and how it is called | Default `haiku` through Claude Code, no tools, no second credential |
| Q5 | Confidence thresholds | Start strict (Clef 0.9, model 0.8 for "neither"), then set them from M7's sample |
| Q6 | The facilitator addresses again a message judged "neither" | Skip the cascade and go on as 相談 |
| Q7 | Limits per person in collab | **None**: the facilitator controls the collab |
| Q8 | `dt open --host <non-loopback>` | Kept as the read-only Live View |
| Q9 | The AI participant | Virtual (reserved ID, not stored) |
| Q10 | An answer while a run edits the same files | Resolved by the two roles: answers run in parallel with runs, on the files as they are; the answer records the revision it read |
| Q11 | A generic classifier provider interface | Later |
| Q12 | The triage process | **Configurable** (`agent.triage.warm`); the default is a fresh `claude -p` call per triage. M7 measures whether warm pays |

## The session so far (decided, round 3)

What the agents are given about the session so far, besides the current files (which they read themselves):

- **The timeline, as the page's chat shows it**, written as text and built mechanically from the session's records (no
  AI summary, so it is stable and survives restarts): people's messages (who, body, what they reply to, targets);
  each AI turn in a few lines (which requests, the outcome — completed, unchanged, answered, failed, declined,
  reverted —, its summary, the elements it changed, without the diff; its assumptions and how they were decided);
  events (proposals approved or rejected with the reason, reverts, restores, external edits seen); and what is open
  now (questions awaiting an answer, proposals awaiting approval, the queue). The chat alone is not enough: it does
  not say what a run actually changed, whether it failed, or what was decided through the page (approvals, picks,
  reverts, restores).
- **Limits**: the newest 30 entries in full, the next 100 one line each, older ones only counted; configurable later.
- **Details**: the runs a request replies to keep their diff (`previousRuns`, as today). A read-only tool to fetch
  any run's diff comes later, if M7 shows the summaries are not enough.
- **Every role, every mode**: given to the answerer and the runner in `dt open` and `dt collab`, cold or warm. A cold
  process gets the whole timeline each time (it remembers nothing); a warm one gets it in full when it starts and then
  only what was added since its previous turn, so the conversation does not grow twice. The triage stage gets a short
  window around the addressed message.
