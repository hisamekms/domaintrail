// The camera's arithmetic, independent of the canvas library: the port's camera (`diagram.ts`) against a viewport
// transform, the zoom steps, the fits, the centring and the wheel zoom. They keep what the Live View did with tldraw
// (its `zoomIn` / `zoomOut`, `zoomToBounds`, `zoomToSelection`, `centerOnPoint` and wheel zoom), so that the canvas
// moves as before; `flow-canvas.tsx` applies them to React Flow.
import type { Point, Rect } from '../scene';
import type { Camera } from './diagram';

/** The zoom levels `zoomIn` and `zoomOut` step through; the first and the last are the zoom's limits. */
export const ZOOM_STEPS: readonly number[] = [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8];
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** How long an animated camera move takes. */
export const ANIMATION_MS = 200;

/** A size on the screen, in CSS pixels. */
export interface Size {
    readonly w: number;
    readonly h: number;
}

/**
 * A viewport transform, as React Flow (and d3-zoom) keep it: a point of the page is on the canvas at
 * `page * zoom + (x, y)`. The port's camera puts it at `(page + (x, y)) * z`.
 */
export interface Transform {
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
}

export const cameraToTransform = (c: Camera): Transform => ({ x: c.x * c.z, y: c.y * c.z, zoom: c.z });
export const transformToCamera = (t: Transform): Camera => ({ x: t.x / t.zoom, y: t.y / t.zoom, z: t.zoom });

const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** The next step up from `zoom`: a level less than half a step below a step counts as that step. */
export function zoomInStep(zoom: number): number {
    for (let i = 1; i < ZOOM_STEPS.length; i++) {
        const [z1, z2] = [ZOOM_STEPS[i - 1], ZOOM_STEPS[i]];
        if (z2 - zoom > (z2 - z1) / 2) return z2;
    }
    return MAX_ZOOM;
}

/** The next step down from `zoom`: a level less than half a step above a step counts as that step. */
export function zoomOutStep(zoom: number): number {
    for (let i = ZOOM_STEPS.length - 1; i > 0; i--) {
        const [z1, z2] = [ZOOM_STEPS[i - 1], ZOOM_STEPS[i]];
        if (z2 - zoom < (z2 - z1) / 2) return z1;
    }
    return MIN_ZOOM;
}

/** The camera at zoom `z` that keeps the page point under `at` (relative to the canvas's top-left corner) there. */
export function zoomAround(camera: Camera, at: Point, z: number): Camera {
    return { x: camera.x + (at.x / z - at.x) - (at.x / camera.z - at.x), y: camera.y + (at.y / z - at.y) - (at.y / camera.z - at.y), z };
}

/** The margin a fit leaves when it is not given one: 128 pixels in all, less on a narrow canvas. */
export const defaultInset = (size: Size): number => Math.min(128, size.w * 0.28);

/**
 * The camera showing `bounds` whole and centred on a canvas of `size`, with `inset` pixels in all around them, zoomed
 * in no further than `maxZoom` when it is given.
 */
export function fitCamera(bounds: Rect, size: Size, inset: number, maxZoom?: number): Camera {
    let z = clampZoom(Math.min((size.w - inset) / bounds.w, (size.h - inset) / bounds.h));
    if (maxZoom !== undefined) z = Math.min(maxZoom, z);
    return { x: -bounds.x + (size.w - bounds.w * z) / 2 / z, y: -bounds.y + (size.h - bounds.h * z) / 2 / z, z };
}

/**
 * How far a fit of the selection zooms in: at 100% it fits the selection whatever its size; at any other level it
 * goes no further than 100%.
 */
export const selectionMaxZoom = (zoom: number): number | undefined => (Math.abs(zoom - 1) < 0.01 ? undefined : 1);

/** The camera at zoom `z` that puts the page point `point` at the centre of a canvas of `size`. */
export function centerCamera(point: Point, size: Size, z: number): Camera {
    return { x: -(point.x - size.w / 2 / z), y: -(point.y - size.h / 2 / z), z };
}

/** The most a single wheel event zooms by (in hundredths of the zoom). */
const MAX_WHEEL_ZOOM_STEP = 10;

/**
 * The zoom after a wheel event with Ctrl or ⌘ (a trackpad's pinch is a wheel event with Ctrl): `deltaY` pixels down
 * zoom out by as many hundredths of the zoom, at most ten per event.
 */
export function wheelZoom(zoom: number, deltaY: number): number {
    const dy = Math.max(-MAX_WHEEL_ZOOM_STEP, Math.min(MAX_WHEEL_ZOOM_STEP, deltaY));
    return clampZoom(zoom - (dy / 100) * zoom);
}
