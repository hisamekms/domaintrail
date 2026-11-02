// The composer's chips, collapsed to two rows (ADR 0026, the composer): with many targets the chips would wrap into up
// to ten rows and push the chat up. Collapsed, the chips that fit in two rows show in the order they were added, and
// the last item of the second row is `+n`, the chips not shown. Measured on the real chips (their widths differ).
// Pure: no React, no DOM.

/** The rows the chips take at most while collapsed. */
export const COLLAPSED_ROWS = 2;

/** Room for subpixel widths: a chip that overflows a row by less than this still fits. */
const EPSILON = 0.5;

/** The rows `widths` take when they wrap in a row of `width`, `gap` apart (as `flex-wrap` places them). */
export function rowCount(widths: readonly number[], width: number, gap: number): number {
    let rows = 0;
    let x = 0;
    for (const raw of widths) {
        // a chip is never wider than the row (`max-width: 100%`)
        const w = Math.min(raw, width);
        if (rows > 0 && x + gap + w <= width + EPSILON) x += gap + w;
        else {
            rows++;
            x = w;
        }
    }
    return rows;
}

/**
 * How many chips show while collapsed: all of them when they fit in `rows`, else the most of the first ones that,
 * followed by the `+n` button (`more` wide), still fit.
 */
export function collapsedCount(widths: readonly number[], width: number, gap: number, more: number, rows: number = COLLAPSED_ROWS): number {
    if (!(width > 0) || rowCount(widths, width, gap) <= rows) return widths.length;
    for (let keep = widths.length - 1; keep > 0; keep--) {
        if (rowCount([...widths.slice(0, keep), more], width, gap) <= rows) return keep;
    }
    return 0;
}
