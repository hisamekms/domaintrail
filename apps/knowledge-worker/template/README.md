# The knowledge store's Worker

DomainTrail keeps the knowledge taken from sessions in a store ([ADR 0031](https://github.com/hisamekms/domaintrail/blob/main/docs/adr/0031-knowledge.md)).
With `knowledge.store: "cloudflare"`, the store is this Worker: D1 holds the items, their versions and sources, the
audit log and the redaction log; R2 holds the images; Cloudflare Access stands in front of it. You deploy it to your
own Cloudflare account: dt creates nothing in Cloudflare and needs no Cloudflare credentials, only an Access service
token to call the Worker.

This directory is the template, as shipped in the `domaintrail` npm package under `dist/knowledge-worker/`:

| File | What it is |
|---|---|
| `worker.js` | the Worker, built from DomainTrail's sources (`apps/knowledge-worker`); do not edit |
| `page/` | the read-only page the Worker serves (its HTML, script and styles), built from DomainTrail's sources; do not edit |
| `wrangler.jsonc` | its configuration: fill in every `<…>` |
| `migrations/` | the D1 schema, one file per version; applied by `wrangler d1 migrations apply` |

## Deploy

You need a Cloudflare account with a zone (a domain) for the Worker's host name, and Wrangler 4. The Workers Paid plan
is recommended: an extraction writes in one D1 batch, and the Free plan allows 50 D1 queries per invocation.

1. **Copy the template** of the DomainTrail version your dt runs, into a directory of its own (a repository of its own,
   or a directory beside your workspace):

   ```bash
   npm pack domaintrail@<version>
   tar xzf domaintrail-<version>.tgz package/dist/knowledge-worker
   mv package/dist/knowledge-worker knowledge-store && rm -r package domaintrail-<version>.tgz
   cd knowledge-store
   npm init -y && npm install --save-dev wrangler@4
   npx wrangler login
   ```

2. **Create the database and the bucket**, and put their names and the database's ID into `wrangler.jsonc`
   (`database_id`, `bucket_name`):

   ```bash
   npx wrangler d1 create knowledge
   npx wrangler r2 bucket create <knowledge-images>
   npx wrangler d1 migrations apply knowledge --remote
   ```

3. **Set up Access** (Zero Trust dashboard):
   - Access → Service credentials → Service tokens: create two tokens, one for **writing** (the dt that runs a session:
     it adds what the extractor finds, and people correct and delete through it) and one for **reading** (the MCP server
     `dt mcp`). Keep each Client ID and Client Secret.
   - Access → Applications → Add an application → Self-hosted, for the Worker's host name (`knowledge.example.com`).
     Give it two policies: an **Allow** policy for the people who may read the knowledge page (an e-mail domain, a
     group), and a **Service Auth** policy that includes both service tokens.
   - From the application's Overview, copy the **Application Audience (AUD) tag**.

4. **Fill in `wrangler.jsonc`**: the host name in `routes`; `ACCESS_TEAM_DOMAIN` (`<team>.cloudflareaccess.com`);
   `ACCESS_AUD` (the AUD tag); `WRITER_TOKENS` (the **writing** token's Client ID; other tokens can only read).

5. **Deploy** and check it:

   ```bash
   npx wrangler deploy
   curl -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" https://knowledge.example.com/v1/health
   # {"api":"v1","caller":"service:<id>"}
   ```

6. **Point dt at it**: `knowledge.store: "cloudflare"` with the Worker's URL and your project's name in the
   workspace's `domaintrail.jsonc`, and the service token in the environment of the dt that runs sessions (see
   `dt guide config`).

7. **Publish the stormings** from your repository's CI, so that the page has something to draw (see below).

The Worker verifies Access's token itself, too (`Cf-Access-Jwt-Assertion`, against your team's keys and the AUD tag):
a request that did not pass Access is refused, and so is every request while `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is
unset. `workers_dev` and `preview_urls` are off, so the Worker has no URL outside Access.

## The read-only page

`https://knowledge.example.com/` is a page for the people from the business (ADR 0031, section 11): they read the
knowledge at any time, on the canvas of a storming, behind the same Access application (its Allow policy). It shows a
published storming at its Big Picture or Design Level, with a dot on each sticky that has knowledge and a mark on one
with a conflict; selecting a sticky lists its items (newest first, or by kind), and an item opens to its text, quotes,
the other stickies it is about, its versions and images. The ナレッジ list searches and filters every item; the items
about stickies that no published storming has (removed or renamed since) are listed apart; the bar says the date and
commit of the drawing. Anyone who can open the page may correct and delete, with 元に戻す for 10 seconds, as in a
session. The page's address keeps what it shows (`?project=…&storming=…&level=…`), so a link opens the same view.

Every request reaches the Worker first (`assets.run_worker_first`), which verifies the Access token before it serves
the page; the page then calls the API of the same origin with the reader's Access cookie. A person's change is taken
from the page's own origin only (another site cannot make a reader's browser delete).

## Publishing the stormings from CI

The Worker cannot read your repository: `dt publish` sends each storming's published form (its stickies with their
labels, links and places, and the commit and date of the drawing; no chat, no person) to `PUT
/v1/projects/<project>/published/<storming>`. Run it when `main` changes, so that readers see the drawing that was
agreed and merged. Only a **writing** service token publishes (a person, or the reading token, cannot); give CI a
writing token of its own and add its Client ID to `WRITER_TOKENS`.

dt sends the token to `knowledge.url` of the committed config. In CI it cannot ask anyone to approve that, so it
publishes only when the destination is **pinned outside the repository**: `DOMAINTRAIL_PUBLISH_URL` and
`DOMAINTRAIL_PUBLISH_PROJECT`, kept as CI variables, must equal the config's `knowledge.url` and `knowledge.project`.
A commit that changes `knowledge.url` then makes `dt publish` refuse, instead of sending the token elsewhere. Run it on
`main` only (never on pull requests, whose code could print the secrets), and protect the workflow file with the
branch's review rules.

A GitHub Actions workflow (`.github/workflows/knowledge-publish.yml`; set the repository variables
`KNOWLEDGE_URL` and `KNOWLEDGE_PROJECT`, and the secrets `KNOWLEDGE_CLIENT_ID` and `KNOWLEDGE_CLIENT_SECRET` of CI's
writing token):

```yaml
name: knowledge-publish
on:
  push:
    branches: [main]
    paths: ['**/*.dtes', '**/domaintrail.jsonc']
  workflow_dispatch:
concurrency: knowledge-publish
permissions:
  contents: read
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # each drawing is dated by the last commit that changed its file
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx dt publish # add `-r domain` when the config is in domain/
        env:
          DOMAINTRAIL_PUBLISH_URL: ${{ vars.KNOWLEDGE_URL }}
          DOMAINTRAIL_PUBLISH_PROJECT: ${{ vars.KNOWLEDGE_PROJECT }}
          DOMAINTRAIL_KNOWLEDGE_CLIENT_ID: ${{ secrets.KNOWLEDGE_CLIENT_ID }}
          DOMAINTRAIL_KNOWLEDGE_CLIENT_SECRET: ${{ secrets.KNOWLEDGE_CLIENT_SECRET }}
```

It prints one line per storming (`published`, or `unchanged` when the drawing is the one kept). A storming that does
not parse is not published (`dt check` first). `dt publish --out <dir>` writes the forms as files instead, to look at
what would be sent.

## How it keeps the knowledge

- **Projects.** Every path is under `/v1/projects/<project>`; the workspace names its project in `knowledge.project`.
  A project is made when it is first written to. Every project is open to whoever passes Access; members and
  `visibility: "members"` are prepared in the schema but not enforced yet.
- **Extractions** are applied as operations in one D1 transaction, once per `Idempotency-Key` (`<session>#<number>`):
  a retry gets the first result back. An operation on an item that a person corrected or deleted meanwhile is dropped,
  and the person's change stands.
- **Deleting** hides an item from every read at once; it can be restored until the **sweep**, a Cron Trigger every 5
  minutes, removes every version of it, its images, and the reasons of its audit records, and appends the IDs of its
  source messages to the **redaction log**, which every dt of the project reads to redact its own session database.
  `SWEEP_AFTER_SECONDS` (default 60) is how long a deleted item waits for the sweep.
- **The audit log** records each change with the model's actor (the extraction, or the person a call acted for) and the
  Access identity of the call (a person's e-mail, or `service:<Client ID>`).
- **Search** uses D1's full-text search (FTS5, trigram tokenizer: any substring of three characters or more, Japanese
  included; shorter terms are scanned).

D1 keeps 30 days of history (Time Travel), which ADR 0031 accepts for deleted data. `wrangler d1 export` does not
export a database with a full-text table; use Time Travel to restore.

## Upgrade

The template's version is DomainTrail's. When you upgrade dt, upgrade the Worker to the same version:

1. copy the new `worker.js`, `page/` and `migrations/` over yours (keep your `wrangler.jsonc`, and compare it with the new one
   for settings it added);
2. `npx wrangler d1 migrations apply knowledge --remote` (migrations are only ever added; apply them before deploying);
3. `npx wrangler deploy`.

The API's paths carry its version (`/v1`); a version of dt that needs another one says so in its changelog.

## Local development

```bash
npx wrangler d1 migrations apply knowledge --local
printf 'INSECURE_SKIP_ACCESS_CHECK=true\nACCESS_TEAM_DOMAIN=\nACCESS_AUD=\nWRITER_TOKENS=dev\n' > .dev.vars
npx wrangler dev
```

Without Access, the Worker takes the caller from the `CF-Access-Client-Id` (or `Cf-Access-Authenticated-User-Email`)
header as it comes; never set `INSECURE_SKIP_ACCESS_CHECK` on a deployed Worker. To open the page locally, have the
browser send `Cf-Access-Authenticated-User-Email` (an extension that sets headers), and publish to it with
`DOMAINTRAIL_KNOWLEDGE_CLIENT_ID=dev` (any secret) and `knowledge.url` on `http://localhost:8787`.
