import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/** What persisted state needs of a storage (localStorage, or a stand-in in the tests). */
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The storage of the page, or undefined where there is none (or it cannot even be reached). */
function pageStorage(): KeyValueStorage | undefined {
    try {
        return typeof localStorage === 'undefined' ? undefined : localStorage;
    } catch {
        return undefined;
    }
}

/** The value stored as JSON under `key`, else `initial` (nothing stored, a storage that throws, or a value that does not parse). */
export function readStored<T>(key: string, initial: T, storage: KeyValueStorage | undefined = pageStorage()): T {
    try {
        const raw = storage?.getItem(key) ?? null;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stored by writeStored from a T
        return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
        return initial;
    }
}

/** Stores `value` as JSON under `key`; a storage that throws (private mode, full) leaves it in memory only. */
export function writeStored(key: string, value: unknown, storage: KeyValueStorage | undefined = pageStorage()): void {
    try {
        storage?.setItem(key, JSON.stringify(value));
    } catch {
        // storage unavailable (private mode, etc.)
    }
}

/** State kept in localStorage (per browser). Falls back to memory when storage is unavailable. */
export function usePersistentState<T>(key: string, initial: T): [T, (value: T) => void] {
    const [value, setValue] = useState<T>(() => readStored(key, initial));
    const set = useCallback(
        (v: T) => {
            setValue(v);
            writeStored(key, v);
        },
        [key],
    );
    return [value, set];
}

/** Closes a dropdown on a click outside `root` or on Escape. */
export function useDismiss(open: boolean, root: RefObject<HTMLElement | null>, close: () => void): void {
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (root.current && !(e.target instanceof Node && root.current.contains(e.target))) close();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') close();
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open, root, close]);
}

/**
 * Where a drag of a pane's edge leaves the pane. `raw` is the size the pointer asks for
 * (measured from the closed pane's `collapsed` size when it was closed).
 * Below half of `min` the pane closes and keeps `initial` (its size before the drag), so that it reopens at that size;
 * otherwise it is open at `raw` within `min` and `max`.
 */
export function dragPane(raw: number, initial: number, min: number, max: number): { open: boolean; size: number } {
    if (raw < min / 2) return { open: false, size: initial };
    return { open: true, size: Math.round(Math.min(max, Math.max(min, raw))) };
}

/** A pane's size within `min` and `max`, in whole px; `min` wins when there is less room than it. */
export function clampSize(size: number, min: number, max: number): number {
    return Math.round(Math.max(min, Math.min(max, size)));
}

/** How far an arrow key moves a resizer (px), and with Shift. */
export const KEY_STEP = 16;
export const KEY_STEP_LARGE = 64;

/**
 * The size after a key on a resizer, or undefined for a key it does not take: the arrows along its axis step it (the
 * one pointing away from the pane grows it, as a drag that way would), Shift in larger steps; Home and End go to
 * `min` and `max`.
 */
export function keyedSize(
    key: string,
    shift: boolean,
    size: number,
    o: { direction: 'x' | 'y'; invert?: boolean; min: number; max: number },
): number | undefined {
    const [back, forth] = o.direction === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const step = shift ? KEY_STEP_LARGE : KEY_STEP;
    const sign = o.invert ? -1 : 1;
    switch (key) {
        case back:
            return clampSize(size - sign * step, o.min, o.max);
        case forth:
            return clampSize(size + sign * step, o.min, o.max);
        case 'Home':
            return clampSize(o.min, o.min, o.max);
        case 'End':
            return clampSize(o.max, o.min, o.max);
        default:
            return undefined;
    }
}

/** The height of `ref`'s element (0 until it is laid out), followed as it changes. */
export function useElementHeight(ref: RefObject<HTMLElement | null>): number {
    const [height, setHeight] = useState(0);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const update = (): void => setHeight(el.clientHeight);
        update();
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, [ref]);
    return height;
}

/**
 * Drag handle between panes. `direction` is the axis of the size being changed;
 * `invert` makes dragging towards the start grow the pane (for panes on the right / bottom).
 * A function `max` is read when the drag starts (for limits that depend on the window size).
 * Dragging the pane smaller than half of `min` closes it, and dragging the edge of a closed pane
 * (`collapsed` is what it shows then) opens it again.
 * It is a focusable separator: the arrow keys along its axis resize the pane (a growing one opens a closed pane), Home
 * and End go to the limits, and a double click calls `onReset` (the default size).
 */
export function Resizer(props: {
    direction: 'x' | 'y';
    size: number;
    min: number;
    max: number | (() => number);
    invert?: boolean;
    open: boolean;
    collapsed: number;
    onResize: (size: number) => void;
    onOpenChange: (open: boolean) => void;
    /** The separator's accessible name. */
    label: string;
    onReset?: () => void;
    /** Draws a grip in its middle, for a handle that is always visible. */
    grip?: boolean;
}) {
    const readMax = (): number => Math.max(props.min, typeof props.max === 'function' ? props.max() : props.max);
    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const start = props.direction === 'x' ? e.clientX : e.clientY;
        const initial = props.size;
        const from = props.open ? initial : props.collapsed;
        const max = readMax();
        let open = props.open;
        let size = initial;
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        // panes follow the pointer without their open / close animation
        document.documentElement.classList.add('resizing');
        const move = (ev: PointerEvent) => {
            const delta = (props.direction === 'x' ? ev.clientX : ev.clientY) - start;
            const next = dragPane(from + (props.invert ? -delta : delta), initial, props.min, max);
            if (next.size !== size) props.onResize((size = next.size));
            if (next.open !== open) props.onOpenChange((open = next.open));
        };
        const up = () => {
            document.documentElement.classList.remove('resizing');
            target.removeEventListener('pointermove', move);
            target.removeEventListener('pointerup', up);
            target.removeEventListener('pointercancel', up);
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
        target.addEventListener('pointercancel', up);
    };
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
        const next = keyedSize(e.key, e.shiftKey, props.size, { direction: props.direction, invert: !!props.invert, min: props.min, max: readMax() });
        if (next === undefined) return;
        e.preventDefault();
        if (!props.open) {
            // a closed pane: a key that grows it opens it at its size
            if (next > props.size || e.key === 'End') props.onOpenChange(true);
            return;
        }
        if (next !== props.size) props.onResize(next);
    };
    return (
        <div
            className={`resizer resizer-${props.direction}${props.grip ? ' resizer-grip' : ''}`}
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
            onDoubleClick={props.onReset}
            role="separator"
            tabIndex={0}
            aria-label={props.label}
            aria-orientation={props.direction === 'x' ? 'vertical' : 'horizontal'}
            aria-valuenow={props.open ? props.size : 0}
            aria-valuemin={props.min}
            aria-valuemax={typeof window === 'undefined' && typeof props.max === 'function' ? undefined : readMax()}
        />
    );
}
