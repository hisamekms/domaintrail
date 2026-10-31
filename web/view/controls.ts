import { useSyncExternalStore } from 'react';

/** What the canvas shows at its bottom-left: the zoom controls (− % + ⤢ ◎) and the legend (its button and panel). */
export interface ControlsVisibility {
    readonly zoom: boolean;
    readonly legend: boolean;
}

/**
 * The reader's choice from the canvas pane's menu (remembered per browser), and what the hide key put over it for
 * now (not remembered): pressing the key again goes back to the choice.
 */
export interface ControlsState {
    readonly chosen: ControlsVisibility;
    readonly override: ControlsVisibility | null;
}

export const ALL_SHOWN: ControlsVisibility = { zoom: true, legend: true };
const NONE_SHOWN: ControlsVisibility = { zoom: false, legend: false };

/** What is shown: the key's override while there is one, else the reader's choice. */
export const shownControls = (s: ControlsState): ControlsVisibility => s.override ?? s.chosen;

/**
 * The hide key: hides everything shown for now, or — when nothing is shown — shows everything for now; pressed again,
 * it goes back to the reader's choice.
 */
export function toggleTemporarily(s: ControlsState): ControlsState {
    if (s.override) return { ...s, override: null };
    const shown = shownControls(s);
    return { ...s, override: shown.zoom || shown.legend ? NONE_SHOWN : ALL_SHOWN };
}

/** A choice from the menu: it starts from what is shown (the key's override ends) and is remembered. */
export function choose(s: ControlsState, part: keyof ControlsVisibility, on: boolean): ControlsState {
    return { chosen: { ...shownControls(s), [part]: on }, override: null };
}

/** The zoom level as the cluster shows it (1 → `100%`). */
export const formatZoom = (zoom: number): string => `${Math.round(zoom * 100)}%`;

/** What a key press does on the canvas. */
export type CanvasShortcut = 'fitAll' | 'fitSelection' | 'toggleControls';

/**
 * The canvas's keys: `Shift+1` fits everything, `Shift+2` the selection (tldraw's own keys for the same, which the
 * canvas takes over so that they fit as its buttons do), and `U` hides or shows the bottom-left controls for now
 * (`H` is tldraw's hand tool). Nothing while typing, composing (IME) or with Ctrl / ⌘ / Alt; the digits are matched by
 * their key position, as Shift changes the character they type with the keyboard layout.
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

/** localStorage key of the reader's choice (JSON, like the other persisted settings). */
export const CONTROLS_KEY = 'domaintrail.canvas.controls';

/** The saved choice, if it is one; everything shown otherwise. */
export function parseChosen(raw: string | null): ControlsVisibility {
    try {
        const v: unknown = raw === null ? null : JSON.parse(raw);
        if (v && typeof v === 'object' && 'zoom' in v && 'legend' in v && typeof v.zoom === 'boolean' && typeof v.legend === 'boolean')
            return { zoom: v.zoom, legend: v.legend };
    } catch {
        // not JSON
    }
    return ALL_SHOWN;
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
        state = { chosen: parseChosen(raw), override: null };
    }
    return state;
}

function update(next: ControlsState): void {
    state = next;
    try {
        localStorage.setItem(CONTROLS_KEY, JSON.stringify(next.chosen));
    } catch {
        // storage unavailable (private mode, etc.)
    }
    for (const l of listeners) l();
}

/** The bottom-left controls' visibility, shared by every canvas of the page. */
export interface CanvasControls {
    readonly shown: ControlsVisibility;
    readonly choose: (part: keyof ControlsVisibility, on: boolean) => void;
    readonly toggleTemporarily: () => void;
}

const subscribe = (l: () => void): (() => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
};

export function useCanvasControls(): CanvasControls {
    const s = useSyncExternalStore(subscribe, current, current);
    return {
        shown: shownControls(s),
        choose: (part, on) => update(choose(current(), part, on)),
        toggleTemporarily: () => update(toggleTemporarily(current())),
    };
}
