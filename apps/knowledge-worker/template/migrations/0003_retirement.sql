-- Version 3: retiring an item (廃止, ADR 0031 section 12), and the AI's proposals to retire one (or to undo it).
--
-- A retired item stays as it is — its text, sources and versions — with its retirement beside it (JSON: the reason,
-- the replacing item, who and when, the proposal approved). NULL: not retired. The lists leave the retired items out
-- unless asked; the counts per sticky never count them.
--
-- A proposal is kept whole as JSON (`body`, as the HTTP API sends it), with its item and state beside it for the
-- queries: the open ones are the list of 廃止の候補, the dismissed ones keep the same from being proposed again. The
-- sweep removes the proposals about an item it removes, and those quoting a message of it.
--
-- Nothing is rewritten: the items of before are not retired, and there are no proposals yet.

ALTER TABLE items ADD COLUMN retirement TEXT;

CREATE TABLE proposals (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  item TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('Open', 'Approved', 'Dismissed')),
  body TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  PRIMARY KEY (project, id)
);

CREATE INDEX proposals_item ON proposals (project, item);
CREATE INDEX proposals_open ON proposals (project, state, proposed_at DESC);
