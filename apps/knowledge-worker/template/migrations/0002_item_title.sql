-- Version 2: an item has a title (ADR 0031, section 2), one short line kept beside its text and versioned with it.
--
-- The items written before titles are removed: the feature is still in development, an item without a title is not
-- read (the `files` store reports such a file as K001), and no title is made up for one. They are removed as the sweep
-- removes a deleted item — their stickies, search text, versions, image references and the reasons of their audit
-- records —, but without a redaction record: nobody chose to delete them, so their messages are left in the sessions.
-- The images they referred to are left to the sweep, which removes the images nothing refers to after a day. The
-- extractions' idempotency records go too, so that an extraction sent again is applied anew, with titles.
--
-- Then the column: NOT NULL, and never empty (`CHECK`). SQLite adds a NOT NULL column only with a default; the default
-- `''` fails the check, so every new row must give its title.

DELETE FROM item_search;
DELETE FROM item_about;
DELETE FROM item_versions;
DELETE FROM image_refs;
UPDATE audit SET reason = NULL;
DELETE FROM extractions;
DELETE FROM items;

ALTER TABLE items ADD COLUMN title TEXT NOT NULL DEFAULT '' CHECK (title <> '');
