// A text measure without a browser, for `dt export svg`: the widths of the Live View's fonts from a table measured once
// in Chrome on macOS (`font-widths.ts`, made by scripts/font-widths.ts), so that text wraps and fits its notes as the
// page lays it out there, the same on every machine and in CI. A character the table lacks is a full em when it is wide
// (CJK, kana, hangul, full-width forms, emoji), nothing when it only modifies the one before, and 0.6em otherwise.
import { FONT_METRICS, FONT_RANGES, FONT_WIDTHS } from './font-widths.js';
import type { Font, Fonts, TextMeasure } from './portable-svg.js';

/** Code points drawn a full em wide: CJK, kana, hangul, the full-width forms, and everything past the BMP (emoji). */
const isWide = (cp: number): boolean =>
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp > 0xffff;

/** Code points with no width of their own: combining marks, joiners and variation selectors. */
const isZeroWidth = (cp: number): boolean =>
    (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x3099 && cp <= 0x309a);

/** The table of one font: the width of each code point of `FONT_RANGES`, in thousandths of an em. */
function decode(rows: readonly (readonly string[])[]): Map<number, number> {
    const widths = new Map<number, number>();
    FONT_RANGES.forEach(([from], i) => {
        const s = (rows[i] ?? []).join('');
        for (let k = 0; 2 * k < s.length; k++) widths.set(from + k, parseInt(s.slice(2 * k, 2 * k + 2), 36));
    });
    return widths;
}

const tables = new Map<string, Map<number, number>>();

/** The table of the font closest to `font`'s weight in its stack. */
function table(stack: 'sans' | 'mono', weight: number): Map<number, number> {
    const key = stack === 'mono' ? `mono${weight < 550 ? 400 : 600}` : `sans${weight <= 500 ? 400 : weight < 650 ? 600 : 700}`;
    let t = tables.get(key);
    if (!t) {
        t = decode(FONT_WIDTHS[key] ?? []);
        tables.set(key, t);
    }
    return t;
}

/** The width of a code point in thousandths of an em. */
function advance(widths: Map<number, number>, cp: number): number {
    const known = widths.get(cp);
    if (known !== undefined) return known;
    if (isZeroWidth(cp)) return 0;
    return isWide(cp) ? 1000 : 600;
}

/**
 * Measures text in the font stacks `fonts` from the table: a font whose family is `fonts.mono` is measured as the mono
 * stack, any other as the sans one. Ascent and descent are whole pixels, as a canvas's `fontBoundingBox` gives them.
 */
export function tableMeasure(fonts: Fonts): TextMeasure {
    const stackOf = (font: Font): 'sans' | 'mono' => (font.family === fonts.mono ? 'mono' : 'sans');
    return {
        width: (text, font) => {
            const widths = table(stackOf(font), font.weight ?? 400);
            let total = 0;
            for (const ch of text) total += advance(widths, ch.codePointAt(0)!);
            return (total * font.size) / 1000;
        },
        metrics: (font) => {
            const m = FONT_METRICS[stackOf(font)];
            return { ascent: Math.round((m.ascent * font.size) / 1000), descent: Math.round((m.descent * font.size) / 1000) };
        },
    };
}
