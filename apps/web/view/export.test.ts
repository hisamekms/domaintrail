// Exporting (view/export.ts): the viewer's options, remembered; the scale a PNG is drawn at; the part of the page shown.
import { describe, expect, test } from 'bun:test';
import type { LaidOutGraph } from '@domaintrail/visualization';
import { EXPORT_OPTIONS_KEY, exportBounds, PNG_SCALE, pngScale, readExportOptions, writeExportOptions } from './export';

/** A storage of a map, like the browser's. */
function storage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
    const data = new Map(Object.entries(initial));
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('the export options', () => {
    test('are off until the viewer turns them on, and remembered', () => {
        const s = storage();
        expect(readExportOptions(s)).toEqual({ heading: false, legend: false });
        writeExportOptions(s, { heading: true, legend: false });
        expect(readExportOptions(s)).toEqual({ heading: true, legend: false });
        writeExportOptions(s, { heading: true, legend: true });
        expect(JSON.parse(s.data.get(EXPORT_OPTIONS_KEY)!)).toEqual({ heading: true, legend: true });
    });

    test('anything unreadable is the default, and no storage is no failure', () => {
        expect(readExportOptions(storage({ [EXPORT_OPTIONS_KEY]: '{' }))).toEqual({ heading: false, legend: false });
        expect(readExportOptions(storage({ [EXPORT_OPTIONS_KEY]: '{"heading":"yes","legend":true}' }))).toEqual({ heading: false, legend: true });
        expect(readExportOptions(undefined)).toEqual({ heading: false, legend: false });
        const failing = {
            setItem: () => {
                throw new Error('quota');
            },
        };
        expect(() => writeExportOptions(failing, { heading: true, legend: true })).not.toThrow();
    });
});

describe('a PNG', () => {
    test('is drawn at twice the size, unless the canvas would be larger than a browser draws', () => {
        expect(pngScale(1200, 800)).toBe(PNG_SCALE);
        // a long storming: as large as a canvas can be, each side and in all
        const long = pngScale(20000, 1200);
        expect(long).toBeLessThan(1);
        expect(20000 * long).toBeLessThanOrEqual(16384);
        const big = pngScale(6000, 6000);
        expect(6000 * big * 6000 * big).toBeLessThanOrEqual(64 * 1024 * 1024 + 1);
    });

    test('shows everything the graph draws, edge routes included, with room for the marks on its boxes', () => {
        const graph: LaidOutGraph = {
            id: 'structure',
            nodes: [],
            edges: [],
            nodeLayout: { a: { x: 10, y: 20, width: 100, height: 50 } },
            edgeLayout: {
                e: {
                    points: [
                        { x: 0, y: 0 },
                        { x: 200, y: 0 },
                    ],
                },
            },
            signature: 's',
        };
        const b = exportBounds(graph);
        expect(b.x).toBeLessThan(0);
        // the change badge stands out above a box's top
        expect(b.y).toBeLessThanOrEqual(-10);
        expect(b.x + b.w).toBeGreaterThan(200);
        expect(b.y + b.h).toBeGreaterThan(70);
    });
});
