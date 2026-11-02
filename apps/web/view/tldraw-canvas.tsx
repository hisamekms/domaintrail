// The canvas port (`diagram.ts`) implemented with tldraw: the scene's items become the custom shapes of `shapes.tsx`,
// and the port's calls become the editor's. With `shapes.tsx`, the only module that knows tldraw.
import { useCallback, useRef } from 'react';
import { Box, createShapeId, react, Tldraw, type Editor, type TLShapeId, type TLShapePartial } from 'tldraw';
import type { Rect, Scene, SceneId, SceneItem, SceneItemType } from '../scene';
import { shapeUtils } from '../shapes';
import type { CanvasItem, DiagramCanvas, Move } from './diagram';

const ANIMATION = { animation: { duration: 200 } };
const animation = (move?: Move) => (move?.animate ? ANIMATION : undefined);

const SHAPE_TYPES: Record<SceneItemType, string> = { node: 'domain-node', group: 'domain-group', internal: 'domain-internal', edge: 'domain-edge' };
const ITEM_TYPES = new Map<string, SceneItemType>(Object.entries(SHAPE_TYPES).map(([item, shape]) => [shape, item as SceneItemType])); // oxlint-disable-line typescript/no-unsafe-type-assertion -- the keys of SHAPE_TYPES

/** A scene item's shape ID (`n:Sales.Order` -> `shape:n:Sales.Order`), and back. */
const shapeId = (id: SceneId): TLShapeId => createShapeId(id);
const itemId = (id: TLShapeId): SceneId => id.slice('shape:'.length);

/** What the app reads from a shape: its element, and the graph node or edge it draws, and whether it is a ghost. */
interface ShapeMeta {
    elementId?: string;
    graphNode?: string;
    edge?: string;
    ghost?: boolean;
}

const rect = (b: Box): Rect => ({ x: b.x, y: b.y, w: b.w, h: b.h });

function shapeOf(item: SceneItem): TLShapePartial {
    const meta: ShapeMeta = { elementId: item.elementId };
    if ('graphNode' in item && item.graphNode !== undefined) meta.graphNode = item.graphNode;
    if ('edge' in item) meta.edge = item.edge;
    if (item.ghost) meta.ghost = true;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tldraw's shape types do not know our custom shapes
    return { id: shapeId(item.id), type: SHAPE_TYPES[item.type], x: item.x, y: item.y, meta: { ...meta }, props: { ...item.props } } as TLShapePartial;
}

/**
 * The canvas is read-only for the user (GUI editing is out of scope for the MVP), but tldraw's
 * read-only mode also rejects programmatic edits, so it is lifted only while the model is synced.
 */
function withWriteAccess(editor: Editor, fn: () => void): void {
    const readonly = editor.getIsReadonly();
    if (readonly) editor.updateInstanceState({ isReadonly: false });
    try {
        editor.run(fn, { history: 'ignore', ignoreShapeLock: true });
    } finally {
        if (readonly) editor.updateInstanceState({ isReadonly: true });
    }
}

/** Reconciles the editor's shapes with the scene; the camera is never touched here. */
function showScene(editor: Editor, scene: Scene): void {
    const groups = scene.groups.map(shapeOf);
    const internal = scene.internal.map(shapeOf);
    const edges = scene.edges.map(shapeOf);
    const wanted = [...groups, ...scene.nodes.map(shapeOf), ...scene.ghosts.map(shapeOf), ...internal, ...edges];
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
        /* oxlint-enable typescript/no-unsafe-type-assertion */

        // z-order: contexts < aggregate boundaries < nodes < internal transitions < edges (as `sceneItems` orders them)
        const boundaryIds = scene.groups.filter((g) => g.props.kind === 'aggregateBoundary').map((g) => shapeId(g.id));
        const contextIds = scene.groups.filter((g) => g.props.kind !== 'aggregateBoundary').map((g) => shapeId(g.id));
        if (boundaryIds.length) editor.sendToBack(boundaryIds);
        if (contextIds.length) editor.sendToBack(contextIds);
        if (internal.length) editor.bringToFront(internal.map((r) => r.id));
        if (edges.length) editor.bringToFront(edges.map((e) => e.id));
    });
}

/** Whether tldraw is moving the camera itself (zoomToFit and the like, animated): a camera set now would stop it. */
function animatingCamera(editor: Editor): boolean {
    // internal to tldraw (5.5): the running animation of `_animateToViewport`, null when there is none
    const animation: unknown = Reflect.get(editor, '_viewportAnimation');
    return animation != null;
}

const metaOf = (meta: unknown): ShapeMeta => meta as ShapeMeta; // oxlint-disable-line typescript/no-unsafe-type-assertion -- written by shapeOf

/** The port over a mounted tldraw editor. */
export function createTldrawCanvas(editor: Editor): DiagramCanvas {
    return {
        show: (scene) => showScene(editor, scene),
        clear: () => withWriteAccess(editor, () => editor.deleteShapes([...editor.getCurrentPageShapeIds()])),

        getCamera: () => {
            const { x, y, z } = editor.getCamera();
            return { x, y, z };
        },
        setCamera: (camera, move) => editor.setCamera(camera, animation(move)),
        getZoom: () => editor.getZoomLevel(),
        zoomIn: (move) => editor.zoomIn(editor.getViewportScreenCenter(), animation(move)),
        zoomOut: (move) => editor.zoomOut(editor.getViewportScreenCenter(), animation(move)),
        resetZoom: (move) => editor.resetZoom(editor.getViewportScreenCenter(), animation(move)),
        fitContent: (move) => editor.zoomToFit(animation(move)),
        fitBounds: (b, opts) => editor.zoomToBounds(new Box(b.x, b.y, b.w, b.h), { targetZoom: opts.maxZoom, inset: opts.inset, ...animation(opts) }),
        fitSelection: (move) => {
            if (editor.getSelectedShapeIds().length > 0) editor.zoomToSelection(animation(move));
        },
        centerOn: (point, move) => editor.centerOnPoint(point, animation(move)),
        isAnimating: () => animatingCamera(editor),
        isMoving: () => editor.inputs.getIsDragging() || editor.inputs.getIsPanning() || editor.getCameraState() === 'moving',
        // tldraw's own update of its viewport is throttled
        measure: () => editor.updateViewportScreenBounds(editor.getContainer()),

        contentBounds: () => {
            const b = editor.getCurrentPageBounds();
            return b && rect(b);
        },
        viewportPageBounds: () => rect(editor.getViewportPageBounds()),
        viewportScreenBounds: () => rect(editor.getViewportScreenBounds()),
        screenToPage: (p) => {
            const { x, y } = editor.screenToPage(p);
            return { x, y };
        },
        pageToViewport: (p) => {
            const { x, y } = editor.pageToViewport(p);
            return { x, y };
        },

        item: (id): CanvasItem | undefined => {
            const shape = editor.getShape(shapeId(id));
            const type = shape && ITEM_TYPES.get(shape.type);
            if (!shape || !type) return undefined;
            const meta = metaOf(shape.meta);
            const kind = 'kind' in shape.props && typeof shape.props.kind === 'string' ? shape.props.kind : '';
            return { id, type, elementId: meta.elementId ?? '', ghost: meta.ghost === true, kind };
        },
        itemBounds: (id) => {
            const b = editor.getShapePageBounds(shapeId(id));
            return b && rect(b);
        },
        findElement: (elementId) => {
            const shapes = editor.getCurrentPageShapes();
            const exact = shapes.find((s) => metaOf(s.meta).elementId === elementId && s.type === 'domain-node');
            const shape = exact ?? shapes.find((s) => metaOf(s.meta).elementId === elementId);
            return shape && itemId(shape.id);
        },

        selectedIds: () => editor.getSelectedShapeIds().map(itemId),
        onlySelectedId: () => {
            const id = editor.getOnlySelectedShapeId();
            return id ? itemId(id) : undefined;
        },
        selectionBounds: () => {
            const b = editor.getSelectionPageBounds();
            return b ? rect(b) : undefined;
        },
        select: (ids) => editor.select(...ids.map(shapeId)),
        selectNone: () => editor.selectNone(),
        hoveredId: () => {
            const id = editor.getHoveredShapeId();
            return id ? itemId(id) : undefined;
        },
        isPointing: () => editor.inputs.getIsPointing(),
        pointer: () => {
            const { x, y } = editor.inputs.getCurrentScreenPoint();
            return { x, y };
        },

        setTheme: (theme) => {
            if (editor.user.getUserPreferences().colorScheme !== theme) editor.user.updateUserPreferences({ colorScheme: theme });
        },
        container: () => editor.getContainer(),
        watch: (effect) => react('canvas watch', effect),
    };
}

/**
 * tldraw hit-tests shapes itself (DOM hover never reaches them) and resets the cursor on its own state changes
 * (e.g. after a click), so the pointer cursor is re-derived whenever the hover target or the cursor changes.
 */
function pointerCursor(editor: Editor): () => void {
    return react('pointer cursor', () => {
        const id = editor.getHoveredShapeId();
        const shape = id ? editor.getShape(id) : undefined;
        const clickable = !!shape && !metaOf(shape.meta).ghost;
        const cursor = editor.getInstanceState().cursor.type;
        if (clickable && cursor === 'default') editor.setCursor({ type: 'pointer', rotation: 0 });
        else if (!clickable && cursor === 'pointer') editor.setCursor({ type: 'default', rotation: 0 });
    });
}

/**
 * A read-only tldraw canvas drawing the scene's shapes, without tldraw's UI. `onMount` gets its port once it is
 * mounted; `expose` also puts the editor on `window.__domaintrailEditor` (for debugging and e2e checks).
 */
export function TldrawCanvas({ onMount, expose }: { onMount: (canvas: DiagramCanvas) => void; expose?: boolean }) {
    const latest = useRef(onMount);
    latest.current = onMount;
    const mount = useCallback(
        (editor: Editor) => {
            editor.updateInstanceState({ isReadonly: true });
            if (expose) Object.assign(window, { __domaintrailEditor: editor });
            const stop = pointerCursor(editor);
            latest.current(createTldrawCanvas(editor));
            return stop;
        },
        [expose],
    );
    return <Tldraw shapeUtils={shapeUtils} hideUi onMount={mount} />;
}
