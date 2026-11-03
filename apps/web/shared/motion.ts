import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

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

/** The easing token `name` (e.g. `--motion-ease-enter`) on the page, as a CSS easing (`ease-out` without a page). */
export function motionEasing(name: string): string {
    if (typeof document === 'undefined') return 'ease-out';
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || 'ease-out';
}

/** A box's height moving from `from` to `to` pixels in `ms`. */
export interface Grow {
    readonly from: number;
    readonly to: number;
    readonly ms: number;
}

/**
 * The growth of a box whose content changed: from the height it had (`undefined`: it had none to grow from, so it is
 * shown as it is) to its new one, in `ms`; none with no motion (`ms` 0: "reduce motion") or when the height is the same.
 */
export function growMotion(from: number | undefined, to: number, ms: number): Grow | undefined {
    if (from === undefined || ms <= 0 || Math.abs(to - from) < 1) return undefined;
    return { from, to, ms };
}

/**
 * A box that grows to its new content instead of jumping to it: as `key` changes, its height moves from the one it had
 * to the new one (`--motion-grow`, decelerating) while the content fades in. One measure per change, after the change
 * (the height before is the one measured at the change before); `fromNothing`: on its first showing it grows from 0
 * (a row that arrived live). Nothing moves with "reduce motion".
 */
export function useGrow<E extends HTMLElement>(key: unknown, fromNothing = false): RefObject<E | null> {
    const ref = useRef<E | null>(null);
    const last = useRef<number | undefined>(undefined);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const to = el.getBoundingClientRect().height;
        const from = last.current ?? (fromNothing ? 0 : undefined);
        last.current = to;
        const grow = growMotion(from, to, motionMs('--motion-grow'));
        if (!grow || typeof el.animate !== 'function') return;
        // clipped while it grows: the new content is taller than the box until the end
        el.style.overflow = 'clip';
        const animation = el.animate(
            [
                { height: `${grow.from}px`, opacity: 0 },
                { height: `${grow.to}px`, opacity: 1 },
            ],
            { duration: grow.ms, easing: motionEasing('--motion-ease-enter') },
        );
        const done = (): void => {
            el.style.removeProperty('overflow');
        };
        animation.onfinish = done;
        return () => {
            animation.cancel();
            done();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    return ref;
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

/** The clock a hold runs on (the page's timers; a fake one in the tests). */
export interface HoldClock {
    now(): number;
    /** Runs `run` in `ms`; what it returns cancels it. */
    after(ms: number, run: () => void): () => void;
}

const PAGE_CLOCK: HoldClock = {
    now: () => Date.now(),
    after: (ms, run) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
    },
};

/** A value held on screen (see `useHeld`): `set` it as it changes, `cancel` drops what waits (the line unmounting). */
export interface Hold<T> {
    set(value: T | undefined): void;
    cancel(): void;
}

/**
 * The timing of `useHeld`, without React: `show` is called with each value to show. A value is shown for `holdMs` at
 * least; what is set meanwhile waits for the end of it, and a newer value replaces the waiting one (only the latest is
 * shown, nothing is replayed). The first value, and a change from or to `undefined` (nothing shown), are shown at once.
 * `same` tells a value that did not change (shown or waiting, it is then left as it is).
 */
export function createHold<T>(
    initial: T | undefined,
    holdMs: number,
    show: (value: T | undefined) => void,
    same: (a: T, b: T) => boolean = Object.is,
    clock: HoldClock = PAGE_CLOCK,
): Hold<T> {
    let shown = initial;
    let since = clock.now();
    let timer: (() => void) | undefined;
    const cancel = (): void => {
        timer?.();
        timer = undefined;
    };
    const apply = (value: T | undefined): void => {
        timer = undefined;
        shown = value;
        since = clock.now();
        show(value);
    };
    return {
        set(value) {
            cancel();
            if (shown === undefined || value === undefined) {
                if (shown !== value) apply(value);
                return;
            }
            if (same(shown, value)) return;
            const wait = since + holdMs - clock.now();
            if (wait <= 0) apply(value);
            else timer = clock.after(wait, () => apply(value));
        },
        cancel,
    };
}

/**
 * `value`, held on screen `holdMs` at least (see `createHold`): a value that changes faster than one can read shows
 * the latest one at that pace. This is a pace, not a motion: it is the same with "reduce motion".
 */
export function useHeld<T>(value: T | undefined, holdMs: number, same?: (a: T, b: T) => boolean): T | undefined {
    const [shown, setShown] = useState(value);
    const [hold] = useState(() => createHold(value, holdMs, setShown, same));
    useEffect(() => hold.set(value), [hold, value]);
    // what waits is dropped with the component (the run ended, the line left the page)
    useEffect(() => () => hold.cancel(), [hold]);
    return shown;
}
