# A seeded session for review

For people developing DomainTrail: `bun run session:seed` starts a collaboration session already filled with the
chat's display patterns — messages, runs in every state, questions, assumptions, replies, reactions, element
references — so that the Live View's chat can be reviewed without writing them by hand or running Claude Code. Each
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
| `--scenario <names>` | `chat`, `runs`, `questions`, `assumptions`, `replies`, `reactions`, `references`, or `all` (default); repeatable or a comma list. `all` plays them in that order into one timeline. |
| `--dir <dir>` | The scratch workspace it makes (default `$TMPDIR/dt-session-seed`). A directory that is not empty is refused. |
| `--reset` | Wipes `--dir` first, when an earlier seed made it (it has a `.dt-session-seed` file) and no session server runs on it. |
| `--workspace <dir>` | The workspace copied (default `examples/shop`; the scenarios name its elements). |
| `--port <port>` | The Live View's port (default 4321). |
| `--no-classifier` | Leaves the message classifier off: no 依頼 / 会話 tags. |
| `--leave-queued` | Leaves one run queued at the end; the next subscriber takes it. |
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
  facilitator's messages and reactions show as 「あなた」, and the 依頼 / 会話 tags, the ⤓ and the menus are yours.
- **As a participant**: a private window, the same URL, another name. Your browser is a new participant, so none of the
  seeded messages are yours; the seeded people's cookies (`dt_session`) are in `<dir>/.domaintrail/seed.json`, for a
  browser (or a test) that should be one of them.
- **With the real agent**: `node dist/dt.js -r <dir> session subscribe --agent claude` takes the runs queued from then
  on (and the one `--leave-queued` left).

## What the scenarios show

- `chat`: consecutive messages by one person, the facilitator's own messages, targets of each kind (a `.dt` element, a
  state, a command, a storming element, an occurrence) and the whole workspace, `@name[n]` mentions, a long message
  (clamped), 依頼 / 会話 / no tag, applied marks, and two targets a run then renames and removes (stale).
- `runs`: completed with changes and then applied again with a note (one card), completed without changes, failed
  (the agent exits 1, with its report; the agent cannot run), declined with its reason, cancelled while running, and
  one run of three messages with a status line each (done, partly, skipped).
- `questions`: a single-choice and a multiple-choice question with votes open, two questions (one without options), an
  answered one (an option, and その他 in the facilitator's words) whose run completes the card, and one taken over by a
  run with a note (its votes frozen).
- `assumptions`: assumptions with alternatives and votes open (for an alternative and for keeping it), an alternative
  picked (→ #n, and the run that redoes it), and assumptions left as they were (the message applied again).
- `replies`: two replies to a completed run applied together (their run continues the card), and a reply to that run.
- `reactions`: one emoji by many (the facilitator's among them), reactions on an AI turn, and 19 different emoji on one
  message (the limit is 20).
- `references`: `@{…}` in a summary, a note, an assumption, a question and its options — `.dt` elements, states,
  commands, storming elements, ones that do not resolve, and `\@{` written as text.

Not produced: a run left **running** (the seed's agent would have to hold its lease; stopped, the lease expires and
the run fails), and a run **queued** unless `--leave-queued` (a real subscriber started later would take it).

## The classifier

The 依頼 / 会話 tags need the message classifier (`session.classifier`). The seed enables it in the scratch config
with a placeholder account and serves a stand-in for Cloudflare's API itself (`DOMAINTRAIL_CLASSIFIER_URL`): each
seeded message reads as the scenario says, and a message typed later reads as a request when it asks for a change
(して, 追加, 削除, …). No message leaves the machine. The stand-in lives in the seed's process, so a session server
started again without the seed classifies nothing (`DT_SEED_CLASSIFIER_TOKEN` is not set): every message is then
applicable, as with the classifier off.

## The smoke test

`test/session-seed.test.ts` seeds `reactions` on a free port against `dist/dt.js` and checks the messages, runs and
marks; it runs with `bun test` after `bun run build`.
