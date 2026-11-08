// The scene the canvas draws (`@domaintrail/visualization`'s drawing: every item at its place on the page with what it
// shows), and what the page does with one: which item draws an element, how a selection marks its copies and lines.
import type { Point, SceneEdge, SceneId, SceneItem, SceneNode } from '@domaintrail/visualization';

export {
    edgeItemId,
    ghostItemId,
    graphNodeOf,
    internalItemId,
    nodeItemId,
    rectCenter,
    rectContains,
    sceneItems,
    unionRects,
    type ChangeMark,
    type DiagMark,
    type EdgeProps,
    type EdgeTone,
    type GroupProps,
    type InternalProps,
    type NodeProps,
    type Point,
    type Rect,
    type Scene,
    type SceneEdge,
    type SceneGroup,
    type SceneId,
    type SceneInternal,
    type SceneItem,
    type SceneItemType,
    type SceneNode,
    type SettledHotspot,
} from '@domaintrail/visualization';

/**
 * The item drawing `elementId`: its node if it has one, else the first item that stands for it. An element drawn as
 * several notes (a storming's actor beside each command it issues) is the note nearest `near` (the viewport's centre),
 * or without it the first in reading order (top to bottom, then left to right).
 */
export function itemForElement(items: readonly SceneItem[], elementId: string, near?: Point): SceneItem | undefined {
    const nodes = items.filter((s): s is SceneNode => s.elementId === elementId && s.type === 'node');
    if (!nodes.length) return items.find((s) => s.elementId === elementId);
    const centre = (n: SceneNode): Point => ({ x: n.x + n.props.w / 2, y: n.y + n.props.h / 2 });
    const distance = (n: SceneNode): number => (near ? Math.hypot(centre(n).x - near.x, centre(n).y - near.y) : 0);
    return nodes.reduce((best, n) => {
        const [d, b] = [distance(n), distance(best)];
        return d < b || (d === b && (n.y < best.y || (n.y === best.y && n.x < best.x))) ? n : best;
    });
}

/** Reading order on a storming's canvas: left to right (the flow of time), then top to bottom. */
export const readingOrder = (a: Point, b: Point): number => a.x - b.x || a.y - b.y;

/** Where a note stands among its element's notes: the `k`-th (from 1, in reading order) of `n`. */
export interface CopyIndex {
    readonly k: number;
    readonly n: number;
}

/**
 * The notes of the elements whose notes are selected (`selected`), each with its place among its element's notes: an
 * element drawn more than once (a storming's actor, read model or aggregate beside each command that uses it) shows
 * all its notes, numbered 「k/n」, when one is selected. Elements drawn once are left out; so are ghosts.
 */
export function copyIndices(items: Iterable<SceneItem>, selected: ReadonlySet<SceneId>): Map<SceneId, CopyIndex> {
    // a hidden resolved hotspot (behind its sticky's check) is not a note
    const nodes = [...items].filter((s): s is SceneNode => s.type === 'node' && !s.ghost && s.on === undefined);
    const elements = new Set(nodes.filter((s) => selected.has(s.id)).map((s) => s.elementId));
    const out = new Map<SceneId, CopyIndex>();
    for (const element of elements) {
        const copies = nodes.filter((s) => s.elementId === element).sort(readingOrder);
        if (copies.length > 1) copies.forEach((c, i) => out.set(c.id, { k: i + 1, n: copies.length }));
    }
    return out;
}

/**
 * The lines joined to the selected storming notes, drawn thicker in the accent colour (nothing else changes around a
 * selection); none while only lines are selected, and none on the domain model's canvas.
 */
export function joinedEdges(items: Iterable<SceneItem>, selected: ReadonlySet<SceneId>): Set<SceneId> {
    const all = [...items];
    const notes = new Set(all.filter((s) => s.type === 'node' && !s.ghost && s.props.kind.startsWith('es') && selected.has(s.id)).map((s) => s.id));
    return new Set(all.filter((s): s is SceneEdge => s.type === 'edge' && !s.ghost && (notes.has(s.source) || notes.has(s.target))).map((s) => s.id));
}
