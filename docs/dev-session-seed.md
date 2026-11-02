# A seeded session for review

For people developing DomainTrail: `bun run session:seed` starts a collaboration session already filled with the
chat's display patterns — messages, runs in every state, questions, assumptions, replies, reactions, element
references, reverts — so that the Live View's chat can be reviewed without writing them by hand or running Claude Code. Each
session is a new scratch copy of [examples/shop](../examples/shop/README.md); nothing is mocked but the agent (and,
optionally, the message classifier). For a session with the real Claude Code, see
[A first real run of a session](session-first-run.md).

## Running it

Build first (`bun install`, `bun run build`): the seed starts the built CLI (`node dist/dt.js`). Then:

```bash
bun run session:seed                                   # every scenario, on http://127.0.0.1:4321/
bun run session:seed --scenario questions --port 4331  # one scenario
bun run session:seed --scenario chat,replies --dir /tmp/dt-seed-2 --reset
```

| Option | |
| --- | --- |
| `--scenario <names>` | `chat`, `runs`, `questions`, `assumptions`, `replies`, `reactions`, `references`, `revert`, or `all` (default); repeatable or a comma list. `all` plays them in that order into one timeline. |
| `--dir <dir>` | The scratch workspace it makes (default `$TMPDIR/dt-session-seed`). A directory that is not empty is refused. |
| `--reset` | Wipes `--dir` first, when an earlier seed made it (it has a `.dt-session-seed` file) and no session server runs on it. |
| `--workspace <dir>` | The workspace copied (default `examples/shop`; the scenarios name its elements). |
| `--port <port>` | The Live View's port (default 4321). |
| `--no-classifier` | Leaves the message classifier off: every message has the AI に送る button. |
| `--leave-queued` | Leaves one run queued at the end; the next subscriber takes it. |
| `--leave-running` | Leaves one run running at the end, held by the seed's agent, and two queued behind it (AI の作業's 実行中 and 待ち). Not with `--leave-queued`. |
| `--exit` | Stops the session server once seeded instead of leaving it running. |

The seed copies the workspace (without `.domaintrail/` and `generated/`), commits it to a git repository of its own
(`git -C <dir> diff` shows what the runs changed), starts `dt session start`, signs in five people — `ooyama_F`, made
the facilitator with the start's link, and 佐藤, 鈴木, 田中, 高橋 — and plays the scenarios through the session's REST
API, as the pages do. The runs are taken by the real subscriber of `dt session subscribe`, with a scripted runner in
place of Claude Code: it edits the workspace's `.dt` and `.dtes` files for real, `dt fmt` and `dt check` run, and the
server records the revisions. Once the scenarios are done the seed's agent is stopped: it holds no run.

It then prints the Live View's URL, a fresh facilitator link and how to join, and leaves the session server running
until Ctrl+C. The session stays in the directory: `dt -r <dir> session start` resumes it (without the classifier's
tags, see below).

## Looking at it

- **As the facilitator**: open the Live View, join with any name, then open the printed facilitator link (single use,
  10 minutes; `node dist/dt.js -r <dir> session link` prints another). You then hold the role `ooyama_F` held: the
  facilitator's messages and reactions show as 「あなた」, and the AI に送る buttons and the menus are yours.
- **As a participant**: a private window, the same URL, another name. Your browser is a new participant, so none of the
  seeded messages are yours; the seeded people's cookies (`dt_session`) are in `<dir>/.domaintrail/seed.json`, for a
  browser (or a test) that should be one of them.
- **With the real agent**: `node dist/dt.js -r <dir> session subscribe --agent claude` takes the runs queued from then
  on (and the one `--leave-queued` left).

## What the scenarios show

- `chat`: consecutive messages by one person, the facilitator's own messages, targets of each kind (a `.dt` element, a
  state, a command, a storming element, an occurrence) and the whole workspace (no target chips), `#name[n]` mentions
  (and one `@name[n]`, as bodies were written before), people mentioned (`@name[pN]`: two in one message, the
  facilitator in the long one, an element and two people together — sign in as 田中 or 鈴木 to see them marked), a long message
  (clamped), messages read as a request, as talk (no AI に送る button) and not classified, applied marks, and two targets a run then renames and removes (stale).
Every scripted reply gives a title (the card's name), as Claude Code's does, except the first card of `runs`, whose
two replies have none, like replies from before titles: it shows the fallback (its first message). A run continuing a
card gives a title of its own that the card does not take.

- `runs`: completed with changes and then applied again with a note (one card), completed without changes, failed
  (the agent exits 1, with its report; the agent cannot run), declined with its reason, cancelled while running, and
  one run of three messages with a status line each (done, partly, skipped).
- `questions`: a single-choice and a multiple-choice question with votes open, two questions (one without options), an
  answered one (an option, and その他 in the facilitator's words) whose run completes the card, and one taken over by a
  run with a note (its votes frozen).
- `assumptions`: an assumption with alternatives and votes open (for an alternative and for keeping it) beside one the
  facilitator approved (`承認 name · time`, nothing sent to the AI), an alternative picked (`送り直し name · time`, the
  time a link to the run that redoes it), and assumptions left as they were (the message applied again).
- `replies`: two replies to a completed run applied together (their run continues the card), a reply to that run, and
  replies to people's messages: one to 田中's message (sign in as 田中 to see it marked) and a reply to that reply, with a
  target.
- `reactions`: one emoji by many (the facilitator's among them), reactions on an AI turn, and 19 different emoji on one
  message (the limit is 20).
- `references`: `@{…}` in a summary, a note, an assumption, a question and its options — `.dt` elements, states,
  commands, storming elements, ones that do not resolve, and `\@{` written as text.
- `revert` (in `stormings/order-to-cash.dtes`, which no other scenario edits): 再請求のイベント (with an assumption) and a
  later unit adding a read model elsewhere in the file; the first is reverted mechanically by the server — a 打ち消し
  card, its assumption 打ち消し済み, `git diff` showing only the later read model. Then 支払の督促 (with an assumption), a
  later unit renaming the event it added, and its revert, which conflicts and is left to the seed's agent: an AI card
  that reverts it. To try both paths yourself, ⋯ → この作業を打ち消す… on any card that changed files; edit by hand the
  lines a unit added first to make its revert conflict (it then waits for an agent, its card saying why: stop it, or run
  a subscriber). With `--leave-running`, a revert asked now waits behind the running run (待ち), and the server reverts
  it once the runs ahead of it end.

Not produced by default: a run left **running** and runs **queued**. `--leave-running` leaves both: once the scenarios
are done, 田中's message runs and the seed's agent keeps working on it (holding its lease) while the seed runs — telling
what it is doing every 3 seconds, round and round (reading `stormings/returns.dtes`, editing it, `dt check`, …), so the
running turn's activity line changes — and two
runs wait behind it — 佐藤's message, then 鈴木's and 高橋's together. Stopping the running one (✕, then 実行を中止 in the dialog) starts the next,
which the agent holds the same way. Without it the agent is stopped (stopped, a lease expires and the run fails);
`--leave-queued` leaves one run queued for a real subscriber started later. The questions left open by `questions`
show in AI の作業 as 答え待ち.

## The classifier

Telling talk from requests (a message read as talk has no AI に送る button in its row, only in its … menu) needs
the message classifier (`session.classifier`). The seed enables it in the scratch config
with a placeholder account and serves a stand-in for Cloudflare's API itself (`DOMAINTRAIL_CLASSIFIER_URL`): each
seeded message reads as the scenario says, and a message typed later reads as a request when it asks for a change
(して, 追加, 削除, …). No message leaves the machine. The stand-in lives in the seed's process, so a session server
started again without the seed classifies nothing (`DT_SEED_CLASSIFIER_TOKEN` is not set): every message is then
applicable, as with the classifier off.

## The smoke test

`test/session-seed.test.ts` seeds `reactions` on a free port against `dist/dt.js` and checks the messages, runs and
marks; it runs with `bun test` after `bun run build`.
