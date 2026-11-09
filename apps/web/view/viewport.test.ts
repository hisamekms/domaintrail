import { describe, expect, test } from 'bun:test';
import { sameValue } from './diagram';
import { centeredCamera } from './center';
import {
    cameraToTransform,
    centerCamera,
    defaultInset,
    fitCamera,
    MAX_ZOOM,
    MIN_ZOOM,
    selectionMaxZoom,
    transformToCamera,
    wheelZoom,
    ZOOM_STEPS,
    zoomAround,
    zoomInStep,
    zoomOutStep,
} from './viewport';

/** Where the port's camera puts a page point on the canvas. */
const onCanvas = (c: { x: number; y: number; z: number }, p: { x: number; y: number }) => ({ x: (p.x + c.x) * c.z, y: (p.y + c.y) * c.z });

describe("the camera and React Flow's viewport", () => {
    test('put every page point at the same place on the canvas', () => {
        const camera = { x: -120, y: 35.5, z: 0.85 };
        const t = cameraToTransform(camera);
        for (const p of [
            { x: 0, y: 0 },
            { x: 400, y: -73 },
        ]) {
            const viaTransform = { x: p.x * t.zoom + t.x, y: p.y * t.zoom + t.y };
            const viaCamera = onCanvas(camera, p);
            expect(viaTransform.x).toBeCloseTo(viaCamera.x, 9);
            expect(viaTransform.y).toBeCloseTo(viaCamera.y, 9);
        }
    });

    test('convert back to the same camera (a camera saved per view is restored as it was)', () => {
        const camera = { x: 210.25, y: -48, z: 2 };
        expect(transformToCamera(cameraToTransform(camera))).toEqual(camera);
    });
});

describe('the zoom steps (tldraw’s, kept)', () => {
    test('go from 5% to 800%', () => {
        expect(ZOOM_STEPS).toEqual([0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8]);
        expect([MIN_ZOOM, MAX_ZOOM]).toEqual([0.05, 8]);
    });

    test('zoom in to the next step, and out to the previous one', () => {
        expect(zoomInStep(1)).toBe(2);
        expect(zoomInStep(0.25)).toBe(0.5);
        expect(zoomOutStep(1)).toBe(0.5);
        expect(zoomOutStep(2)).toBe(1);
    });

    test('count a level less than half a step from a step as that step', () => {
        // 85% (a fit) is nearer 100% than 50%: + goes to 200%, − to 50%
        expect(zoomInStep(0.85)).toBe(2);
        expect(zoomOutStep(0.85)).toBe(0.5);
        // 60% is nearer 50%: + goes to 100%
        expect(zoomInStep(0.6)).toBe(1);
        // 140% counts as 100%: − goes to 50%; 160% counts as 200%: − goes to 100%
        expect(zoomOutStep(1.4)).toBe(0.5);
        expect(zoomOutStep(1.6)).toBe(1);
    });

    test('stop at the limits', () => {
        expect(zoomInStep(8)).toBe(8);
        expect(zoomOutStep(0.05)).toBe(0.05);
    });
});

describe('zooming around a point', () => {
    test('keeps the page point under it in place', () => {
        const camera = { x: -50, y: 20, z: 0.85 };
        const at = { x: 400, y: 300 };
        const page = { x: at.x / camera.z - camera.x, y: at.y / camera.z - camera.y };
        const zoomed = zoomAround(camera, at, 2);
        expect(zoomed.z).toBe(2);
        const after = onCanvas(zoomed, page);
        expect(after.x).toBeCloseTo(at.x, 9);
        expect(after.y).toBeCloseTo(at.y, 9);
    });
});

describe('a fit', () => {
    const size = { w: 1000, h: 600 };

    test('shows the bounds whole and centred, with the inset around them', () => {
        const bounds = { x: 100, y: 50, w: 2000, h: 400 };
        const c = fitCamera(bounds, size, 16);
        expect(c.z).toBeCloseTo((1000 - 16) / 2000, 9);
        const tl = onCanvas(c, bounds);
        const br = onCanvas(c, { x: bounds.x + bounds.w, y: bounds.y + bounds.h });
        expect(tl.x).toBeCloseTo(8, 9);
        expect(br.x).toBeCloseTo(992, 9);
        expect((tl.y + br.y) / 2).toBeCloseTo(300, 9);
    });

    test('zooms in no further than maxZoom, and never past the limits', () => {
        const small = { x: 0, y: 0, w: 10, h: 10 };
        expect(fitCamera(small, size, 16, 1).z).toBe(1);
        expect(fitCamera(small, size, 16).z).toBe(MAX_ZOOM);
        expect(fitCamera({ x: 0, y: 0, w: 1e6, h: 1e6 }, size, 16).z).toBe(MIN_ZOOM);
    });

    test('leaves 128 pixels in all by default, less on a narrow canvas', () => {
        expect(defaultInset(size)).toBe(128);
        expect(defaultInset({ w: 300, h: 600 })).toBeCloseTo(84, 9);
    });

    test('of the selection goes no further than 100%, unless at 100% already', () => {
        expect(selectionMaxZoom(0.5)).toBe(1);
        expect(selectionMaxZoom(2)).toBe(1);
        expect(selectionMaxZoom(1)).toBeUndefined();
    });
});

describe('centring', () => {
    test('puts the point at the middle of the canvas, keeping the zoom', () => {
        const c = centerCamera({ x: 300, y: -40 }, { w: 800, h: 500 }, 0.5);
        expect(c.z).toBe(0.5);
        expect(onCanvas(c, { x: 300, y: -40 })).toEqual({ x: 400, y: 250 });
    });

    test('keeps the same page point in the middle when a diagram fills the tab and returns', () => {
        const initial = { x: -125, y: 38, z: 1.5 };
        const small = { w: 800, h: 500 };
        const large = { w: 1400, h: 900 };
        const point = { x: small.w / 2 / initial.z - initial.x, y: small.h / 2 / initial.z - initial.y };
        const expanded = centeredCamera(initial, small, large);
        const restored = centeredCamera(expanded, large, small);
        expect(onCanvas(expanded, point)).toEqual({ x: large.w / 2, y: large.h / 2 });
        expect(restored).toEqual(initial);
    });
});

describe('the wheel with Ctrl or ⌘ (and a pinch)', () => {
    test('zooms by a hundredth of the zoom per pixel, at most ten per event', () => {
        expect(wheelZoom(1, 5)).toBeCloseTo(0.95, 9);
        expect(wheelZoom(1, -5)).toBeCloseTo(1.05, 9);
        expect(wheelZoom(2, 120)).toBeCloseTo(1.8, 9);
        expect(wheelZoom(2, -120)).toBeCloseTo(2.2, 9);
    });

    test('stays within the limits', () => {
        expect(wheelZoom(MAX_ZOOM, -10)).toBe(MAX_ZOOM);
        expect(wheelZoom(MIN_ZOOM, 10)).toBe(MIN_ZOOM);
    });
});

describe('a value kept from the canvas', () => {
    test('renders again only when it changed (plain objects compared one level deep)', () => {
        expect(sameValue(0.85, 0.85)).toBe(true);
        expect(sameValue({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true);
        expect(sameValue({ x: 1, y: 2 }, { x: 1, y: 3 })).toBe(false);
        expect(sameValue({ x: 1 }, { x: 1, y: undefined })).toBe(false);
        expect(sameValue(undefined, { x: 1 })).toBe(false);
        expect(sameValue([1], [1])).toBe(false);
    });
});
