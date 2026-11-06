import { describe, expect, test } from 'bun:test';
import type { LaidOutGraph } from '@domaintrail/visualization';
import { rectCenter, rectContains, type Rect, unionRects } from '../scene';
import { cameraMove, fitAll, graphBounds, highlightElement } from './canvas';
import type { Camera, DiagramCanvas } from './diagram';

describe('the camera of the Event Storming view', () => {
    test('fits the whole graph whenever another storming, level or timeline is shown, even one shown before', () => {
        expect(cameraMove({ switched: true, storming: true, saved: false })).toBe('fitAll');
        expect(cameraMove({ switched: true, storming: true, saved: true })).toBe('fitAll');
    });

    test('keeps the camera when a live reload redraws the same graph', () => {
        expect(cameraMove({ switched: false, storming: true, saved: true })).toBe('keep');
        expect(cameraMove({ switched: false, storming: true, saved: false })).toBe('keep');
    });

    test('leaves the other canvases as they were: their own camera back, fitted readably the first time', () => {
        expect(cameraMove({ switched: true, storming: false, saved: true })).toBe('restore');
        expect(cameraMove({ switched: true, storming: false, saved: false })).toBe('fitReadable');
        expect(cameraMove({ switched: false, storming: false, saved: true })).toBe('keep');
    });
});

/** A canvas showing `items` (their page bounds), with the viewport `viewport`, recording the calls that change it. */
function fakeCanvas(items: Record<string, Rect & { elementId: string }>, viewport: Rect): { canvas: DiagramCanvas; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const record =
        (name: string) =>
        (...args: unknown[]): void => {
            calls.push([name, ...args]);
        };
    let camera: Camera = { x: 0, y: 0, z: 1 };
    const canvas: DiagramCanvas = {
        show: record('show'),
        clear: record('clear'),
        getCamera: () => camera,
        setCamera: (c, move) => {
            camera = c;
            calls.push(['setCamera', c, ...(move ? [move] : [])]);
        },
        getZoom: () => camera.z,
        zoomIn: record('zoomIn'),
        zoomOut: record('zoomOut'),
        resetZoom: record('resetZoom'),
        fitContent: record('fitContent'),
        fitBounds: record('fitBounds'),
        fitSelection: record('fitSelection'),
        centerOn: record('centerOn'),
        isAnimating: () => false,
        isMoving: () => false,
        measure: record('measure'),
        contentBounds: () => undefined,
        viewportPageBounds: () => viewport,
        viewportScreenBounds: () => ({ x: 0, y: 0, w: viewport.w, h: viewport.h }),
        screenToPage: (p) => p,
        pageToViewport: (p) => p,
        item: (id) => (items[id] ? { id, type: 'node', elementId: items[id].elementId, ghost: false, kind: 'entity' } : undefined),
        itemBounds: (id) => items[id],
        findElement: (elementId) => Object.keys(items).find((id) => items[id].elementId === elementId),
        elementNodes: (elementId) => Object.keys(items).filter((id) => items[id].elementId === elementId),
        selectedIds: () => [],
        onlySelectedId: () => undefined,
        selectionBounds: () => undefined,
        select: record('select'),
        selectNone: record('selectNone'),
        hoveredId: () => undefined,
        isPointing: () => false,
        pointer: () => ({ x: 0, y: 0 }),
        setTheme: record('setTheme'),
        container: () => {
            throw new Error('no container in a test');
        },
        watch: (effect) => {
            effect();
            return () => {};
        },
    };
    return { canvas, calls };
}

describe('highlighting an element on the canvas', () => {
    const items = { 'n:A.Order': { x: 100, y: 100, w: 50, h: 40, elementId: 'A.Order' }, 'n:A.Far': { x: 900, y: 900, w: 50, h: 40, elementId: 'A.Far' } };
    const viewport = { x: 0, y: 0, w: 500, h: 400 };

    test('selects its item, leaving the camera alone when the item is in view', () => {
        const { canvas, calls } = fakeCanvas(items, viewport);
        highlightElement(canvas, 'A.Order');
        expect(calls).toEqual([['select', ['n:A.Order']]]);
    });

    test('centers an item out of view, animated', () => {
        const { canvas, calls } = fakeCanvas(items, viewport);
        highlightElement(canvas, 'A.Far');
        expect(calls).toEqual([
            ['select', ['n:A.Far']],
            ['centerOn', { x: 925, y: 920 }, { animate: true }],
        ]);
    });

    test('clears the selection when the element is not drawn', () => {
        const { canvas, calls } = fakeCanvas(items, viewport);
        highlightElement(canvas, 'A.Missing');
        expect(calls).toEqual([['selectNone']]);
    });
});

describe('fitting a graph', () => {
    const graph = {
        nodeLayout: { a: { x: 10, y: 20, width: 100, height: 50 } },
        edgeLayout: {
            e: {
                points: [
                    { x: 60, y: 70 },
                    { x: 60, y: 300 },
                ],
                label: { x: 200, y: 150, width: 40, height: 20 },
            },
        },
    } as const;

    test('takes in the edges and their labels, which stick out of the nodes', () => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the layout is read
        expect(graphBounds(graph as unknown as LaidOutGraph)).toEqual({ x: 10, y: 20, w: 230, h: 280 });
    });

    test('never zooms in past normal size', () => {
        const { canvas, calls } = fakeCanvas({}, { x: 0, y: 0, w: 500, h: 400 });
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the layout is read
        fitAll(canvas, graph as unknown as LaidOutGraph, true);
        expect(calls).toEqual([['fitBounds', { x: 10, y: 20, w: 230, h: 280 }, { maxZoom: 1, inset: 16, animate: true }]]);
    });
});

describe('rectangles on the page', () => {
    test('contain only what lies strictly inside them', () => {
        const outer = { x: 0, y: 0, w: 100, h: 100 };
        expect(rectContains(outer, { x: 10, y: 10, w: 20, h: 20 })).toBe(true);
        expect(rectContains(outer, { x: 0, y: 10, w: 20, h: 20 })).toBe(false);
        expect(rectContains(outer, { x: 90, y: 10, w: 20, h: 20 })).toBe(false);
    });

    test('are joined into the smallest one around them all', () => {
        expect(unionRects([])).toBeUndefined();
        expect(
            unionRects([
                { x: 0, y: 5, w: 10, h: 10 },
                { x: -5, y: 20, w: 5, h: 5 },
            ]),
        ).toEqual({ x: -5, y: 5, w: 15, h: 20 });
        expect(rectCenter({ x: 10, y: 20, w: 30, h: 40 })).toEqual({ x: 25, y: 40 });
    });
});
