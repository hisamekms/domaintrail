# ADR 0030: Modes (`dt open` / `dt collab` / `dt agent`), messages addressed to the AI, triage and a warm agent

- Status: accepted (2026-11-03), being implemented: M2–M4 landed; tasks M5–M7 of [the plan](../plans/modes.md). Every decision below
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

### 9. The model as built (M2)

*Proposed* (M2, where the plan left the detail open; see the plan's "As built in M2"): a Solo session refuses other
participants; the facilitator's re-address of a "neither" is a triage step of its own stage (`Facilitator`); a triage
records where it went (an answer, a proposal or a run) once; the approved proposals are an optional group of the run's
input; `dt fmt` / `dt check` report `Ran`, `Failed` or `Skipped`, and stored rows of the former shape are read in the new
one rather than rewritten.

### 10. The triage and the answers as built (M4)

*Proposed* (M4, where the plan left the detail open; see the plan's "As built in M4"): the answers entry point holds
what it handed out in memory (a job per answerer, withdrawn after its timeout; a failed stage 3 is a 相談, a failed
answer or proposal is tried twice and then left until the server starts again); a participant's page gets the triages'
outcomes without the stages, also in the events; Clef asks three questions in one call; the answerer and the triage
model are reached through Claude Code only, the triage cold by default, the answers warm with one schema for answers and
proposals; the session so far is given whole and since the last entry the same process saw (the runner asks for it at
the start, the server tracks it per answer stream); `dt fmt` and `dt check` are skipped when a run changed no file.

*Decided by the maintainer* (2026-11-03, after a security review of M4): the agents may read any file inside the
workspace's root — not only the model — and nothing outside it, never `.domaintrail/` (our credential and session data,
our responsibility) nor `.git/`, and no file `.gitignore` ignores; keeping secrets out of the repository is the user's
responsibility. *Proposed* (how): `claude` loads no settings file, so that the user's allow rules cannot widen what it
reads, and in `dontAsk` mode it then reads only inside its working directory (measured with Claude Code 2.1.317), with
deny rules for `.domaintrail/` and `.git/`. Claude Code's rules cannot express "not ignored by git", so the answerer
(whose input is any participant's message, without the facilitator) works in a private **view** of the workspace — a
copy of the readable files only, refreshed before each turn — rather than with rules over the workspace: nothing it
should not read exists where it can read. The runner must edit the workspace, so it works there, with the ignored
entries present at its start as deny rules. The server refuses an output that contains the agent API's credential.
*Residual risk*: the runner's deny list is computed when a run starts (a file ignored and created during the run is not
in it) and capped at 500 entries; Claude Code's rule matching is best effort for `Grep`/`Glob` (measured to hold for
these paths); a secret the user keeps in a file git does not ignore is readable by design; and the user's hooks and
`apiKeyHelper` no longer run for the agents.

*As built in M4b* (a second security review): which files are readable is asked of **git itself** where it speaks for
the root — the view is built from the allowlist `git ls-files -co --exclude-standard` and the runner's deny list from
`git ls-files -o -i --exclude-standard --directory` — so every source of ignores applies as in git, the user's
`core.excludesFile` (by default `~/.config/git/ignore`) and `.git/info/exclude` included; a failing git inside a
repository is an error, never a fallback. Where git does not speak for the root (no repository, or a root its
repository ignores: to git all of it is ignored), the tree is walked with `GitIgnore` plus the user's excludes file.
`.git` (a directory, or a submodule's or worktree's file) and `.domaintrail` are kept out at any depth: never in the
view, and denied by `Read`/`Edit` rules of `**/.git/**`, `**/.git`, `**/.domaintrail/**` and `**/.domaintrail`
(measured with Claude Code 2.1.317: refused for nested paths, and only because of these rules). A file is copied into
the view only when no directory above it is a link, and is opened without following one. Checked once with Claude Code
2.1.317: a globally ignored file, a `.git/info/exclude` entry, a nested `.git/config`, a submodule's `.git` file and a
nested `.domaintrail/` are unreadable for the answerer and the runner; a README is readable. *Residual risk* besides
the above: the runner's deny list stays capped at 500 entries (no sound uncapped form: a deny rule cannot be negated
by an allow rule, so "deny all but git's list" cannot be said); the files of an untracked nested repository or a
submodule are left out of the view, but the runner can read them, and their own ignores are not applied; Claude Code's
own `git status` at a session's start shows the runner the names (not the contents) of untracked files.

*As built after M4b* (a review of M4b): on a case-insensitive file system (macOS by default) `.GIT/config` opens
`.git/config`, so `.git`, `.domaintrail` (and, for the view, `node_modules`) are recognised in any case and Unicode
form (NFC, lower case) in git's lists and in the walks, and the view copies a listed file only when each name of its
path is one `readdir` returns as is (the case comes from the file system, never from git's index). Claude Code's deny
rules already hold for case variants on such a file system (measured with Claude Code 2.1.317 on macOS: `.GIT/x`,
`.DomainTrail/x`, `.ENV` against a `.env` rule and `SUB/.env` against a `sub` rule were refused), so no rule is added
for them. Nested repositories and submodules are denied to the runner **as a whole** — the gitlinks of the index (`git
ls-files --stage`, mode 160000) and the untracked repositories git does not descend into (`git ls-files -o
--exclude-standard`, a trailing `/`), first in the deny list; when git does not speak for the root, every directory
holding a `.git` — since git applies none of their own ignores for the root's repository (a submodule's `.env` would
otherwise be readable). They were already out of the view (git lists none of their files; the walk no longer descends
into them). This replaces the residual risk above that the runner can read their files; a directory with a `.git` that
is no valid repository is, to git, part of the root's and is treated as such.
A second look settled two more points. The runner's deny list **fails closed**: more than 500 entries (nested
repositories first, then git's ignored entries, in git's order) refuse the run — it fails with a reason of its own,
`ReadScopeTooLarge` (a value of the run's `FailureReason`, passed through `POST /agent/runs/:id/fail`), which the page
shows as it shows any failure reason, saying to ignore whole directories; the agent's log adds to move nested
repositories out — instead of running with the rest unprotected (this replaces the cap of the residual risk above); a
gitlink whose directory is absent is not listed.
And only the exact `.git` and `.domaintrail` are left out of the deny list (the static rules cover them); a case
variant (`.GIT/x`, `sub/.DomainTrail`) keeps a rule of its own rather than rely on the matcher's case handling, while
what goes into the answerer's view still leaves out every case variant.

### 11. The CLI and the config as built (M5)

*Proposed* (M5; see the plan's "As built in M5"): `dt open`'s one person is bound to a secret only the launching user
holds — it prints a one-time link (60 minutes, accepted on its own page only, not a facilitator link) that signs the
browser opening it in with a cookie named per server start, HttpOnly, SameSite=Strict, without Max-Age, whose value
only that server instance knows (in memory; revoked when it stops or the session leaves Solo); a request without it is
not identified, so another local process or OS user is not the facilitator, and the cookie is worth nothing to another
server on the same host. `dt open` answers loopback Hosts and Origins only, never `collab.access`'s. Its identities fail
closed once the session is no longer Solo, and a workspace has one live session server (`server.json`, its process
alive): another `dt open` / `dt collab` refuses to start rather than open or change the session under it.
The agent API's credential is never written to disk (decided by the maintainer, 2026-11-03): the agent in process gets
it in memory; a standalone `dt agent` exchanges a one-time pairing code (`dt collab agent-link` / `dt open agent-link`:
single use, 10 minutes, its own kind, revoked when the server stops) for it and keeps it in memory. `agent.json` is
removed when found; `.domaintrail/` gets a `.gitignore` (`*`).
`dt open link` (decided by the maintainer at the merge of M4 and M5) prints another sign-in link for the running
`dt open` server under the same rules (single use, 60 minutes, the same cookie, all revoked when the server stops);
being issued by another process, its code is kept as a hash in the session's database in a hash domain of its own,
never accepted as a facilitator link or an agent code. It refuses a `dt collab` server; a Solo session continued by
`dt collab` is held through the facilitator link only.

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
