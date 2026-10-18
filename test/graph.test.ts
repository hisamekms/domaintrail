import { afterAll, describe, expect, test } from 'bun:test';
import { analyze } from '../src/core/analyze.js';
import { loadWorkspace } from '../src/core/files.js';
import { boundaryId, buildStateGraph, buildStructureGraph, initialNodeId } from '../src/graph/build.js';
import { diffModels } from '../src/graph/diff.js';
import { ElkLayoutEngine } from '../src/layout/elk.js';
import { EXAMPLES, check } from './helpers.js';

const engine = new ElkLayoutEngine();
afterAll(() => engine.dispose());

const exampleModel = async () => (await analyze(await loadWorkspace(EXAMPLES))).model!;

describe('Structure View graph', () => {
    test('contexts contain aggregate boundaries which contain exclusively owned elements', async () => {
        const g = buildStructureGraph(await exampleModel());
        const parent = Object.fromEntries(g.nodes.map((n) => [n.id, n.parent]));
        expect(parent['Sales.Order@boundary']).toBe('Sales');
        expect(parent['Sales.Order']).toBe(boundaryId('Sales.Order'));
        expect(parent['Sales.OrderItem']).toBe(boundaryId('Sales.Order'));
        // Money (shared context) is used by Sales.Order (via OrderItem) and by Billing.Invoice -> stays in its context
        expect(parent['Common.Money']).toBe('Common');
    });

    test('owns, value and references edges', async () => {
        const g = buildStructureGraph(await exampleModel());
        const edges = Object.fromEntries(g.edges.map((e) => [e.id, `${e.kind}:${e.source}->${e.target}`]));
        expect(edges).toEqual({
            'Billing.Invoice.order': 'references:Billing.Invoice->Sales.Order',
            'Billing.Invoice.billedAmount': 'value:Billing.Invoice->Common.Money',
            'Sales.Order.items': 'owns:Sales.Order->Sales.OrderItem',
            'Sales.Order.customer': 'references:Sales.Order->Sales.Customer',
            'Sales.OrderItem.unitPrice': 'owns:Sales.OrderItem->Common.Money',
        });
    });
});

describe('Structure overview graph', () => {
    test('same nodes and edges, names only, larger text', async () => {
        const model = await exampleModel();
        const detail = buildStructureGraph(model);
        const overview = buildStructureGraph(model, { overview: true });
        expect(overview.id).toBe('structure-overview');
        expect(overview.textScale).toBe(1.5);
        expect(overview.nodes.map((n) => n.id)).toEqual(detail.nodes.map((n) => n.id));
        expect(overview.edges.map((e) => e.id)).toEqual(detail.edges.map((e) => e.id));
        const order = overview.nodes.find((n) => n.id === 'Sales.Order')!;
        expect(order.lines).toEqual([]);
        expect(order.height).toBeLessThan(detail.nodes.find((n) => n.id === 'Sales.Order')!.height);
        const layout = await engine.layout(overview);
        expect(Object.keys(layout.nodeLayout).sort()).toEqual(overview.nodes.map((n) => n.id).sort());
    });
});

describe('State View graph', () => {
    test('states, factory start node and one edge per (from, to) pair', async () => {
        const model = await exampleModel();
        const g = buildStateGraph(model.elements['Sales.Order'], model);
        expect(g.nodes.map((n) => n.id)).toEqual([initialNodeId('Sales.Order'), 'Sales.Order#Draft', 'Sales.Order#Confirmed', 'Sales.Order#Cancelled']);
        expect(g.edges.map((e) => `${e.source.split(/[#@]/)[1]}->${e.target.split(/[#@]/)[1]}:${e.label?.en.name}`)).toEqual([
            'new->Draft:place(customer) ⇒ OrderPlaced',
            'Draft->Draft:addItem(item)',
            'Draft->Confirmed:confirm(at) ⇒ OrderConfirmed',
            'Draft->Cancelled:cancel(reason) ⇒ OrderCancelled',
            'Confirmed->Cancelled:cancel(reason) ⇒ OrderCancelled',
        ]);
    });

    test('aggregates without states show commands as self transitions', async () => {
        const model = await exampleModel();
        const g = buildStateGraph(model.elements['Sales.Customer'], model);
        expect(g.edges.map((e) => `${e.source}->${e.target}`)).toEqual(['Sales.Customer@new->Sales.Customer', 'Sales.Customer->Sales.Customer']);
    });
});

describe('layout', () => {
    test('every node and edge gets coordinates; children lie inside their containers', async () => {
        const g = buildStructureGraph(await exampleModel());
        const l = await engine.layout(g);
        for (const n of g.nodes) expect(l.nodeLayout[n.id]).toBeDefined();
        for (const e of g.edges) expect(l.edgeLayout[e.id]?.points.length).toBeGreaterThanOrEqual(2);
        for (const n of g.nodes.filter((x) => x.parent)) {
            const c = l.nodeLayout[n.id];
            const p = l.nodeLayout[n.parent!];
            expect(c.x).toBeGreaterThanOrEqual(p.x);
            expect(c.y).toBeGreaterThanOrEqual(p.y);
            expect(c.x + c.width).toBeLessThanOrEqual(p.x + p.width + 0.01);
            expect(c.y + c.height).toBeLessThanOrEqual(p.y + p.height + 0.01);
        }
    });

    test('layout is deterministic for the same graph', async () => {
        const g = buildStructureGraph(await exampleModel());
        const [a, b] = [await engine.layout(g), await engine.layout(g)];
        expect(a.nodeLayout).toEqual(b.nodeLayout);
        expect(a.signature).toBe(b.signature);
    });
});

describe('diff', () => {
    test('identifies added, changed and removed elements, states and commands', async () => {
        const before = (await check({ 'a.dt': 'context S { id AId: UUID aggregate A { id: AId state X state Y command go() from X to Y } value V }' })).model!;
        const after = (await check({ 'a.dt': 'context S { id AId: UUID aggregate A { id: AId note: String? state X state Z command go() from X to Z } value W }' })).model!;
        const d = diffModels(before, after);
        expect(d.added.sort()).toEqual(['S.A#Z', 'S.W']);
        expect(d.changed.sort()).toEqual(['S.A', 'S.A:go']);
        expect(d.removed.sort()).toEqual(['S.A#Y', 'S.V']);
    });

    test('moving declarations between lines or files is not a change', async () => {
        const before = (await check({ 'a.dt': 'context S { id AId: UUID\n value V }' })).model!;
        const after = (await check({ 'b.dt': 'context S { value V }', 'c.dt': '\n\ncontext S { id AId: UUID }' })).model!;
        expect(diffModels(before, after)).toEqual({ added: [], changed: [], removed: [] });
    });
});
