import { createShapeId, type Editor, type TLShapeId, type TLShapePartial } from 'tldraw';
import type { Diagnostic } from '../src/modeling/core/diagnostics';
import type { ModelDiff } from '../src/visualization/domain/graph/diff';
import {
    INTERNAL_PADDING,
    compartmentHeight,
    internalRowHeight,
    transitionText,
    type DisplayMode,
    type GraphEdge,
    type GraphNode,
    type Lang,
    type LaidOutGraph,
    type NodeLayout,
    type Texts,
    type TransitionLabels,
} from '../src/visualization/domain/graph/ir';
import { MESSAGES } from './i18n';
import type { ChangeMark, DiagMark, EdgeTone } from './shapes';

export interface RenderOptions {
    diff: ModelDiff;
    diagnostics: Diagnostic[];
    /** The previously shown version of the same graph; removed nodes are drawn as ghosts at their old position. */
    previous?: LaidOutGraph;
    mode: DisplayMode;
    lang: Lang;
    /** State View: what transitions are labeled with (default both). */
    transitionLabels?: TransitionLabels;
}

/** Which variant of the graph's texts to show. */
type Variant = Pick<RenderOptions, 'mode' | 'lang' | 'transitionLabels'>;
const textOf = (t: Texts, v: Variant): string => t[v.lang][v.mode];

const GROUP_KINDS = new Set(['context', 'sharedContext', 'aggregateBoundary', 'esGroup']);
const nodeShapeId = (id: string): TLShapeId => createShapeId(`n:${id}`);
const edgeShapeId = (id: string): TLShapeId => createShapeId(`e:${id}`);
const ghostShapeId = (id: string): TLShapeId => createShapeId(`ghost:${id}`);
const internalShapeId = (id: string): TLShapeId => createShapeId(`i:${id}`);

const rowsIn = (n: GraphNode, v: Variant) =>
    n.lines.map((l) => ({
        k: textOf(l.key, v),
        v: l.value ? textOf(l.value, v) : '',
        ...(l.origin && { o: textOf(l.origin, v) }),
        ...(l.change && { c: l.change }),
    }));

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
    const internal: TLShapePartial[] = [];
    for (const n of graph.nodes) {
        const l = graph.nodeLayout[n.id];
        if (!l) continue;
        const isGroup = GROUP_KINDS.has(n.kind);
        const marks = { change: isGroup ? ('none' as const) : change(n.elementId), diag: isGroup ? ('none' as const) : (severity.get(n.elementId) ?? 'none') };
        const base = { id: nodeShapeId(n.id), x: l.x, y: l.y, meta: { elementId: n.elementId, graphNode: n.id } };
        if (isGroup) {
            groups.push({
                ...base,
                type: 'domain-group',
                props: { w: l.width, h: l.height, kind: n.kind, label: textOf(n.label, opts), lines: n.lines.map((r) => textOf(r.key, opts)), scale, ...marks },
            });
        } else {
            nodes.push({
                ...base,
                type: 'domain-node',
                props: { ...nodeProps(graph, n, l, opts), ...marks, badge: badgeText(marks.change, opts.lang) },
            });
            internal.push(...internalRows(graph, n, l, opts, (id) => ({ change: change(id), diag: severity.get(id) ?? 'none' })));
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
                props: { ...nodeProps(opts.previous, n, l, opts), change: 'removed', badge: badgeText('removed', opts.lang), diag: 'none' },
            });
            for (const row of internalRows(opts.previous, n, l, opts, () => ({ change: 'removed', diag: 'none' }))) {
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- internal rows carry their edge in meta
                ghosts.push({ ...row, id: ghostShapeId(`i:${(row.meta as { edge: string }).edge}`), meta: { ...row.meta, ghost: true } });
            }
        }
    }

    // an Event Storming edge belongs to the element it starts from (its IDs name render nodes, not elements)
    const storming = graph.id.startsWith('storming');
    const elementOf = new Map(graph.nodes.map((n) => [n.id, n.elementId]));
    const edges: TLShapePartial[] = [];
    for (const e of graph.edges) {
        const owner = storming ? (elementOf.get(e.source) ?? e.source) : edgeOwner(e, structure);
        const shape = edgeShape(graph, e, opts, owner, severity.get(owner) === 'error' && !structure && !storming ? 'error' : toneOf(change(owner)));
        if (shape) edges.push(shape);
    }

    const wanted = [...groups, ...nodes, ...ghosts, ...internal, ...edges];
    const wantedIds = new Set(wanted.map((s) => s.id));

    withWriteAccess(editor, () => {
        const stale = editor.getCurrentPageShapes().filter((s) => !wantedIds.has(s.id));
        editor.deleteShapes(stale.map((s) => s.id));

        const create: TLShapePartial[] = [];
        const update: TLShapePartial[] = [];
        for (const s of wanted) (editor.getShape(s.id) ? update : create).push(s);
        /* oxlint-disable typescript/no-unsafe-type-assertion -- tldraw's shape types do not know our custom shapes */
        editor.createShapes(create as never);
        editor.updateShapes(update as never);

        // z-order: contexts < aggregate boundaries < nodes < internal transitions < edges
        const boundaryIds = groups.filter((g) => (g.props as { kind: string }).kind === 'aggregateBoundary').map((g) => g.id);
        const contextIds = groups.filter((g) => (g.props as { kind: string }).kind !== 'aggregateBoundary').map((g) => g.id);
        /* oxlint-enable typescript/no-unsafe-type-assertion */
        if (boundaryIds.length) editor.sendToBack(boundaryIds);
        if (contextIds.length) editor.sendToBack(contextIds);
        if (internal.length) editor.bringToFront(internal.map((r) => r.id));
        if (edges.length) editor.bringToFront(edges.map((e) => e.id));
    });
}

/** The change badge's text, in the Live View's language (the shape draws it, and its outline goes around it). */
const badgeText = (change: ChangeMark, lang: Lang): string => (change === 'none' ? '' : MESSAGES[lang][change]);

function nodeProps(graph: LaidOutGraph, n: GraphNode, l: NodeLayout, v: Variant) {
    return {
        w: l.width,
        h: l.height,
        kind: n.kind,
        label: textOf(n.label, v),
        stereotype: n.stereotype ? textOf(n.stereotype, v) : '',
        scale: graph.textScale ?? 1,
        rows: rowsIn(n, v),
        // the compartment of internal transitions takes the bottom of the box, as laid out
        compartment: n.internal?.length ? compartmentHeight(n, graph.transitionLabels ?? 'both') : 0,
    };
}

/** A node's internal transitions, each a shape of its own over the compartment (so it is selected on its own). */
function internalRows(
    graph: LaidOutGraph,
    n: GraphNode,
    l: NodeLayout,
    v: Variant,
    marks: (command: string) => { change: ChangeMark; diag: DiagMark },
): TLShapePartial[] {
    if (!n.internal?.length) return [];
    const labels = v.transitionLabels ?? 'both';
    let y = l.y + l.height - compartmentHeight(n, graph.transitionLabels ?? 'both') + INTERNAL_PADDING;
    return n.internal.map((t) => {
        const text = transitionText(t.label, t.events, labels);
        const h = internalRowHeight(t, labels);
        const row: TLShapePartial = {
            id: internalShapeId(t.id),
            type: 'domain-internal',
            x: l.x + 4,
            y,
            meta: { elementId: t.elementId, edge: t.id },
            props: {
                w: l.width - 8,
                h,
                label: textOf(text.main, v),
                sub: text.sub ? textOf(text.sub, v) : '',
                faded: text.faded,
                scale: graph.textScale ?? 1,
                ...marks(t.elementId),
            },
        };
        y += h;
        return row;
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

function edgeShape(graph: LaidOutGraph, e: GraphEdge, v: Variant, owner: string, tone: EdgeTone): TLShapePartial | undefined {
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
    const text = e.label && (e.kind === 'transition' ? transitionText(e.label, e.events, v.transitionLabels ?? 'both') : { main: e.label, faded: false });
    return {
        id: edgeShapeId(e.id),
        type: 'domain-edge',
        x: ox,
        y: oy,
        meta: { elementId: owner, edge: e.id },
        props: {
            points: route.points.map((p) => ({ x: p.x - ox, y: p.y - oy })),
            kind: e.kind,
            label: text ? textOf(text.main, v) : '',
            sub: text && 'sub' in text && text.sub ? textOf(text.sub, v) : '',
            faded: text ? text.faded : false,
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
