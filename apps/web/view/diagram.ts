// The canvas port (docs/plans/react-flow.md): everything the Live View asks of the library that draws its diagrams,
// so that the app (`view/*`, `session/*`, `states-canvas.tsx`, `theme.ts`) does not know which library it is. Its
// implementation is React Flow's (`view/flow-canvas.tsx`); apps/web/canvas-boundary.test.ts keeps React Flow out of the
// rest.
import { useEffect, useState, type DependencyList } from 'react';
import type { Point, Rect, Scene, SceneId, SceneItemType } from '../scene';
import type { Theme } from '../theme';

/**
 * Where the canvas looks: a point of the page is on the canvas (relative to its top-left corner) at
 * `(page + (x, y)) * z`. `z` is the zoom level (1 = 100%). (tldraw's convention, kept so that the cameras saved per
 * view and `centeredCamera` stay as they were; `viewport.ts` converts it.)
 */
export interface Camera {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

/** A camera move: animated moves take 200 ms. */
export interface Move {
    readonly animate?: boolean;
}

/** An item as the canvas shows it. */
export interface CanvasItem {
    readonly id: SceneId;
    readonly type: SceneItemType;
    readonly elementId: string;
    readonly ghost: boolean;
    /** The node's, group's or edge's kind (`owns`, `references`, `esEvent`...); empty for internal transitions. */
    readonly kind: string;
}

/**
 * A canvas showing a scene, read-only. Its contract:
 *
 * - **Scene**: `show` draws a scene, reconciling by item ID (unchanged items keep their identity and selection) and
 *   stacking the items as `sceneItems` orders them; it never moves the camera. `clear` removes everything.
 * - **Read-only**: the user pans, zooms, hovers and selects (click, shift-click, drag a selection box); nothing can be
 *   moved, resized, edited or deleted.
 * - **Camera**: see `Camera`. Zooming in and out and resetting to 100% keep the canvas's center where it is. Fits
 *   leave a margin; `fitBounds` and `fitContent` never zoom past `maxZoom` when it is given.
 * - **Selection**: by item IDs; a click selects one item (the canvas's own gestures), `select` replaces the selection.
 * - **Coordinates**: *page* is the layout's space; *viewport* is relative to the canvas's top-left corner, in CSS
 *   pixels; *screen* is the browser window's client coordinates.
 * - **Pointer**: over an item that can be clicked (not a ghost) the pointer cursor shows.
 * - **Changes**: every getter may be read inside `watch`, which runs its effect again when what it read changes
 *   (`useCanvasValue` is its React hook).
 */
export interface DiagramCanvas {
    show(scene: Scene): void;
    clear(): void;

    getCamera(): Camera;
    setCamera(camera: Camera, move?: Move): void;
    getZoom(): number;
    zoomIn(move?: Move): void;
    zoomOut(move?: Move): void;
    /** Back to 100%. */
    resetZoom(move?: Move): void;
    /** Fits every item. */
    fitContent(move?: Move): void;
    /** Fits a rectangle of the page, leaving `inset` pixels around it, zoomed in no further than `maxZoom`. */
    fitBounds(bounds: Rect, opts: Move & { maxZoom?: number; inset?: number }): void;
    /** Fits the selected items (nothing happens when nothing is selected). */
    fitSelection(move?: Move): void;
    /** Moves the camera so that a point of the page is at the canvas's center (the zoom is kept). */
    centerOn(point: Point, move?: Move): void;
    /** Whether the camera is moving by itself (an animated fit): a camera set now would stop it. */
    isAnimating(): boolean;
    /** Whether the user is dragging or panning, or the camera is moving. */
    isMoving(): boolean;
    /** The canvas's container changed size: update what the canvas knows of it now (before a camera set in the same frame). */
    measure(): void;

    /** The bounds of every item, on the page; undefined when nothing is drawn. */
    contentBounds(): Rect | undefined;
    /** The part of the page the canvas shows. */
    viewportPageBounds(): Rect;
    /** The canvas on the screen (its position in the window, and its size). */
    viewportScreenBounds(): Rect;
    screenToPage(point: Point): Point;
    pageToViewport(point: Point): Point;

    item(id: SceneId): CanvasItem | undefined;
    /** An item's bounds on the page. */
    itemBounds(id: SceneId): Rect | undefined;
    /**
     * The item drawing a model element: its node if it has one (of several, the one nearest the middle of the view), else
     * the first item that stands for it.
     */
    findElement(elementId: string): SceneId | undefined;
    /** Every node drawing a model element (a storming's element drawn once per use has several), not the ghosts. */
    elementNodes(elementId: string): readonly SceneId[];

    selectedIds(): readonly SceneId[];
    /** The selected item when exactly one is selected. */
    onlySelectedId(): SceneId | undefined;
    /** The bounds of the selection, on the page. */
    selectionBounds(): Rect | undefined;
    select(ids: readonly SceneId[]): void;
    selectNone(): void;
    /** The item under the pointer. */
    hoveredId(): SceneId | undefined;
    /** Whether the pointer is pressed on the canvas (a pan, a click). */
    isPointing(): boolean;
    /** The pointer, relative to the canvas's top-left corner. */
    pointer(): Point;

    setTheme(theme: Theme): void;
    /** The element the canvas is drawn in (pointer events over the canvas reach it). */
    container(): HTMLElement;

    /** Runs `effect` now and again whenever what it read from the canvas changes; returns the stop. */
    watch(effect: () => void): () => void;
}

/** Whether two values are the same, or plain objects with the same values (one level deep). */
export function sameValue(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.is(Reflect.get(a, k), Reflect.get(b, k)));
}

/**
 * A value computed from the canvas, kept up to date (`DiagramCanvas.watch`); `compute` gets no canvas before it is
 * mounted. `deps` are what `compute` reads besides the canvas. A value equal to the previous one (`sameValue`) does
 * not render again.
 */
export function useCanvasValue<T>(canvas: DiagramCanvas | null, compute: (canvas: DiagramCanvas | null) => T, deps: DependencyList): T {
    const [value, setValue] = useState<T>(() => compute(canvas));
    useEffect(() => {
        const update = (v: T): void => setValue((old) => (sameValue(old, v) ? old : v));
        if (!canvas) {
            update(compute(null));
            return;
        }
        return canvas.watch(() => update(compute(canvas)));
        // the deps stand for what compute reads
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvas, ...deps]);
    return value;
}
