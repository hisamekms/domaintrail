import { useEffect } from 'react';
import { Box, react, type Editor } from 'tldraw';
import type { LaidOutGraph } from '../src/graph/ir';
import { findShapeForElement } from './render';

/**
 * Initial zoom never goes below this (in units of normal-size text), so text stays readable;
 * large diagrams are shown from the top-left.
 */
const MIN_INITIAL_ZOOM = 0.9;

export function fitReadable(editor: Editor, textScale = 1): void {
    const minZoom = MIN_INITIAL_ZOOM / textScale;
    editor.zoomToFit();
    if (editor.getZoomLevel() >= minZoom) return;
    const bounds = editor.getCurrentPageBounds();
    if (!bounds) return;
    const screen = editor.getViewportScreenBounds();
    const margin = 24;
    editor.setCamera({ ...editor.getCamera(), z: minZoom });
    editor.centerOnPoint({
        x: Math.min(bounds.center.x, bounds.x + screen.w / minZoom / 2 - margin),
        y: Math.min(bounds.center.y, bounds.y + screen.h / minZoom / 2 - margin),
    });
}

/** Everything the graph draws, edge labels included (they stick out of the shapes' bounds). */
function graphBounds(graph: LaidOutGraph): Box | undefined {
    const boxes = [
        ...Object.values(graph.nodeLayout),
        ...Object.values(graph.edgeLayout).flatMap((e) => [...(e.label ? [e.label] : []), ...e.points.map((p) => ({ ...p, width: 0, height: 0 }))]),
    ];
    return boxes.length ? Box.Common(boxes.map((b) => new Box(b.x, b.y, b.width, b.height))) : undefined;
}

/** Fits the whole graph, zoomed in no further than normal size (for small panes, where `fitReadable` would crop). */
export function fitAll(editor: Editor, graph: LaidOutGraph, animate = false): void {
    const bounds = graphBounds(graph);
    if (bounds) editor.zoomToBounds(bounds, { targetZoom: 1, inset: 16, animation: animate ? { duration: 200 } : undefined });
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

/** Selects the shape of `id` if it is drawn, and brings it into view; otherwise clears the selection. */
export function highlightElement(editor: Editor, id: string): void {
    const shape = findShapeForElement(editor, id);
    if (!shape) {
        editor.selectNone();
        return;
    }
    editor.select(shape);
    const b = editor.getShapePageBounds(shape);
    if (b && !editor.getViewportPageBounds().contains(b)) editor.centerOnPoint(b.center, { animation: { duration: 200 } });
}

/**
 * tldraw hit-tests shapes itself (DOM hover never reaches them) and resets the cursor on its own state changes
 * (e.g. after a click), so the pointer cursor is re-derived whenever the hover target or the cursor changes.
 */
export function usePointerCursor(editor: Editor | null): void {
    useEffect(() => {
        if (!editor) return;
        return react('pointer cursor', () => {
            const id = editor.getHoveredShapeId();
            const shape = id ? editor.getShape(id) : undefined;
            const clickable = !!shape && !(shape.meta as { ghost?: boolean }).ghost;
            const cursor = editor.getInstanceState().cursor.type;
            if (clickable && cursor === 'default') editor.setCursor({ type: 'pointer', rotation: 0 });
            else if (!clickable && cursor === 'pointer') editor.setCursor({ type: 'default', rotation: 0 });
        });
    }, [editor]);
}
