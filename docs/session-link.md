# Collaborating over the internet with an invite link (`dt collab --tunnel`)

The `link` identity mode lets people join a `dt collab` session from anywhere, without Cloudflare Access or any
account: the facilitator shares an **invite link**, each person who opens it gives a name and **asks to join**, and the
facilitator **lets them in or not** from the page. The session is reached through a tunnel: a Cloudflare **quick
tunnel** that `dt collab --tunnel` starts by itself, or a tunnel or reverse proxy of your own. For a team that has
Cloudflare Access, the `access` mode ([docs/session-access.md](session-access.md)) is the stronger choice: everyone is
known by their identity provider before they reach the session.

## Running it

Install `cloudflared` (for example `brew install cloudflared`; [downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
No Cloudflare account is needed. Then, in the workspace:

```sh
dt collab --tunnel
```

1. Because the session is going on the internet, `dt collab` lists the security-relevant settings (with
   `collab --tunnel` among them) and asks before starting the first time; in a script, pass `--yes`.
2. `cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate` starts, and its address,
   `https://<words>.trycloudflare.com`, becomes the session's public URL. The server still listens on 127.0.0.1 only:
   the tunnel connects to it there.
3. `dt collab` prints the **facilitator link** and an **invite link**, both on the public URL. Open the facilitator
   link in your browser, give your name: you are the facilitator.
4. Share the invite link (a chat message, e-mail…). The collab menu's **招待** (Invite) makes a new one and copies it
   (the previous one stops working); **招待を止める** (Stop inviting) stops it. `dt collab invite` prints a new one from
   another terminal, `dt collab invite --stop` stops it.
5. Each person who asks shows in the chat's head of your page: their name, **許可** (Let in) and **拒否** (Deny).
6. When the session ends (the collab menu's コラボを終える, or Ctrl+C), cloudflared stops with it.

`--tunnel` switches the identity mode to `link` (it is refused with `identity: "access"`, with `--port 0` and with a
non-loopback `--host`). Ports, the agent and everything else are as for any `dt collab`.

### Your own tunnel or reverse proxy

Without `--tunnel`, set the identity mode and the https URL your tunnel serves the session at (ngrok, Tailscale
Funnel, cloudflared with your own hostname, a reverse proxy…), and route it to `http://127.0.0.1:<port>`:

```jsonc
{
  "collab": {
    "identity": "link",
    "link": { "publicUrl": "https://dt.example.com" }
  }
}
```

The URL must be https and have no path; its host and origin are then the only ones the server answers besides
loopback.

## What participants see

1. The invite link opens a short form: a name (the one they used last is offered).
2. Then a page that says **参加の許可を待っています** (Waiting to be let in), with their name; it reloads itself every
   few seconds.
3. Let in: the page becomes the session, as a participant. Denied: it says so. Nobody decided within 10 minutes (or
   the invite stopped): it says the request expired, and they can open the invite link again.

A participant leaves with the collab menu's 退出; the facilitator removes someone from the list of participants (the
icon on their row): their pages close and their sign-in ends. Hand the facilitator role over as in any collab
(ファシリテーターを引き継ぐ); a facilitator link opened by someone not signed in asks for a name and signs them in holding
the role.

## The security model

- **Anyone with the invite link can ask to join; only the facilitator lets people in.** The link is a secret, but a
  shared one: it may be forwarded. Look at each name before you let it in, and stop the invite once everyone is in.
- **The invite link** carries a random code of 256 bits; the server keeps only its hash. It works any number of times
  for 60 minutes, one at a time (a new one stops the previous one and expires the requests made through it), and dies
  with the server. It never appears in the server's log, and leaves the address bar after the form (a POST, then a
  redirect).
- **Join requests** are kept in the server's memory only: at most 20 pending at once, 100 through one invite, five per
  client per 10 minutes; each expires after 10 minutes or with its invite. The client is the socket's address; with
  `--tunnel` only, `CF-Connecting-IP` (set by the cloudflared this `dt` started; never trusted from anyone else).
  Names follow the join form's rules (one line, at most 60 characters) and are escaped wherever shown.
- **Cookies** are `__Host-` prefixed, `HttpOnly`, `Secure`, `SameSite=Strict`, named anew by each server; the session
  cookie lasts as long as the browser session, the waiting page's as long as the invite. Every sign-in of the session
  ends when a link server starts and when it stops (people are let in again; the facilitator opens the new facilitator
  link), and a sign-in of another identity mode is never accepted.
- **Every request and the WebSocket** must name the public host (or loopback) in `Host`; a request that changes
  something (any method but GET and HEAD) and the WebSocket must also carry the public URL's `Origin`. With the
  SameSite=Strict cookie, that is the protection against cross-site requests.
- **Facilitator only, on the server**: making and stopping the invite, listing, approving and denying requests,
  removing participants.
- **The approval at start**: `collab.identity`, `collab.link` and `--tunnel` are among the security-relevant settings,
  so switching to an internet-facing mode is asked for (`--yes` without a terminal).

### Its limits

- A quick tunnel is **public and temporary**: anyone who learns its address reaches the session's sign-in pages (not
  the model: everything else needs a sign-in). Cloudflare gives no uptime guarantee for quick tunnels; the address
  changes with every start.
- The invite link is as safe as where it is shared. A forwarded link lets a stranger ask; they get in only if the
  facilitator approves a name they did not expect.
- Nobody's identity is verified: a name is what the person typed. For verified identities, use the `access` mode.
- The AI reads any workspace file that `.gitignore` does not ignore and answers every participant: keep secrets out of
  the workspace (as for any collab).
- If this `dt` is killed with SIGKILL, it cannot stop cloudflared: stop it by hand (`pkill cloudflared`). Any other
  end (the session ends, Ctrl+C, an error, a crash) stops it.
