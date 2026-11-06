// What a reader can hide of a view of a storming (ADR 0032 §10): one set of kinds, each hidden by
// another layout or by the drawing alone.
import { describe, expect, test } from 'bun:test';
import type { GraphNode, LaidOutGraph } from '../graph/ir.js';
import { drawsElement, hiddenInDrawing, hideInDrawing } from './hide.js';
import { HIDDEN_BY, HIDEABLE, hides, laidOutHidden, type Hideable } from './ir.js';
import { stormingViewKey } from './graph.js';

const note = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({
    id,
    kind: 'esEvent',
    label: { ja: { label: id, name: id, both: id }, en: { label: id, name: id, both: id } },
    lines: [],
    elementId: `es/S/${id}`,
    width: 150,
    height: 150,
    ...extra,
});

describe('the kinds a view of a storming can hide', () => {
    test('one set of kinds; only those hidden by another layout make another view (its key)', () => {
        expect([...HIDEABLE].sort()).toEqual(Object.keys(HIDDEN_BY).sort() as Hideable[]);
        expect(HIDDEN_BY).toEqual({ exceptions: 'layout', resolvedHotspots: 'drawing' });
        const all = new Set<Hideable>(['resolvedHotspots', 'exceptions']);
        expect(laidOutHidden(all)).toEqual({ hidden: ['exceptions'] });
        expect(laidOutHidden(['resolvedHotspots'])).toEqual({});
        expect(laidOutHidden([])).toEqual({});
        // the views keyed as before: `-exceptions`, and nothing for what the drawing hides
        expect(stormingViewKey({ level: 'big-picture', ...laidOutHidden(all) })).toBe('big-picture|-exceptions');
        expect(stormingViewKey({ level: 'big-picture', ...laidOutHidden(['resolvedHotspots']) })).toBe('big-picture|');
        expect(hides({ hidden: ['exceptions'] }, 'exceptions')).toBe(true);
        expect(hides({}, 'exceptions')).toBe(false);
    });
});

describe('hiding in the drawing', () => {
    const graph: LaidOutGraph = {
        id: 'storming:S:design-level:*',
        nodes: [
            note('e:A'),
            note('n:Open', { kind: 'esHotspot' }),
            note('n:Settled', { kind: 'esHotspot', status: 'resolved', resolution: '決めた' }),
            note('n:Loose', { kind: 'esHotspot', status: 'resolved', resolution: '決めた' }),
        ],
        edges: [
            { id: 'h1', kind: 'esHotspot', source: 'n:Open', target: 'e:A' },
            { id: 'h2', kind: 'esHotspot', source: 'n:Settled', target: 'e:A' },
        ],
        nodeLayout: { 'e:A': { x: 0, y: 0, width: 150, height: 150 } },
        edgeLayout: {},
        signature: 'sig',
    };
    const resolved = new Set<Hideable>(['resolvedHotspots']);

    test('a resolved hotspot is folded (not drawn, its line gone), with the stickies whose check stands for it; nothing moves', () => {
        const drawn = hideInDrawing(graph, resolved);
        expect(drawn.nodes.map((n) => [n.id, n.folded])).toEqual([
            ['e:A', undefined],
            ['n:Open', undefined],
            ['n:Settled', ['e:A']],
            ['n:Loose', []],
        ]);
        expect(drawn.edges.map((e) => e.id)).toEqual(['h1']);
        expect(drawn.nodeLayout).toBe(graph.nodeLayout);
        expect(drawn.signature).toBe(graph.signature);
    });

    test('the graph itself when nothing of it is hidden (the exceptions are the layout’s)', () => {
        expect(hideInDrawing(graph, new Set())).toBe(graph);
        expect(hideInDrawing(graph, new Set(['exceptions']))).toBe(graph);
    });

    test('what the view draws of an element, hidden or not', () => {
        expect(hiddenInDrawing(graph.nodes[2]!, resolved)).toBe(true);
        expect(hiddenInDrawing(graph.nodes[1]!, resolved)).toBe(false);
        expect(drawsElement(graph, 'es/S/n:Settled', resolved)).toBe(false);
        expect(drawsElement(graph, 'es/S/n:Settled', new Set())).toBe(true);
        expect(drawsElement(graph, 'es/S/n:Open', resolved)).toBe(true);
    });
});
