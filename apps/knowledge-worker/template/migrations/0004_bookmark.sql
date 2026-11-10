-- Version 4: a project-shared bookmark on a knowledge item. Existing items start unbookmarked.
-- It is independent of content versions and survives correction, extraction and retirement.

ALTER TABLE items ADD COLUMN bookmarked INTEGER NOT NULL DEFAULT 0 CHECK (bookmarked IN (0, 1));

CREATE INDEX items_bookmarked ON items (project, state, bookmarked, updated_at DESC, id DESC);
