import type { Graph, LaidOutGraph, Point } from '../domain/graph/ir.js';

export interface LayoutOptions {
    /**
     * Where some nodes were in a previous layout of the graph (by node ID): hints for an incremental layout that moves
     * existing nodes as little as it can. Without them, the layout is canonical (the same graph, the same layout).
     */
    positions?: Readonly<Record<string, Point>>;
}

/**
 * Computes absolute node positions and edge routes for a Graph IR.
 * Implementations: ELK (default). A D2/TALA adapter can implement the same interface.
 */
export interface LayoutEngine {
    readonly name: string;
    /** Bump when layout options change so that persisted layouts are recomputed. */
    readonly version: number;
    layout(graph: Graph, options?: LayoutOptions): Promise<LaidOutGraph>;
}
