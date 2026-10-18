import { useCallback, useState } from 'react';

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

/**
 * Drag handle between panes. `direction` is the axis of the size being changed;
 * `invert` makes dragging towards the start grow the pane (for panes on the right / bottom).
 * A function `max` is read when the drag starts (for limits that depend on the window size).
 */
export function Resizer(props: {
    direction: 'x' | 'y';
    size: number;
    min: number;
    max: number | (() => number);
    invert?: boolean;
    onResize: (size: number) => void;
}) {
    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const start = props.direction === 'x' ? e.clientX : e.clientY;
        const initial = props.size;
        const max = Math.max(props.min, typeof props.max === 'function' ? props.max() : props.max);
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        // panes follow the pointer without their open / close animation
        document.documentElement.classList.add('resizing');
        const move = (ev: PointerEvent) => {
            const delta = (props.direction === 'x' ? ev.clientX : ev.clientY) - start;
            const next = initial + (props.invert ? -delta : delta);
            props.onResize(Math.round(Math.min(max, Math.max(props.min, next))));
        };
        const up = () => {
            document.documentElement.classList.remove('resizing');
            target.removeEventListener('pointermove', move);
            target.removeEventListener('pointerup', up);
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
    };
    return <div className={`resizer resizer-${props.direction}`} onPointerDown={onPointerDown} role="separator" />;
}
