import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';
import { usePersistentState } from '../shared/layout';
import {
    clampComposerRows,
    COMPOSER_ROWS_KEY,
    DEFAULT_COMPOSER_ROWS,
    draggedComposerRows,
    keyedComposerRows,
    maxComposerRows,
    MIN_COMPOSER_ROWS,
} from './composer-size';

/** The composer's height in rows, the most it can have now, and the way to change it. */
export interface ComposerSize {
    rows: number;
    max: number;
    setRows: (rows: number) => void;
    input: RefObject<HTMLTextAreaElement | null>;
}

/** A row of the text and the rest of the box (padding, border), in px, as the textarea shows them now. */
function measure(el: HTMLTextAreaElement): { row: number; extra: number } {
    const style = getComputedStyle(el);
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const row = (el.clientHeight - padding) / Math.max(1, el.rows);
    return { row, extra: el.offsetHeight - row * Math.max(1, el.rows) };
}

/**
 * The height of the composer's text, remembered per browser, at most a share of the chat pillar's height (measured
 * again when the pillar or the text size changes; the saved choice is kept and shown again once there is room).
 */
export function useComposerSize(input: RefObject<HTMLTextAreaElement | null>): ComposerSize {
    const [saved, setSaved] = usePersistentState<number>(COMPOSER_ROWS_KEY, DEFAULT_COMPOSER_ROWS);
    const [max, setMax] = useState(Number.POSITIVE_INFINITY);
    useLayoutEffect(() => {
        const el = input.current;
        const pillar = el?.closest<HTMLElement>('.session-chat');
        if (!el || !pillar) return;
        const update = (): void => {
            const { row, extra } = measure(el);
            setMax(maxComposerRows(pillar.clientHeight, row, extra));
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(pillar);
        observer.observe(el);
        return () => observer.disconnect();
    }, [input]);
    const setRows = useCallback((rows: number) => setSaved(clampComposerRows(rows, max)), [setSaved, max]);
    return { rows: clampComposerRows(saved, max), max: Math.max(MIN_COMPOSER_ROWS, Math.min(max, 1000)), setRows, input };
}

/**
 * The handle on the composer's top edge: dragging it up makes the text taller (by whole rows), ↑/↓ by a row,
 * Home/End to the fewest/most, a double click back to the default.
 */
export function ComposerResizer(props: ComposerSize & { label: string }) {
    const { rows, max, setRows, input, label } = props;
    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
        const el = input.current;
        if (!el || e.button !== 0) return;
        e.preventDefault();
        const start = e.clientY;
        const { row } = measure(el);
        let current = rows;
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        // no animation while dragging
        document.documentElement.classList.add('resizing');
        const move = (ev: PointerEvent): void => {
            const next = draggedComposerRows(rows, ev.clientY - start, row, max);
            if (next !== current) setRows((current = next));
        };
        const up = (): void => {
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
            className="chat-composer-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label={label}
            aria-valuemin={MIN_COMPOSER_ROWS}
            aria-valuemax={max}
            aria-valuenow={rows}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onDoubleClick={() => setRows(DEFAULT_COMPOSER_ROWS)}
            onKeyDown={(e) => {
                const next = keyedComposerRows(e.key, rows, max);
                if (next === undefined) return;
                e.preventDefault();
                setRows(next);
            }}
        />
    );
}
