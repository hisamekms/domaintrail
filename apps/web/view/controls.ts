/** The zoom level as the cluster shows it (1 → `100%`). */
export const formatZoom = (zoom: number): string => `${Math.round(zoom * 100)}%`;

/** What a key press does on the canvas. */
export type CanvasShortcut = 'fitAll' | 'fitSelection';

/**
 * The canvas's keys: `Shift+1` fits everything, `Shift+2` the selection (the canvas's own keys for the same, taken
 * over so that they fit as its buttons do). Nothing while typing, composing (IME) or with Ctrl / ⌘ / Alt; the digits
 * are matched by their key position, as Shift changes the character they type with the keyboard layout.
 */
export function canvasShortcut(
    e: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>,
    typing: boolean,
): CanvasShortcut | null {
    if (typing || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return null;
    if (e.shiftKey && e.code === 'Digit1') return 'fitAll';
    if (e.shiftKey && e.code === 'Digit2') return 'fitSelection';
    return null;
}

/** Whether an element takes typed text (an input, a text area, a select, something editable). */
export function takesText(el: Element | null): boolean {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
        const type = (el.getAttribute('type') ?? 'text').toLowerCase();
        return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file'].includes(type);
    }
    return el instanceof HTMLElement && el.isContentEditable;
}
