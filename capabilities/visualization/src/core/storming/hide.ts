// What a reader hides of a view of a storming, as the drawing does it (`HIDDEN_BY`'s `drawing` kinds, ADR 0032 §10):
// the same layout drawn without it, its place left empty, so that hiding it moves no note. The page does it alone, and
// `dt export svg` the same way.
import type { Graph, GraphNode } from '../graph/ir.js';
import type { Hideable } from './ir.js';

/** Whether a note of a view is left out of its drawing when `hidden` is hidden: a resolved hotspot, when they are. */
export const hiddenInDrawing = (node: Pick<GraphNode, 'kind' | 'status'>, hidden: ReadonlySet<Hideable>): boolean =>
    hidden.has('resolvedHotspots') && node.kind === 'esHotspot' && node.status === 'resolved';

/**
 * A view's graph drawn without what `hidden` hides: a hidden hotspot is folded (`GraphNode.folded`: not drawn, its
 * place left empty), with the notes it is `on` (its question's lines, which go with it), whose check stands for it.
 * Nothing moves. The graph itself when nothing of it is hidden.
 */
export function hideInDrawing<G extends Graph>(graph: G, hidden: ReadonlySet<Hideable>): G {
    const gone = new Set(graph.nodes.filter((n) => hiddenInDrawing(n, hidden)).map((n) => n.id));
    if (!gone.size) return graph;
    const on = (id: string): string[] => graph.edges.filter((e) => e.kind === 'esHotspot' && e.source === id && !gone.has(e.target)).map((e) => e.target);
    return {
        ...graph,
        nodes: graph.nodes.map((n): GraphNode => (gone.has(n.id) ? { ...n, folded: on(n.id) } : n)),
        edges: graph.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)),
    };
}

/** Whether a view's graph draws `elementId` (a note of it not hidden, `hiddenInDrawing`) when `hidden` is hidden. */
export const drawsElement = (graph: Pick<Graph, 'nodes'>, elementId: string, hidden: ReadonlySet<Hideable>): boolean =>
    graph.nodes.some((n) => n.elementId === elementId && !hiddenInDrawing(n, hidden));
