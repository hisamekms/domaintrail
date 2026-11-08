// The marks on a box's edge, as the canvas draws them (styles.css's `.dn-badge`, `.dn-diag` and `.dn-resolved-mark`)
// and the portable SVG mirrors them: the change badge, the diagnostic mark and a resolved hotspot's check.

/** Where a resolved hotspot's check sits: a disc this far inside its note's top-right corner. */
export const RESOLVED_MARK = { inset: 4, radius: 8 };

/** The check of a resolved hotspot's mark, in a disc of radius `r` centred at (`cx`, `cy`): an SVG path to stroke. */
export const checkPath = (cx: number, cy: number, r: number): string =>
    `M${cx - 0.45 * r},${cy + 0.02 * r} L${cx - 0.12 * r},${cy + 0.36 * r} L${cx + 0.48 * r},${cy - 0.32 * r}`;

/** Where the change badge and the diagnostic mark sit on a node's edge (see .dn-badge and .dn-diag). */
export const BADGE = { left: 8, bottom: 7, height: 17, padding: 6, cjk: 12, latin: 7.2 };
export const DIAG_RADIUS = 9;

/** The badge's width, from its text (12px: full-width characters 12px, others about 7px) and padding. */
export const badgeWidth = (text: string): number =>
    2 * BADGE.padding + text.split('').reduce((w, ch) => w + (/[　-鿿＀-￯]/.test(ch) ? BADGE.cjk : BADGE.latin), 0);
