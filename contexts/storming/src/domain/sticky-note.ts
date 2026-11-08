/**
 * The sticky note a storming element is drawn as in the Live View: a square of one fixed side, whatever its label. The
 * label is shrunk to fit it, down to a floor, and below the floor clamped to the lines that fit and ended with «…».
 * The layout (visualization's storming graph), the canvas (apps/web) and the S015 warning share these numbers.
 */
export const STICKY_NOTE = {
    /** The side of every note (px). */
    side: 150,
    /** The label's font size (px, bold sans-serif): where it starts, and the floor it shrinks to. */
    maxFontSize: 17,
    minFontSize: 13,
    /** The label's line height per px of its font size (24px at 17px). */
    lineHeight: 24 / 17,
    /**
     * The label's room in a note (px; see `.dn-head` and `.dn-stereo` in apps/web/styles.css): the side less the border
     * (1.5px a side) and the padding (10px a side; 6px above, 4px below), and the stereotype's line (14px).
     */
    labelWidth: 127,
    labelHeight: 123,
} as const;

/** Of the width of a character at a font size (em): a full-width (CJK) one, and a narrow one, on the narrow side. */
const WIDE_EM = 1;
const NARROW_EM = 0.55;
const SPACE_EM = 0.3;

const isWide = (ch: string): boolean => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch);

/**
 * An estimate of the lines `label` wraps to in a note at `fontSize`, as the canvas wraps it: a full-width character
 * breaks anywhere, a word between spaces goes to the next line when it does not fit the rest of this one, and a word
 * longer than a line breaks anywhere. Narrow characters are taken narrower than most are, so that the estimate errs
 * towards fewer lines.
 */
export function estimatedLabelLines(label: string, fontSize: number = STICKY_NOTE.minFontSize): number {
    const width = STICKY_NOTE.labelWidth / fontSize;
    const tokens = label.trim().match(/\s+|[^\s]/gu) ?? [];
    let lines = 1;
    let used = 0;
    let word = 0;
    /** Places `w` em (a character or a word) at the end of the line, or on a new line when it does not fit. */
    const place = (w: number): void => {
        if (used + w <= width) {
            used += w;
            return;
        }
        if (w <= width) {
            lines++;
            used = w;
            return;
        }
        // a word longer than a line: what fits stays, the rest goes on the next lines
        let rest = w - (width - used);
        lines += Math.ceil(rest / width);
        rest %= width;
        used = rest === 0 ? width : rest;
    };
    const endWord = (): void => {
        if (word > 0) place(word);
        word = 0;
    };
    for (const t of tokens) {
        if (/\s/.test(t)) {
            endWord();
            // a space at the end of a line hangs; it never opens a line
            used = Math.min(width, used + SPACE_EM);
        } else if (isWide(t)) {
            endWord();
            place(WIDE_EM);
        } else {
            word += NARROW_EM;
        }
    }
    endWord();
    return lines;
}

/** The lines of a label that fit in a note at the floor font size. */
export const LINES_AT_FLOOR = Math.floor(STICKY_NOTE.labelHeight / (STICKY_NOTE.minFontSize * STICKY_NOTE.lineHeight));

/** Whether `label` is likely cut short with «…» in its note: it overflows the note even at the floor font size. */
export const labelOverflowsNote = (label: string): boolean => estimatedLabelLines(label) > LINES_AT_FLOOR;
