// One emoji, as a reaction of a collaboration session holds it (ADR 0026, appendix "Votes and reactions"): what counts
// as one emoji, and the one form it is kept in. Pure (no DOM, no node:*), so that the config (`collab.quickReactions`),
// the server (the `Emoji` primitive of the collaboration model) and the page decide alike.
//
// One emoji is one grapheme (`Intl.Segmenter`) made only of emoji characters and their components — a pictograph
// (`\p{Extended_Pictographic}`, with its ZWJ sequences, skin tones, variation selector and tag sequences), a flag (two
// regional indicators) or a keycap (`#`, `*` or a digit, then U+20E3). Text, a lone component, two emoji and anything
// over `MAX_EMOJI_BYTES` are not.
//
// The form kept is NFC and fully qualified: every variation selector 16 (U+FE0F) is dropped and then added back after
// each emoji character whose default presentation is text (`\p{Emoji}` without `\p{Emoji_Presentation}`), unless a
// skin tone follows it. So ❤ (U+2764) and ❤️ (U+2764 U+FE0F) are the same reaction, ❤️, the form emoji pickers insert
// and every platform draws as an emoji.

/** The emoji the add-reaction popover of a session's chat offers first (`collab.quickReactions`; any other can be typed there). */
export const DEFAULT_QUICK_REACTIONS: readonly string[] = ['👍', '👀', '🤔', '🎉', '❤️', '🙏'];

/** The most UTF-8 bytes an emoji may take (the longest RGI sequences take about 35). */
export const MAX_EMOJI_BYTES = 64;

const VS16 = '\uFE0F';
const ONLY_EMOJI_PARTS = /^[\p{Emoji}\p{Emoji_Component}]+$/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const FLAG = /^\p{Regional_Indicator}{2}$/u;
const KEYCAP_SEQUENCE = /^[#*0-9]\uFE0F?\u20E3$/u;
const TEXT_DEFAULT = /^(?=\p{Emoji})\P{Emoji_Presentation}$/u;
const MODIFIER = /^\p{Emoji_Modifier}$/u;

const bytes = (s: string): number => new TextEncoder().encode(s).length;

/** The graphemes of a text: what a reader counts as characters. */
function graphemes(s: string): string[] {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (g) => g.segment);
}

/** Whether a text is exactly one emoji, in any form (see the module's comment). */
export function isSingleEmoji(s: string): boolean {
    if (!s || bytes(s) > MAX_EMOJI_BYTES || !ONLY_EMOJI_PARTS.test(s) || graphemes(s).length !== 1) return false;
    return PICTOGRAPH.test(s) || FLAG.test(s) || KEYCAP_SEQUENCE.test(s);
}

/** The form an emoji is kept in: NFC, fully qualified (VS16 after each emoji character shown as text by default). */
export function normalizeEmoji(s: string): string {
    const points = Array.from(s.normalize('NFC').replaceAll(VS16, ''));
    return points.map((p, i) => (TEXT_DEFAULT.test(p) && !MODIFIER.test(points[i + 1] ?? '') ? p + VS16 : p)).join('');
}

/** Whether a text is one emoji in the form kept: what the `Emoji` primitive holds. */
export const isNormalEmoji = (s: string): boolean => isSingleEmoji(s) && normalizeEmoji(s) === s;

/** One emoji typed or pasted, in the form kept; `undefined` when it is not exactly one emoji. */
export function readEmoji(s: string): string | undefined {
    if (bytes(s) > MAX_EMOJI_BYTES) return undefined;
    const e = normalizeEmoji(s.trim());
    return isSingleEmoji(e) ? e : undefined;
}
