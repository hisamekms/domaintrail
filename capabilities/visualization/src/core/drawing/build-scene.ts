// The scene of a laid-out graph (`scene.ts`): what the Live View's canvas and the portable SVG draw.
import type { ModelDiff } from '@domaintrail/modeling';
import type { Diagnostic } from '@domaintrail/kernel';
import {
    compartmentHeight,
    type DisplayMode,
    type GraphEdge,
    type GraphNode,
    INTERNAL_PADDING,
    internalRowHeight,
    type LaidOutGraph,
    type Lang,
    type NodeLayout,
    type Texts,
    type TransitionLabels,
    transitionText,
} from '../graph/ir.js';
import { RESOLVED_MARK } from './marks.js';
import { DIAGRAM_TEXTS } from './texts.js';
import {
    type ChangeMark,
    type DiagMark,
    edgeItemId,
    type EdgeTone,
    ghostItemId,
    internalItemId,
    nodeItemId,
    type NodeProps,
    type Scene,
    type SceneEdge,
    type SceneGroup,
    type SceneInternal,
    type SceneNode,
    type SettledHotspot,
} from './scene.js';
/** The elements marked added, changed or removed: a model's diff, or any other list of element IDs (a turn's stickies). */
export interface ChangedElements {
    readonly added: readonly string[];
    readonly changed: readonly string[];
    readonly removed: readonly string[];
}

export interface RenderOptions {
    diff: ModelDiff | ChangedElements;
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

const GROUP_KINDS = new Set(['context', 'sharedContext', 'aggregateBoundary', 'esGroup', 'esStage']);

const rowsIn = (n: GraphNode, v: Variant): NodeProps['rows'] =>
    n.lines.map((l) => ({
        k: textOf(l.key, v),
        v: l.value ? textOf(l.value, v) : '',
        ...(l.origin && { o: textOf(l.origin, v) }),
        ...(l.change && { c: l.change }),
    }));

/** Element that owns a state / command ID (`Sales.Order#Draft` -> `Sales.Order`). */
export const ownerElement = (id: string): string => id.split(/[#:]/)[0];

/**
 * The scene that draws `graph` (see `scene.ts`): its nodes, containers, internal transitions and edges with their
 * change and diagnostic marks, and the ghosts of the nodes removed since `opts.previous`. Items are keyed by stable
 * IDs, so that a canvas keeps the identity (and selection) of unchanged items.
 */
export function buildScene(graph: LaidOutGraph, opts: RenderOptions): Scene {
    const structure = graph.id.startsWith('structure');
    const scale = graph.textScale ?? 1;
    const severity = diagnosticsByElement(opts.diagnostics, structure);
    // the diff lists stable IDs; the graph's nodes carry them as plain strings
    const added: readonly string[] = opts.diff.added;
    const changed: readonly string[] = opts.diff.changed;
    const removed: readonly string[] = opts.diff.removed;
    const change = (elementId: string): ChangeMark => (added.includes(elementId) ? 'added' : changed.includes(elementId) ? 'changed' : 'none');

    const groups: SceneGroup[] = [];
    const nodes: SceneNode[] = [];
    const internal: SceneInternal[] = [];
    const settled = settledOn(graph, opts);
    for (const n of graph.nodes) {
        const l = graph.nodeLayout[n.id];
        if (!l) continue;
        if (n.folded) {
            // a hidden resolved hotspot: not drawn (its place left empty); at the check of the first sticky it is on
            const sticky = n.folded[0] !== undefined ? graph.nodeLayout[n.folded[0]] : undefined;
            if (!sticky) continue;
            const at = checkPlace(sticky);
            nodes.push({
                id: nodeItemId(n.id),
                type: 'node',
                x: at.x,
                y: at.y,
                elementId: n.elementId,
                graphNode: n.id,
                on: nodeItemId(n.folded[0]!),
                props: { ...nodeProps(graph, n, at, opts), change: 'none', badge: '', diag: 'none' },
            });
            continue;
        }
        const isGroup = GROUP_KINDS.has(n.kind);
        const marks = { change: isGroup ? ('none' as const) : change(n.elementId), diag: isGroup ? ('none' as const) : (severity.get(n.elementId) ?? 'none') };
        const base = { id: nodeItemId(n.id), x: l.x, y: l.y, elementId: n.elementId, graphNode: n.id };
        if (isGroup) {
            groups.push({
                ...base,
                type: 'group',
                props: {
                    w: l.width,
                    h: l.height,
                    kind: n.kind,
                    label: textOf(n.label, opts),
                    lines: n.lines.map((r) => textOf(r.key, opts)),
                    scale,
                    ...marks,
                    ...(n.dimmed && { dimmed: true as const }),
                },
            });
        } else {
            nodes.push({
                ...base,
                ...(n.parent !== undefined && { parent: nodeItemId(n.parent) }),
                type: 'node',
                props: {
                    ...nodeProps(graph, n, l, opts),
                    ...marks,
                    badge: badgeText(marks.change, opts.lang),
                    ...(settled.has(n.id) && { settled: settled.get(n.id) }),
                    ...(n.dimmed && { dimmed: true as const }),
                },
            });
            internal.push(...internalRows(graph, n, l, opts, (id) => ({ change: change(id), diag: severity.get(id) ?? 'none' })));
        }
    }

    const ghosts: (SceneNode | SceneInternal)[] = [];
    if (opts.previous && opts.previous.id === graph.id) {
        const present = new Set(graph.nodes.map((n) => n.elementId));
        for (const n of opts.previous.nodes) {
            const l = opts.previous.nodeLayout[n.id];
            if (!l || GROUP_KINDS.has(n.kind) || present.has(n.elementId) || !removed.includes(n.elementId)) continue;
            ghosts.push({
                id: ghostItemId(n.id),
                type: 'node',
                x: l.x,
                y: l.y,
                elementId: n.elementId,
                ghost: true,
                props: { ...nodeProps(opts.previous, n, l, opts), change: 'removed', badge: badgeText('removed', opts.lang), diag: 'none' },
            });
            for (const row of internalRows(opts.previous, n, l, opts, () => ({ change: 'removed', diag: 'none' }))) {
                ghosts.push({ ...row, id: ghostItemId(row.id), ghost: true });
            }
        }
    }

    // an Event Storming edge belongs to the element it starts from (its IDs name render nodes, not elements)
    const storming = graph.id.startsWith('storming');
    const elementOf = new Map(graph.nodes.map((n) => [n.id, n.elementId]));
    // a resolved hotspot's `on` starts from its note
    const resolved = new Set(graph.nodes.filter((n) => n.status === 'resolved').map((n) => n.id));
    const edges: SceneEdge[] = [];
    for (const e of graph.edges) {
        if (e.hidden) continue;
        const owner = storming ? (elementOf.get(e.source) ?? e.source) : edgeOwner(e, structure);
        // an element's error is told by its mark and text (issue #33 §5); its lines keep their kind's colour
        const item = edgeItem(graph, e, opts, owner, toneOf(change(owner)));
        if (!item) continue;
        const props = {
            ...item.props,
            ...(e.kind === 'esHotspot' && resolved.has(e.source) && { resolved: true as const }),
            ...(e.dimmed && { dimmed: true as const }),
        };
        edges.push({ ...item, props });
    }

    return { groups, nodes, ghosts, internal, edges };
}

/** The hidden resolved hotspots (`GraphNode.folded`) behind each sticky's check, by the sticky's graph node, in the graph's order. */
function settledOn(graph: LaidOutGraph, v: Variant): Map<string, SettledHotspot[]> {
    const out = new Map<string, SettledHotspot[]>();
    for (const n of graph.nodes)
        for (const sticky of n.folded ?? [])
            out.set(sticky, [...(out.get(sticky) ?? []), { item: nodeItemId(n.id), label: textOf(n.label, v), resolution: n.resolution ?? '' }]);
    return out;
}

/** Where a sticky's check stands (`RESOLVED_MARK`, inside its top-right corner). */
function checkPlace(sticky: NodeLayout): NodeLayout {
    const side = 2 * RESOLVED_MARK.radius;
    return { x: sticky.x + sticky.width - RESOLVED_MARK.inset - side, y: sticky.y + RESOLVED_MARK.inset, width: side, height: side };
}

/** The change badge's text, in the Live View's language (the shape draws it, and its outline goes around it). */
const badgeText = (change: ChangeMark, lang: Lang): string => (change === 'none' ? '' : DIAGRAM_TEXTS[lang][change]);

function nodeProps(graph: LaidOutGraph, n: GraphNode, l: NodeLayout, v: Variant): Omit<NodeProps, 'change' | 'badge' | 'diag'> {
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
        ...(n.status === 'resolved' && { resolution: n.resolution ?? '' }),
    };
}

/** A node's internal transitions, each an item of its own over the compartment (so it is selected on its own). */
function internalRows(
    graph: LaidOutGraph,
    n: GraphNode,
    l: NodeLayout,
    v: Variant,
    marks: (command: string) => { change: ChangeMark; diag: DiagMark },
): SceneInternal[] {
    if (!n.internal?.length) return [];
    const labels = v.transitionLabels ?? 'both';
    let y = l.y + l.height - compartmentHeight(n, graph.transitionLabels ?? 'both') + INTERNAL_PADDING;
    return n.internal.map((t) => {
        const text = transitionText(t.label, t.events, labels);
        const h = internalRowHeight(t, labels);
        const row: SceneInternal = {
            id: internalItemId(t.id),
            type: 'internal',
            x: l.x + 4,
            y,
            elementId: t.elementId,
            edge: t.id,
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

/** Model element an edge belongs to: the declaring element (structure) or the command (transitions). */
function edgeOwner(e: GraphEdge, structure: boolean): string {
    // structure edges are named `<element>.<field>`; transitions `<command>|<from>-><to>`
    return structure ? e.source : e.id.split('|')[0];
}

const toneOf = (c: ChangeMark): EdgeTone => (c === 'added' ? 'added' : c === 'changed' ? 'changed' : 'normal');

function edgeItem(graph: LaidOutGraph, e: GraphEdge, v: Variant, owner: string, tone: EdgeTone): SceneEdge | undefined {
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
        id: edgeItemId(e.id),
        type: 'edge',
        x: ox,
        y: oy,
        elementId: owner,
        edge: e.id,
        source: nodeItemId(e.source),
        target: nodeItemId(e.target),
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
            ...(e.relation && { relation: { kind: e.relation.kind, names: (e.relation.names ?? []).map((n) => textOf(n, v)) } }),
        },
    };
}

function diagnosticsByElement(diags: Diagnostic[], structure: boolean): Map<string, DiagMark> {
    const out = new Map<string, DiagMark>();
    for (const d of diags) {
        // an info only informs: no mark on the note
        if (!d.elementId || d.severity === 'info') continue;
        const ids = structure ? [ownerElement(d.elementId)] : [d.elementId, ownerElement(d.elementId)];
        for (const id of ids) {
            if (out.get(id) !== 'error') out.set(id, d.severity === 'error' ? 'error' : 'warning');
        }
    }
    return out;
}
