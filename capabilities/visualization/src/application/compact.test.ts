// The compact spacing (「詰めて表示」, printing): its gaps reach ELK and the grid, and the view service lays out a pushed
// graph compactly on request, caching and saving it beside the graph's normal layout, never in its place.
import { afterAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { analyzeStormings } from '@domaintrail/storming';
import { ElkLayoutEngine, SPACING_OPTIONS } from '../adapters/elk.js';
import { GRID_SPACING, layoutGrid } from '../core/graph/grid.js';
import { sameText, type Graph, type GraphNode, type LaidOutGraph } from '../core/graph/ir.js';
import { renderToGraph } from '../core/storming/graph.js';
import { projectView } from '../core/storming/render.js';
import { stormingViewKey } from '../core/storming/graph.js';
import type { LayoutCache, LayoutStore } from './ports.js';
import { compactKey, createViewService } from './view-service.js';

const STAGES = path.join(import.meta.dir, '..', '..', '..', '..', 'test', 'fixtures', 'stages', 'convenience-store-stages.dtes');
const STAGED_TEXT = await readFile(STAGES, 'utf8');

const engine = new ElkLayoutEngine();
afterAll(() => engine.dispose());

const note = (id: string): GraphNode => ({ id, kind: 'esEvent', label: sameText(id), lines: [], elementId: id, width: 120, height: 120 });

/** Two notes in a row (a storming reads left to right): the gap between them is the gap between layers. */
const pair: Graph = {
    id: 'storming:Pair:big-picture:*',
    nodes: [note('A'), note('B'), note('C')],
    edges: [
        { id: 'A-B', kind: 'esSequence', source: 'A', target: 'B' },
        { id: 'A-C', kind: 'esSequence', source: 'A', target: 'C' },
    ],
};

describe('the compact spacing', () => {
    test('closes up ELK’s gaps between layers and between the notes of a layer, and marks the layout compact', async () => {
        const normal = await engine.layout(pair);
        const compact = await engine.layout(pair, { spacing: 'compact' });
        const gap = (g: LaidOutGraph): number => g.nodeLayout['B']!.x - (g.nodeLayout['A']!.x + g.nodeLayout['A']!.width);
        const beside = (g: LaidOutGraph): number => Math.abs(g.nodeLayout['C']!.y - g.nodeLayout['B']!.y) - 120;
        expect(gap(normal)).toBe(Number(SPACING_OPTIONS.normal['elk.layered.spacing.nodeNodeBetweenLayers']));
        expect(gap(compact)).toBe(Number(SPACING_OPTIONS.compact['elk.layered.spacing.nodeNodeBetweenLayers']));
        expect(beside(normal)).toBe(Number(SPACING_OPTIONS.normal['elk.spacing.nodeNode']));
        expect(beside(compact)).toBe(Number(SPACING_OPTIONS.compact['elk.spacing.nodeNode']));
        expect(normal.spacing).toBeUndefined();
        expect(compact.spacing).toBe('compact');
        // the same graph: the cache key of a layout is the graph's signature plus where it is kept (`compactKey`)
        expect(compact.signature).toBe(normal.signature);
    });

    test('closes up the grid of a storming with stages: narrower gutters, the routes and captions still between the notes', async () => {
        const [storming] = (await analyzeStormings([{ path: 's.dtes', text: STAGED_TEXT }], undefined)).stormings;
        const graph = renderToGraph(projectView(storming!, { level: 'big-picture' }), storming!);
        const normal = layoutGrid(graph);
        const compact = layoutGrid(graph, 'compact');
        expect(compact.spacing).toBe('compact');
        const width = (g: LaidOutGraph): number => Math.max(...Object.values(g.nodeLayout).map((b) => b.x + b.width));
        expect(width(compact)).toBeLessThan(width(normal) * 0.9);
        // two notes next to each other on the main row: a column's gutter apart
        const row0 = (g: LaidOutGraph): number[] =>
            Object.entries(graph.grid!.cells)
                .filter(([id, c]) => c.row === 0 && !graph.nodes.some((n) => n.parent === id))
                .map(([id]) => g.nodeLayout[id]!.x)
                .sort((a, b) => a - b);
        const gaps = (g: LaidOutGraph): number[] =>
            row0(g)
                .slice(1)
                .map((x, i) => x - row0(g)[i]!);
        expect(Math.min(...gaps(normal)) - Math.min(...gaps(compact))).toBe(GRID_SPACING.normal.col - GRID_SPACING.compact.col);
        // a lane's caption stays above its first note, below the row above it
        for (const e of graph.edges.filter((x) => x.label)) {
            const label = compact.edgeLayout[e.id]!.label!;
            expect(label.y + label.height).toBeLessThanOrEqual(compact.nodeLayout[e.target]!.y);
        }
    });
});

/** A layout store in memory, which keeps what it was last given. */
function memoryStore(): LayoutStore & { saved: LayoutCache } {
    const store = {
        saved: new Map() as LayoutCache,
        load: (): Promise<LayoutCache> => Promise.resolve(new Map(store.saved)),
        save: (_engine: unknown, layouts: ReadonlyMap<string, LaidOutGraph>): Promise<void> => {
            store.saved = new Map(layouts);
            return Promise.resolve();
        },
    };
    return store;
}

describe('compact layouts of the view service', () => {
    const service = (store: LayoutStore) =>
        createViewService({
            root: '/w',
            engine,
            layoutStore: store,
            workspace: {
                readSources: () =>
                    Promise.resolve([
                        { path: 'sales.dt', text: 'context Sales {\n  id OrderId: UUID\n  aggregate Order {\n    id: OrderId\n  }\n}\n' },
                        { path: 's.dtes', text: STAGED_TEXT },
                    ]),
            },
            git: {
                resolveCommit: () => Promise.reject(new Error('no git')),
                sourcesAt: () => Promise.resolve([]),
                listRefs: () => Promise.resolve({ branches: [], tags: [], commits: [] }),
                gitDirs: () => Promise.resolve(undefined),
            },
        });

    test('are laid out on request, kept beside the normal ones under their own key, and reused', async () => {
        const store = memoryStore();
        const view = service(store);
        const state = await view.refresh();
        const structure = state.structure!;
        const stage = state.stormings[0]!.views[stormingViewKey({ level: 'big-picture' })]!.graph;
        expect(stage.grid).toBeDefined();

        const compact = (await view.compactGraph(structure.id))!;
        expect(compact.spacing).toBe('compact');
        expect(compact.nodes).toEqual(structure.nodes);
        const grid = (await view.compactGraph(stage.id))!;
        expect(grid.spacing).toBe('compact');
        expect(await view.compactGraph('no-such-graph')).toBeNull();

        // saved apart: the normal layouts are as they were
        expect(store.saved.get(structure.id)?.nodeLayout).toEqual(structure.nodeLayout);
        expect(store.saved.get(compactKey(structure.id))?.nodeLayout).toEqual(compact.nodeLayout);
        expect(store.saved.get(compactKey(stage.id))?.nodeLayout).toEqual(grid.nodeLayout);
        expect(compactKey(structure.id)).not.toBe(structure.id);

        // a refresh keeps both, and a later run reuses the saved compact layout
        await view.refresh();
        expect(store.saved.has(compactKey(structure.id))).toBe(true);
        const again = service(store);
        await again.refresh();
        expect((await again.compactGraph(structure.id))!.nodeLayout).toEqual(compact.nodeLayout);
    });

    test('a focused Structure View is laid out compactly on request too, cached apart from its normal layout', async () => {
        const view = service(memoryStore());
        await view.refresh();
        const normal = (await view.focusGraph(['Sales'], 'detail'))!;
        const compact = (await view.focusGraph(['Sales'], 'detail', [], 'compact'))!;
        expect(normal.spacing).toBeUndefined();
        expect(compact.spacing).toBe('compact');
        expect((await view.focusGraph(['Sales'], 'detail'))!.spacing).toBeUndefined();
        expect((await view.focusGraph(['Sales'], 'detail', [], 'compact'))!.spacing).toBe('compact');
    });
});
