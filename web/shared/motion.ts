import { useEffect, useState } from 'react';

// The page's motion, in JavaScript: the durations are the CSS tokens of styles.css (`--motion-*`, the "motion"
// section), read from the page, so that the OS's "reduce motion" (which sets them to 0ms there) makes these instant too.

/** A CSS duration (`120ms`, `0.2s`) in milliseconds; 0 when it is not one. */
export function parseDuration(value: string): number {
    const m = /^\s*(-?[\d.]+)(ms|s)\s*$/.exec(value);
    if (!m) return 0;
    const n = Number(m[1]) * (m[2] === 's' ? 1000 : 1);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The duration of the motion token `name` (e.g. `--motion-swap`) on the page, in milliseconds (0 without a page). */
export function motionMs(name: string): number {
    if (typeof document === 'undefined') return 0;
    return parseDuration(getComputedStyle(document.documentElement).getPropertyValue(name));
}

/** Whether the panes are opening (`enter`: decelerating, a little longer) or closing (`exit`: shorter). */
export type PaneMotion = 'enter' | 'exit';

/**
 * The motion of the panes after their open states went from `before` to `after` (the same panes, in the same order):
 * `enter` as soon as one opens (the others give way at the same pace), `exit` when they only close, else `last`.
 */
export function paneMotion(before: readonly boolean[], after: readonly boolean[], last: PaneMotion): PaneMotion {
    if (after.some((open, i) => open && !before[i])) return 'enter';
    if (after.some((open, i) => !open && before[i])) return 'exit';
    return last;
}

/** The motion of the panes whose open states are `open` (see `paneMotion`), kept until they change again. */
export function usePaneMotion(open: readonly boolean[]): PaneMotion {
    const key = open.join();
    const [state, setState] = useState<{ key: string; open: readonly boolean[]; motion: PaneMotion }>({ key, open, motion: 'enter' });
    if (state.key !== key) {
        // derived from the previous render's states, during the render: the new widths get the new timing at once
        const next = { key, open, motion: paneMotion(state.open, open, state.motion) };
        setState(next);
        return next.motion;
    }
    return state.motion;
}

/**
 * `value`, shown `--motion-swap` later: meanwhile `swapping` is true, so that the old one fades out before the new one
 * is shown (and fades in). A change back before then cancels it; with no motion it is shown at once.
 */
export function useSwap<T>(value: T, token = '--motion-swap'): { shown: T; swapping: boolean } {
    const [shown, setShown] = useState(value);
    const instant = shown !== value && motionMs(token) === 0;
    useEffect(() => {
        if (shown === value) return;
        const timer = setTimeout(() => setShown(value), motionMs(token));
        return () => clearTimeout(timer);
    }, [value, shown, token]);
    if (instant) return { shown: value, swapping: false };
    return { shown, swapping: shown !== value };
}
