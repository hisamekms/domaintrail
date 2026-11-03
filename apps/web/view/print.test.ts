// Printing (view/print.tsx): what the page prints, when the 印刷 action prints, and the sheet a diagram is printed on.
import { describe, expect, test } from 'bun:test';
import type { LaidOutGraph } from '@domaintrail/visualization';
import { PRINT_WAIT_MS, printKind, readyToPrint, sheetBounds } from './print';

const graph = (id: string, signature: string, extra: Partial<LaidOutGraph> = {}): LaidOutGraph => ({
    id,
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
    signature,
    ...extra,
});

describe('printing', () => {
    test('a canvas view prints its diagram on a sheet; the catalog prints the page', () => {
        expect(printKind(true)).toBe('diagram');
        expect(printKind(false)).toBe('page');
    });

    test('the 印刷 action waits for the compact layout, but not for ever, nor for a view without a diagram', () => {
        expect(readyToPrint(graph('structure', 's'), 0)).toBe(false);
        expect(readyToPrint(undefined, 100)).toBe(false);
        expect(readyToPrint(graph('structure', 's', { spacing: 'compact' }), 0)).toBe(true);
        expect(readyToPrint(null, 0)).toBe(true);
        expect(readyToPrint(graph('structure', 's'), PRINT_WAIT_MS)).toBe(true);
    });

    test('the sheet shows everything the diagram draws, edge routes included, with a margin', () => {
        const b = sheetBounds(graph('structure', 's'));
        expect(b.x).toBeLessThan(0);
        expect(b.y).toBeLessThan(0);
        expect(b.x + b.w).toBeGreaterThan(200);
        expect(b.y + b.h).toBeGreaterThan(70);
    });
});
