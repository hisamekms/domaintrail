// The canvas port (`diagram.ts`) implemented with React Flow (`@xyflow/react`): the scene's items become React Flow's
// nodes (groups, nodes, ghosts, internal transitions: custom node types drawing `diagram-items.tsx`) and edges (one
// custom edge type drawing the ELK route), read-only. The only module that knows React Flow (see
// apps/web/canvas-boundary.test.ts).
//
// The scene, the selection and the hover are kept here, so that the port answers at once (React Flow learns of them
// when it renders); the camera is React Flow's viewport, converted to the port's camera by `viewport.ts`, which also
// keeps the zoom steps, fits and wheel zoom the Live View had with tldraw.
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import {
    Handle,
    Position,
    ReactFlow,
    ReactFlowProvider,
    SelectionMode,
    useStore,
    useStoreApi,
    type Edge,
    type EdgeChange,
    type EdgeProps,
    type NodeChange,
    type NodeHandle,
    type Node,
    type NodeProps,
    type ReactFlowState,
} from '@xyflow/react';
import {
    EdgeContent,
    edgeClassName,
    EdgeMarks,
    edgeOutlinePath,
    GroupContent,
    groupClassName,
    groupStyle,
    InternalContent,
    internalClassName,
    internalStyle,
    markScale,
    NodeContent,
    nodeClassName,
    nodeOutlinePath,
    nodeStyle,
    roundRectPath,
} from '../diagram-items';
import {
    itemForElement,
    rectContains,
    unionRects,
    type DiagMark,
    type Point,
    type Rect,
    type Scene,
    type SceneEdge,
    type SceneGroup,
    type SceneId,
    type SceneInternal,
    type SceneItem,
    type SceneNode,
    sceneItems,
} from '../scene';
import type { Theme } from '../theme';
import type { Camera, CanvasItem, DiagramCanvas, Move } from './diagram';
import {
    ANIMATION_MS,
    cameraToTransform,
    centerCamera,
    defaultInset,
    fitCamera,
    MAX_ZOOM,
    MIN_ZOOM,
    selectionMaxZoom,
    transformToCamera,
    wheelZoom,
    zoomAround,
    zoomInStep,
    zoomOutStep,
    type Size,
} from './viewport';

/** A scene item drawn as a React Flow node (everything but edges), or an anchor for an edge whose end is not drawn. */
type BoxItem = SceneNode | SceneGroup | SceneInternal;
type ItemNode = Node<{ item: BoxItem }, 'domain-node' | 'domain-group' | 'domain-internal'>;
type AnchorNode = Node<Record<string, never>, 'domain-anchor'>;
type FlowNode = ItemNode | AnchorNode;
type ItemEdge = Edge<{ item: SceneEdge }, 'domain-edge'>;

/** The node type of each kind of item (not React Flow's own `default`, `group`..., which its stylesheet draws). */
const NODE_TYPE = { node: 'domain-node', group: 'domain-group', internal: 'domain-internal' } as const;

/** The stacking of the scene's layers (as `sceneItems` orders them), with React Flow's z-index in manual mode. */
const LAYER = { context: 0, boundary: 1, node: 2, ghost: 3, internal: 4, edge: 5 } as const;

function layerOf(item: SceneItem): number {
    if (item.ghost) return LAYER.ghost;
    if (item.type === 'group') return item.props.kind === 'aggregateBoundary' ? LAYER.boundary : LAYER.context;
    return LAYER[item.type];
}

/**
 * Every node has a source and a target handle: React Flow draws an edge only between handles. The edge ignores where
 * they are (it draws its own route), so they sit at the node's corner, unseen; `HANDLES` stands for them until the
 * node is measured (nodes out of view never are).
 */
const HANDLES: NodeHandle[] = [
    { type: 'source', position: Position.Top, x: 0, y: 0, width: 1, height: 1 },
    { type: 'target', position: Position.Top, x: 0, y: 0, width: 1, height: 1 },
];

function Handles(): ReactNode {
    return (
        <>
            <Handle type="source" position={Position.Top} isConnectable={false} className="diagram-handle" />
            <Handle type="target" position={Position.Top} isConnectable={false} className="diagram-handle" />
        </>
    );
}

/** The outline of an item while it is hovered or selected (tldraw's indicator): 1.5 pixels on the screen at any zoom. */
function Outline({ w, h, d }: { w: number; h: number; d: string }): ReactNode {
    return (
        <svg className="diagram-outline" width={w} height={h} aria-hidden>
            <path d={d} />
        </svg>
    );
}

/** `markScale` of the zoom (only the nodes with marks follow the zoom). */
const useMarkScale = (): number => useStore((s: ReactFlowState) => markScale(s.transform[2]));

/** The change badge and the diagnostic mark at the canvas's zoom. */
function ZoomedMarks({ badge, diag }: { badge: string; diag: DiagMark }): ReactNode {
    return <EdgeMarks badge={badge} diag={diag} scale={useMarkScale()} />;
}

/** The outline of a node with marks, stepping around them at their size for the zoom. */
function MarkedOutline({ p }: { p: SceneNode['props'] }): ReactNode {
    return <Outline w={p.w} h={p.h} d={nodeOutlinePath(p, useMarkScale())} />;
}

function DomainNode({ data, selected }: NodeProps<ItemNode>): ReactNode {
    const { item } = data;
    if (item.type !== 'node') return null;
    const p = item.props;
    const marked = p.kind !== 'initial' && (p.badge !== '' || p.diag !== 'none');
    return (
        <>
            <div className={nodeClassName(p, selected)} style={nodeStyle(p)}>
                <NodeContent p={p} Marks={ZoomedMarks} />
            </div>
            {marked ? <MarkedOutline p={p} /> : <Outline w={p.w} h={p.h} d={nodeOutlinePath(p, 1)} />}
            <Handles />
        </>
    );
}

function DomainGroup({ data, selected }: NodeProps<ItemNode>): ReactNode {
    const { item } = data;
    if (item.type !== 'group') return null;
    const p = item.props;
    return (
        <>
            <div className={groupClassName(p, selected)} style={groupStyle(p)}>
                <GroupContent p={p} />
            </div>
            <Outline w={p.w} h={p.h} d={roundRectPath(p.w, p.h, 12)} />
            <Handles />
        </>
    );
}

function DomainInternal({ data }: NodeProps<ItemNode>): ReactNode {
    const { item } = data;
    if (item.type !== 'internal') return null;
    const p = item.props;
    return (
        <>
            <div className={internalClassName(p)} style={internalStyle(p)}>
                <InternalContent p={p} />
            </div>
            <Outline w={p.w} h={p.h} d={roundRectPath(p.w, p.h, 4)} />
            <Handles />
        </>
    );
}

function Anchor(): ReactNode {
    return <Handles />;
}

/** An edge drawn exactly along the route computed by the layout engine, at the item's origin (React Flow's own edges re-route). */
function DomainEdge({ data }: EdgeProps<ItemEdge>): ReactNode {
    if (!data) return null;
    const { item } = data;
    if (item.props.points.length < 2) return null;
    return (
        <g className={edgeClassName(item.props)} transform={`translate(${item.x},${item.y})`}>
            <EdgeContent p={item.props} />
            <path className="diagram-outline-line" d={edgeOutlinePath(item.props.points)} />
        </g>
    );
}

// outside any component: React Flow warns when they change
const NODE_TYPES = {
    [NODE_TYPE.node]: memo(DomainNode),
    [NODE_TYPE.group]: memo(DomainGroup),
    [NODE_TYPE.internal]: memo(DomainInternal),
    'domain-anchor': memo(Anchor),
};
const EDGE_TYPES = { 'domain-edge': memo(DomainEdge) };

/** An item's bounds on the page: a box's, or an edge's route's. */
function boundsOf(item: SceneItem): Rect {
    if (item.type !== 'edge') return { x: item.x, y: item.y, w: item.props.w, h: item.props.h };
    const xs = item.props.points.map((p) => p.x);
    const ys = item.props.points.map((p) => p.y);
    const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
    return { x: item.x + x0, y: item.y + y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

/**
 * What the canvas shows and how the user is pointing at it, outside React (the port answers from it at once). `rendered`
 * changes when React Flow must draw again (the scene, the selection, the theme); every change runs the `watch` effects.
 */
class CanvasState {
    items = new Map<SceneId, SceneItem>();
    selected: ReadonlySet<SceneId> = new Set();
    hovered: SceneId | undefined;
    pointer: Point = { x: 0, y: 0 };
    pointing = false;
    moving = false;
    /** When an animated camera move ends (0: none under way). */
    animatingUntil = 0;
    theme: Theme = 'light';
    rendered = 0;

    private renders = new Set<() => void>();
    private effects = new Set<() => void>();
    private queued = false;

    /** For `useSyncExternalStore`. */
    subscribeRender = (listener: () => void): (() => void) => {
        this.renders.add(listener);
        return () => this.renders.delete(listener);
    };

    watch(effect: () => void): () => void {
        effect();
        this.effects.add(effect);
        return () => this.effects.delete(effect);
    }

    /** Something the port reads changed: the effects run once, after the current task's changes. */
    changed = (): void => {
        if (this.queued) return;
        this.queued = true;
        queueMicrotask(() => {
            this.queued = false;
            // a copy: an effect may start or stop watching
            for (const effect of Array.from(this.effects)) effect();
        });
    };

    /** React Flow must draw again. */
    render(): void {
        this.rendered++;
        for (const l of this.renders) l();
        this.changed();
    }

    setSelected(ids: Iterable<SceneId>): void {
        const next = new Set([...ids].filter((id) => this.items.has(id)));
        if (next.size === this.selected.size && [...next].every((id) => this.selected.has(id))) return;
        this.selected = next;
        this.render();
    }

    set<K extends 'hovered' | 'pointing' | 'moving'>(key: K, value: this[K]): void {
        if (this[key] === value) return;
        this[key] = value;
        this.changed();
    }
}

/** React Flow's nodes and edges for the state, reusing those of unchanged items (so that React Flow redraws only what changed). */
function useFlowElements(state: CanvasState): { nodes: FlowNode[]; edges: ItemEdge[] } {
    const rendered = useSyncExternalStore(state.subscribeRender, () => state.rendered);
    const cache = useRef(new Map<SceneId, { item: SceneItem; selected: boolean; element: FlowNode | ItemEdge }>());
    return useMemo(() => {
        void rendered;
        const previous = cache.current;
        const next = new Map<SceneId, { item: SceneItem; selected: boolean; element: FlowNode | ItemEdge }>();
        const nodes: FlowNode[] = [];
        const edges: ItemEdge[] = [];
        const anchors = new Set<SceneId>();
        const reuse = (item: SceneItem, build: (selected: boolean) => FlowNode | ItemEdge): FlowNode | ItemEdge => {
            const selected = state.selected.has(item.id);
            const old = previous.get(item.id);
            const element = old && old.item === item && old.selected === selected ? old.element : build(selected);
            next.set(item.id, { item, selected, element });
            return element;
        };
        for (const item of state.items.values()) {
            if (item.type === 'edge') {
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- built as an edge below
                edges.push(reuse(item, (selected) => toEdge(item, selected)) as ItemEdge);
                for (const end of ['source', 'target'] as const) {
                    if (state.items.has(item[end]) || anchors.has(item[end])) continue;
                    anchors.add(item[end]);
                    nodes.push(toAnchor(item, end));
                }
            } else {
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- built as a node below
                nodes.push(reuse(item, (selected) => toNode(item, selected)) as FlowNode);
            }
        }
        cache.current = next;
        return { nodes, edges };
    }, [state, rendered]);
}

function toNode(item: BoxItem, selected: boolean): ItemNode {
    const ghost = item.ghost === true;
    return {
        id: item.id,
        type: NODE_TYPE[item.type],
        position: { x: item.x, y: item.y },
        width: item.props.w,
        height: item.props.h,
        data: { item },
        selected,
        selectable: !ghost,
        draggable: false,
        connectable: false,
        deletable: false,
        focusable: false,
        zIndex: layerOf(item),
        handles: HANDLES,
        ...(ghost && { className: 'diagram-ghost' }),
    };
}

function toEdge(item: SceneEdge, selected: boolean): ItemEdge {
    return {
        id: item.id,
        type: 'domain-edge',
        source: item.source,
        target: item.target,
        data: { item },
        selected,
        deletable: false,
        focusable: false,
        reconnectable: false,
        zIndex: LAYER.edge,
    };
}

/** A node standing for an edge's end that the scene does not draw (so that React Flow still draws the edge). */
function toAnchor(edge: SceneEdge, end: 'source' | 'target'): AnchorNode {
    const b = boundsOf(edge);
    return {
        id: edge[end],
        type: 'domain-anchor',
        position: { x: b.x, y: b.y },
        width: Math.max(1, b.w),
        height: Math.max(1, b.h),
        data: {},
        selectable: false,
        draggable: false,
        connectable: false,
        deletable: false,
        focusable: false,
        zIndex: LAYER.context,
        handles: HANDLES,
        className: 'diagram-anchor',
    };
}

/** The port over the state and a mounted React Flow (its store), drawn in `container`. */
function createFlowCanvas(state: CanvasState, store: ReturnType<typeof useStoreApi>, container: HTMLElement): DiagramCanvas {
    const size = (): Size => {
        const r = container.getBoundingClientRect();
        return { w: r.width, h: r.height };
    };
    const transform = (): { x: number; y: number; zoom: number } => {
        const [x, y, zoom] = store.getState().transform;
        return { x, y, zoom };
    };
    const getCamera = (): Camera => transformToCamera(transform());
    const setCamera = (camera: Camera, move?: Move): void => {
        const panZoom = store.getState().panZoom;
        if (!panZoom) return;
        const animate = move?.animate === true;
        state.animatingUntil = animate ? performance.now() + ANIMATION_MS : 0;
        const done = panZoom.setViewport(cameraToTransform(camera), animate ? { duration: ANIMATION_MS, interpolate: 'linear' } : undefined);
        if (animate)
            void done.then(() => {
                state.animatingUntil = 0;
                state.changed();
            });
    };
    const zoomTo = (z: number, move?: Move): void => {
        const { w, h } = size();
        setCamera(zoomAround(getCamera(), { x: w / 2, y: h / 2 }, z), move);
    };
    const contentBounds = (): Rect | undefined => unionRects([...state.items.values()].map(boundsOf));
    const fitBounds = (bounds: Rect, opts: Move & { maxZoom?: number; inset?: number }): void => {
        const s = size();
        setCamera(fitCamera(bounds, s, opts.inset ?? defaultInset(s), opts.maxZoom), opts);
    };
    const itemBounds = (id: SceneId): Rect | undefined => {
        const item = state.items.get(id);
        return item && boundsOf(item);
    };
    const selectionBounds = (): Rect | undefined => unionRects([...state.selected].flatMap((id) => itemBounds(id) ?? []));

    return {
        show: (scene: Scene) => {
            state.items = new Map(sceneItems(scene).map((item) => [item.id, item]));
            state.selected = new Set([...state.selected].filter((id) => state.items.has(id)));
            state.render();
        },
        clear: () => {
            state.items = new Map();
            state.selected = new Set();
            state.render();
        },

        getCamera,
        setCamera,
        getZoom: () => transform().zoom,
        zoomIn: (move) => zoomTo(zoomInStep(transform().zoom), move),
        zoomOut: (move) => zoomTo(zoomOutStep(transform().zoom), move),
        resetZoom: (move) => zoomTo(1, move),
        fitContent: (move) => {
            const bounds = contentBounds();
            if (bounds) fitBounds(bounds, { ...move });
        },
        fitBounds,
        fitSelection: (move) => {
            const bounds = selectionBounds();
            if (bounds) fitBounds(bounds, { ...move, maxZoom: selectionMaxZoom(transform().zoom) });
        },
        centerOn: (point, move) => setCamera(centerCamera(point, size(), transform().zoom), move),
        isAnimating: () => state.animatingUntil > performance.now(),
        isMoving: () => state.moving || store.getState().paneDragging,
        // React Flow watches its container's size itself; this makes what it culls follow at once
        measure: () => {
            const { w, h } = size();
            store.setState({ width: w, height: h });
        },

        contentBounds,
        viewportPageBounds: () => {
            const { x, y, zoom } = transform();
            const { w, h } = size();
            return { x: -x / zoom, y: -y / zoom, w: w / zoom, h: h / zoom };
        },
        viewportScreenBounds: () => {
            const r = container.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        },
        screenToPage: (p) => {
            const r = container.getBoundingClientRect();
            const { x, y, zoom } = transform();
            return { x: (p.x - r.x - x) / zoom, y: (p.y - r.y - y) / zoom };
        },
        pageToViewport: (p) => {
            const { x, y, zoom } = transform();
            return { x: p.x * zoom + x, y: p.y * zoom + y };
        },

        item: (id): CanvasItem | undefined => {
            const item = state.items.get(id);
            if (!item) return undefined;
            const kind = item.type === 'internal' ? '' : item.props.kind;
            return { id, type: item.type, elementId: item.elementId, ghost: item.ghost === true, kind };
        },
        itemBounds,
        findElement: (elementId) => itemForElement([...state.items.values()], elementId)?.id,

        selectedIds: () => [...state.selected],
        onlySelectedId: () => (state.selected.size === 1 ? [...state.selected][0] : undefined),
        selectionBounds,
        select: (ids) => state.setSelected(ids),
        selectNone: () => state.setSelected([]),
        hoveredId: () => state.hovered,
        isPointing: () => state.pointing,
        pointer: () => state.pointer,

        setTheme: (theme) => {
            if (state.theme === theme) return;
            state.theme = theme;
            state.render();
        },
        container: () => container,
        watch: (effect) => state.watch(effect),
    };
}

/** The keys of a canvas that has the focus (tldraw's own, kept): Escape clears the selection; the others move the camera. */
function canvasKey(canvas: DiagramCanvas, e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return false;
    const animate = { animate: true };
    if (e.key === 'Escape') canvas.selectNone();
    else if (e.shiftKey && e.code === 'Digit1') canvas.fitContent(animate);
    else if (e.shiftKey && e.code === 'Digit2') canvas.fitSelection(animate);
    else if (e.shiftKey && e.code === 'Digit0') canvas.resetZoom(animate);
    else if (e.key === '+' || e.key === '=') canvas.zoomIn(animate);
    else if (e.key === '-' || e.key === '_') canvas.zoomOut(animate);
    else return false;
    return true;
}

/**
 * Whether a selection box may take a group: not when the box lies inside it (it was drawn over its inside, as tldraw
 * had it). The box runs from where it started to the pointer (React Flow's own rectangle is one move behind).
 */
function boxTakes(item: SceneItem | undefined, s: ReactFlowState, pointer: Point): boolean {
    const box = s.userSelectionRect;
    if (item?.type !== 'group' || !box) return true;
    const [x, y, zoom] = s.transform;
    const p = { x: (pointer.x - x) / zoom, y: (pointer.y - y) / zoom };
    const page = { x: Math.min(box.startX, p.x), y: Math.min(box.startY, p.y), w: Math.abs(p.x - box.startX), h: Math.abs(p.y - box.startY) };
    return !rectContains(boundsOf(item), page);
}

function Flow({ onMount }: { onMount: (canvas: DiagramCanvas) => void }): ReactNode {
    const store = useStoreApi();
    const [state] = useState(() => new CanvasState());
    const container = useRef<HTMLDivElement>(null);
    const canvas = useRef<DiagramCanvas | null>(null);
    const latest = useRef(onMount);
    latest.current = onMount;
    const { nodes, edges } = useFlowElements(state);
    const theme = useSyncExternalStore(state.subscribeRender, () => state.theme);

    // every change of React Flow's state (the viewport, its size, a pan) may change what the port answers; after a
    // selection box, React Flow would put a draggable rectangle over the selection, which would take the next clicks
    useEffect(
        () =>
            store.subscribe((s) => {
                if (s.nodesSelectionActive) store.setState({ nodesSelectionActive: false });
                state.changed();
            }),
        [store, state],
    );

    // the pointer over the canvas, and whether it is pressed; the camera's own wheel zoom
    useEffect(() => {
        const el = container.current;
        if (!el) return;
        const move = (e: PointerEvent): void => {
            const r = el.getBoundingClientRect();
            state.pointer = { x: e.clientX - r.x, y: e.clientY - r.y };
            state.changed();
        };
        const down = (e: PointerEvent): void => {
            move(e);
            state.set('pointing', true);
            // the canvas takes the focus, as tldraw's did (its keys; the page's keys skip the inspector's diagram then)
            el.focus({ preventScroll: true });
        };
        const up = (): void => state.set('pointing', false);
        // Ctrl / ⌘ + wheel (and a trackpad's pinch) zoom around the pointer as they did with tldraw; React Flow pans
        // on the other wheel events
        const wheel = (e: WheelEvent): void => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            e.stopPropagation();
            const c = canvas.current;
            if (!c) return;
            const r = el.getBoundingClientRect();
            const camera = c.getCamera();
            c.setCamera(zoomAround(camera, { x: e.clientX - r.x, y: e.clientY - r.y }, wheelZoom(camera.z, e.deltaY)));
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerdown', down, true);
        el.addEventListener('wheel', wheel, { capture: true, passive: false });
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        return () => {
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerdown', down, true);
            el.removeEventListener('wheel', wheel, { capture: true });
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
        };
    }, [state]);

    const onInit = useCallback(() => {
        if (!container.current || canvas.current) return;
        canvas.current = createFlowCanvas(state, store, container.current);
        latest.current(canvas.current);
    }, [state, store]);

    const onNodesChange = useCallback(
        (changes: NodeChange<FlowNode>[]) => {
            const s = store.getState();
            const selected = new Set(state.selected);
            for (const c of changes) {
                if (c.type !== 'select') continue;
                if (!c.selected) selected.delete(c.id);
                else if (boxTakes(state.items.get(c.id), s, state.pointer)) selected.add(c.id);
            }
            state.setSelected(selected);
        },
        [state, store],
    );
    const onEdgesChange = useCallback(
        (changes: EdgeChange<ItemEdge>[]) => {
            const selected = new Set(state.selected);
            for (const c of changes) {
                if (c.type !== 'select') continue;
                if (c.selected) selected.add(c.id);
                else selected.delete(c.id);
            }
            state.setSelected(selected);
        },
        [state],
    );
    // a click on an item of a selection of several selects it alone (React Flow keeps them all), as tldraw did
    const click = useCallback(
        (event: { shiftKey: boolean }, element: { id: string }) => {
            const item = state.items.get(element.id);
            if (!event.shiftKey && item && !item.ghost && state.selected.has(element.id)) state.setSelected([element.id]);
        },
        [state],
    );
    const hover = useCallback((_: unknown, element: { id: string }) => state.set('hovered', element.id), [state]);
    const leave = useCallback(
        (_: unknown, element: { id: string }) => {
            if (state.hovered === element.id) state.set('hovered', undefined);
        },
        [state],
    );
    const moveStart = useCallback(
        (event: MouseEvent | TouchEvent | null) => {
            // the user takes the camera: an animation under way stops
            if (event) state.animatingUntil = 0;
            state.set('moving', true);
        },
        [state],
    );
    const moveEnd = useCallback(() => state.set('moving', false), [state]);
    const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
        if (canvas.current && canvasKey(canvas.current, e)) e.preventDefault();
    }, []);

    return (
        <div className="diagram-canvas" ref={container} tabIndex={-1} onKeyDown={onKeyDown}>
            <ReactFlow<FlowNode, ItemEdge>
                nodes={nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                onInit={onInit}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={click}
                onEdgeClick={click}
                onNodeMouseEnter={hover}
                onNodeMouseLeave={leave}
                onEdgeMouseEnter={hover}
                onEdgeMouseLeave={leave}
                onMoveStart={moveStart}
                onMoveEnd={moveEnd}
                colorMode={theme}
                // read-only: nothing moves, connects or goes away
                nodesDraggable={false}
                nodesConnectable={false}
                nodesFocusable={false}
                edgesFocusable={false}
                edgesReconnectable={false}
                deleteKeyCode={null}
                // a click selects, Shift adds; Shift + drag draws a selection box; any other drag pans
                elementsSelectable
                multiSelectionKeyCode="Shift"
                selectionKeyCode="Shift"
                selectionMode={SelectionMode.Partial}
                panOnDrag
                noPanClassName="diagram-nopan"
                // the wheel pans as much as it scrolls; Ctrl / ⌘ + wheel zooms (above)
                panOnScroll
                panOnScrollSpeed={1}
                zoomOnScroll={false}
                zoomActivationKeyCode={null}
                zoomOnDoubleClick={false}
                minZoom={MIN_ZOOM}
                maxZoom={MAX_ZOOM}
                zIndexMode="manual"
                elevateNodesOnSelect={false}
                elevateEdgesOnSelect={false}
                onlyRenderVisibleElements
            />
        </div>
    );
}

/** A read-only React Flow canvas drawing the scene's items. `onMount` gets its port once it is mounted. */
export function FlowCanvas({ onMount }: { onMount: (canvas: DiagramCanvas) => void }): ReactNode {
    return (
        <ReactFlowProvider>
            <Flow onMount={onMount} />
        </ReactFlowProvider>
    );
}
