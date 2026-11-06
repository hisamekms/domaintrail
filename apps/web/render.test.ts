import { describe, expect, test } from 'bun:test';
import type { Diagnostic } from '@domaintrail/kernel';
import type { ModelDiff } from '@domaintrail/modeling';
import type { LaidOutGraph } from '@domaintrail/visualization';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import { buildScene, type RenderOptions } from './render';
import { copyIndices, graphNodeOf, itemForElement, joinedEdges, readingOrder, sceneItems, type Scene } from './scene';
import { viewPayloads } from './test-helpers';

const file = (body: string) => ({ path: 'a.dt', text: `context A {\n${body}\n}\n` });
const BEFORE = `
  id OrderId: UUID
  event Placed { orderId: OrderId }
  aggregate Order {
    id: OrderId
    note: String
    state Open
    state Done
    state Held
    create command place(id: OrderId) -> Open emits Placed
    command close() Open -> Done
    command hold() Open -> Held
    command annotate(note: String) Open -> Open
  }`;
const AFTER = `
  id OrderId: UUID
  event Placed { orderId: OrderId }
  aggregate Order {
    id: OrderId
    note: String
    memo: String?
    state Open
    state Done
    create command place(id: OrderId) -> Open emits Placed
    command close() Open -> Done
    command annotate(note: String) Open -> Open
  }`;

/** The payloads before and after `Held` and `hold` are removed and `memo` is added. */
const payloads = async (): Promise<[ViewPayload, ViewPayload]> => {
    const [before, after] = await viewPayloads([file(BEFORE)], [file(AFTER)]);
    return [before, after];
};
const warning = (elementId: string): Diagnostic => ({
    file: 'a.dt',
    start: { line: 1, column: 1 },
    end: { line: 1, column: 1 },
    severity: 'warning',
    code: 'TEST',
    message: 'a warning',
    elementId,
});
const optionsOf = (p: ViewPayload, previous?: LaidOutGraph): RenderOptions => ({
    diff: p.diff,
    diagnostics: [],
    ...(previous && { previous }),
    mode: 'label',
    lang: 'en',
});

describe('the scene of a structure graph', () => {
    test('draws contexts and aggregate boundaries as groups, and elements as nodes with their change and diagnostic marks', async () => {
        const [, after] = await payloads();
        const scene = buildScene(after.structure!, { ...optionsOf(after), diagnostics: [warning('A.Order#Open')] });
        expect(scene.groups.map((g) => [g.id, g.props.kind])).toEqual([
            ['n:A', 'context'],
            ['n:A.Order@boundary', 'aggregateBoundary'],
        ]);
        expect(scene.groups.every((g) => g.props.change === 'none' && g.props.diag === 'none')).toBe(true);
        const [order] = scene.nodes;
        expect(order).toMatchObject({ id: 'n:A.Order', type: 'node', elementId: 'A.Order', graphNode: 'A.Order' });
        // a state's diagnostic marks its aggregate in the structure
        expect(order.props).toMatchObject({ change: 'changed', badge: 'Changed', diag: 'warning' });
        expect(order.props.rows.find((r) => r.k === 'memo')).toMatchObject({ c: 'added' });
        const layout = after.structure!.nodeLayout['A.Order'];
        expect([order.x, order.y, order.props.w, order.props.h]).toEqual([layout.x, layout.y, layout.width, layout.height]);
    });

    test('stacks contexts behind aggregate boundaries, behind nodes, internal transitions and edges', async () => {
        const [before, after] = await payloads();
        const states = after.states['A.Order'].both;
        const scene = buildScene(states, optionsOf(after, before.states['A.Order'].both));
        const structure = buildScene(after.structure!, optionsOf(after));
        expect(sceneItems(structure).map((i) => i.id)).toEqual(['n:A', 'n:A.Order@boundary', 'n:A.Order']);
        expect(scene.ghosts.length * scene.internal.length * scene.edges.length).toBeGreaterThan(0);
        expect(sceneItems(scene).map((i) => i.id)).toEqual([...scene.nodes, ...scene.ghosts, ...scene.internal, ...scene.edges].map((i) => i.id));
    });
});

describe('the scene of a state graph', () => {
    test('draws an internal transition as a row of its own over the compartment of its state', async () => {
        const [, after] = await payloads();
        const scene = buildScene(after.states['A.Order'].both, optionsOf(after));
        const open = scene.nodes.find((n) => n.elementId === 'A.Order#Open')!;
        expect(open.props.compartment).toBeGreaterThan(0);
        expect(scene.internal).toHaveLength(1);
        const [row] = scene.internal;
        expect(row).toMatchObject({ type: 'internal', elementId: 'A.Order:annotate', props: { label: 'annotate(note)', w: open.props.w - 8 } });
        expect(row.id).toBe(`i:${row.edge}`);
        expect(row.x).toBe(open.x + 4);
        expect(row.y).toBeGreaterThanOrEqual(open.y + open.props.h - open.props.compartment);
        expect(row.y + row.props.h).toBeLessThanOrEqual(open.y + open.props.h);
    });

    test('draws edges along their route, relative to their origin, owned by their command', async () => {
        const [, after] = await payloads();
        const graph = after.states['A.Order'].both;
        const scene = buildScene(graph, optionsOf(after));
        const place = scene.edges.find((e) => e.elementId === 'A.Order:place')!;
        expect(place).toMatchObject({ type: 'edge', props: { kind: 'transition', label: 'place(id)', sub: '⇒ Placed', tone: 'normal' } });
        expect(place.id).toBe(`e:${place.edge}`);
        const route = graph.edgeLayout[place.edge];
        expect(place.props.points.map((p) => ({ x: p.x + place.x, y: p.y + place.y }))).toEqual(route.points);
        expect(Math.min(...place.props.points.map((p) => p.x), place.props.lx)).toBe(0);
        expect(Math.min(...place.props.points.map((p) => p.y), place.props.ly)).toBe(0);
    });

    test('names the items of the nodes an edge joins (a canvas joins them)', async () => {
        const [, after] = await payloads();
        const graph = after.states['A.Order'].both;
        const scene = buildScene(graph, optionsOf(after));
        const items = new Set(sceneItems(scene).map((i) => i.id));
        for (const e of scene.edges) {
            const edge = graph.edges.find((g) => g.id === e.edge)!;
            expect([e.source, e.target]).toEqual([`n:${edge.source}`, `n:${edge.target}`]);
            expect(items.has(e.source) && items.has(e.target)).toBe(true);
        }
    });

    test('labels transitions as asked', async () => {
        const [, after] = await payloads();
        const scene = buildScene(after.states['A.Order'].event, { ...optionsOf(after), transitionLabels: 'event' });
        expect(scene.edges.find((e) => e.elementId === 'A.Order:place')?.props).toMatchObject({ label: 'Placed', sub: '' });
    });

    test('draws a removed state as a ghost where it was in the previous graph', async () => {
        const [before, after] = await payloads();
        const previous = before.states['A.Order'].both;
        const scene = buildScene(after.states['A.Order'].both, optionsOf(after, previous));
        expect(scene.ghosts.map((g) => [g.id, g.type, g.elementId, g.ghost])).toEqual([['ghost:A.Order#Held', 'node', 'A.Order#Held', true]]);
        const [held] = scene.ghosts;
        expect([held.x, held.y]).toEqual([previous.nodeLayout['A.Order#Held'].x, previous.nodeLayout['A.Order#Held'].y]);
        expect(held.props).toMatchObject({ change: 'removed', badge: 'Removed', diag: 'none' });
        // without the previous version of the same graph, nothing is drawn of it
        expect(buildScene(after.states['A.Order'].both, optionsOf(after)).ghosts).toEqual([]);
        expect(buildScene(after.states['A.Order'].both, optionsOf(after, after.structure!)).ghosts).toEqual([]);
    });
});

describe('scene items', () => {
    const scene = async (): Promise<Scene> => {
        const [, after] = await payloads();
        return buildScene(after.states['A.Order'].both, optionsOf(after));
    };

    test('name the graph node they draw', () => {
        expect(graphNodeOf('n:A.Order#Open')).toBe('A.Order#Open');
        expect(graphNodeOf('e:A.Order:close|x')).toBeUndefined();
        expect(graphNodeOf('ghost:A.Order#Held')).toBeUndefined();
    });

    test('are found by element: the node first, else the first item that stands for it', async () => {
        const items = sceneItems(await scene());
        expect(itemForElement(items, 'A.Order#Open')?.id).toBe('n:A.Order#Open');
        expect(itemForElement(items, 'A.Order:annotate')?.type).toBe('internal');
        expect(itemForElement(items, 'A.Order:close')?.type).toBe('edge');
        expect(itemForElement(items, 'A.Missing')).toBeUndefined();
    });
});

describe('an element of a storming drawn once per use (Design Level)', () => {
    const dtes = (clerk: string, boss: string): { path: string; text: string } => ({
        path: 'es.dtes',
        text: `storming S {
  event Opened event Approved event Closed event Archived
  actor Clerk ${clerk}
  ${boss}
  command Open { by Clerk emits Opened }
  command Approve { emits Approved }
  command Close { by Clerk ${boss ? 'by Boss ' : ''}emits Closed }
  command Archive { emits Archived }
  policy P1 { on Opened issues Approve }
  policy P2 { on Approved issues Archive }
  timeline T { Opened Approved Closed }
}
`,
    });
    const payload = async (): Promise<ViewPayload> => (await viewPayloads([dtes('"窓口係"', 'actor Boss')]))[0]!;
    const graph = async (): Promise<LaidOutGraph> => (await payload()).stormings[0]!.views['design-level|']!.graph;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- element IDs as a diff lists them
    const ids = (...list: string[]): ModelDiff['added'] => list as unknown as ModelDiff['added'];
    const scene = async (diff: ModelDiff = { added: [], changed: [], removed: [] }, previous?: LaidOutGraph): Promise<Scene> =>
        buildScene(await graph(), { diff, diagnostics: [], ...(previous && { previous }), mode: 'label', lang: 'en' });

    test('every note of a changed, added or removed element carries its change mark', async () => {
        const nodes = (await scene({ added: ids('es/S/Boss'), changed: ids('es/S/Clerk'), removed: [] })).nodes;
        const change = (id: string) => nodes.find((n) => n.id === id)?.props.change;
        expect(nodes.filter((n) => n.elementId === 'es/S/Clerk').map((n) => n.id)).toEqual(['n:n:Clerk@Close', 'n:n:Clerk@Open']);
        expect([change('n:n:Clerk@Open'), change('n:n:Clerk@Close')]).toEqual(['changed', 'changed']);
        expect(change('n:n:Boss@Close')).toBe('added');
        expect(change('n:n:Open')).toBe('none');
        // removed since the previous graph: a ghost where each of its notes was
        const before = await graph();
        const without = dtes('', 'actor Boss');
        const [after] = await viewPayloads([{ ...without, text: without.text.replace(/ {2}actor Clerk \n/, '').replaceAll('by Clerk ', '') }]);
        const ghosts = buildScene(after!.stormings[0]!.views['design-level|']!.graph, {
            diff: { added: [], changed: [], removed: ids('es/S/Clerk') },
            diagnostics: [],
            previous: before,
            mode: 'label',
            lang: 'en',
        }).ghosts;
        expect(ghosts.map((g) => g.id).sort()).toEqual(['ghost:n:Clerk@Close', 'ghost:n:Clerk@Open']);
    });

    test('a jump to the element finds the note nearest the viewport’s centre, else the first in reading order', async () => {
        const items = sceneItems(await scene());
        const at = (id: string) => items.find((s) => s.id === id)!;
        const [open, close] = [at('n:n:Clerk@Open'), at('n:n:Clerk@Close')];
        expect(open.x).toBeLessThan(close.x);
        expect(itemForElement(items, 'es/S/Clerk', { x: close.x + 1, y: close.y + 1 })?.id).toBe(close.id);
        expect(itemForElement(items, 'es/S/Clerk', { x: open.x, y: open.y })?.id).toBe(open.id);
        const first = [open, close].sort((a, b) => a.y - b.y || a.x - b.x)[0]!;
        expect(itemForElement(items, 'es/S/Clerk')?.id).toBe(first.id);
    });

    test('selecting one note numbers every note of its element in reading order, not other elements', async () => {
        const items = sceneItems(await scene());
        const copies = (...selected: string[]) => Object.fromEntries(copyIndices(items, new Set(selected)));
        // left to right: the actor beside Open, then the one beside Close
        expect(copies('n:n:Clerk@Close')).toEqual({ 'n:n:Clerk@Open': { k: 1, n: 2 }, 'n:n:Clerk@Close': { k: 2, n: 2 } });
        expect(copies('n:n:Clerk@Open', 'n:n:Clerk@Close')).toEqual(copies('n:n:Clerk@Open'));
        // an element drawn once: no number
        expect(copies('n:n:Open')).toEqual({});
        // an edge selected numbers nothing
        const edge = items.find((s) => s.type === 'edge' && s.elementId === 'es/S/Clerk')!;
        expect(copies(edge.id)).toEqual({});
    });

    test('reading order: left to right, then top to bottom', () => {
        const at = (x: number, y: number) => ({ x, y });
        expect([at(5, 0), at(0, 9), at(0, 1)].sort(readingOrder)).toEqual([at(0, 1), at(0, 9), at(5, 0)]);
    });

    test('selecting a note marks the lines joined to it, and nothing else; a selected line marks none', async () => {
        const items = sceneItems(await scene());
        const joined = (...selected: string[]): string[] => [...joinedEdges(items, new Set(selected))].sort();
        const edgesAt = (id: string): string[] =>
            items
                .filter((i) => i.type === 'edge' && (i.source === id || i.target === id))
                .map((i) => i.id)
                .sort();
        expect(joined('n:n:Close')).toEqual(edgesAt('n:n:Close'));
        expect(joined('n:n:Close').length).toBeGreaterThan(1);
        // a copy: its own lines, not its other copies'
        expect(joined('n:n:Clerk@Open')).toEqual(edgesAt('n:n:Clerk@Open'));
        expect(joined()).toEqual([]);
        expect(joined(joined('n:n:Close')[0]!)).toEqual([]);
    });
});

describe('a resolved hotspot in a storming’s scene', () => {
    test('carries its resolution on its note and quiets its `on`; an open hotspot and its `on` stay as they are', async () => {
        const [payload] = await viewPayloads([
            {
                path: 'es.dtes',
                text: `storming S {
  event Placed
  hotspot Open { on Placed }
  hotspot Settled {
    on Placed
    status resolved
    resolution "決めた"
  }
}
`,
            },
        ]);
        for (const view of ['design-level|', 'big-picture|']) {
            const scene = buildScene(payload!.stormings[0]!.views[view]!.graph, optionsOf(payload!));
            const note = (id: string) => scene.nodes.find((n) => n.elementId === `es/S/${id}`)!.props;
            expect(note('Settled').resolution).toBe('決めた');
            expect(note('Open').resolution).toBeUndefined();
            const on = (id: string) => scene.edges.find((e) => e.elementId === `es/S/${id}`)!.props;
            expect(on('Settled')).toMatchObject({ kind: 'esHotspot', resolved: true });
            expect(on('Open').resolved).toBeUndefined();
        }
    });
});

describe('a handler shared by the commands converging on one event (ADR 0032)', () => {
    test('its emits names the commands it stands for', async () => {
        const [payload] = await viewPayloads([
            {
                path: 'es.dtes',
                text: `storming S {
  event Requested
  actor Clerk
  actor Shop
  aggregate Request
  command Receive { by Shop handledBy Request emits Requested }
  command Create { by Clerk handledBy Request emits Requested }
  timeline T { Requested }
}
`,
            },
        ]);
        const scene = buildScene(payload!.stormings[0]!.views['design-level|']!.graph, optionsOf(payload!));
        const handler = scene.nodes.find((i) => i.elementId === 'es/S/Request')!;
        const emits = scene.edges.find((e) => e.source === handler.id)!;
        expect(emits.props.relation).toEqual({ kind: 'decides', names: ['Create', 'Receive'] });
    });
});
