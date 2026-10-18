import { createRequire } from 'node:module';
import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk-api.js';
import { CONTAINER_PADDING, graphSignature, maxUnits, type Graph, type LaidOutGraph, type NodeLayout, type Point } from '../graph/ir.js';
import type { LayoutEngine } from './engine.js';

const ROOT = '__root__';
const IS_BUN = 'Bun' in globalThis;
const WORKER_SCRIPT = 'elkjs/lib/elk-worker.min.js';

/**
 * elk.bundled.js mis-detects Bun as a web worker (global `self`), so on Bun ELK runs in a real Worker.
 * Node has no Web Worker; there ELK runs in-process through the worker script's own fake Worker.
 */
function createWorker(url?: string): never {
    if (IS_BUN) return new Worker(import.meta.resolve(WORKER_SCRIPT)) as never;
    const { Worker: FakeWorker } = createRequire(import.meta.url)(WORKER_SCRIPT) as { Worker: new (url?: string) => unknown };
    return new FakeWorker(url) as never;
}

/** Approximate width of one character of an edge label (13px sans-serif). */
const LABEL_CHAR_WIDTH = 7.6;

const BASE_OPTIONS: Record<string, string> = {
    'elk.algorithm': 'layered',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.layered.spacing.nodeNodeBetweenLayers': '60',
    'elk.spacing.nodeNode': '40',
    'elk.spacing.edgeNode': '24',
    'elk.spacing.edgeEdge': '16',
    'elk.spacing.edgeLabel': '6',
    // Prefer the declaration order of the source; keeps layouts stable for small edits.
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
    'elk.randomSeed': '1',
    'elk.edgeLabels.placement': 'CENTER',
};

const DIRECTION: Record<string, string> = {
    structure: 'DOWN',
    // same direction as the detail mode, so switching keeps the mental map
    'structure-overview': 'DOWN',
    states: 'RIGHT',
};

export class ElkLayoutEngine implements LayoutEngine {
    readonly name = 'elk';
    readonly version = 7;
    private readonly elk = new ELK({ workerFactory: createWorker });

    /** Stops the layout worker so the process can exit (the in-process fake Worker has nothing to stop). */
    dispose(): void {
        if (IS_BUN) this.elk.terminateWorker();
    }

    async layout(graph: Graph): Promise<LaidOutGraph> {
        const scale = graph.textScale ?? 1;
        const children = new Map<string, ElkNode[]>();
        const elkNodes = new Map<string, ElkNode>();
        const containers = new Set(graph.nodes.map((n) => n.parent).filter((p): p is string => !!p));

        for (const n of graph.nodes) {
            const node: ElkNode = { id: n.id, children: [] };
            if (containers.has(n.id)) {
                node.layoutOptions = {
                    'elk.padding': `[top=${Math.round(CONTAINER_PADDING.top * scale)},left=${CONTAINER_PADDING.left},bottom=${CONTAINER_PADDING.bottom},right=${CONTAINER_PADDING.right}]`,
                    'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                    'elk.nodeSize.minimum': `(${Math.max(160, maxUnits(n.label) * 10.5 * scale + 40)},60)`,
                };
            } else {
                node.width = n.width;
                node.height = n.height;
            }
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
                labels: e.label ? [{ text: e.label.name, width: Math.ceil(maxUnits(e.label) * LABEL_CHAR_WIDTH * scale) + 8, height: Math.ceil(19 * scale) }] : [],
            }));

        const kind = graph.id.split(':')[0];
        const root: ElkNode = {
            id: ROOT,
            layoutOptions: { ...BASE_OPTIONS, 'elk.direction': DIRECTION[kind] ?? 'DOWN' },
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

        return { ...graph, nodeLayout, edgeLayout, signature: graphSignature(graph) };
    }
}
