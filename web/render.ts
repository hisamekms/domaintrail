import { createShapeId, type Editor, type TLShapeId, type TLShapePartial } from 'tldraw';
import type { Diagnostic } from '../src/core/diagnostics';
import type { ModelDiff } from '../src/graph/diff';
import type { DisplayMode, GraphEdge, GraphNode, Lang, LaidOutGraph, Texts } from '../src/graph/ir';
import type { ChangeMark, DiagMark, EdgeTone } from './shapes';

export interface RenderOptions {
    diff: ModelDiff;
    diagnostics: Diagnostic[];
    /** The previously shown version of the same graph; removed nodes are drawn as ghosts at their old position. */
    previous?: LaidOutGraph;
    mode: DisplayMode;
    lang: Lang;
}

/** Which variant of the graph's texts to show. */
type Variant = Pick<RenderOptions, 'mode' | 'lang'>;
const textOf = (t: Texts, v: Variant): string => t[v.lang][v.mode];

const GROUP_KINDS = new Set(['context', 'sharedContext', 'aggregateBoundary']);
const nodeShapeId = (id: string): TLShapeId => createShapeId(`n:${id}`);
const edgeShapeId = (id: string): TLShapeId => createShapeId(`e:${id}`);
const ghostShapeId = (id: string): TLShapeId => createShapeId(`ghost:${id}`);

const rowsIn = (n: GraphNode, v: Variant) => n.lines.map((l) => ({ k: textOf(l.key, v), v: l.value ? textOf(l.value, v) : '' }));

/** Element that owns a state / command ID (`Sales.Order#Draft` -> `Sales.Order`). */
export const ownerElement = (id: string): string => id.split(/[#:]/)[0];

export function shapeElementId(editor: Editor, shapeId: TLShapeId): string | undefined {
    const meta = editor.getShape(shapeId)?.meta as { elementId?: string } | undefined;
    return meta?.elementId;
}

export function findShapeForElement(editor: Editor, elementId: string): TLShapeId | undefined {
    const shapes = editor.getCurrentPageShapes();
    const exact = shapes.find((s) => (s.meta as { elementId?: string }).elementId === elementId && s.type === 'domain-node');
    return (exact ?? shapes.find((s) => (s.meta as { elementId?: string }).elementId === elementId))?.id;
}

/**
 * Reconciles the editor's shapes with `graph`. Shapes are keyed by stable IDs, so unchanged nodes keep
 * their identity (and selection); the camera is never touched here.
 */
export function renderGraph(editor: Editor, graph: LaidOutGraph, opts: RenderOptions): void {
    const structure = graph.id.startsWith('structure');
    const scale = graph.textScale ?? 1;
    const severity = diagnosticsByElement(opts.diagnostics, structure);
    const change = (elementId: string): ChangeMark =>
        opts.diff.added.includes(elementId) ? 'added' : opts.diff.changed.includes(elementId) ? 'changed' : 'none';

    const groups: TLShapePartial[] = [];
    const nodes: TLShapePartial[] = [];
    for (const n of graph.nodes) {
        const l = graph.nodeLayout[n.id];
        if (!l) continue;
        const isGroup = GROUP_KINDS.has(n.kind);
        const marks = { change: isGroup ? ('none' as const) : change(n.elementId), diag: isGroup ? ('none' as const) : (severity.get(n.elementId) ?? 'none') };
        const base = { id: nodeShapeId(n.id), x: l.x, y: l.y, meta: { elementId: n.elementId, graphNode: n.id } };
        if (isGroup) {
            groups.push({ ...base, type: 'domain-group', props: { w: l.width, h: l.height, kind: n.kind, label: textOf(n.label, opts), lines: n.lines.map((r) => textOf(r.key, opts)), scale, ...marks } });
        } else {
            nodes.push({
                ...base,
                type: 'domain-node',
                props: { w: l.width, h: l.height, kind: n.kind, label: textOf(n.label, opts), stereotype: n.stereotype ? textOf(n.stereotype, opts) : '', scale, rows: rowsIn(n, opts), ...marks },
            });
        }
    }

    const ghosts: TLShapePartial[] = [];
    if (opts.previous && opts.previous.id === graph.id) {
        const present = new Set(graph.nodes.map((n) => n.elementId));
        for (const n of opts.previous.nodes) {
            const l = opts.previous.nodeLayout[n.id];
            if (!l || GROUP_KINDS.has(n.kind) || present.has(n.elementId) || !opts.diff.removed.includes(n.elementId)) continue;
            ghosts.push({
                id: ghostShapeId(n.id),
                type: 'domain-node',
                x: l.x,
                y: l.y,
                meta: { elementId: n.elementId, ghost: true },
                props: { w: l.width, h: l.height, kind: n.kind, label: textOf(n.label, opts), stereotype: n.stereotype ? textOf(n.stereotype, opts) : '', scale, rows: rowsIn(n, opts), change: 'removed', diag: 'none' },
            });
        }
    }

    const edges: TLShapePartial[] = [];
    for (const e of graph.edges) {
        const owner = edgeOwner(e, structure);
        const shape = edgeShape(graph, e, opts, severity.get(owner) === 'error' && !structure ? 'error' : toneOf(change(owner)));
        if (shape) edges.push(shape);
    }

    const wanted = [...groups, ...nodes, ...ghosts, ...edges];
    const wantedIds = new Set(wanted.map((s) => s.id));

    withWriteAccess(editor, () => {
        const stale = editor.getCurrentPageShapes().filter((s) => !wantedIds.has(s.id));
        editor.deleteShapes(stale.map((s) => s.id));

        const create: TLShapePartial[] = [];
        const update: TLShapePartial[] = [];
        for (const s of wanted) (editor.getShape(s.id) ? update : create).push(s);
        editor.createShapes(create as never);
        editor.updateShapes(update as never);

        // z-order: contexts < aggregate boundaries < nodes < edges
        const boundaryIds = groups.filter((g) => (g.props as { kind: string }).kind === 'aggregateBoundary').map((g) => g.id);
        const contextIds = groups.filter((g) => (g.props as { kind: string }).kind !== 'aggregateBoundary').map((g) => g.id);
        if (boundaryIds.length) editor.sendToBack(boundaryIds);
        if (contextIds.length) editor.sendToBack(contextIds);
        if (edges.length) editor.bringToFront(edges.map((e) => e.id));
    });
}

/**
 * The canvas is read-only for the user (GUI editing is out of scope for the MVP), but tldraw's
 * read-only mode also rejects programmatic edits, so it is lifted only while the model is synced.
 */
export function withWriteAccess(editor: Editor, fn: () => void): void {
    const readonly = editor.getIsReadonly();
    if (readonly) editor.updateInstanceState({ isReadonly: false });
    try {
        editor.run(fn, { history: 'ignore', ignoreShapeLock: true });
    } finally {
        if (readonly) editor.updateInstanceState({ isReadonly: true });
    }
}

/** Model element an edge belongs to: the declaring element (structure) or the command (transitions). */
function edgeOwner(e: GraphEdge, structure: boolean): string {
    // structure edges are named `<element>.<field>`; transitions `<command>|<from>-><to>`
    return structure ? e.source : e.id.split('|')[0];
}

const toneOf = (c: ChangeMark): EdgeTone => (c === 'added' ? 'added' : c === 'changed' ? 'changed' : 'normal');

function edgeShape(graph: LaidOutGraph, e: GraphEdge, v: Variant, tone: EdgeTone): TLShapePartial | undefined {
    const route = graph.edgeLayout[e.id];
    if (!route || route.points.length < 2) return undefined;
    const xs = route.points.map((p) => p.x);
    const ys = route.points.map((p) => p.y);
    if (route.label) {
        xs.push(route.label.x);
        ys.push(route.label.y);
    }
    const ox = Math.min(...xs);
    const oy = Math.min(...ys);
    const l = route.label;
    return {
        id: edgeShapeId(e.id),
        type: 'domain-edge',
        x: ox,
        y: oy,
        meta: { elementId: edgeOwner(e, graph.id.startsWith('structure')), edge: e.id },
        props: {
            points: route.points.map((p) => ({ x: p.x - ox, y: p.y - oy })),
            kind: e.kind,
            label: e.label ? textOf(e.label, v) : '',
            scale: graph.textScale ?? 1,
            lx: l ? l.x - ox : 0,
            ly: l ? l.y - oy : 0,
            lw: l?.width ?? 0,
            lh: l?.height ?? 0,
            tone,
        },
    };
}

function diagnosticsByElement(diags: Diagnostic[], structure: boolean): Map<string, DiagMark> {
    const out = new Map<string, DiagMark>();
    for (const d of diags) {
        if (!d.elementId) continue;
        const ids = structure ? [ownerElement(d.elementId)] : [d.elementId, ownerElement(d.elementId)];
        for (const id of ids) {
            if (out.get(id) !== 'error') out.set(id, d.severity === 'error' ? 'error' : 'warning');
        }
    }
    return out;
}
