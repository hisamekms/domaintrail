import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether one canvas's bottom-left controls (− % + ⤢ ◎ and the legend) are collapsed into one » button. Each canvas
 * remembers its state per browser; the bar's « and » buttons and the `U` key toggle only that canvas's controls.
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

/** Former shared localStorage key, read as the initial value for controls without an individual setting. */
export const CONTROLS_KEY = 'domaintrail.canvas.controls';
export const controlsStorageKey = (id: string): string => `${CONTROLS_KEY}.${encodeURIComponent(id)}`;

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

const states = new Map<string, ControlsState>();
const listeners = new Map<string, Set<() => void>>();

function current(id: string): ControlsState {
    let state = states.get(id);
    if (!state) {
        let raw: string | null = null;
        try {
            raw = localStorage.getItem(controlsStorageKey(id)) ?? localStorage.getItem(CONTROLS_KEY);
        } catch {
            // storage unavailable (private mode, etc.)
        }
        state = parseControls(raw);
        states.set(id, state);
    }
    return state;
}

function update(id: string, next: ControlsState): void {
    states.set(id, next);
    try {
        localStorage.setItem(controlsStorageKey(id), JSON.stringify(next));
    } catch {
        // storage unavailable (private mode, etc.)
    }
    for (const l of listeners.get(id) ?? []) l();
}

/** Whether this canvas's bottom-left controls are collapsed. */
export interface CanvasControls {
    readonly collapsed: boolean;
    readonly toggle: () => void;
}

const subscribe = (id: string, l: () => void): (() => void) => {
    const own = listeners.get(id) ?? new Set<() => void>();
    own.add(l);
    listeners.set(id, own);
    return () => {
        own.delete(l);
        if (own.size === 0) listeners.delete(id);
    };
};

export function useCanvasControls(id: string): CanvasControls {
    const subscribeOwn = useCallback((l: () => void) => subscribe(id, l), [id]);
    const snapshot = useCallback(() => current(id), [id]);
    const s = useSyncExternalStore(subscribeOwn, snapshot, snapshot);
    return { collapsed: s.collapsed, toggle: () => update(id, toggleCollapsed(current(id))) };
}
