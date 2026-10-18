import { useCallback, useEffect, useState, type RefObject } from 'react';

/** State kept in localStorage (per browser). Falls back to memory when storage is unavailable. */
export function usePersistentState<T>(key: string, initial: T): [T, (value: T) => void] {
    const [value, setValue] = useState<T>(() => {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? initial : (JSON.parse(raw) as T);
        } catch {
            return initial;
        }
    });
    const set = useCallback(
        (v: T) => {
            setValue(v);
            try {
                localStorage.setItem(key, JSON.stringify(v));
            } catch {
                // storage unavailable (private mode, etc.)
            }
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
            if (root.current && !root.current.contains(e.target as Node)) close();
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

/**
 * Drag handle between panes. `direction` is the axis of the size being changed;
 * `invert` makes dragging towards the start grow the pane (for panes on the right / bottom).
 * A function `max` is read when the drag starts (for limits that depend on the window size).
 * Dragging the pane smaller than half of `min` closes it, and dragging the edge of a closed pane
 * (`collapsed` is what it shows then) opens it again.
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
}) {
    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const start = props.direction === 'x' ? e.clientX : e.clientY;
        const initial = props.size;
        const from = props.open ? initial : props.collapsed;
        const max = Math.max(props.min, typeof props.max === 'function' ? props.max() : props.max);
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
    return (
        <div
            className={`resizer resizer-${props.direction}`}
            onPointerDown={onPointerDown}
            role="separator"
            aria-orientation={props.direction === 'x' ? 'vertical' : 'horizontal'}
        />
    );
}
