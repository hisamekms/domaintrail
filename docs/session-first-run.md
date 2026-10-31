# A first real run of a session

The tests run sessions with a fake agent in place of Claude Code. This page is for a person who runs one session with
the real Claude Code once, on a scratch copy of the example, before using sessions on their own model: the commands,
what to check, and what to record when something fails. What a session is, and every option, is in
[`dt guide session`](guide.md#collaboration-sessions); the same check behind Cloudflare Access is
[Running a session behind Cloudflare Access](session-access.md).

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
   facilitator link. The session panel (the people icon on the rail at the right edge) lists you once, as *Facilitator*.
3. **A second participant**: a private window, the same URL, another name (*Bob*). Each panel lists the other.
4. **Start the agent** (terminal 2): `dt -r /tmp/dt-session session subscribe --agent claude --once`. It prints
   `Subscribed to session …; waiting for runs.`
5. **Requests** (as Bob): in the Event Storming view, pick the storming `Returns`, one timeline and Design Level, select
   an event's note, write a draft about the selection (e.g. "Add an event for a return the customer cancels"), and a
   second draft about the whole workspace; select both and send them. Ada's panel lists both requests, the first with
   its occurrence (the timeline and the step).
6. **A run** (as Ada): include both requests, add a note if you like, and queue the run. Terminal 2 logs the run's
   progress; within a few minutes the run is *Completed* (or *Needs clarification* with the agent's question, or
   *Failed* with its report). Both pages show the storming as the agent left it, without a reload.
7. **Check the files**: `git -C /tmp/dt-session status --short` lists only `.dt` and `.dtes` files, and
   `git -C /tmp/dt-session diff` is what the requests asked for. `--once` has ended the subscriber.
8. **Revisions** (as Ada): the timeline has *Before a run* and *Run result*; compare the two (the diff matches `git
   diff`), mark the result as confirmed, then restore *Before a run*: both pages show the model as it was, and `git -C
   /tmp/dt-session diff` is empty.
9. **Stop**: Ctrl+C in terminal 1 (the session stays open and is resumed by the next `dt session start`). To end it,
   as Ada, in the browser console: `fetch('/api/session/close', { method: 'POST', headers: { 'content-type':
   'application/json' }, body: '{}' })` — every page closes. Then remove `/tmp/dt-session`.

If terminal 2 logs `not claiming further runs: review …`, the agent changed a file other than a `.dt` or `.dtes`
source: look at those files (`git -C /tmp/dt-session status`), in particular anything under `.claude/`, before you
start the subscriber again.

## When something fails

Record, without tokens, cookies or the facilitator link's code: the step and what you saw; the clone's commit (`git rev-parse --short HEAD`), `claude
--version`, `node --version` and the OS; the output of both terminals around that time (they print no token, no
prompt and no request text); the run's state, failure reason and report in the panel (exit code, formatted, checked,
new `.dt` errors, `.dtes` not parsed); and `git -C /tmp/dt-session status --short`.
