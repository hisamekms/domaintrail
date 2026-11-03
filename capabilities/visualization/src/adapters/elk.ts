import { createRequire } from 'node:module';
import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk-api.js';
import {
    CONTAINER_PADDING,
    LINE_HEIGHT,
    TRANSITION_LINE_HEIGHT,
    TRANSITION_SUB_LINE_HEIGHT,
    TRANSITION_SUB_SIZE,
    graphSignature,
    maxUnits,
    transitionText,
    type Graph,
    type GraphEdge,
    type LaidOutGraph,
    type LayoutSpacing,
    type NodeLayout,
    type Point,
    type Texts,
} from '../core/graph/ir.js';
import type { LayoutEngine, LayoutOptions } from '../application/layout-engine.js';

const ROOT = '__root__';
const IS_BUN = 'Bun' in globalThis;
const WORKER_SCRIPT = 'elkjs/lib/elk-worker.min.js';

/**
 * elk.bundled.js mis-detects Bun as a web worker (global `self`), so on Bun ELK runs in a real Worker.
 * Node has no Web Worker; there ELK runs in-process through the worker script's own fake Worker.
 */
/* oxlint-disable typescript/no-unsafe-type-assertion -- ELK types its worker factory loosely; either Worker serves it */
function createWorker(url?: string): never {
    if (IS_BUN) return new Worker(import.meta.resolve(WORKER_SCRIPT)) as never;
    const { Worker: FakeWorker } = createRequire(import.meta.url)(WORKER_SCRIPT) as { Worker: new (url?: string) => unknown };
    return new FakeWorker(url) as never;
}
/* oxlint-enable typescript/no-unsafe-type-assertion */

/** Approximate width of one character of an edge label (13px sans-serif). */
const LABEL_CHAR_WIDTH = 7.6;

const BASE_OPTIONS: Record<string, string> = {
    'elk.algorithm': 'layered',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.edgeRouting': 'ORTHOGONAL',
    // Prefer the declaration order of the source; keeps layouts stable for small edits.
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
    'elk.randomSeed': '1',
    'elk.edgeLabels.placement': 'CENTER',
};

/**
 * The gaps between things, by spacing. The compact ones close up the gaps between notes and containers while leaving
 * room for an arrowhead between layers, for an edge's label beside its line and between parallel edges.
 */
export const SPACING_OPTIONS: Record<LayoutSpacing, Record<string, string>> = {
    normal: {
        'elk.layered.spacing.nodeNodeBetweenLayers': '60',
        'elk.spacing.nodeNode': '40',
        'elk.spacing.edgeNode': '24',
        'elk.spacing.edgeEdge': '16',
        'elk.spacing.edgeLabel': '6',
    },
    compact: {
        'elk.layered.spacing.nodeNodeBetweenLayers': '20',
        'elk.spacing.nodeNode': '12',
        'elk.spacing.edgeNode': '8',
        'elk.spacing.edgeEdge': '6',
        'elk.spacing.edgeLabel': '3',
    },
};

/** A container's padding beside and below its children, by spacing (its top holds its label and description). */
const CONTAINER_SIDES: Record<LayoutSpacing, { left: number; bottom: number; right: number }> = {
    normal: CONTAINER_PADDING,
    compact: { left: 10, bottom: 10, right: 10 },
};

const DIRECTION: Record<string, string> = {
    structure: 'DOWN',
    // same direction as the detail mode, so switching keeps the mental map
    'structure-overview': 'DOWN',
    'structure-aggregates': 'DOWN',
    // shown in the inspector, which is tall and narrow
    states: 'DOWN',
    // Event Storming reads left to right, along its timelines (spec §10.1)
    storming: 'RIGHT',
};

/**
 * Edge options by kind. ELK reverses some edges of a cycle to lay it out; a timeline's order goes first (spec §10.2), so a
 * causal cycle back to an earlier event never turns a timeline around.
 */
const EDGE_OPTIONS: Partial<Record<GraphEdge['kind'], Record<string, string>>> = {
    esSequence: { 'elk.layered.priority.direction': '10' },
};

/** An edge's label box; a transition's is sized for the texts the graph shows (a second, smaller line for its events). */
function labelOf(e: GraphEdge, label: Texts, graph: Graph, scale: number): { text: string; width: number; height: number } {
    const text: { main: Texts; sub?: Texts } = e.kind === 'transition' ? transitionText(label, e.events, graph.transitionLabels ?? 'both') : { main: label };
    const units = Math.max(maxUnits(text.main), text.sub ? maxUnits(text.sub) * TRANSITION_SUB_SIZE : 0);
    const height = TRANSITION_LINE_HEIGHT + (text.sub ? TRANSITION_SUB_LINE_HEIGHT : 0);
    return { text: text.main.en.name, width: Math.ceil(units * LABEL_CHAR_WIDTH * scale) + 8, height: Math.ceil(height * scale) };
}

export class ElkLayoutEngine implements LayoutEngine {
    readonly name = 'elk';
    readonly version = 11;
    private readonly elk = new ELK({ workerFactory: createWorker });

    /** Stops the layout worker so the process can exit (the in-process fake Worker has nothing to stop). */
    dispose(): void {
        if (IS_BUN) this.elk.terminateWorker();
    }

    async layout(graph: Graph, options: LayoutOptions = {}): Promise<LaidOutGraph> {
        const scale = graph.textScale ?? 1;
        const spacing = options.spacing ?? 'normal';
        const sides = CONTAINER_SIDES[spacing];
        const children = new Map<string, ElkNode[]>();
        const elkNodes = new Map<string, ElkNode>();
        const containers = new Set(graph.nodes.map((n) => n.parent).filter((p): p is string => !!p));
        const direction = DIRECTION[graph.id.split(':')[0]] ?? 'DOWN';
        // ELK applies the minimum size of a container transposed in a vertical layout
        const minimum = (w: number, h: number): string => (direction === 'DOWN' || direction === 'UP' ? `(${h},${w})` : `(${w},${h})`);

        for (const n of graph.nodes) {
            const node: ElkNode = { id: n.id, children: [] };
            if (containers.has(n.id)) {
                // a context's description is drawn under its label
                const top = Math.round(CONTAINER_PADDING.top * scale) + n.lines.length * LINE_HEIGHT;
                node.layoutOptions = {
                    'elk.padding': `[top=${top},left=${sides.left},bottom=${sides.bottom},right=${sides.right}]`,
                    'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                    'elk.nodeSize.minimum': minimum(Math.ceil(Math.max(160, maxUnits(n.label) * 10.5 * scale + 40, n.width)), Math.max(60, n.height)),
                };
            } else {
                node.width = n.width;
                node.height = n.height;
            }
            const at = options.positions?.[n.id];
            if (at) node.layoutOptions = { ...node.layoutOptions, 'elk.position': `(${at.x},${at.y})` };
            elkNodes.set(n.id, node);
            const parent = n.parent && graph.nodes.some((p) => p.id === n.parent) ? n.parent : ROOT;
            children.set(parent, [...(children.get(parent) ?? []), node]);
        }
        for (const [parent, list] of children) {
            if (parent !== ROOT) elkNodes.get(parent)!.children = list;
        }

        const edges: ElkExtendedEdge[] = graph.edges
            .filter((e) => elkNodes.has(e.source) && elkNodes.has(e.target))
            .map((e) => ({
                id: e.id,
                sources: [e.source],
                targets: [e.target],
                labels: e.label ? [labelOf(e, e.label, graph, scale)] : [],
                ...(EDGE_OPTIONS[e.kind] && { layoutOptions: EDGE_OPTIONS[e.kind] }),
            }));

        const root: ElkNode = {
            id: ROOT,
            layoutOptions: {
                ...BASE_OPTIONS,
                ...SPACING_OPTIONS[spacing],
                'elk.direction': direction,
                // An incremental layout orders the nodes within each layer by their previous positions instead of the model
                // order. It never changes their layers, so the order along edges (a timeline's) is the canonical one's.
                ...(options.positions && { 'elk.layered.crossingMinimization.semiInteractive': 'true', 'elk.layered.considerModelOrder.strategy': 'NONE' }),
            },
            children: children.get(ROOT) ?? [],
            edges,
        };
        const result = await this.elk.layout(root);

        const nodeLayout: Record<string, NodeLayout> = {};
        const absolute = new Map<string, Point>([[ROOT, { x: 0, y: 0 }]]);
        const walk = (node: ElkNode, offset: Point): void => {
            for (const c of node.children ?? []) {
                const pos = { x: offset.x + (c.x ?? 0), y: offset.y + (c.y ?? 0) };
                absolute.set(c.id, pos);
                nodeLayout[c.id] = { ...pos, width: c.width ?? 0, height: c.height ?? 0 };
                walk(c, pos);
            }
        };
        walk(result, { x: 0, y: 0 });

        const edgeLayout: LaidOutGraph['edgeLayout'] = {};
        const collect = (node: ElkNode): void => {
            for (const e of (node.edges ?? []) as (ElkExtendedEdge & { container?: string })[]) {
                const off = absolute.get(e.container ?? node.id) ?? { x: 0, y: 0 };
                const s = e.sections?.[0];
                if (!s) continue;
                const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: p.x + off.x, y: p.y + off.y }));
                const lbl = e.labels?.[0];
                edgeLayout[e.id] = {
                    points: pts,
                    label: lbl ? { x: (lbl.x ?? 0) + off.x, y: (lbl.y ?? 0) + off.y, width: lbl.width ?? 0, height: lbl.height ?? 0 } : undefined,
                };
            }
            for (const c of node.children ?? []) collect(c);
        };
        collect(result);

        return { ...graph, nodeLayout, edgeLayout, signature: graphSignature(graph), ...(spacing === 'compact' && { spacing }) };
    }
}
