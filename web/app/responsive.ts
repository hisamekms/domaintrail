// How the layout gives way to the conversation on a narrow window, without React: the left pane shrinks to its
// activity bar, then the inspector moves below the canvas. These are the page's own changes: the reader's saved choices
// are kept, and come back when the window is wide enough again.

/** Where the inspector is docked: right of the canvas, or below it. */
export type Dock = 'right' | 'bottom';

/** With the conversation open, a window narrower than this shows the left pane as its activity bar only. */
export const COLLAPSE_LEFT_BELOW = 1280;
/** With the conversation open, a window narrower than this shows the inspector below the canvas. */
export const DOCK_BELOW_BELOW = 1024;

/**
 * What the reader chose while the page overrode their choice (a narrow window): kept for as long as the override lasts,
 * never saved.
 */
export interface Overrides {
    readonly left?: boolean;
    readonly dock?: Dock;
}

export const NO_OVERRIDES: Overrides = {};

/** Which of the reader's choices the page overrides at this width. */
export function forced(width: number, conversationOpen: boolean): { readonly left: boolean; readonly dock: boolean } {
    return { left: conversationOpen && width < COLLAPSE_LEFT_BELOW, dock: conversationOpen && width < DOCK_BELOW_BELOW };
}

/**
 * The layout shown: the reader's saved choices (`left` open, `dock`), unless the window is too narrow for them next to
 * the conversation; then what the reader chose since (`overrides`), else the page's choice (the left pane collapsed,
 * the inspector below).
 */
export function effectiveLayout(input: { width: number; conversationOpen: boolean; left: boolean; dock: Dock; overrides: Overrides }): {
    readonly left: boolean;
    readonly dock: Dock;
    readonly forced: { readonly left: boolean; readonly dock: boolean };
} {
    const f = forced(input.width, input.conversationOpen);
    return {
        left: f.left ? (input.overrides.left ?? false) : input.left,
        dock: f.dock ? (input.overrides.dock ?? 'bottom') : input.dock,
        forced: f,
    };
}

/** The overrides still in force: one whose override ended is dropped, so that the next one starts from the page's choice. */
export function keptOverrides(overrides: Overrides, f: { readonly left: boolean; readonly dock: boolean }): Overrides {
    const left = f.left ? overrides.left : undefined;
    const dock = f.dock ? overrides.dock : undefined;
    if (left === overrides.left && dock === overrides.dock) return overrides;
    return { ...(left !== undefined && { left }), ...(dock !== undefined && { dock }) };
}

/** The inspector's width on the right until the reader drags it: about a third of the room beside the left pane and the conversation, within 300–420px. */
export const AUTO_INSPECTOR_MIN = 300;
export const AUTO_INSPECTOR_MAX = 420;
export function autoInspectorWidth(room: number): number {
    return Math.round(Math.min(AUTO_INSPECTOR_MAX, Math.max(AUTO_INSPECTOR_MIN, room * 0.36)));
}
