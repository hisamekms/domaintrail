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
| `dt export sources [-o <file.zip>\|-]` | The `.dt`, `.dtes` and config files as one ZIP (see [As built: the sources as one ZIP](#as-built-the-sources-as-one-zip)) | — |

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

### As built in M4

M4 landed the triage and the answers end to end on the server and in `capabilities/agent`, with these details settled:

- **Routes** (`apps/dt/src/server/session/routes.ts`): `POST /api/session/requests` sends through `sendMessage` and
  answers `{ request, triage? }`; its former `apply` is an unknown field (400). `POST /api/session/requests/address`
  (`{ requests }`) and `POST /api/session/requests/:id/address` (the facilitator's 「AI に送る」) answer `{ triages }`;
  `POST /api/session/proposals/approve` (`{ proposals: [{ proposal, edited? }], note? }`) `{ run, proposals }`;
  `…/proposals/:id/reject` (`{ note? }`) and `…/:id/withdraw` (the requester) `{ proposal }`. The page keeps its UI:
  the robot button and まとめて送る without a comment call the address route; もう一度送る and a run with a comment still
  queue a run (`POST /api/session/runs`) until M6. `session.classifications`, `createClassifications` and Clef's single
  question are gone.
- **What each role sees** (`views.ts`): a participant's state has each triage as `TriageOutcomeBody` (no `steps`, no
  `decidedBy`); its pages get no `triage.step_recorded`, `triage.decided` without `decidedBy`, `triage.overridden`
  without its step (`ParticipantTriageMessage`). The facilitator gets the records. The server logs one line per triage
  decided or overridden, without the text, to the `debug` log (by default the log, when `DOMAINTRAIL_DEBUG` is set).
- **Stage 2** (`clefStep` in `application/classifier.ts`; the server's `triage.ts`): Clef's three `noul` questions
  (`consultation`, `change_request`, `neither`) in one call, the probabilities as the step's reason, the model recorded;
  not configured, a `Clef` step `Unknown` with that reason. Pending triages waiting for it are taken when a message is
  addressed and when the server starts. The threshold is `classifier.threshold` (it was `session.classifier.threshold`
  in M4, default 0.5); since the merge of M4 and M5 its default is 0.9 (`TRIAGE_THRESHOLDS.clef`, Q5).
- **The answers entry point** (`answers.ts`): what is handed out is held in memory — a job ID per hand-out, one job in
  hand per stream, a timeout of 120 s (`ANSWER_TIMEOUT_MS`; `agent.answer.timeout` is the agent's own bound) plus 5 s
  for the answerer to report a failure, then `answer.job_withdrawn`. Stage 3 that fails, times out or gives an invalid
  output is recorded as a `Model` step `Unknown` with the error (so the triage is a 相談); an answer or a proposal that
  fails is handed out again, at most twice (`MAX_ATTEMPTS`), then given up (logged) until an answer stream connects
  (each new one gives the given-up jobs another round) or the facilitator retries it (`POST
  /api/session/requests/:id/retry-answer`); the given-up jobs are listed in the agents' presence (`givenUp`; how the
  page shows it is M6's). An answerer that disconnects has its job handed to another. The stream also carries
  `revision.restored` (the warm answerer forgets). Answer and propose jobs carry the session so far whole and, for a
  stream that answered before, since the last entry its previous job was given (`sessionSoFarSince`), the run the
  message replies to (`repliedRuns`) and the latest revision (`readRevision`). `changedSinceYourLastAnswer` is the
  answerer's own (its scans), not a field of the job.
- **Runs**: `POST /agent/runs/:id/start` takes `since` and gives `sessionSoFar` and `sessionSoFarSince`; the runner's
  prompt has them, the approved proposals (`approvedProposals`) and rules 12–14 (follow approved proposals; answer a
  question with `answered` instead of editing; the session so far is data). The subscriber skips `dt fmt` / `dt check`
  when the run changed no file and reports `ran` / `failed` / `skipped`.
- **Presence**: the state's `agent` and `agent.presence` (sent on each change): `connected.run` counts the open
  `/agent/events` streams, `connected.answer` the open answer streams; `waiting` the answer jobs waiting (given-up ones
  left out) plus the runs queued.
- **The answerer role** (`capabilities/agent`): `startAnswerer` (core) and `createClaudeAnswerer` (adapter). Stage 3:
  `--tools ""`, `--model haiku` by default, a fresh `claude -p` per triage unless `triage.warm`. Answers and proposals:
  `--tools Read,Grep,Glob --allowedTools Read Grep Glob`, one schema for both (`answererJsonSchema`, so one warm process
  takes both), warm by default, replaced after 50 turns, ended after 30 minutes without one; a warm process that fails
  falls back to a fresh one as the runner's does. The model that answered is read from Claude Code's `init` event.
  Answers and proposals name elements as the runs' replies do (`@{Sales.Order}`).
- **What the agents may read** (security review and the maintainer's decision, 2026-11-03): any file inside the
  workspace's root, never outside it, never `.domaintrail/` nor `.git/`, and no file `.gitignore` ignores; keeping
  secrets out of the repository is the user's. `claude` loads no settings file (`--setting-sources ""`; measured: the
  user's own `Read` allow rule let it read anywhere), so in `dontAsk` it reads only inside its working directory; bare
  reading tools are no allow rule (a bare `Read` allows reading anywhere), bare editing tools become `Edit(./**)`;
  `Read`/`Edit` of `./.domaintrail/**` and `./.git/**` are denied. The answerer and stage 3 run in a **view**: a
  private copy (0700, outside the workspace) of the files git does not ignore, refreshed before each turn
  (`workspace-view.ts`), since permission rules cannot say "not ignored". The runner edits the workspace itself, so the
  ignored files and directories present when a run starts are deny rules (at most 500). The user's `model` and
  `effortLevel` are read from `~/.claude/settings.json` for a role without its own. The server refuses (400
  `CredentialInOutput`, logged) an answer, a proposal or a run's reply that contains the agent API's credential.
  Checked once with Claude Code 2.1.317: from the view, a README is readable; `.env` (ignored), `.domaintrail/`, the
  workspace by its absolute path and a file outside it are not; the runner cannot read or edit a denied `.env` nor
  write outside its directory.
- **M4b** (a second security review; ADR 0030 "As built in M4b"): in a git repository the view is git's allowlist
  (`git ls-files -co --exclude-standard`) and the runner's deny list git's ignored entries (`-o -i --directory`), so
  `core.excludesFile` and `.git/info/exclude` apply; elsewhere `GitIgnore` plus the user's excludes file.
  `.git` and `.domaintrail` are kept out at any depth (`**/.git/**`, `**/.git`, `**/.domaintrail/**`,
  `**/.domaintrail` deny rules; never in the view). Checked with Claude Code 2.1.317 against canaries.
- **After M4b** (its review; ADR 0030 "As built after M4b"): `.git` / `.domaintrail` recognised in any case and
  Unicode form, the view copying a listed file only under the names `readdir` gives; nested repositories and
  submodules (gitlinks, untracked repositories; walked: a directory holding a `.git`) denied to the runner as a whole.
  The runner's deny list fails closed past 500 entries (the run fails, the agent's log says how to reduce them); case
  variants of `.git` / `.domaintrail` keep their own deny rule (only the exact names are left to the static rules).
- **Config**: no key was added in M4. `resolveAnswerConfig`, `validateAnswerConfig`, `resolveTriageConfig`,
  `validateTriageConfig` and their defaults are exported by `@domaintrail/agent`; M5's config module places them under
  `agent.answer` / `agent.triage` (see "Connected after M4 and M5").

### As built in M5

M5 landed the commands and the config, with these details settled or changed:

- **Commands**: `dt open`, `dt collab` (+ `dt collab link`), `dt agent [--role answer|run] [--once]`; `dt view` and
  `dt session start|link|subscribe` are hidden commands that fail with the replacement's name (exit 2). `--no-agent`
  and `--agent claude` share one option (`--agent claude` makes an unusable Claude Code an error, after which the
  server is stopped). `dt open --host <non-loopback>` serves the read-only Live View (`--agent claude` with it is an
  error).
- **`dt open`'s sign-in** (security review, two rounds): not "every loopback request is the facilitator". `dt open`
  prints a one-time link (`/session/open?code=…`, single use, 60 minutes) in place of the plain address; opening it
  sets a cookie and redirects to the Live View. The link is the only step. Everything about it lives in the server's
  memory only (`wiring/solo.ts`, `createSoloSignIn`): the code is not a facilitator link (the database never sees it,
  the collab facilitator page does not take it); the cookie's name is chosen when the server starts
  (`dt_open_<random>`), it is HttpOnly, SameSite=Strict and a session cookie (no Max-Age), and its value is known to
  this server instance alone — so the cookie, which a browser sends to every port of the host, is worth nothing to
  another server, nor to this one after a restart (which prints a new link). Without it a request is not identified
  (401; a page says to open the printed link, no join form), so another local process or OS user is not the
  facilitator. The link and the sign-ins are revoked when the server stops or the session leaves Solo. When `dt collab`
  continues the session, the person takes the facilitator link it prints (their messages are the facilitator
  participant's already).
- **Loopback only**: `dt open` never reads `collab` beyond `quickReactions` (`open.port` / `open.host`, the dev
  identity); its host policy admits loopback Hosts and Origins only, whatever `collab.access` allows.
- **Fail closed and one server per workspace**: the Solo identities identify no one once the session is not open and
  Solo (`dt collab` continuing it); `startSessionServer` refuses to start while another live server (`server.json`
  with its process alive, or a server of the same process) serves the workspace, so a session's mode never changes
  under a running server.
- **The agent in process**: `checkClaudeCode` decides; the subscriber is the same as `dt agent`'s (loopback HTTP),
  handed the agent API's URL and bearer token in memory; Ctrl+C stops the agent before its server.
- **The agent credential is never on disk** (maintainer, 2026-11-03): `agent.json` is gone. A standalone `dt agent`
  pairs: `dt collab agent-link` (or `dt open agent-link` for a running `dt open`) prints a one-time code (random, single
  use, 10 minutes, stored as a hash beside the facilitator links but in a hash domain of its own, so neither kind is
  accepted as the other) and the agent API's address; `dt agent --code <code> [--url <agent API>]` exchanges it at
  `POST /agent/pair` (loopback, no `Origin`) for the token and keeps it in memory. The server revokes every unused
  link and code when it stops. `server.json` keeps the page's and the agent API's addresses (no secret); a leftover
  `agent.json` of an older version is removed when a server starts; `.domaintrail/` gets a `.gitignore` (`*`) when it
  has none.
- **Roles**: `--role` is parsed and passed on, both by default (connected to M4's answerer at the merge, below).
- **Config**: `agent.answer` also has `idleTimeout` (default 30) and `agent.triage` has `warm` (default false, Q12);
  `agent.answer.timeout` is in seconds (default 120). The session server is given a `SessionSettings` composed from
  `collab`, `agent.port`, `agent.run.{allowedTools,maxPreviousRunDiff}` and `classifier`.
- **The seed** runs `dt collab --no-agent` (its scripted agent plays the runs); how it sends messages since the merge
  is below.

### Connected after M4 and M5

The merge of M4 (the triage and the answers) and M5 (the commands and the config) connected them:

- **Both roles in every agent**: `dt agent` and the agent `dt open` / `dt collab` start in process take on the answerer
  (`startAnswerer` with `createClaudeAnswerer`, in the view of the workspace) and the runner, both by default;
  `dt agent --role answer` or `--role run` takes one. The two share one paired credential (in memory) and end together.
  The answer stream (`/agent/answers/*`) is behind the same bearer token as the runs' routes; only `POST /agent/pair`
  goes without it.
- **Config**: one module (`capabilities/agent/src/adapters/config.ts`) holds `agent.run`, `agent.answer` and
  `agent.triage`; its checks of `agent.answer` and `agent.triage` are M4's exported validators
  (`validateAnswerConfig(value, at, fail)`, `validateTriageConfig`), with M5's keys (`agent.answer.idleTimeout`
  included); the unknown keys are the app's to check, with its hints. The resolved `agent.answer` (warm, restartAfter,
  idleTimeout, timeout, model, effort) and `agent.triage` (model, warm) feed the answerer; a role without its own model
  or effort takes the user's Claude Code settings. `classifier.threshold` defaults to 0.9 (`TRIAGE_THRESHOLDS.clef`).
- **`dt open link`** (the maintainer's decision at the merge): another one-time sign-in link for the running `dt open`
  server, so the person need not restart it for a new one (another browser, the first link expired). The same rules as
  the printed link — single use, 60 minutes, the same cookie — but issued by the command, so its code is written (as a
  hash, in a hash domain of its own: neither a facilitator link nor an agent code) to the session's database, where the
  server redeems it; every unused one is revoked when the server stops, and none is accepted once the sign-in is
  revoked (the session left Solo). Refused for a running `dt collab` server (mirror of `dt collab link` refusing a
  `dt open` one). Continuing a Solo session with `dt collab` still requires the facilitator link it prints: the
  solo cookie is not carried over.
- **The seed**: one message applied without a note goes as the page's 「AI に送る」 does
  (`POST /api/session/requests/:id/address`): its triage decides a change request — the mock classifier, or, with
  `--no-classifier`, the seed's own answerer (the real `startAnswerer` with a scripted agent: stage 3 reads the
  scenario's message as a change request and anything else as needing no answer; it answers and proposes nothing) —
  and the facilitator's addressing queues the run. Several messages in one run, a run with a note, もう一度送る and an
  alternative still use the runs route (as the page does until M6). A participant's reply the classifier reads as a
  request gets a proposal job the seed's answerer does not make: the server gives it up after two attempts.

### As built: proposals as targets and options

The maintainer's second design of the change proposal (2026-11-03; it replaces M2's `{ what, where, how }`):

- **Shape** (`proposal.dt`, `domain/proposals.ts`): `ProposalContent { targets: ModelTarget[0..50], how, options:
  ProposalOption[0..3] }` — the targets are model elements (`.dt` or `.dtes`), the how one or two lines
  (`PROPOSAL_LIMITS.how` 300; the facilitator's edit up to 2000); an option is `{ label (60), targets, how?,
  recommended }`, none or two to three of them, exactly one recommended. No file names or paths anywhere.
- **The AI's output** (`ProposalData`, `readProposal`): targets as element references (`@{Sales.Order}`,
  `@{es:Returns/ReturnRequested}`). Clamped rather than refused: a malformed reference (a path, a file, whitespace)
  is dropped, a well-formed one that names nothing is kept (a proposal may add it; the page shows it unlinked),
  duplicates and those past 50 dropped; past three options the recommended one and the first others are kept; none
  recommended → the first, several → the first marked; a single option is no choice and becomes the proposal. Text
  past its limit is still refused. The answerer sends the proposal as it read it, and the server reads it again.
- **Approval**: `approve(option?, editedHow?)` (`NoSuchOption` unless an option of a proposal with options, none of
  one without); the route takes `{ proposal, option?, how? }` and the recommended option when none is given. The run's
  input freezes `ApprovedProposal { proposal, request, instruction: { label?, targets, how } }` — the chosen option's
  label, its targets (the proposal's when it has none) and the edited how, else the option's, else the proposal's; the
  runner's prompt shows it as `{ request, chosenOption?, targets, how }` (rule 12). The run card and the facilitator's
  仕分けの記録 show the chosen option (選んだ案).
- **Prompts**: the answerer is told to name the elements as references, write how in one or two short lines, never a
  file, never alternatives in prose, and give options only when genuinely unsure (two or three, one recommended).
- **Former proposals** (`legacy.ts`): a proposal, its `ChangeProposed`, an approval's `edited` (→ `editedHow`) and an
  approved proposal in a run's input (`content` → `instruction`) written as three texts are read with no targets, no
  options and the three texts joined, a line each, as the how.
- **The card** (`proposal.tsx`, `proposal-view.ts`): the targets as chips (`#注文` 集約・販売, a link; the first three,
  then 「ほか n」), then the how, no field labels. With options: the how, then one row per option (label, AI の勧め on
  the recommended one, its chips, its own how); the facilitator picks with a radio (the recommendation chosen first)
  and has one 承認 / 編集 (the chosen option's how) / 却下; everyone else sees the options read-only with
  「ファシリテーターの承認待ち」, and the requester 取り下げ. Approving several together takes each card's pick. Solo is
  unchanged (no proposals).

### As built: the ways of working in the prompts

- **Guide**: two topics, `storming-practice` (under `storming`) and `modeling-practice` (under `dsl`), with the
  maintainer's text; `workflow` points to both.
- **Push**: the runner's prompt and the answerer's answer and propose prompts give the topics of the languages the
  request is about, as the guide has them (the CLI reads them from the guide it embeds and hands them to the agent;
  no copy in the prompts): `.dtes` targets the storming's, `.dt` targets the modeling's, both or no target both. The
  runner's prompt puts its rules first where they differ; the answerer's stays read-only.
- **Pull**: the runner may run `dt guide` (alone, one topic or rule, or `--all`): `Bash(dt guide:*)` in the default
  `allowedTools`, and the agent's `dt` takes it besides `fmt` and `check`. The answerer has no `dt`.

### As built: reading outside the workspace, and the local config

Decided by the maintainer (2026-11-03): the AI may read paths outside the workspace, per project and per role, and
each person keeps settings of their own in a local file.

- **`agent.read.paths`** (both roles), **`agent.answer.read.paths`**, **`agent.run.read.paths`** (each added to the
  common list; since the review, from a git-ignored local file only, below): directories or files, absolute, `~/…` or relative to the config file (`resolveReadPaths`; the resolved
  `agent.read` is `{ answer, run }`). The configuration's check (`checkReadPaths`, with `agent.run.dt`'s, after the pure
  validation; links followed): a path inside the workspace, one holding it, or one in a `.git` / `.domaintrail`
  directory (any case) is an **error**, not a warning — a config that names the workspace means something other than
  what the AI would read. A missing path is not an error (a teammate may not have it): the agent skips it when it
  starts and logs `not reading … (not found)`.
- **Inside a path**, the workspace's semantics: in a git work tree, git's allowlist there (`core.excludesFile`,
  `.git/info/exclude`; a path its repository ignores as a whole falls back to `GitIgnore`, as the workspace does);
  elsewhere every file (a stray `.gitignore` outside a repository ignores nothing); never `.git` / `.domaintrail` at any
  depth or case; a nested repository inside a path denied as a whole (the path itself may be one). A file path: read
  unless git ignores it (`gitFileState`).
- **Enforced per role** (`apps/dt/src/wiring/read-scope.ts`): paths are taken by their real paths when the agent starts
  (`readTargets`, checked again). The answerer gets private views of them (`createWorkspaceView` with a `name`, in one
  0700 directory, refreshed before each turn) added with `--add-dir`, and a note (`--append-system-prompt`) mapping
  each view to its original path so that it quotes them by it; stage 3 gets nothing (no tools). The runner reads them in
  place: `--add-dir` per directory, `Read(//<file>)` allowed per file, and deny rules `Edit(//<dir>)`,
  `Edit(//<dir>/**)`, `Edit(//<file>)` (never written: deny wins over `Edit(./**)` and every allow rule),
  `Read(//<dir>/**/.git[/**])`, `Read(//<dir>/**/.domaintrail[/**])` (the static rules are relative to the working
  directory), and `Read(//<entry>[/**])` for what git ignores there, the nested repositories and the symbolic links
  (Claude Code resolves a link's target, measured, but a link is denied anyway). Those entries count with the
  workspace's against the 500 (`TooManyDeniedEntries`, now naming `agent.read.paths`). Measured with Claude Code
  2.1.317 with the runner's own arguments: a file of an extra directory read; its git-ignored file, its `.git/config`
  denied; Edit, Write and `Bash(echo > …)` there denied; a write in the workspace allowed.
- **Startup lines**: `dt open`, `dt collab` and `dt agent` print, when any role reads outside the workspace, one line
  per role (`AI answers read outside the workspace: …`, `AI runs read (never write) outside the workspace: …` or `…
  the workspace only`; `dt agent --role` prints its role's). In Collab every participant can make the AI quote these
  files (documented in `dt guide session-agent`).
- **`domaintrail.local.jsonc`** (or `.local.json`; `<name>.local.<ext>` beside a `-c <name>.<ext>`, decided: yes):
  read after the project's file and deep-merged (`mergeConfig`: objects key by key, arrays and scalars replaced;
  `__proto__` is a key, never a prototype); every setting may be overridden. The project's file is validated on its own
  (its errors name it), then the merge (its errors name the local file; its unknown keys included). The two files sit
  in one directory, so relative paths resolve alike. A local file alone (no project file) is the configuration
  (decided: yes; the search upwards stops at the first directory holding either). Every command loads both (`check`,
  `generate`, `fmt`, `show`, `lsp`, `open`, `collab`, `agent`); the language server adopts a local file alone as a
  nearest config, and watches no config file (it did not before either). `dt open` / `dt collab` / `dt agent` print
  `Config: domaintrail.jsonc + domaintrail.local.jsonc` and warn (stderr) when git tracks the local file or does not
  ignore it, with the line for `.gitignore` (never edited for them).

#### After the security review of the read paths (2026-11-03)

The review's findings, fixed, and the maintainer's two decisions:

- **Config files never written** (high): `CONFIG_EDIT_DENIED` denies `Edit` of the four config file names at any
  depth, each also with every letter bracketed (`[dD][oO]…`: case-insensitive by construction; measured: brackets are
  honoured, `DOMAINTRAIL.LOCAL.JSONC` and `CONF/team.jsonc` refused); a `-c` file and its local override are denied as
  given, by real path and relative to the workspace (`configFileRules`). The loader takes a config file only under its
  exact name (`existsExactly`), and the files named like a config file in any case beside a `-c` file outside the
  workspace join the runner's scan (`configGuardScan`), so creating one fails the run and stops the subscriber.
- **Read paths only from a git-ignored local file** (decision): in the project's file an error ("move it to
  domaintrail.local.jsonc (git-ignored)"); in a local file git tracks or does not ignore an error (asked of git when the
  config loads, fail closed). Refused as well: `/`, the home directory, and a path that is or holds `~/.ssh`,
  `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.config`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/Library`, `/etc`,
  `/private/etc`, `/var`, `/private/var`; a path inside one of them too, but `~/Library` (iCloud Drive), `/var` and
  `/private/var` (the temporary directories).
- **Approval of the security-relevant settings** (decision; `apps/dt/src/cli/trust.ts`): `agent.read*` (resolved, per
  role), `agent.run.allowedTools`, `agent.run.dt`, `collab.identity`, `collab.host`, `collab.access`, `open.host` and
  `classifier` (but `threshold`), of the merged configuration, hashed (SHA-256 of canonical JSON). Not the defaults and
  not the hash approved for the workspace's real path: printed and asked (y/N) on a terminal, `--yes` without one, else
  refused (exit 1). Kept in `$XDG_CONFIG_HOME/domaintrail/trust.json` (default `~/.config/domaintrail/trust.json`, also
  on macOS; 0700 / 0600, written whole then renamed). `answer` and `triage` have no tool or permission key (the
  answerer's tools are fixed), so none is hashed. The tests keep theirs in a directory of the run's
  (`test/preload.ts`); the session seed passes `--yes`.
- **Case variants on Node** (medium): `realpathSync.native` in `real()` (`dt-shim.ts`, its launcher) and in
  `readTargets` (Node's `realpathSync` keeps the written case); `test/read-paths-node.test.ts` runs the check on Node.
- **Fail closed on names no rule can express** (low): `UnexpressiblePath` (a `ReadScopeTooLarge`) refuses the run for
  a denied path or an extra directory or file with a line break or NUL, never a rule left out.
- **Each read path checked again** (low): its real path and device/inode recorded at start (`ReadTarget.id`),
  compared before each answerer turn and each run (`checkTarget`); a change fails that turn or run.
- **The answerer's copies** (low): their directory names its owner process (`.owner`); at start, this user's
  `dt-answerer-read-*` whose owner is gone (or without one past a minute) are removed; all together at most 200 MiB
  (`MAX_EXTRA_VIEW_BYTES`), refused before copying past it.

## The page

- **Mode**: in solo the collab menu, invite, hand-over, leave, participants and reactions-of-others are hidden; the chat
  is the person and the AI.
- **AI status**: the chat header shows 「AI: 接続済み」, 「AI: 接続なし」 or 「AI 接続なし（n 件待ち）」.
- **Composer**: `@` offers `AI` first; a message that will be addressed (it mentions `@AI`, replies to the AI, or solo)
  shows a small AI mark before sending, so the person knows whether the AI will read it.
- **Messages**: an addressed message shows its triage's progress (仕分け中 → 回答中 / 承認待ち / 待機中 / —); the
  facilitator has 「AI に送る」 on every message not yet addressed, and 「仕分けの記録」 on addressed ones.
- **Answers**: the AI's reply bubble under the message, its text with element links; replying to it addresses the AI.
- **Proposals**: a card under the message (the target elements, how in a line or two, and options when the AI was
  unsure: see "As built: proposals as targets and options"); for the facilitator 承認, 編集して承認, 却下, and
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

## Later: message templates (decided, round 4)

After M6 (the composer is reworked there), a separate task **M8** adds templates to the composer:

- Typing `/` in the composer lists templates, the same gesture as `@` for people and the AI; nothing is shown on the
  page otherwise.
- A template is only the beginning of a message: picking it puts its text in the composer, to edit and send. It never
  says whether the message is a 相談 or a 依頼; the triage decides as for any message.
- The list depends on what is open and selected: Event Storming (Big Picture / Design Level), the structure or catalog
  with an element selected, a state view, or nothing selected. A selected element goes in as the `#` target.
- Built-in templates, plus a team's own in `domaintrail.jsonc` (a section to name in M8), shown after the built-in ones.

## `/` commands: ways of working with the AI (decided, round 5, 2026-11-03)

This widens M8. Typing `/` lists **commands** next to the templates. A command starts a way of working with the AI.
A template only puts text in the composer.

- **Two kinds of command:**
  - **Interview.** The AI asks one question at a time, digs into vague answers, and ends with a brief that the user
    confirms (確定), edits and confirms, or drops.
  - **Review.** The AI reads the model, lists candidate changes, and the user checks the ones to apply; they become a
    run. This reuses the proposal options, with several picked instead of one.
- **First set:**
  - Interviews: `/es` (start an event storming) and `/model` (start modeling a context), plus the templates.
  - Next, a review: `/levels`, once events can carry `level design`. It suggests which events are Design Level only
    and which to promote.
  - Later: other reviews (terms, hotspots, from a storming to `.dt`), then a team's own commands defined in the
    repository.
- **Interview contents:**
  - `/es`: the business in scope; the first and last events; the purpose (learn the current flow / improve / design
    anew); what the result is for (align people / lead into modeling); how far to go (Big Picture / Design Level);
    who takes part.
  - `/model`: the context; whether a storming feeds it; what the generated code is for; constraints (existing
    systems, fixed terms); how far to go.
- **Routing:** while an interview runs, the messages of the person who started it go to the interviewer without
  triage. Replies to an interview would otherwise come out "neither". Only the facilitator can start one in Collab;
  the others' messages are triaged as usual.
- **Where the brief goes:** the `///` description right above the `storming` (for `/es`) or the `context` (for
  `/model`). Four or five lines with conventional heads:

  ```text
  /// 目的: …
  /// 範囲: …
  /// 使い道: …
  /// レベル: …
  ```

  A run writes it. A storming that does not exist yet is created with the brief. Being a description, the brief shows
  in the inspector, and the AI reads it with the model. The grammar does not change; dedicated clauses can come later
  if the AI or the tools need the items as data.
- **Languages:** the app is Japanese and English.
  - Each command has a stable English ID (`es`, `model`, `levels`) and a name in each UI language: 「ES を始める」 /
    "Start event storming".
  - Filtering after `/` matches the ID and the name in the current language.
  - The questions, the brief and the AI's replies follow the UI language, or the language the user writes in.
  - The brief is written once, in the language of the interview; it is not duplicated in both languages.
  - A command is defined once, independently of language. Templates have both languages.
- **Empty workspace:** the empty-canvas line points to `/es` instead of only "ask in the chat".

### As built in M8 (first set)

(The IDs `es` and `model` below are `es:start` and `model:start` since phase 1 of the ES commands, below.)

- **Model** (`interview.dt`, `domain/interviews.ts`): an `Interview` aggregate (聞き取り) — `command` (`Es` | `Model`,
  wire IDs `es` / `model`), `startedBy`, `opening` (the starter's message sent with it: the command's name), `focus`
  (the element selected then), `language` (`Ja` | `En`) — with states `Asking { awaiting? }` → `Briefed { brief,
  answered }` → `Confirmed { brief, edited, run }`, or `Stopped`. Commands: `start` (the facilitator only:
  `FacilitatorOnly`), `hear` (the starter wrote: `awaiting` is that message; from `Briefed` it drops the brief),
  `ask` and `summarize` (only for the message still awaited: `InterviewMovedOn`), `confirm` and `stop` (the starter
  only: `NotTheInterviewer`). One running per session (`InterviewAlreadyRunning`, the use case). The brief is
  `InterviewBrief { name (an identifier), label?, isNew, replaces, text }`, its text the `head: text` lines. Stored in
  a table of its own (migration 12); older sessions have none.
- **Routing**: `sendMessage` gives a message of the running interview's starter to it (`hearIn`, no triage) before
  addressing; anyone else's message is addressed and triaged as before, a reply to the AI's question included. The
  AI's questions are messages of the AI replying to the message they answer (`Request.answer`), so the chat and the
  session so far show them as answers.
- **The interviewer**: an `interview` job on the answers entry point (`interviewJobs`: due while `awaiting` is set, one
  per awaited message), with the transcript (the interview's messages), the language, `focus` and the session so far;
  the answerer's read-only agent answers it in a warm process of its own (another JSON schema): `{ kind: 'question' }`
  or `{ kind: 'brief', brief: { name, label?, isNew, replaces, lines[3..6] } }`, read again by the server. Its prompt
  lists each command's items, asks one question at a time, digs into vague answers, reads the stormings' `///` and the
  model first, follows the UI language unless the person writes in another. It is given the guide's way of working of
  its command's DSL (`/es`: storming-practice, `/model`: modeling-practice), as the answerer is.
- **Confirm → run**: `confirmInterview` queues a run on the message the brief answered whose input carries
  `brief: BriefInstruction { interview, command, brief }` (the text as edited); the runner's rule 16 writes the lines as
  the `///` description above `storming <name>` / `context <name>`, creating it when `create`, replacing an existing
  description only when the card said so. A proposal was not reused: it needs a triage, and the starter's confirmation
  is the approval.
- **Session so far**: entries for the interview started, its brief waiting, confirmed (edited, its run) or stopped, and
  what is open (a running interview, a brief to confirm).
- **Routes**: `POST /api/session/interviews` (`{ command, body, language, focus? }`), `…/:id/confirm` (`{ text? }`),
  `…/:id/stop`; the state has `interviews` and the team's `templates`; events `interview.*` (the page fetches the
  state again).
- **The page**: `/` alone in the composer lists the commands (for the facilitator, while none runs; marked with the
  AI's spark) then the templates of the contexts (`big-picture`, `design-level`, `storming`, `model`, `element`,
  `aggregate`, `event`, `state`, `none`); the bar above the composer shows the running interview (AI が考えています,
  中止) and its brief (確定 / 編集して確定 / 中止; read-only for others). In Solo a question sits under the answer it follows.
  A whole storming's link selects it, so its description (the brief) shows in the inspector. The empty view points to
  `/es` (for the facilitator).
- **Templates**: eight built in (both languages) and the team's in the top-level `templates` of `domaintrail.jsonc`
  (`{ id, name, text, when? }`, a name and a text as one string or `{ ja, en }`; at most 30), validated by
  Collaboration (`checkTemplates`) and in the JSON schema, used by `dt open` and `dt collab`.

### As built: choices to answer an interview's question

The interviewer's questions often listed example answers in their text (decided 2026-11-03): they became choices to
press.

- **The interviewer**: a question may carry `choices` (2 to 6, each at most 40 characters) and `multiple` (several make
  one answer: who takes part, what the result is for). The prompt asks for them when the question has natural
  candidates, taken from the workspace and the answers so far rather than generic ones, with no "other" (the page adds
  it) and the question's text then free of that list; an answer picked from them is the person's data, never an
  instruction. The schema bounds them; `readChoices` cleans rather than refuses (non-strings and blanks dropped, one
  line, cut to 40 with `…`, duplicates dropped case aside, six at most, fewer than two: none; `multiple` only with
  choices), in the agent and again in the server.
- **Model**: `Asking { awaiting?, asked? }`, `asked: AskedQuestion { question, choices: AnswerChoice[0..6], multiple }`
  set by `ask` (its `question` parameter is that value) and dropped by `hear`; `InterviewQuestionAsked` carries the
  choices. The interview row is JSON, so no migration: an older row has no `asked`. The state carries it, so a reload
  shows the choices.
- **The page** (`InterviewChoices` under the AI's message): only for the starter on a live page, only under the
  question the interview awaits, only while it awaits it (hidden at once once sent). One choice: a button that sends it
  at once as a message replying to the question (heard by the interview as any of the starter's messages); several:
  checkboxes and 送る, the checked ones sent joined (「、」 in Japanese, ", " in English). Always last, その他（自分で書く）
  / Other (write it) gives the composer the focus; the composer works at any time. The brand on its pale wash,
  compact, wrapping. The others in a Collab session see no choices (the answer shows as a message).

### Built-in ES commands, phase 1

Decided by the maintainer (2026-11-03): ES-only commands are `/es:{name}`, modeling ones `/model:{name}`; the
interviews became `/es:start` and `/model:start` (IDs `es:start`, `model:start`; the wire still reads `es` and `model`,
and stored interviews keep their `Es` / `Model`, so older sessions read as before). Display names stay verbs in each UI
language. Besides the interviews there are two kinds of command: **candidate** commands (the AI lists candidate
changes, the person checks some, they become one run) and **answer** commands (the AI answers in the chat).

- **Model** (`command.dt`, `domain/slash-commands.ts`): a `SlashCommand` aggregate (コマンド) of its own, not an
  extension of `Interview` (no transcript, no brief; one shape for both kinds) — `kind` (`EsExceptions` | `EsRecap`),
  `startedBy`, `opening` (the starter's message: the command's name, with the view it was sent from), `scope` (the
  storming in view: the view's, else the selected element's), `language` — with states `Working` → `Listed {
  candidates[0..20], listedAt }` → `Applied { candidates, chosen: CandidateIndex[1..20], run }`, or `Working` →
  `Answered { answer }`, or `Stopped`. A candidate is `{ label (60), targets (element references, at most 20), how
  (one line, 300), reason? (200) }`. `start` requires the facilitator when the command is the facilitator's
  (`FacilitatorOnly`); `apply` and `stop` its starter (`NotTheStarter`), `apply` numbers of the list
  (`NoSuchCandidate`); one running (`Working` or `Listed`) of each kind per session (`CommandAlreadyRunning`, the use
  case). Stored in a table of its own (migration 14, `slash_commands`). The run's input gains `candidates:
  CandidatesInstruction { command, kind, scope?, chosen[1..20] }`.
- **The table** (`SLASH_COMMANDS`): each command's ID, kind, type (`candidates` | `answer`), whether only the
  facilitator starts it and whether it needs a storming in view. `/es:exceptions`: candidates, the facilitator's,
  needs a storming. `/es:recap`: an answer, anyone's (an answer changes nothing, so a participant may ask for one).
  Phase 2 (`/es:levels`, `/es:names`, `/es:gaps`, `/es:next`, below) adds a row, an enum entry, a prompt in
  `COMMAND_PROMPTS` (`answer-prompt.ts`) and, for a candidate command, a clause of the runner's rule 19.
- **Routing**: `POST /api/session/commands` (`{ command, body, language, focus?, viewedAt? }`, any participant) sends
  the opening message without triage and starts the command; nothing in view for a command that needs a storming lists
  no candidates at once (the AI is not asked) and the card says 「見ているストーミングがありません」. While it works the
  answers entry point hands out a `command` job (`commandJobs`: one per `Working` command) with the command, its ID
  and type, the opening message (its `viewedAt`), the language and the session so far; the answerer runs it in a
  fresh read-only process with the schema of its type (`{ kind: 'candidates', candidates }` or `{ kind: 'answer',
  answer }`), read again by the server (`readCommandReply`): candidates past twelve dropped, malformed references
  dropped as a proposal's, text past its limit refused, the other kind refused. Candidates → `listCandidates`; an
  answer → `answerCommand`, a message of the AI replying to the opening (as the interviewer's questions), Markdown.
  Given up as the other answer jobs (`MAX_ATTEMPTS`, もう一度).
- **Apply**: `POST /api/session/commands/:id/apply` (`{ chosen: number[] }`, its starter) queues one run on the
  opening message whose input carries the chosen candidates (`queueRequests`, as a confirmed brief): a sibling of the
  approved proposal rather than a reuse of it, since there is no triage and several are picked. `…/:id/stop` drops it.
  The runner's **rule 19**: `chosenCandidates` (`{ command, storming, candidates: [{ label, targets, how, reason? }] }`)
  are what to do, not the request; for `/es:exceptions` each is one `exception` in the storming (rule 17) in the stage
  of its branch point — the branch event written again, the new events, `then <Event>` when it returns —, `level
  design` only when `how` says so (rule 15), none the storming already has. A run of an ES command is about `.dtes`
  only (rule 4, the storming's way of working).
- **Prompts** (English; the output follows the UI language unless the session is written in another): both get the
  storming-practice topic. `/es:exceptions`: for each step of the main flow in view (a stage's or timeline's when one
  is shown, else the whole storming), plausible exceptions not modeled yet — failure, cancellation, timeout, missing
  input, rejection —, at most two per step and twelve in all, as an `exception` to add: label the new event (a short
  past-tense phrase), targets the branch event then the new ones then the return, how the timeline in one line.
  `/es:recap`: from the session so far, three short bullet lists under bold lead-ins (決まったこと / 追加・変更 / 未決),
  empty ones left out, nothing invented.
- **The page**: `/` lists the commands the person may start now (`canStartCommand`: interviews and
  `/es:exceptions` for the facilitator, `/es:recap` for anyone; none of a kind while one runs), grouped `es:start`,
  the other `es:` commands, `model:start`, then the templates; `/es` filters to the ES commands, each with what it
  does (AI が聞き取ります / AI が候補を挙げます / AI が答えます). A candidate command is a card on the AI's bubble under
  its message (`candidates.tsx`): AI が考えています and 中止 while it works; the candidates with a checkbox each for its
  starter, **none checked** (the person chooses deliberately; the AI's order already puts the strongest first), chips
  for their elements, how and why, 採用したものを反映 / 中止, read-only for the others (始めた人の選択待ち); applied, the
  chosen ones checked and the rest dimmed, with 「n 件を反映」 and a link to the run, whose card says ↳ 採用した候補 and
  links back. An answer command's card shows only while the AI works (Collab); in Solo its message has the pending
  slot, then the answer. Everything is server state: a reload shows the same.
- **Session so far**: the command run (on which storming), its candidates (listed, each a line), those applied (with
  the run) or that it was stopped; what is open (a command the AI works on, candidates awaiting a choice).
- **Not done**: editing a candidate's how before applying.

### Built-in ES commands, phase 2

Decided by the maintainer (2026-11-03): four more ES commands, each a row of `SLASH_COMMANDS`, an entry of
`SlashCommandKind`, a prompt in `COMMAND_PROMPTS` and, for a candidate command, a clause of rule 19. `/` lists them
after `es:start` in the order of the work on a storming — the flow, then its details, then the session:
`es:exceptions`, `es:gaps`, `es:levels`, `es:names`, `es:recap`, `es:next` —, then `model:start`, then the templates.
(`/es:next` became `/hint`, listed first: "As built: ヒントをもらう" below.)

- **`/es:gaps` 間を埋める** (candidates, the facilitator's, needs a storming): the events missing between two
  consecutive events of the flows in view (the timelines, and the exceptions when the view shows them), one candidate
  per gap: label the (first) new event, targets the event before, the new ones, the event after, how the flow and
  where. Rule 19: declare the new events and insert them between the first and the last target in the timeline or
  exception `how` names, nowhere else.
- **`/es:levels` レベルを見直す** (candidates, the facilitator's, needs a storming): events to give `level design`
  (details of the mechanism) or to take it from (what the people should see at Big Picture), one event per candidate
  (its only target), how starting with 「level design を付ける」/「level design を外す」 ("Add/Remove level design").
  Rule 19: exactly that, as the last clause of the event's body, nothing else of it.
- **`/es:names` 名前を揃える** (candidates, the facilitator's, needs a storming): labels to rename — not in the past
  tense, the same thing named differently (one candidate per element that changes), too long (S015), technical
  wording —, one element per candidate, label the new label (in the storming's language), how old → new and, when
  the old label carried a detail, 「詳細は /// へ: …」. Rule 19: the label only, never the identifier; the `///` kept,
  the detail added to it.
- **`/es:next` 次にやること** (an answer, anyone's, needs a storming): the answerer replies `{ kind: 'next', status,
  steps: [{ text, reason, command? }] }` — status one line (200), one to three steps (more dropped), text (120) and
  reason (200) one line each, `command` one of `es:start`, `es:exceptions`, `es:gaps`, `es:levels`, `es:names`,
  `es:recap` (another is dropped, the step kept). The server writes the message from it (`nextAnswerText`: the
  status, then a numbered list `**text** — reason`, the command's ID in code after it), so the session so far and any
  reader see it whole, and keeps the steps on the command (`Answered.next: NextAnswer`, `SuggestedCommand` an enum of
  its own; the stored row is JSON, no migration). The job's `type` is the reply's shape (`candidates` | `answer` |
  `next`). Steps may be for the people (call a domain expert, stop and recap, decide X).
- **The page**: `/es:next`'s message shows the status, the numbered steps, each reason muted and — where a step names
  a command the person may start (a participant sees no button for a facilitator's one; one of its kind running is
  disabled) — a brand-coloured button with the command's ID that puts `/es:gaps` in the composer and focuses it:
  `/`'s list opens on that command, and the person sends it; nothing runs by itself. What the composer held is
  replaced.
- **Nothing in view**: a command that needs a storming, an answer command included, lists no candidates at once and
  asks nothing; its card says 「見ているストーミングがありません」 until its starter closes it (an answer command's card
  shows while it is listed).
- **What they read**: the storming-practice topic, as phase 1. `/es:names` and `/es:next` also get `dt check`'s
  findings on the `.dtes` files (`diagnostics`, the first forty; computed by the answerer's side with the analysis
  `dt check` makes, `stormingDiagnostics`), in the data block: they carry the files' labels.
- **Chips** (from the review of phase 1): a candidate's chips are only the targets that resolve now; one to be added
  (an exception's or a gap's new event) is named by the candidate's label and how rather than by an identifier
  nobody wrote (`#NoMyNumberCard`). Once applied, the new elements resolve and their chips appear.

### As built: ヒントをもらう (`/hint`)

Decided by the user (2026-11-03): `/es:next` became **`/hint` ヒントをもらう / "Get a hint"**, the AI coaching the person
— a beginner especially — in the event storming and the modeling alike.

- **The command**: ID `hint`, no prefix (it belongs to neither world); `SlashCommandKind.Hint` replaces `EsNext`. A
  command stored as `EsNext`, and its `SlashCommandStarted`, are read as `Hint` (`legacy.ts`; nothing rewritten, no
  migration), so an older session shows its answers with their steps as before. `POST /api/session/commands` no longer
  takes `es:next` (400, as any unknown ID): the page and the server ship together. Anyone runs it, in Solo and Collab.
  It needs no storming in view (`needsStorming: false`, no `scope`): it is always asked; the AI reads where the person
  is. One at a time per session, as every command.
- **The prompt** (`COMMAND_PROMPTS.hint`): first work out the world — doing Event Storming, modeling, moving from one
  to the other, or not started — from `sessionSoFar` (recent messages, the AI's turns, interviews and their briefs,
  the commands run), `viewedAt` (the view; none: nothing opened) and the files (Glob for `.dtes` and `.dt`): the
  stormings' briefs, level, stages, exception coverage and open hotspots; the model's contexts, their `///`,
  aggregates, states, invariants; `dt check`'s findings on **all** the files (`diagnostics`, scope `workspace`: the
  `.dt` too, where `/es:names` reads the `.dtes` only). No files: they have not started — advise `es:start` or
  `model:start`. Then the same shape as before: status (one line, which world and how far), one to three steps with
  reasons, `command` one of `es:start`, `es:exceptions`, `es:gaps`, `es:levels`, `es:names`, `es:recap`,
  `model:start` (`SuggestedCommand` gained `ModelStart`; the schema's enum is `SUGGESTED_COMMAND_IDS`, validation as
  before: another is dropped, the step kept). An `es:` command advised from elsewhere says which storming to open.
  Tone: a coach — short, concrete, encouraging, no unexplained jargon —, in the UI language unless the session is
  written in another. Both ways of working (storming-practice and modeling-practice) are given; names, labels and
  findings stay in the data block.
- **The button**: ヒントをもらう at the left end of the composer's bar, as tall as the send button: a `Lightbulb` and the
  label on the brand's pale wash (an action), the label dropped when the bar is narrow (a container query on
  `.chat-composer-bar`, 18rem: the chat at its default width shows it, at its narrowest not), its tooltip and
  aria-label always. Pressed, it starts `/hint` at once (the opening message is the command's name, with the view and
  the selection); the composer keeps what it holds. Disabled while a
  hint runs (or while the page starts one); hidden where commands cannot run: the composer is not shown (the session
  not live), or no answerer is connected.
- **The answer**: the AI's ordinary message (author AI) with a small `Lightbulb` by its name (role img, 「ヒント」); the
  steps' command buttons put the command in the composer as before (`/model:start` too, for who may start it).
- **`/`'s list**: `/hint` comes first, before `es:start` (decided: it is where a beginner starts; `/es` still lists
  the ES commands alone). The commands the latest **answered** hint of the session suggests carry a small filled
  amber `Star` (「ヒントのおすすめ」, `--chat-hint-star`) until another hint is answered (one still working, or
  stopped, leaves them).
- **Fixed with it**: an AI message in the history (clamped) faded its last line even when it fitted; the fade is now
  only for a message taller than the clamp (`cut`).

## The view a message was sent from (as built)

The AI roles did not know what the requester was looking at: the page's `ViewLocation` served presence and cursors
only. Each message now carries the sender's view, and every role gets it as data.

- **Model** (`view.dt`): `ViewedAt { view: ViewShown, states? }`, `ViewShown` one of `ContextMap { all }`,
  `Structure { level: Detail | Overview | Aggregates, focus: ContextName[] }`, `Catalog { query?, sections[],
  contexts[] }`, `Storming { storming, level: BigPicture | DesignLevel, timeline? | stage?, exceptions }`; `states` the
  aggregate whose state diagram the inspector shows. The element selected is not part of it: it is a target (`#`).
  `Request.viewedAt?` (and `RequestSent`, `FrozenRequest`), set by `send` only: a revert and the AI's answer have none,
  nor do messages sent before. No migration: requests are JSON rows, an absent field is an older row.
- **Capture** (`views.ts` `sentView`, `outgoing.ts`): the page sends `viewedAt` with every message of the composer
  (a template's text included: it is sent as a message) and with a `/` command started (`StartInterviewBody.viewedAt`,
  kept on the opening message). The 「AI に送る」 rescue sends nothing new: the message keeps the view it was sent
  from. The catalog's filter moved into the view workspace so that the session's part of the page can read it.
- **Server**: `readViewedAt` checks the shape and limits (400 `InvalidInput` naming the field); `resolveViewedAt`
  checks the names against the view the server shows now (`knownViewNames` from `view.state`) and **drops** what the
  workspace lacks — a timeline or stage (the storming's integrated canvas stays), contexts, the aggregate — and the
  whole view when its storming is gone. Decided over "kept but marked unresolved": the page only offers what the server
  showed it, so an unknown name is a stale or hostile page, and the prompts stay free of names that point nowhere.
- **Run**: frozen with the request (`freezeRequests`), so a run, warm or cold, gets it as its input says.
- **Prompts** (`viewedAtData`): in the data block, per request, e.g. `viewedAt: { view: 'storming', storming:
  '@{es:OrderToCash}', level: 'design', stage: 'Payment', exceptions: true }`. The runner's rule 18 says what
  "here" / 「ここ」 means and that a request sent from a stage adds within it; rule 15 says an event added for a request
  sent at Design Level that is a detail of the mechanism gets `level design`, and none is added at Big Picture unless
  asked (which events are mechanism details stays the practice's). The answerer's read-only rules say the same for its
  answers and proposals; stage 3 reads `message.viewedAt` (「ここに…を足して」 asks for a change there); the
  interviewer takes it as a hint for `focus`, never a reason to skip a question.
- **Not done**: the triage record (仕分けの記録) does not show the view (it would need the view's name, which only the
  participant list builds); the session so far does not mention views.

### As built: 詰めて表示 and printing

A user asked to close up the gaps between sticky notes when printing (decided 2026-11-03):

- **Layout**: a layout option `spacing` (`normal` | `compact`) reaches ELK (`SPACING_OPTIONS`: between layers 60 → 20,
  nodes 40 → 12, edge–node 24 → 8, edge–edge 16 → 6, edge label 6 → 3; a container's sides 20 → 10) and the stages'
  grid (`GRID_SPACING`: columns 72 → 32, stages 64 → 24, rows 72 → 52, before the loose notes 72 → 24, a frame's sides
  40 → 12 and heading 46 → 40). Layout runs on the server; the page asks for a compact layout on demand
  (`/api/compact?graph=<id>` for a pushed graph, `spacing=compact` on `/api/focus`), and the view service caches and
  saves it under `<graph id>#compact` beside the normal one (a compact layout is canonical: no incremental hints).
- **The page**: 詰めて表示 in the canvas's controls (remembered per browser, off by default) for every diagram,
  the inspector's state diagrams included; its own camera, no ghosts, its own cursor location (`layoutKey` `~compact`).
- **Printing**: a print sheet drawn into `<body>` while printing only: the scene in an `<svg>` whose viewBox is the
  diagram's bounds (HTML boxes in a `foreignObject`, edges as SVG), so the browser fits it to any page; `@page { size:
  landscape }` while it is drawn, the app hidden by `@media print`, the light theme from `beforeprint` to `afterprint`.
  Ctrl+P draws the sheet synchronously in `beforeprint` (`flushSync`) with the compact layout if the page has it; the
  印刷 action waits for the compact layout (at most 5 s) and the fonts, then calls `window.print()`. The catalog prints
  as a page.

### As built: the print heading, the legend and exporting

Decided by the user (2026-11-03), after printing:

- **Heading**: the print sheet's page has no margin (`@page { size: landscape; margin: 0 }`), so Chrome prints no header
  or footer of its own; the sheet has its own margin (10mm) and one line above the diagram: the breadcrumb and the view's
  conditions (`view/sheet.ts`, `sheetHeading`): the workspace › the view › the storming › すべて（統合）/ a stage / a
  timeline (as its picker names it) · the level · 例外を含む / 例外を除く (a storming with exceptions, not one timeline);
  the Structure View › the focused contexts · the level; the Context Map · すべてのコンテキスト (`mapAll`); a state
  diagram: 状態遷移 › the aggregate. Names by the display mode; nothing else (no date, version or brand).
- **Legend**: 凡例を含める (off by default) puts the view's legend under the diagram, on a printed sheet (the legend's
  own markup, `LegendBody`) and in an export; the legend's content is one function (`legendContent`) for the screen, the
  sheet and the SVG.
- **書き出し** (`view/export.ts`, the menu in `canvas-controls.tsx`): PNG, SVG, PDF (the 印刷 action), 見出しを含める
  (off; PNG and SVG only, a print always has it) and 凡例を含める, remembered per browser (`domaintrail.export`). The
  inspector's state diagram exports PNG and SVG (it does not print); the catalog does not export.
- **Portable SVG** (`view/portable-svg.ts`): built from the scene, not from the DOM: rects, paths, `text`/`tspan` and
  markers only (no `foreignObject`, no classes, no `paint-order`: an edge label's halo is the same text stroked white
  under it). styles.css's item rules are mirrored as tables of attributes; the colours are the light theme's custom
  properties resolved in the page (switched to light and back within one task, read back through a 1×1 canvas as
  `#rrggbb` and an opacity); the fonts are `--sans` / `--mono`. A sticky note's label is laid out by `fitLabel` with a
  line breaker (`wrapLines`: wide characters break anywhere but before closing punctuation, words at spaces, an
  overlong word where the line is full) over the canvas's `measureText`, clamped with «…»; baselines come from the
  font's ascent and descent (CSS's half-leading). Checked to render alike as an `<img>` in Chrome and in resvg.
- **PNG**: the portable SVG drawn into a canvas at 2× on white (`pngScale` lowers it for a canvas over 16384 px a side
  or 64 M pixels); it has no foreign content, so the canvas is never tainted.
- **File names**: `<workspace>-<view>-<storming | contexts>-<stage | timeline>-<level>`, from IDs, slugged
  (`exportFileName`).

### As built: printing and exporting in the view toolbar

Decided by the user (2026-11-03): the view toolbar says what is shown (the subject and its conditions, what an AI is
told the view was); the canvas's controls, how it is looked at.

- **書き出し** moved from the canvas's controls to the toolbar's right end, after 絞り込み (`view/export-menu.tsx`,
  `ExportButton`): one menu, opening below, right-aligned: 印刷, PDF（印刷画面から保存）, PNG, SVG, then 見出しを含める and
  凡例を含める. The catalog has 「印刷」 there instead (`PrintButton`: the page, as Ctrl+P); an empty view, nothing
  (`toolbarOutput`).
- **The canvas's controls**: zoom − % +, 全体, 選択に合わせる, 詰めて表示, 凡例, 畳む; the keys unchanged. The inspector's
  state diagram keeps its 書き出し there (PNG, SVG, opening upward).
- **「例外を表示」** moved from the storming's subject to its 絞り込み (`StormingFilter`, section 表示), on the same
  conditions (a storming with exceptions, not one timeline); hidden exceptions count one, and すべて解除 shows them.

### As built: actors, read models and aggregates once per use (Event Storming views)

- **Decided by the user**: at Design Level an actor drawn once and linked to every command that used it ran lines across
  the diagram. An actor or external system (a command's issuer), a read model (what it `reads`) and an aggregate (its
  `target`) are now drawn once per command of the view that uses them, beside that command. View only: the `.dtes`
  and the semantic graph do not change. Big Picture, policies, hotspots, the legend and the catalog are unchanged.
- **Projection** (`core/storming/uses.ts`, `render.ts`, `stage-view.ts`): a copy is a render node
  `n:<element>@<command>` with `use: <command>` and the element's ID; an element no command of the view uses keeps the
  one note `n:<element>` where it was drawn. Each use's edge joins the copy and its command only, so each copy has one
  short edge. The ELK drawings (the integrated canvas and a timeline) place the copy by that edge: the issuer and the
  read model on the command's left, the aggregate on its right. The stage grid stacks it in its command's column,
  above the command (aggregate, read model, actor, external, nearest first).
- **The page**: everything resolves by element — the inspector (the element once, with all its relations), change marks
  (every copy), references, presence and hotspot targets. Selecting a copy draws the selection on it and a fainter
  dashed ring (`dn-same`) on the element's other notes (`sameElementNodes`); a jump to the element (the chat, the
  catalog, a reference) picks the copy nearest the middle of the view, else the first in reading order
  (`itemForElement`). Hovering does not mark the siblings (a hover does not redraw the canvas).
- **Payload**: `examples/shop`'s OrderToCash at Design Level has 8 more notes on its integrated canvas (顧客 and 注文 ×4,
  カート and 請求書 ×2), the same edges; its Normal and PaymentRetry timelines keep their counts, the copies renamed
  (`n:Invoice` → `n:Invoice@IssueInvoice`).

### As built: resolved hotspots marked on the diagram

- **Decided by the user** (variant A): a hotspot with `status resolved` (`docs/dtes-v0.1.md` §3.5) was drawn like an
  open one; only the inspector said 解決済み. It is now toned down so that the open ones stand out: a paler, greyer
  pink paper and edge, a green check disc inside its top-right corner (under the diagnostic mark, which sits on the
  corner), and its `on` a fainter dotted line. Hovering the note shows 解決済み: <resolution> (the app's tooltip; a
  clamped label shows its full text and then the resolution). The inspector shows 状態 and 結論 as before. No toggle
  to hide resolved hotspots, and no action to resolve one (the AI in the chat edits the `.dtes`).
- **Projection** (`core/storming/graph.ts`): the graph node of a resolved hotspot carries `status: 'resolved'` and its
  `resolution` (empty when missing, an S009 error), in every view (integrated, timeline, stage grid; both levels); an
  open one carries neither. `graphSignature` includes the status, since the page keeps compact layouts by signature with
  the nodes they came with; resolving a hotspot does not move anything.
- **The page**: `NodeProps.resolution` and `EdgeProps.resolved` (`render.ts`), the classes `dn-resolved` and
  `de-resolved` and the `ResolvedMark` in `NodeContent` (`diagram-items.tsx`), so the canvas and the print sheet draw it
  alike; the portable SVG (and so the PNG) draws the toned colours as attributes and the check as a circle and a path.
  The storming legend has a 解決済みのホットスポット chip, with the check, right after ホットスポット (`LegendKind`,
  `legendKindNames`).
- **Tokens** (`styles.css`): `--es-hotspot-resolved` / `-border` / `-text` (light `#fbf1f5` / `#e3a1b9` / `#8f3a5e`,
  dark `#2e2229` / `#9a5b76` / `#d9bfcc`), `--es-hotspot-resolved-edge` (slate-350, night-600), `--es-resolved-mark`
  and `-ink` (emerald-700 with white, emerald-300 with night-950). The label on the toned paper: 6.47:1 (APCA Lc 77.4)
  light, 8.91:1 (Lc −69.0) dark; the check on its disc 5.48:1 light, 12.21:1 dark. Pinned in `palette.test.ts`, with
  the resolved paper, edge and `on` nearer the surface than the open hotspot's.
- **Payload**: `examples/shop`'s OrderToCash has a resolved hotspot (MixedCurrencies), so its storming graphs' hashes in
  `test/__snapshots__/live-payload-contract.test.ts.snap` change (the node's two fields and the signature); the counts
  of nodes and edges do not.

### As built: the neutrals tinted to the brand's hue

- **Decided by the user**: the Live View's neutrals read cold blue-grey beside the indigo brand. Every neutral primitive
  but white (`--p-slate-*`, `--p-night-*` in `apps/web/styles.css`) keeps its OKLCH lightness and takes the hue of
  `--p-brand-indigo` (277°) with 1.25× its chroma (e.g. slate-900 `#0f172a` → `#12152e`, night-900 `#191d2b` →
  `#1a1c2e`). The names stay (a tinted slate is still a slate). The slate-based literals follow as `color-mix` of the
  primitives (`--row-hover`, `--shadow`, `--backdrop`, the dark `--legend-bg`). The Event Storming notes, the status,
  diff, brand, participant and avatar hues are unchanged; the canvas background has too little chroma to change.
- **Dark muted text raised**: `--muted` in dark was slate-400 (APCA Lc ≈ 50 on the surfaces); it is now a new
  `--p-slate-350` (`#b5b9d1`, the OKLCH midpoint of slate-300 and slate-400, tinted the same way): Lc −64.5 on `--bg`,
  −63.4 on `--surface`, −61.1 on `--surface-muted` (WCAG 9.6 / 8.7 / 7.3:1), still about Lc 15 below
  `--text-secondary`. Light muted is unchanged in lightness (Lc 77.3, 5.46:1 on the surface).
- **Pinned** by `apps/web/palette.test.ts`: the text, secondary and muted tokens, resolved from `styles.css`, against
  bg, surface and surface-muted in both themes (APCA 0.0.98G-4g and WCAG 4.5:1), and dark muted at least Lc 10 below
  the secondary text.

### As built: the sources as one ZIP

- **Decided by the user**: someone without git should be able to take the model and run `dt` elsewhere. The sources
  are exported as one ZIP, from the CLI (`dt export sources`) and from the Live View's collab menu
  (ソース一式をダウンロード / Download sources (.zip)) for everyone on the page: Solo, the facilitator and the
  participants. No README in it, only the sources.
- **What it holds** (`platform/workspace` `sourceArchiveFiles`): the files `dt check` analyzes (`findDomainFiles` with
  the config's `sources`), `.dt` and `.dtes` files only whatever the globs match, and the project's config file when it
  is a plain file in the root; paths relative to the root below one folder named after the root's directory
  (`shop/sales/order.dt`; characters Windows refuses become `-`). Never: the local override (`*.local.json[c]`),
  `.domaintrail`, `.git`, `node_modules`, generated output, symlinks (the walk neither follows nor lists them; a
  config file that is a symlink is left out), and, where git speaks for the root, any file `git ls-files -co
  --exclude-standard` does not list (`gitReadableFiles`), even with `respectGitignore: false`; so the files of a
  nested repository or submodule are left out too.
- **The ZIP** (`platform/workspace` `zip`, no dependency): local headers, the central directory and its end record, no
  ZIP64 (more than 65,535 files or 4 GiB is an error); every name in NFC with the UTF-8 flag (bit 11); CRC-32;
  raw DEFLATE (`node:zlib`) unless storing is smaller; DOS date and time from each file's mtime (local time); made by
  Unix with mode 0644. Checked by a reader of the tests' own (central directory, local headers, inflate, CRC) and by
  `unzip -t` and extraction where `unzip` is installed.
- **CLI**: `dt export sources` writes `<workspace>-sources.zip` in the current directory, `-o <file>` elsewhere,
  `-o -` to stdout (the summary on stderr); honors `-r` / `-c`; exits 1 when there is no `.dt` or `.dtes` file
  (a config file alone included), 2 on an invalid config. In `dt --help` and `dt guide export`.
- **Live View**: `GET /api/export/sources.zip` on the Live View's API, made from the files on disk at each request,
  `application/zip`, `Content-Disposition: attachment; filename="…"; filename*=UTF-8''…` (an ASCII fallback
  `sources.zip` for a non-ASCII name), `Cache-Control: no-store`; 404 without sources, 405 for anything but GET/HEAD.
  Behind the access check of the view's API: in a session the page's identity (the dev cookie, or Access's JWT;
  none: 401) for every role; in the read-only Live View (`dt open --host`) the Host/Origin check only, like the view
  itself. The page fetches it, so that a failure is told in the menu, then saves it under the server's name.

### As built: joining over the internet with an invite link (the `link` identity mode)

- **Decided by the user**: collaborate over the internet without Cloudflare Access: a third identity mode, `link`
  (a shared invite link and the facilitator's approval of each join request), and `dt collab --tunnel` (a Cloudflare
  quick tunnel, no account). How to run it, what participants see, the security model and its limits:
  [docs/session-link.md](../session-link.md).
- **Config**: `collab.identity: "link"`; `collab.link.publicUrl` (an https origin, no path) for a self-managed tunnel
  or reverse proxy. `--tunnel` switches the identity to `link` (decided: it implies it rather than requiring it; refused
  with `identity: "access"`, `--port 0` or a non-loopback host) and uses the quick tunnel's URL as the public URL. The
  allowed host and origin are derived from the public URL, never configured apart. `collab.link` and `--tunnel` are in
  the start's approval (`collab --tunnel` as a key of its own, so that settings approved before keep their hash).
- **Collaboration**: the invite (`SessionAccess.issueInvite` / `checkInvite` / `liveInvite` / `revokeInvite`; a table of
  its own, migration 13, its code hashed in a domain of its own; one live per session; revoked with the server's
  links), revoking one identity's sign-ins (`signOutIdentity`), and the join requests (`createJoinRequests`, in the
  server's memory: pending, approved then admitted once, denied, expired after 10 minutes or with the invite; at most
  20 pending, 100 per invite, 5 per client key per 10 minutes). The protocol's `join.requests` message (to the
  facilitator's pages only) and the invite bodies.
- **Server** (`apps/dt/src/server/session/link-join.ts`): `/session/invite` (the name form, posted with the code; a
  request made, then a redirect to `/session/wait`), `/session/wait` (reloads itself with a meta refresh, no script;
  approved: signs in and goes to `/`; denied or expired: says so). Facilitator-only API: `POST /api/session/invite`,
  `POST /api/session/invite/revoke`, `GET /api/session/join-requests`, `POST /api/session/join-requests/:id/approve|deny`,
  `POST /api/session/participants/:id/remove`. The facilitator signs in with the facilitator link: not signed in, it
  asks for a name and signs in holding the role (the code checked first: nothing is signed in with a bad one). The
  cookies (`__Host-dt_link_<random>`, `__Host-dt_wait_<random>`): HttpOnly, Secure, SameSite=Strict, named per server.
  Every request answers the public host or loopback only; a change (any method but GET/HEAD) and the WebSocket's
  upgrade need the public origin (`AccessPolicy.requireOrigin`). The rate limit's client key reads `CF-Connecting-IP`
  only from loopback and only behind the quick tunnel this process started (`quickTunnel`). Every sign-in of the
  session ends when a link server starts and stops, and a sign-in of another mode is never accepted (after the
  security review of this branch). `server.json` records the public URL, so `dt collab link` and `dt collab invite`
  (`--stop`) print links on it; the server notices an invite changed there within seconds.
- **Tunnel** (`apps/dt/src/wiring/tunnel.ts`): `cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate`;
  the `https://<words>.trycloudflare.com` URL read from its output (never `api.trycloudflare.com`), then the first
  "Registered tunnel connection" waited for (10 s at most); clear errors when cloudflared is missing, exits first or
  gives no URL in 30 s. Stopped with the session, on Ctrl+C (after the server), when the server cannot start, and by
  an `exit` handler on any other end; SIGTERM, then SIGKILL after 3 s.
- **Page**: the facilitator's collab menu has 招待 (makes the link and copies it) and 招待を止める while one is live; a
  participant has no invite to copy. Each person waiting is one row in the chat's head (name, 許可, 拒否). The
  participant list offers removing someone who joined through the invite.
- **After the review of this branch** (2026-11-03): behind a proxy of one's own (no `--tunnel`) no per-client limit
  (clients cannot be told apart), only the pending and per-invite caps; IPv6 counted by its /64; a new invite resets
  the counts; the facilitator's page says when the invite is used up (`join.requests.inviteUsedUp`). The waiting page
  clears only its own cookie, and only when sent; stopping the invite turns away the approved not yet in. A session's
  Live View and API are `frame-ancestors 'none'` and `no-store`, but for the content-hashed files of the page. Names
  refuse format characters (Cf; an emoji's ZWJ allowed); a request whose name is a participant's (or a connected
  page's) or another request's is marked, and each shows when it was made. The quick tunnel starts once the server
  holds the port (`publicUrlAfterListen`), so `--port 0` works with `--tunnel`.
- **Checked for real** (2026-11-03, macOS, cloudflared from Homebrew, system Chrome through Playwright): `dt collab
  --tunnel --port 4530 --yes --no-agent` on a scratch copy of `examples/shop`; the facilitator link opened at the
  trycloudflare URL, an invite made from the menu, a second browser asked to join and was let in as a participant, a
  third was denied; `dt collab link` and `dt collab invite` printed links on the public URL; Ctrl+C left no
  cloudflared.

## Who may run the `/` commands in Collab (decided 2026-11-03)

- **Everyone may run every command**, participants included. There is still one running command of each kind per
  session.
- **Changing files is approved by the facilitator.**
  - Candidate commands (`/es:exceptions`, `/es:gaps`, `/es:levels`, `/es:names`): whoever started one, only the
    facilitator checks candidates and applies them, and applying is the approval. Everyone else sees the card
    read-only, as with a proposal's options.
  - Interviews (`/es:start`, `/model:start`): a participant who starts one answers its questions, choices included.
    The brief that writes `///` waits for the facilitator: 承認, 編集して承認 or 却下. Everyone sees the questions and
    the brief.
- **Answer commands** (`/hint`, `/es:recap`): anyone, and the answer is an ordinary AI message everyone sees.
- **The facilitator's own commands** go on without approval, as before.
