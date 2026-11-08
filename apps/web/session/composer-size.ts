// The height of the chat's composer, in rows of its text (so that it follows the text size). The reader drags the
// handle on its top edge (the composer sits at the bottom of the chat pillar: dragging up grows it) or uses the arrow
// keys on it; the choice is remembered per browser.

/** localStorage key of the chosen number of rows (JSON, like the other persisted settings). */
export const COMPOSER_ROWS_KEY = 'domaintrail.chat.composerRows';

/** The height the composer starts at, and comes back to with a double click on the handle. */
export const DEFAULT_COMPOSER_ROWS = 6;

/** The fewest rows the composer can be made. */
export const MIN_COMPOSER_ROWS = 2;

/** The part of the chat pillar's height the composer's text can take at most. */
export const MAX_COMPOSER_SHARE = 0.6;

/** The most rows that fit in the share of the pillar (`pillar`, `row` and `extra` — padding and border — in px). */
export function maxComposerRows(pillar: number, row: number, extra: number): number {
    if (!(pillar > 0) || !(row > 0)) return DEFAULT_COMPOSER_ROWS;
    return Math.max(MIN_COMPOSER_ROWS, Math.floor((pillar * MAX_COMPOSER_SHARE - Math.max(0, extra)) / row));
}

/** A number of rows within [MIN_COMPOSER_ROWS, max], whole; anything not a number (a bad saved value) is the default. */
export function clampComposerRows(rows: unknown, max: number): number {
    const top = Math.max(MIN_COMPOSER_ROWS, Math.floor(max));
    const value = typeof rows === 'number' && Number.isFinite(rows) ? Math.round(rows) : DEFAULT_COMPOSER_ROWS;
    return Math.min(top, Math.max(MIN_COMPOSER_ROWS, value));
}

/** The rows while dragging: up (a negative `deltaY`, in px) grows the composer, by whole rows of `row` px. */
export function draggedComposerRows(start: number, deltaY: number, row: number, max: number): number {
    if (!(row > 0)) return clampComposerRows(start, max);
    return clampComposerRows(start - deltaY / row, max);
}

/** The rows after a key on the handle (↑ one more, ↓ one fewer, Home the fewest, End the most), or undefined. */
export function keyedComposerRows(key: string, rows: number, max: number): number | undefined {
    switch (key) {
        case 'ArrowUp':
            return clampComposerRows(rows + 1, max);
        case 'ArrowDown':
            return clampComposerRows(rows - 1, max);
        case 'Home':
            return MIN_COMPOSER_ROWS;
        case 'End':
            return clampComposerRows(max, max);
        default:
            return undefined;
    }
}
