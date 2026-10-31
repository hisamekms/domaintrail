# Running a session behind Cloudflare Access: the end-to-end check

`dt session start` with `identity: "access"` verifies Cloudflare Access tokens itself (signature with the team's
keys, issuer, audience, expiry) and is tested against a local stand-in for Cloudflare
(`test/session-access.test.ts`). Whether it works with the real Cloudflare Tunnel and Access is checked by a person,
with this page. The decisions behind it are in [ADR 0026](adr/0026-collaboration-sessions.md#appendix-cloudflare-access-s8).

DomainTrail never creates, changes or deletes anything in Cloudflare: the tunnel and the Access application are yours.

## Prerequisites

- A Cloudflare account with Zero Trust, and its **team domain** (`<team>.cloudflareaccess.com`, in Zero Trust under
  Settings → Custom Pages, or the issuer of any Access token).
- A **Cloudflare Tunnel** (`cloudflared`) on the facilitator's machine, with a public hostname, for example
  `session.example.com`, routed to `http://127.0.0.1:4321` (the session's port). Only that one service: the agent API
  is never routed.
- An **Access self-hosted application** for that hostname, with a policy that allows the people taking part (for
  example, their e-mail addresses), and its **Application Audience (AUD) tag** (Access → Applications → the
  application → Overview).
- Two people (or two browsers with two identities the policy allows), and a third browser profile or a private window
  that is signed in to nothing.
- Node.js 22.13 or later and the `dt` of the version under test; a workspace with `.dt` and `.dtes` sources (e.g.
  `examples/shop`), committed to git so a restore can be checked against `git diff`.
- For the run step: `dt session subscribe --agent claude` and Claude Code, as for a local session.

## Configuration

In the workspace's `domaintrail.jsonc`:

```jsonc
{
  "session": {
    "identity": "access",
    "host": "127.0.0.1", // the default: only cloudflared reaches the server
    "port": 4321,
    "access": {
      "teamDomain": "<team>.cloudflareaccess.com",
      "audience": "<the application's AUD tag>",
      "publicUrl": "https://session.example.com",
      "allowedHosts": ["session.example.com"],
      "allowedOrigins": ["https://session.example.com"],
      // optional: accept the CF_Authorization cookie when the Cf-Access-Jwt-Assertion header is missing
      "acceptCookie": false,
      // optional: hosts the identity's picture may come from (e.g. lh3.googleusercontent.com); else initials
      "avatarHosts": [],
    },
  },
}
```

- `dt session start` refuses a `publicUrl` that is not https, whose host is not in `allowedHosts`, or whose origin is
  not in `allowedOrigins` (the tunnel's requests would all be refused).
- Any other Host or Origin is refused (403), with or without a token. Loopback names are always allowed, for the
  facilitator's own browser on the machine.
- `host` stays a loopback address. Binding anything else is allowed (an Access token is still required) and logged,
  but then the server is reachable without the tunnel.

## Start

1. Start the tunnel: `cloudflared tunnel run <tunnel>` (or the service you installed).
2. Start the session in the workspace: `dt session start`. It prints the Live View URL (`http://127.0.0.1:4321/`), the
   facilitator link and the agent API's address (on 127.0.0.1, credential in `.domaintrail/session/agent.json`).
   A line `Cloudflare Access keys are not fetched yet` means the JWKS
   (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`) could not be fetched: check the team domain and the
   machine's network before going on.
3. Claim the facilitator role: open `https://session.example.com/` in your browser and sign in through Access, then
   open the facilitator link, with its host changed to `session.example.com` (the path and the code stay). The link
   works once, for 10 minutes; `dt session link` prints another. The role is never given by Access.
4. Start the agent: `dt session subscribe --agent claude` in the workspace.

## Checklist

Tick each line; for a failure, record what is listed under [When something fails](#when-something-fails).

**Participants**

- [ ] Participant A opens `https://session.example.com/`, signs in through Access and sees the Live View.
- [ ] Participant B does the same with another identity.
- [ ] Each sees the other in the session panel with their **name** (the Identity API's `name`; if that API was not
      reachable, the part of the e-mail before `@`) and an **avatar** when `avatarHosts` allows the picture's host,
      else **initials**.
- [ ] No page shows anyone's e-mail address (look at the panel, and in the browser's developer tools at
      `/api/session/me`, `/api/session/state` and the WebSocket messages: no `@`).
- [ ] A and B are participants; only the facilitator's browser shows the facilitator's actions. A participant who
      calls a facilitator action (e.g. `POST /api/session/runs` from the developer tools' console) gets 403
      `FacilitatorOnly`.

**Refused without Access**

- [ ] `curl -i https://session.example.com/` without a session: Access answers (a redirect to its login page, or 403),
      never the Live View.
- [ ] Straight to the origin without a token, on the facilitator's machine: `curl -i http://127.0.0.1:4321/`,
      `…/api/state`, `…/api/session/state` and `…/index.js` answer 401 and no model.
- [ ] The WebSocket without a token: `curl -i -H 'Connection: Upgrade' -H 'Upgrade: websocket'
      -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' http://127.0.0.1:4321/ws`
      answers 401.
- [ ] A forged token: the same requests with `-H 'Cf-Access-Jwt-Assertion: eyJhbGciOiJub25lIn0.e30.'` answer 401.
- [ ] Another Host: `curl -i -H 'Host: evil.example' http://127.0.0.1:4321/api/state` answers 403.

**The agent API stays local**

- [ ] `https://session.example.com/agent/events` does not reach the agent API: signed out, Access answers; signed in
      (open it in the participant's browser), the session server answers 404 (`curl` to `http://127.0.0.1:4321/agent/events`
      without a token: 401).
- [ ] The agent API's port (from `agent.json`) is bound to 127.0.0.1 only: `lsof -nP -iTCP -sTCP:LISTEN | grep <port>`.

**Expiry and leaving**

- [ ] Set the Access application's session duration to its shortest (e.g. 15 minutes) for this check, or wait for the
      configured one. When a participant's token expires, their page's WebSocket closes (close code 4002, "token
      expired", visible in the developer tools' Network tab); the page reconnects once Access gives it a fresh token,
      or Access asks them to sign in again.
- [ ] A participant who leaves the session (`POST /api/session/leave`, from the page's control when it has one, else
      from the developer tools' console) has their pages closed (code 4001); the answer names `/cdn-cgi/access/logout`,
      where the page sends them to end the Access session.

**A run across the tunnel**

- [ ] Participant A sends a request about an element (a `.dt` element, then a `.dtes` element).
- [ ] The facilitator bundles it into a run; the subscriber runs Claude Code; A and B see the run's state change and the
      model's update live, without reloading.
- [ ] The facilitator restores the revision before the run; both participants see the model as it was, and
      `git diff` in the workspace shows the sources back as they were.
- [ ] The facilitator closes the session: every page closes (code 4000), and a reload gets 401 from the origin even
      with a valid Access session.

## When something fails

Record, without tokens, cookies or e-mail addresses (they are personal data and credentials):

- the step, the time (with time zone) and what was expected and seen;
- the domaintrail version (`npm ls domaintrail`, or the commit of a clone), Node's version, the OS, and the `cloudflared` version;
- the `dt session start` output around that time (it never prints tokens or e-mail);
- the HTTP status and the error `type` of the failing request (developer tools → Network), the WebSocket's close code;
- whether the request carried a `Cf-Access-Jwt-Assertion` header at the origin (if you can see the request at the
  origin, only whether the header was there, not its value);
- for a token refused unexpectedly: the token's header and its `iss`, `aud`, `exp`, `nbf`, `iat` claims, decoded
  (e.g. `cut -d. -f1,2` and base64url-decoded), but not the signature, and with `email`/`sub` removed; the machine's
  clock offset (`date -u` against a reliable clock);
- for a missing name or avatar: the keys (not the values) of `https://<team>.cloudflareaccess.com/cdn-cgi/access/get-identity`
  as seen while signed in, and whether `picture` or `oidc_fields.picture` is there and which host it points to.

## Sources

- Validate JWTs: <https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/>
  (the `Cf-Access-Jwt-Assertion` header and `CF_Authorization` cookie, the `certs` JWKS, RS256, issuer and audience, key
  rotation every 6 weeks with the previous key valid for 7 days).
- Application token: <https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/application-token/>
  (the token's claims and the `get-identity` endpoint).
- Extend SSO with Workers: <https://developers.cloudflare.com/cloudflare-one/tutorials/extend-sso-with-workers/>
  (a `get-identity` answer with `name`, `email` and `oidc_fields`).
