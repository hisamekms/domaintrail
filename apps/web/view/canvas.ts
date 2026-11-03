import { graphBounds, type LaidOutGraph } from '@domaintrail/visualization';
import { rectCenter, rectContains, type SceneId } from '../scene';
import type { DiagramCanvas } from './diagram';

export { graphBounds };

/**
 * Initial zoom never goes below this (in units of normal-size text), so text stays readable;
 * large diagrams are shown from the top-left.
 */
const MIN_INITIAL_ZOOM = 0.9;

export function fitReadable(canvas: DiagramCanvas, textScale = 1): void {
    const minZoom = MIN_INITIAL_ZOOM / textScale;
    canvas.fitContent();
    if (canvas.getZoom() >= minZoom) return;
    const bounds = canvas.contentBounds();
    if (!bounds) return;
    const screen = canvas.viewportScreenBounds();
    const margin = 24;
    canvas.setCamera({ ...canvas.getCamera(), z: minZoom });
    const center = rectCenter(bounds);
    canvas.centerOn({
        x: Math.min(center.x, bounds.x + screen.w / minZoom / 2 - margin),
        y: Math.min(center.y, bounds.y + screen.h / minZoom / 2 - margin),
    });
}

/** Fits the whole graph, zoomed in no further than normal size (for small panes, where `fitReadable` would crop). */
export function fitAll(canvas: DiagramCanvas, graph: LaidOutGraph, animate = false): void {
    const bounds = graphBounds(graph);
    if (bounds) canvas.fitBounds(bounds, { maxZoom: 1, inset: 16, animate });
}

/** What the camera does when a view's graph is drawn. */
export type CameraMove = 'keep' | 'restore' | 'fitAll' | 'fitReadable';

/**
 * A redraw of the shown graph (a live reload) keeps the camera. A newly shown graph gets its own camera back, fitted
 * readably the first time; a storming view, read as a whole timeline, is fitted whole every time its graph is shown.
 */
export function cameraMove(opts: { switched: boolean; storming: boolean; saved: boolean }): CameraMove {
    if (!opts.switched) return 'keep';
    if (opts.storming) return 'fitAll';
    return opts.saved ? 'restore' : 'fitReadable';
}

/** Selects the item of `id` if it is drawn, and brings it into view; otherwise clears the selection. */
export function highlightElement(canvas: DiagramCanvas, id: string): void {
    const item = canvas.findElement(id);
    if (!item) {
        canvas.selectNone();
        return;
    }
    showItem(canvas, item);
}

/** Selects an item and, unless it is wholly in view, centers it (animated). */
export function showItem(canvas: DiagramCanvas, item: SceneId): void {
    canvas.select([item]);
    const b = canvas.itemBounds(item);
    if (b && !rectContains(canvas.viewportPageBounds(), b)) canvas.centerOn(rectCenter(b), { animate: true });
}
