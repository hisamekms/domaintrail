-- The knowledge store's D1 schema (ADR 0031, sections 5 to 8), version 1. Migrations are only ever added, never
-- edited: `wrangler d1 migrations apply knowledge --remote` applies the new ones on upgrade.
--
-- Times are ISO 8601 strings in UTC (`2026-11-05T09:00:00.000Z`), which sort as they compare. The JSON columns hold
-- the model's values as the HTTP API sends them (contexts/knowledge/src/protocol.ts).

-- ---- projects, users, groups, members (section 6) ---------------------------------------------------------------
-- Prepared, not built: every project is open to whoever passes Access (`authorize` allows everyone). A project is made
-- when it is first written to. `visibility` is switched explicitly; adding a member narrows nothing by itself.

CREATE TABLE projects (
  name TEXT PRIMARY KEY,
  visibility TEXT NOT NULL DEFAULT 'open' CHECK (visibility IN ('open', 'members')),
  created_at TEXT NOT NULL
);

-- groups are defined in the store, across projects
CREATE TABLE groups (
  name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE group_members (
  group_name TEXT NOT NULL REFERENCES groups (name) ON DELETE CASCADE,
  user TEXT NOT NULL,
  PRIMARY KEY (group_name, user)
);

-- a member is a user or a group attached to a project directly
CREATE TABLE project_members (
  project TEXT NOT NULL REFERENCES projects (name) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'group')),
  name TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (project, kind, name)
);

-- ---- items (section 2) ------------------------------------------------------------------------------------------

-- An item as it is now. A deleted item stays, hidden from every read, until the sweep removes it with everything of it.
-- `rev` counts every write: a write checks the `rev` it read, so that a person's change made meanwhile is never
-- overwritten (the operations of an extraction on it are then decided again, and dropped).
CREATE TABLE items (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('Live', 'Deleted')),
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  when_label TEXT NOT NULL,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  perspective TEXT,
  -- JSON: the stickies (`<Storming>.<LocalId>`), the sources (session, message, at, quote), the conflicting items
  about TEXT NOT NULL,
  sources TEXT NOT NULL,
  conflicts_with TEXT NOT NULL,
  created_in TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_by TEXT,
  deleted_at TEXT,
  rev INTEGER NOT NULL,
  UNIQUE (project, id)
);

CREATE INDEX items_newest ON items (project, state, updated_at DESC, id DESC);
CREATE INDEX items_session ON items (project, created_in);
CREATE INDEX items_deleted ON items (state, deleted_at);

-- the stickies an item is about, for the filter `about` and the counts per sticky
CREATE TABLE item_about (
  project TEXT NOT NULL,
  sticky TEXT NOT NULL,
  item TEXT NOT NULL,
  PRIMARY KEY (project, sticky, item)
);

CREATE INDEX item_about_item ON item_about (project, item);

-- the versions an item replaced: the content (text, labels, about) and when it was replaced
CREATE TABLE item_versions (
  project TEXT NOT NULL,
  item TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  replaced_at TEXT NOT NULL,
  PRIMARY KEY (project, item, version)
);

-- Full text over an item's text and its sources' quotes, by `items.seq`. The trigram tokenizer matches any substring of
-- three characters or more, which suits Japanese (no word boundaries); a shorter term falls back to a scan of this
-- table's text (`LIKE`), which is still only the project's items.
CREATE VIRTUAL TABLE item_search USING fts5 (body, tokenize = 'trigram');

-- ---- images (section 10) ----------------------------------------------------------------------------------------

-- an image's bytes are in R2 at `<project>/<id>`
CREATE TABLE images (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (project, id)
);

-- the images any version of an item's text refers to: the sweep removes those only a deleted item refers to
CREATE TABLE image_refs (
  project TEXT NOT NULL,
  image TEXT NOT NULL,
  item TEXT NOT NULL,
  PRIMARY KEY (project, image, item)
);

CREATE INDEX image_refs_item ON image_refs (project, item);

-- ---- extractions, audit, redactions (sections 7 and 8) ----------------------------------------------------------

-- The extractions applied, by their idempotency key (`<session>#<number>`): the hash of the operations, and what was
-- applied as IDs and reasons only (`{ items, dropped: [{ index, reason }] }`), so that a deleted item's text does not
-- outlive it here. Kept a week.
CREATE TABLE extractions (
  project TEXT NOT NULL,
  key TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  outcome TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (project, key)
);

CREATE INDEX extractions_applied ON extractions (applied_at);

-- Who changed or deleted what, and why. `actor` is the model's (the extraction, or the person a call acted for);
-- `caller` is the Access identity of the request (a person's e-mail, or `service:<Client ID>`). The sweep drops the
-- reasons of a deleted item's records (a reason may quote someone).
CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  item TEXT NOT NULL,
  version INTEGER NOT NULL,
  operation TEXT NOT NULL,
  actor TEXT NOT NULL,
  caller TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL
);

CREATE INDEX audit_project ON audit (project, seq);
CREATE INDEX audit_item ON audit (project, item, seq);

-- The redaction log: the items the sweep removed and the messages they came from, IDs only, kept for good. Every dt
-- of the project reads it on from its cursor (`seq`) and redacts those messages in its session database.
CREATE TABLE redactions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  item TEXT NOT NULL,
  messages TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX redactions_project ON redactions (project, seq);

-- ---- reserved for `dt publish` (section 11) ---------------------------------------------------------------------

-- the published form of each storming (stickies, links, layout), which the read-only page draws; not served yet
CREATE TABLE published (
  project TEXT NOT NULL,
  storming TEXT NOT NULL,
  version TEXT NOT NULL,
  body TEXT NOT NULL,
  published_at TEXT NOT NULL,
  published_by TEXT NOT NULL,
  PRIMARY KEY (project, storming)
);
