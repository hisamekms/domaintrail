// The part of the page a laid-out graph covers: what the Live View fits and what an export shows.
import type { LaidOutGraph } from '../graph/ir.js';
import { unionRects, type Rect } from './scene.js';

/** Everything the graph draws, edge labels included (they stick out of the shapes' bounds). */
export function graphBounds(graph: LaidOutGraph): Rect | undefined {
    const boxes = [
        ...Object.values(graph.nodeLayout),
        ...Object.values(graph.edgeLayout).flatMap((e) => [...(e.label ? [e.label] : []), ...e.points.map((p) => ({ ...p, width: 0, height: 0 }))]),
    ];
    return unionRects(boxes.map((b) => ({ x: b.x, y: b.y, w: b.width, h: b.height })));
}

/** Room around the diagram in an export (the portable SVG adds its own margin around everything). */
const EXPORT_MARGIN = 8;

/** The part of the page an export shows: everything the graph draws, with a little room for the marks on its boxes. */
export function exportBounds(graph: LaidOutGraph): Rect {
    const b = graphBounds(graph) ?? { x: 0, y: 0, w: 1, h: 1 };
    return { x: b.x - EXPORT_MARGIN, y: b.y - EXPORT_MARGIN - 4, w: b.w + 2 * EXPORT_MARGIN, h: b.h + 2 * EXPORT_MARGIN + 4 };
}
