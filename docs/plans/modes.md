# Plan: open / collab / agent modes, consultation and a warm agent

Today the Live View (`dt view`) and the collaboration session (`dt session start`) are two separate commands, and the AI
runs only in a session, started by hand in another terminal (`dt session subscribe --agent claude`). One person who
wants to talk to the AI about their own model has to run a session for one, join it, claim the facilitator link, send a
message and then send it again with 「AI に送る」. Every run starts Claude Code anew. This plan:

- splits the product into two modes, **non-collab** (`dt open`) and **collab** (`dt collab`), with the AI runner as
  its own command (`dt agent`), started in the same process by default;
- lets a message be a **consultation** (a question answered in the chat, no file changed) as well as a change request,
  with **no** marking by the person: the AI decides inside the run;
- keeps one Claude Code conversation alive per agent (a **warm agent**), after measuring where a run's time goes.

It records the decisions taken by the maintainer on 2026-11-03, the measurements, the design, the collisions with the
work in flight (`feat/react-flow`, `feat/collab-card`), a task breakdown, and the open questions with recommendations.

## Landing

- Starts on `main` after `feat/collab-card` and `feat/react-flow` are merged (see [Collisions](#collisions)); the CLI
  and agent tasks (M3, M4) may start earlier, as they touch neither.
- As for the earlier plans: one integration branch (`feat/modes`) from `main`, one worktree and branch per task, each
  done by a worker and merged into the integration branch after review, one pull request to `main`, squash merged.
- The decisions that change ADR 0026 (collaboration sessions) are written down in a new ADR first (M1): **ADR 0030,
  modes and the warm agent** (0029 is taken by `feat/react-flow`).
- The old commands stay one version as deprecated aliases (the package is published on npm); the release that adds
  `dt open` / `dt collab` / `dt agent` lists them as deprecated in the changelog, the next one removes them.
- Every task leaves typecheck, lint, fmt, tests and build passing.

## Decisions (maintainer, 2026-11-03)

| # | Point | Decision |
|---|---|---|
| 1 | Modes | Two: **non-collab** and **collab**. Commands from zero (plan A): `dt open`, `dt collab` (+ `dt collab link`), `dt agent` |
| 2 | `dt open` | The Live View with the chat, for one person: loopback only, dev identity, no invite, hand-over or leave. Absorbs `dt view` |
| 3 | `dt collab` | Today's `dt session start`, Access mode included; `dt collab link` is today's `dt session link` |
| 4 | `dt agent` | The AI runner alone (today's `dt session subscribe`): on another machine or terminal, or added later |
| 5 | Agent in process | `dt open` and `dt collab` start the agent **in the same process by default** when Claude Code is usable; `--no-agent` does not start it. With no agent connected the page says so (AI: 接続なし / n 件待ち) |
| 6 | Old commands | `dt view`, `dt session start\|link\|subscribe` stay one version as deprecated aliases with a warning, removed in the next |
| 7 | Non-collab send | A sent message goes straight to the AI (one step) when an agent is connected; with no agent it is a memo (no answer); a memo can be sent later with 「AI に送る」 once an agent is connected |
| 8 | Collab send | Unchanged (the facilitator's 「AI に送る」); with no agent the runs queue and the chat header shows 「AI 接続なし（n 件待ち）」 |
| 9 | Consultation | Both modes. A message can be a 相談 (a question; no file change) besides a 依頼 (a change request). **The person gives no special instruction** — no choice at send time, no prefix: every message goes through the same run, the prompt tells the agent a message may be either, and when unsure to ask or answer rather than edit. A run that changed nothing completes as an answer (result = base, no new revision), shown as a reply, not as a 変更なし work item. `dt fmt` / `dt check` are skipped when no file changed |
| 10 | Latency | Receiving runs is already push (the agent API's SSE `/agent/events`): polling vs WebSocket is not the issue. Plan a **warm agent**: one long-lived Claude Code conversation per agent, each run one turn |

Decision 9 replaced an earlier idea of read-only tools for a consultation chosen at send time: since the person does
not say which a message is, a run cannot be given read-only tools up front. See [The trade-off](#the-trade-off-no-hard-read-only-guarantee).

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
- Not touched by this plan but the biggest lever: the model and effort the user's settings choose (see
  [Open questions](#open-questions)).

## Commands, flags and config

### Commands

| Command | What it does | Replaces |
|---|---|---|
| `dt open [--port] [--base <ref>] [--no-agent] [--agent claude]` | Live View with the chat, one person, loopback, dev identity; starts the agent in process | `dt view` |
| `dt collab [--port] [--host] [--base <ref>] [--no-agent] [--agent claude]` | Collaboration session (dev or Access identity), agent in process | `dt session start` |
| `dt collab link` | Another one-time facilitator link | `dt session link` |
| `dt agent [--agent claude] [--once]` | The AI runner alone, against the server running on the workspace (`agent.json`) | `dt session subscribe` |

- `--agent claude` stays the only agent and the default; it is accepted so that later agents fit.
- "Claude Code is usable" (decision 5): `claude` is on the `PATH`, `claude --version` answers within 5 s, and
  `claude --help` lists the flags the adapter needs (`--setting-sources`, `--strict-mcp-config`, `--tools`,
  `--allowedTools`, `--input-format`, `dontAsk`). Otherwise `dt open` / `dt collab` start without the agent and print one
  line why (`AI: not started (claude not found on PATH); start it later with dt agent`). `--agent claude` given
  explicitly turns that into an error.
- The agent in process is the same subscriber as `dt agent`, talking to the agent API over loopback HTTP with the
  credential of `agent.json` (one code path; the measured protocol cost is ~30 ms a run). It stops with the server
  (Ctrl+C fails its run as `Interrupted`, as today).
- A second agent (`dt agent` while the in-process one runs) is allowed: claims are leases, one run at a time per
  agent. The page shows how many are connected.
- `dt open --host <non-loopback>` serves the Live View **read-only** (no chat, no agent), as `dt view --host` does
  today, with a line saying so: the chat and the agent are loopback-only in non-collab mode.

### Deprecated aliases

`dt view …` runs `dt open --no-agent …` without the chat being forced on (see open question Q3), `dt session start` runs
`dt collab`, `dt session link` runs `dt collab link`, `dt session subscribe` runs `dt agent`; each prints
`warning: 'dt session start' is deprecated and will be removed in the next release; use 'dt collab'` on stderr first.
The help lists them under "Deprecated". `dt session start` keeps **not** starting an agent in process (`--no-agent`
implied), so that a user who runs `dt session subscribe` beside it does not get two agents.

### Config (`domaintrail.jsonc`)

| Key | Used by | Note |
|---|---|---|
| `view.port`, `view.host` | `dt open` (and `dt view`) | Kept as is: it is the Live View's address in non-collab mode. A non-loopback `view.host` makes `dt open` read-only, as above |
| `session.port`, `session.host`, `session.identity`, `session.access.*`, `session.maxParticipants`, `session.quickReactions`, `session.classifier` | `dt collab` | Kept as is |
| `session.agent.allowedTools`, `session.agent.dt`, `session.agent.port`, `session.agent.maxPreviousRunDiff` | both modes, `dt agent` | Kept; they configure the agent whichever mode runs it |
| `session.agent.warm` (new) | the agent | `true` (default) / `false`: one long-lived Claude Code process, or one per run (today's) |
| `session.agent.restartAfter` (new) | the agent | Runs before the warm process is replaced by a fresh one (default 20; see [Context growth](#context-growth)) |
| `session.agent.model`, `session.agent.effort` (new, optional) | the agent | Passed as `--model` / `--effort` when given; unset keeps the user's settings (Q5) |

Renaming `session` to `collab` in the file is not part of this plan (it would break every config file for a name);
open question Q4.

### State in `.domaintrail/` per mode

- Both modes keep their state in `.domaintrail/session/` (`session.db`, `blobs/`, `agent.json`, `server.json`), one
  session per workspace, as today. **`dt open` keeps the chat history and the revisions across restarts**: the person
  sees yesterday's answers and can still restore the workspace before a run. A session records the mode it was started
  in (`Solo` / `Collab`; a new field on the session, default `Collab` for the existing ones).
- `dt open` on a workspace with an open **Collab** session refuses with a line naming both ways out (`dt collab` to
  resume it, or end it from its collab menu); `dt collab` on an open **Solo** session continues it as a collab session
  (the solo person is its facilitator; its history stays). Q2 asks the maintainer.
- `dt open` signs the local person in without a form: one participant, the facilitator, named from `git config
  user.name` or the OS user (changeable in the page). No facilitator link is printed.
- `dt view`'s users get a `.domaintrail/session/` directory they did not have (it ignores itself through its own
  `.gitignore`, as today).

## The page

- **Mode**: the state body carries `mode: 'solo' | 'collab'`. In solo the collab menu, invite, hand-over, leave,
  participants and reactions-of-others are hidden; the chat is the person and the AI.
- **Agent status**: the server counts the open `/agent/events` streams (an agent connected) and the queued runs; the
  state body carries `agent: { connected: number; queued: number }` and a WebSocket message updates it. The chat header
  shows 「AI: 接続済み」, 「AI: 接続なし」 or 「AI 接続なし（n 件待ち）」; in collab the facilitator's 「AI に送る」 stays
  enabled without an agent (the run queues).
- **One-step send (solo)**: with an agent connected, the composer's send creates the message and queues its run in
  one call (`POST /api/session/requests` with `run: true`, allowed in solo only, for the facilitator); with none, the
  message is sent as a **memo** (no run; the row shows 「メモ」 and an 「AI に送る」 button that is enabled once an agent
  connects). Several memos can be sent together (まとめて送る), as today.
- **Answers**: a completed run that changed no file and carries an `answer` (or whose requests are all `answered`) is
  drawn as the AI's reply bubble under the message — the answer as text, no revision card, no 比較 / 実行前に戻す, no
  「変更なし」. A run that both answered and changed files is drawn as today's work card with the answer in it.
- **Collab**: unchanged otherwise; the classifier's tags (if enabled) keep deciding only whether a row offers the
  facilitator 「AI に送る」.

## Consultation

### The run

Every message goes through the same run, with the same tools (`session.agent.allowedTools`) and the same success rule.
What changes:

- **Prompt.** The intro says the participants' messages are change requests **or questions about the model**. New
  rules: a request that asks a question, asks for an opinion or an explanation, or does not clearly ask for a change is
  a consultation: read what it needs, answer it in `answer`, change no file, and mark it `answered`. When unsure whether
  a message asks for a change, answer it (and say what you would change) or ask (`clarification`) — never edit on a
  guess. A run may carry both kinds; each request is handled as what it is. Rule 5's "optional: they are run after you
  finish anyway" becomes "do not run them unless you need their output to fix your edit" (the measured runs ran them
  0.6–0.9 s each for nothing).
- **Reply.** A new optional `answer` (plain text with the reply's `@{…}` element references, up to
  `REPLY_LIMITS.answer` = 2000 characters, line breaks kept) and a request status `answered`. `summary` stays the 1–2
  sentence summary (it is what `previousRuns` show later). The JSON schema follows `REPLY_LIMITS` as today.
- **Subscriber.** When the scan after the agent finds **no changed file**, `dt fmt` and `dt check` are not run (today
  they are: measured, run 3), and the finish says so: `formatted` / `checked` become `'ran' | 'failed' | 'skipped'`
  (old servers' booleans read as `ran` / `failed`). Saves ~0.45 s on an answer.
- **Server and model.** The success rule becomes: exit 0, no new `.dt` error, every `.dtes` parses, and — **when the
  run changed files** — `dt fmt` and `dt check` ran. A run that changed nothing completes with result = base and no
  revision, as it already does today. `contexts/collaboration/model/agent-run.dt` (`formatted: Bool`, the invariant
  `succeeded`, the `RuleNotMet` invariant) and `domain/validation.ts`'s `succeeded` change together; the generated code
  is regenerated.
- **Model choice.** The same as a change run (one warm process). A cheaper model for consultations would need the
  run's kind up front, which decision 9 rules out.

### The trade-off: no hard read-only guarantee

A question is answered by an agent that could edit files. The mitigations, in order:

1. **The prompt**: rules that make answering, not editing, the default when a message is not clearly a change request.
2. **The changes are visible**: every run that changed a file shows the change (its card, 比較, the files), whichever
   way the agent read the message, and a run whose request is `answered` but which changed files is flagged on its
   card (「質問への回答ですが、ファイルを変更しました」).
3. **Undo**: 実行前に戻す restores the base revision (the base is taken before every run).
4. **The subscriber's existing guard**: any change outside `.dt` / `.dtes` sources fails the run and stops the agent.

A hard guarantee is possible only where the run's kind is known before it starts, e.g. a participant's question in
collab (Q1, option C): such a run gets `Read, Glob, Grep` only.

### The classifier (Cloudflare Clef, optional)

It no longer decides anything about consultation: the AI does. It keeps its one role in collab, the facilitator's
hint of which chat rows read as requests (the 「AI に送る」 button on requests and unknowns, as now). In solo it is
not called (every message goes to the AI anyway; a sent text would leave the machine for nothing). Its config stays
under `session.classifier`.

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
agent of the tests speaks the same protocol. If a later Claude Code breaks it, `session.agent.warm: false` is the
switch. Revisit the SDK if per-run permission changes become wanted (Q1 option C could use `setPermissionMode`/
`canUseTool` instead of a second process).

### Design

- **`AgentRunner` is unchanged**; a new adapter `createWarmClaudeRunner` implements it. The subscriber's pipeline does
  not change: base revision at start, scan before and after, outside-sources guard, the success rule, the finish.
- **One process per agent**, started on the first run (not at subscribe time: no idle process with no work), with the
  arguments of today's `claudeArguments` plus `--input-format stream-json`. `--json-schema` is fixed per process: it
  uses `replyJsonSchema(MAX_REQUESTS)` (the session's limit of requests per run), and `parseReply` keeps checking the
  numbers against the run's real count, as it does now. `--allowedTools` is fixed too: a change of the facilitator's
  tools (`GET /agent/session`) replaces the process.
- **A run is one turn**: the prompt (`buildPrompt`, unchanged but for the consultation rules and the note below) as one
  user message; the turn's `result` event is the run's result. The run's `onActivity` reads the turn's events as now.
- **What changed since the last turn**: the warm agent remembers file contents (measured: it skipped reading). Each
  turn's data gains `changedSinceYourLastRun: [paths]` — the subscriber compares the scan at this run's start with the
  scan at the previous run's end (files edited by a person, another agent, or a restore) — and rule 9 says to re-read
  them. The prompt already says "the current files are the truth".
- **Cancellation mid-turn**: the interrupt control request; if no `result` comes within 5 s, the process group is
  killed (today's path) and the next run starts a fresh process. A cancelled run's edits stay on disk as today; the
  server has already ended the run.
- **Crash**: the process exiting during a turn fails the run (`AgentError`, the exit code in the report); between
  runs it is noted and the next run starts a fresh one. No retry of the run.
- **Restart (a fresh process, no carried context)**: after `restartAfter` runs (default 20); when a turn's context
  (`usage` of the result: input + cache read + cache creation) passes 150k tokens; after a restore of a revision;
  after a run is declined (rule 7: the turn may have carried an attempt to break the rules, and it should not stay in
  the context); after the agent's `dt` or tools change; and after `session.closed`.
- **Context growth**: measured +10–15k tokens a run. Restarting is cheap (~1.3 s plus the files read again), so the
  plan restarts instead of compacting; `/compact` (measured to work) is kept as a later option.
- **Cross-run influence**: wanted for consultation — a follow-up question ("なぜ？", "それならどう変える？") reads in
  the context of the earlier answer even when the person did not reply to the run. In collab the context mixes
  several people's runs; the prompt's per-run data still says who asked what. `previousRuns` (the runs a message
  replies to) stay in the prompt: they are the record, the memory is a bonus and is lost on restart.
- **User settings**: `--setting-sources user` stays; the user's `Stop` and `PostToolUse` hooks now run once per turn
  instead of once per process (measured: the user's `Stop` hook reports an error notification on every turn here).
  `--bare` would skip them but also ignores OAuth sign-in, so it is not an option for signed-in users. The first-run
  page keeps its warning about `~/.claude/settings.json`.
- **What it saves**: ~1.3 s of process start and exit per run (~8 %), plus the files the agent need not read again:
  25 % over four runs measured. Plus ~0.45 s on an answer (no `dt fmt`/`dt check`), and 0.6–0.9 s on runs where the
  agent no longer runs `dt` itself.

## Collisions

- **`feat/collab-card`** (removes confirming a revision; the run card's undo): touches
  `contexts/collaboration/src/domain/commands.ts`, `application/use-cases.ts`, `model/revision.dt`, the generated
  `Collaboration.ts`, `protocol.ts`, `infrastructure/sqlite.ts` (a migration), `apps/dt/src/server/session/routes.ts`,
  and `apps/web/session/{card,chat,collab,collab-menu,revisions,state,stream,api}.ts(x)`, `apps/web/i18n.tsx`, ADR 0026,
  `docs/guide.md`, `docs/live-view.md`, `docs/session-first-run.md`. This plan's M2 (success rule, reply `answer`,
  session mode, agent presence, one-step send: the same domain, use-case, generated, migration and route files) and
  M5 (the chat and card) collide with it: **start M2 and M5 after it is merged**; the session migration number is
  taken after its migration.
- **`feat/react-flow`** (tldraw → React Flow): touches `apps/web/view/*`, `shapes.tsx`, `states-canvas.tsx`,
  `styles.css`, `theme.ts`, `bun.lock`, one comment in `protocol.ts`, ADRs 0001/0024/0026 and adds ADR 0029. M5 shares
  `styles.css` and maybe `app/App.tsx` (the chat's place): small; **start M5 after it is merged** too. The ADR of this
  plan is 0030.
- `scripts/session-seed` parses `dt session start`'s output and starts it: M4 keeps that output and moves the seed to
  `dt collab` (the alias would print a warning into the seed's log).

## Tasks

| Task | What | Depends on | Parallel with |
|---|---|---|---|
| M1 | ADR 0030 (modes, consultation, warm agent; amends ADR 0026's success rule and S6); `docs/guide.md` outline only | — | M3 |
| M2 | Collaboration: session `mode` (Solo/Collab, migration), reply `answer` + status `answered` (`REPLY_LIMITS.answer`, schema), success rule with `formatted`/`checked` as ran/failed/skipped (model `agent-run.dt`, `validation.ts`, regenerate), agent presence (count of `/agent/events` streams, `agent` in the state body, a WebSocket message), `POST /requests` with `run: true` in solo, protocol types | M1, `feat/collab-card` merged | M3 |
| M3 | Agent: the warm runner (`createWarmClaudeRunner`: stream-json input, interrupt, crash, restart rules, `changedSinceYourLastRun`), `session.agent.warm` / `restartAfter` / `model` / `effort`, the fake agent speaking stream-json input, the usability check of `claude` | M1 | M1, M2 |
| M4 | Agent + CLI: the consultation prompt rules and `dt`-in-the-agent rule; skip `dt fmt`/`dt check` when nothing changed; `dt open` / `dt collab` / `dt collab link` / `dt agent`, the in-process agent and `--no-agent`, the solo sign-in, the deprecated aliases with warnings, `dt open --host` read-only, the seed moved to `dt collab`; CLI and server tests | M2, M3 | M5 |
| M5 | Web: mode (solo hides the collab parts), the chat header's AI status, one-step send and memos, 「AI に送る」 on memos, answers as reply bubbles, the "answered but changed files" flag; i18n | M2, `feat/react-flow` and `feat/collab-card` merged | M4 |
| M6 | Docs: README, `docs/guide.md` (open/collab/agent, consultation), `docs/live-view.md`, `docs/session-first-run.md` (with `dt open`, the warm agent, the measured times), `docs/session-access.md`, changelogs (en/ja: the new commands, the deprecations) | M4, M5 | — |
| M7 | A real run again (`docs/session-first-run.md` with `dt open` and `dt collab`), with the measurement repeated warm: record the times next to this plan's | M6 | — |

M3 can start at once (it touches only `capabilities/agent`); M2 waits for `feat/collab-card`. The removal of the
deprecated aliases is a task of the following release, not of this plan.

## Open questions

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q1 | In collab, do participants' consultations go to the AI without the facilitator? | **A** No: only the facilitator sends to the AI, as today. **B** Yes: any participant can send their own message to the AI (the same run, the same tools) — but the AI may then edit files without the facilitator, since the AI decides what a message is. **C** Yes, read-only: a participant's 「AI に聞く」 starts a run with `Read, Glob, Grep` only (a hard guarantee, as its starter is known); the answer is shown to all, and a change it suggests is a message the facilitator can send. Needs a second warm process (or the SDK's per-turn permissions) and a per-participant limit | **A** now; **C** as a follow-up if facilitators ask for it. B undoes the facilitator's role |
| Q2 | `dt open` on a workspace whose session was started by `dt collab` (and the reverse)? | Refuse / continue / start a second store | `dt open` refuses on an open Collab session (end it or use `dt collab`); `dt collab` continues a Solo session, the solo person becoming the facilitator |
| Q3 | Does the `dt view` alias show the chat? | **a** `dt open --no-agent` (chat with memos) **b** the read-only Live View exactly as today | **b** for the deprecation release (no surprise for scripts, nothing written to `.domaintrail/session/`), with the warning pointing at `dt open` |
| Q4 | Rename the config section `session` to `collab`? | Keep / rename with the old name read for a version | Keep: it configures the agent in both modes too; the name is not wrong enough to break every file |
| Q5 | The agent runs on the model and effort of the user's `~/.claude/settings.json` (here Opus with effort medium): the model is 70–85 % of a run | Leave it / `session.agent.model` and `effort` optional / a default (e.g. Sonnet) | Add the optional keys (M3) and say in the first-run page that they are the biggest lever; no default of our own |
| Q6 | Warm by default? | Default on / opt-in | On, with `session.agent.warm: false` as the switch and the fall-back to cold runs when the warm process misbehaves |
| Q7 | Show the AI's answer to a consultation in solo also as a toast/notification when the chat pane is closed? | — | Not in this plan |
