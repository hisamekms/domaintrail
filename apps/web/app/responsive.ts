// How the layout gives way to the conversation on a narrow window, without React: the left column (the navigator and
// the detail) shrinks to its activity bar. This is the page's own change: the reader's saved choice is kept, and
// comes back when the window is wide enough again.

/**
 * With the conversation open, a window narrower than this shows the left column as its activity bar only. The detail
 * and the chat are seen together down to it: the canvas then keeps about 320px between the two columns.
 */
export const COLLAPSE_LEFT_BELOW = 1024;

/**
 * What the reader chose while the page overrode their choice (a narrow window): kept for as long as the override lasts,
 * never saved.
 */
export interface Overrides {
    readonly left?: boolean;
}

export const NO_OVERRIDES: Overrides = {};

/**
 * Which of the reader's choices the page overrides at this width. With larger text (`scale`, see text-size.ts) the
 * columns are wider by default, so the threshold grows with it.
 */
export function forced(width: number, conversationOpen: boolean, scale = 1): { readonly left: boolean } {
    return { left: conversationOpen && width < COLLAPSE_LEFT_BELOW * scale };
}

/**
 * The layout shown: the reader's saved choice (`left` open), unless the window is too narrow for it next to the
 * conversation; then what the reader chose since (`overrides`), else the page's choice (the left column collapsed).
 */
export function effectiveLayout(input: { width: number; conversationOpen: boolean; left: boolean; overrides: Overrides; scale?: number }): {
    readonly left: boolean;
    readonly forced: { readonly left: boolean };
} {
    const f = forced(input.width, input.conversationOpen, input.scale);
    return { left: f.left ? (input.overrides.left ?? false) : input.left, forced: f };
}

/** The overrides still in force: one whose override ended is dropped, so that the next one starts from the page's choice. */
export function keptOverrides(overrides: Overrides, f: { readonly left: boolean }): Overrides {
    const left = f.left ? overrides.left : undefined;
    if (left === overrides.left) return overrides;
    return left !== undefined ? { left } : {};
}
