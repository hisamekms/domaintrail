# A first real run of a session

The tests run sessions with a fake agent in place of Claude Code. This page is for a person who runs one session with
the real Claude Code once, on a scratch copy of the example, before using sessions on their own model: the commands,
what to check, and what to record when something fails. What a session is, and every option, is in
[`dt guide session`](guide.md#collaboration-sessions); the same check behind Cloudflare Access is
[Running a session behind Cloudflare Access](session-access.md). To review the chat without Claude Code, a session filled
with every display pattern is one command away: [A seeded session for review](dev-session-seed.md).

## Before you start

- Node.js 22.13 or later (`node --version`), and a clone of the repository, built: `bun install` and `bun run build` at
  its root. Below, `dt` stands for `node <the clone>/dist/dt.js` (`alias dt="node $PWD/dist/dt.js"` at the clone's
  root), so that the version under test is the one that runs.
- Claude Code on the `PATH`, signed in (`claude --version`; the adapter was written against 2.1.314). `claude --help`
  must list `--setting-sources`, `--strict-mcp-config`, `--tools`, `--allowedTools` and the `dontAsk` permission mode.
- **Your user settings.** The agent runs with `--setting-sources user`: the workspace's `.claude/` settings are not
  loaded, but `~/.claude/settings.json` is. Read it (`cat ~/.claude/settings.json`) and check that its
  `permissions.allow` rules, its `hooks` and any `apiKeyHelper` give a run nothing more than the session's tools
  (reading and editing files, `dt fmt`, `dt check`). If in doubt, move it aside for the check and put it back after.

## A scratch copy of the example

Copy `examples/shop` without its `.domaintrail` directory (the layout cache, and maybe an older session), and commit
it, so that `git diff` shows what the agent changed:

```bash
mkdir -p /tmp/dt-session && rsync -a --exclude .domaintrail --exclude generated examples/shop/ /tmp/dt-session/
cd /tmp/dt-session && git init -q && git add -A && git commit -qm 'before the session'
```

## The run

1. **Start the session** (terminal 1): `dt -r /tmp/dt-session session start`. It prints `Session: … (started, identity
   dev)`, the Live View's URL (`http://127.0.0.1:4321/`), a facilitator link and the agent API's address.
2. **Become the facilitator**: open the Live View in your browser, give a name on the join form (*Ada*), then open the
   facilitator link. The chat opens at the right end; its participants (the collab menu in its head, the avatars ▾) list you once, as
   *Facilitator*.
3. **A second participant**: a private window, the same URL, another name (*Bob*). Each lists the other.
4. **Start the agent** (terminal 2): `dt -r /tmp/dt-session session subscribe --agent claude --once`. It prints
   `Subscribed to session …; waiting for runs.`
5. **Messages** (as Bob): in the Event Storming view, pick the storming `Returns`, one timeline and Design Level, select
   an event's note, write a message about the selection (e.g. "Add an event for a return the customer cancels") and
   send it, then a second about the whole workspace. Both appear in everyone's chat, the first with its occurrence
   (the timeline and the step).
6. **A run** (as Ada): Shift-click both messages and まとめて送る (or the AI に送る button on one). The run's card appears; terminal 2
   logs its progress; within a few minutes the card is *done* (or asks questions — choose and 答えて再実行 — or is
   *declined* with its reason, or *failed* with its report). Both pages show the storming as the agent left it, without
   a reload. The agent runs `dt fmt` / `dt check` itself through the `dt` the subscriber puts on its `PATH`.
7. **Check the files**: `git -C /tmp/dt-session status --short` lists only `.dt` and `.dtes` files, and
   `git -C /tmp/dt-session diff` is what the requests asked for. `--once` has ended the subscriber.
8. **Revisions** (as Ada): the card's ⋯ → 比較 compares the run's revisions (the diff matches `git diff`);
   ⋯ → 実行前に戻す… restores the workspace as before the run: both pages show the model as it was, and
   `git -C /tmp/dt-session diff` is empty.
9. **Stop**: Ctrl+C in terminal 1 (the session stays open and is resumed by the next `dt session start`). To end it,
   as Ada, the collab menu → コラボを終える… → 終える — every page shows the summary, コラボを終えました. Then remove `/tmp/dt-session`.

**Developing DomainTrail itself?** Point the agent's `dt` at your clone in the workspace's `domaintrail.jsonc`, outside
the workspace: `"session": { "agent": { "dt": ["node", "../domaintrail/dist/dt.js"] } }` (or `["bun",
"../domaintrail/bin/dt.ts"]`). It is read when `dt session subscribe` starts; restart the subscriber after changing
it, and after rebuilding the clone (a changed script stops the next run).

If terminal 2 logs `not claiming further runs: review …`, the agent changed a file other than a `.dt` or `.dtes`
source: look at those files (`git -C /tmp/dt-session status`), in particular anything under `.claude/`, before you
start the subscriber again.

## When something fails

Record, without tokens, cookies or the facilitator link's code: the step and what you saw; the clone's commit (`git rev-parse --short HEAD`), `claude
--version`, `node --version` and the OS; the output of both terminals around that time (they print no token, no
prompt and no request text); the run's state, failure reason and report in its card (exit code, formatted, checked,
new `.dt` errors, `.dtes` not parsed); and `git -C /tmp/dt-session status --short`.
