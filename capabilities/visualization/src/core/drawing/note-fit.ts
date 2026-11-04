// The label of a storming's sticky note, fitted to the note (`STICKY_NOTE`): every note is the same square, so a long
// label starts at the usual size and steps down to a floor until it fits; one that does not fit even at the floor is
// clamped to the lines that fit and ends with «…». This module only decides, given a measure of the label wrapped at a
// size: the Live View's canvas measures it as the browser wraps it, the portable SVG with its own text measure.
import { STICKY_NOTE } from '@domaintrail/storming';

/** The kinds of node drawn as a sticky note. */
export const NOTE_KINDS: ReadonlySet<string> = new Set([
    'esEvent',
    'esCommand',
    'esPolicy',
    'esActor',
    'esExternal',
    'esAggregate',
    'esReadModel',
    'esHotspot',
]);

/** How a label is drawn in its note: its font size and line height (px), and the lines it is clamped to (none: all). */
export interface LabelFit {
    fontSize: number;
    lineHeight: number;
    clamp?: number;
}

/** The font sizes tried, largest first, from `STICKY_NOTE.maxFontSize` down to its floor in 1px steps, times `scale`. */
export function fontSizes(scale = 1): number[] {
    const sizes: number[] = [];
    for (let size = STICKY_NOTE.maxFontSize; size >= STICKY_NOTE.minFontSize; size--) sizes.push(size * scale);
    return sizes;
}

/**
 * The largest font size at which a label fits `room` (px high), given `height`: the height of the label wrapped at a
 * font size (and its line height). At the floor, a label that still does not fit is clamped to the lines that fit (at
 * least one).
 */
export function fitLabel(height: (fontSize: number, lineHeight: number) => number, room: number, scale = 1): LabelFit {
    const sizes = fontSizes(scale);
    for (const fontSize of sizes) {
        const lineHeight = fontSize * STICKY_NOTE.lineHeight;
        // half a pixel of slack for the rounding of fractional line heights
        if (height(fontSize, lineHeight) <= room + 0.5) return { fontSize, lineHeight };
    }
    const fontSize = sizes[sizes.length - 1]!;
    const lineHeight = fontSize * STICKY_NOTE.lineHeight;
    return { fontSize, lineHeight, clamp: Math.max(1, Math.floor((room + 0.5) / lineHeight)) };
}
