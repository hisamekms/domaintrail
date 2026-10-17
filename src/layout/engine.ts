import type { Graph, LaidOutGraph } from '../graph/ir.js';

/**
 * Computes absolute node positions and edge routes for a Graph IR.
 * Implementations: ELK (default). A D2/TALA adapter can implement the same interface.
 */
export interface LayoutEngine {
    readonly name: string;
    /** Bump when layout options change so that persisted layouts are recomputed. */
    readonly version: number;
    layout(graph: Graph): Promise<LaidOutGraph>;
}
