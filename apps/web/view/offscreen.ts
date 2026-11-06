// Where the stickies a selection points at lie when the canvas does not show them (docs/live-view.md, "Selection and
// lines"): the copies of a selected sticky's element, the two ends of a pressed line. Pure: `offscreen-pointers.tsx`
// draws a pointer at the canvas's edge for each side that has some.
import { rectCenter, type Point, type Rect, type SceneId } from '../scene';

/** A side of the canvas. */
export type Side = 'left' | 'right' | 'top' | 'bottom';

/** A sticky the canvas may not show: its item, and its bounds on the page. */
export interface Target {
    readonly id: SceneId;
    readonly rect: Rect;
}

/** The stickies out of view on one side, the nearest first, and where along that edge the pointer stands. */
export interface Pointer {
    readonly side: Side;
    readonly ids: readonly SceneId[];
    /** Where along the edge, from 0 (its top or left end) to 1, the nearest of them lies (kept off the corners). */
    readonly at: number;
}

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * The side of the viewport a rectangle lies beyond, or none while any part of it is in view: the side its centre is
 * farthest past, measured in the viewport's widths and heights (a sticky far to the right and a little below is on the
 * right).
 */
export function offscreenSide(rect: Rect, viewport: Rect): Side | undefined {
    if (overlaps(rect, viewport)) return undefined;
    const c = rectCenter(rect);
    const v = rectCenter(viewport);
    const dx = (c.x - v.x) / Math.max(viewport.w, 1);
    const dy = (c.y - v.y) / Math.max(viewport.h, 1);
    if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
    return dy < 0 ? 'top' : 'bottom';
}

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** How far from a corner a pointer stays, as a share of the edge. */
const CORNER = 0.12;

/**
 * The pointers for `targets` out of `viewport`: one per side that has some, in the order left, right, top, bottom; on
 * each, the targets nearest the viewport's centre first (a press goes to the first).
 */
export function offscreenPointers(targets: readonly Target[], viewport: Rect): Pointer[] {
    const centre = rectCenter(viewport);
    const sides: Side[] = ['left', 'right', 'top', 'bottom'];
    return sides.flatMap((side): Pointer[] => {
        const out = targets
            .filter((t) => offscreenSide(t.rect, viewport) === side)
            .sort((a, b) => distance(rectCenter(a.rect), centre) - distance(rectCenter(b.rect), centre));
        const first = out[0];
        if (!first) return [];
        const c = rectCenter(first.rect);
        const along = side === 'left' || side === 'right' ? (c.y - viewport.y) / Math.max(viewport.h, 1) : (c.x - viewport.x) / Math.max(viewport.w, 1);
        return [{ side, ids: out.map((t) => t.id), at: Math.min(1 - CORNER, Math.max(CORNER, along)) }];
    });
}

/** The arrow of a side, as the pointer shows it before its count: 「→ 2」. */
export const SIDE_ARROWS: Record<Side, string> = { left: '←', right: '→', top: '↑', bottom: '↓' };
