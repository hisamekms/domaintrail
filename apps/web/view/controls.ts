import { useSyncExternalStore } from 'react';

/**
 * Whether the canvas's bottom-left controls (− % + ⤢ ◎ and the legend) are collapsed into one » button. One state,
 * remembered per browser: the bar's « and » buttons and the `U` key all toggle it (the key used to hide the controls
 * only for now, over a separate choice of the canvas's menu; with that menu gone, there is nothing to come back to).
 */
export interface ControlsState {
    readonly collapsed: boolean;
}

export const EXPANDED: ControlsState = { collapsed: false };

/** «, », or the key: collapses the controls, or brings them back. */
export const toggleCollapsed = (s: ControlsState): ControlsState => ({ collapsed: !s.collapsed });

/** The zoom level as the cluster shows it (1 → `100%`). */
export const formatZoom = (zoom: number): string => `${Math.round(zoom * 100)}%`;

/** What a key press does on the canvas. */
export type CanvasShortcut = 'fitAll' | 'fitSelection' | 'toggleControls';

/**
 * The canvas's keys: `Shift+1` fits everything, `Shift+2` the selection (the canvas's own keys for the same, taken
 * over so that they fit as its buttons do), and `U` collapses or brings back the bottom-left controls. Nothing while
 * typing, composing (IME) or with Ctrl / ⌘ / Alt; the digits are matched by their key position, as Shift changes the
 * character they type with the keyboard layout.
 */
export function canvasShortcut(
    e: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing' | 'repeat'>,
    typing: boolean,
): CanvasShortcut | null {
    if (typing || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return null;
    if (e.shiftKey && e.code === 'Digit1') return 'fitAll';
    if (e.shiftKey && e.code === 'Digit2') return 'fitSelection';
    if (!e.repeat && (e.key === 'u' || e.key === 'U')) return 'toggleControls';
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

/** localStorage key of the state (JSON, like the other persisted settings). */
export const CONTROLS_KEY = 'domaintrail.canvas.controls';

/**
 * The saved state, if it is one; expanded otherwise. The former choice of what to show (`{ zoom, legend }`) reads as
 * collapsed when both were hidden, else as expanded.
 */
export function parseControls(raw: string | null): ControlsState {
    try {
        const v: unknown = raw === null ? null : JSON.parse(raw);
        if (v && typeof v === 'object') {
            if ('collapsed' in v && typeof v.collapsed === 'boolean') return { collapsed: v.collapsed };
            if ('zoom' in v && 'legend' in v && typeof v.zoom === 'boolean' && typeof v.legend === 'boolean') return { collapsed: !v.zoom && !v.legend };
        }
    } catch {
        // not JSON
    }
    return EXPANDED;
}

// one state for every canvas of the page (the main canvas and the inspector's state diagram)
let state: ControlsState | null = null;
const listeners = new Set<() => void>();

function current(): ControlsState {
    if (!state) {
        let raw: string | null = null;
        try {
            raw = localStorage.getItem(CONTROLS_KEY);
        } catch {
            // storage unavailable (private mode, etc.)
        }
        state = parseControls(raw);
    }
    return state;
}

function update(next: ControlsState): void {
    state = next;
    try {
        localStorage.setItem(CONTROLS_KEY, JSON.stringify(next));
    } catch {
        // storage unavailable (private mode, etc.)
    }
    for (const l of listeners) l();
}

/** Whether the bottom-left controls are collapsed, shared by every canvas of the page. */
export interface CanvasControls {
    readonly collapsed: boolean;
    readonly toggle: () => void;
}

const subscribe = (l: () => void): (() => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
};

export function useCanvasControls(): CanvasControls {
    const s = useSyncExternalStore(subscribe, current, current);
    return { collapsed: s.collapsed, toggle: () => update(toggleCollapsed(current())) };
}
