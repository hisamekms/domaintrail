import { afterAll, describe, expect, test } from 'bun:test';
import { analyze } from '../src/core/analyze.js';
import { loadWorkspace } from '../src/core/files.js';
import { boundaryId, buildStateGraph, buildStructureGraph, initialNodeId } from '../src/graph/build.js';
import { diffModels } from '../src/graph/diff.js';
import { ElkLayoutEngine } from '../src/layout/elk.js';
import { INTERNAL_PADDING, LINE_HEIGHT, TRANSITION_SUB_LINE_HEIGHT, anyLang, sameText, transitionText, type TransitionLabels } from '../src/graph/ir.js';
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
        const overview = buildStructureGraph(model, { level: 'overview' });
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
    test('states, factory start node and one edge per (from, to) pair; self transitions are listed in the state', async () => {
        const model = await exampleModel();
        const g = buildStateGraph(model.elements['Sales.Order'], model);
        expect(g.nodes.map((n) => n.id)).toEqual([initialNodeId('Sales.Order'), 'Sales.Order#Draft', 'Sales.Order#Confirmed', 'Sales.Order#Cancelled']);
        const short = (id: string) => id.split(/[#@]/)[1];
        expect(g.edges.map((e) => `${short(e.source)}->${short(e.target)}:${e.label?.en.name}${e.events ? ` ⇒ ${e.events.en.name}` : ''}`)).toEqual([
            'new->Draft:place(customer) ⇒ OrderPlaced',
            'Draft->Confirmed:confirm(at) ⇒ OrderConfirmed',
            'Draft->Cancelled:cancel(reason) ⇒ OrderCancelled',
            'Confirmed->Cancelled:cancel(reason) ⇒ OrderCancelled',
        ]);
        const draft = g.nodes.find((n) => n.id === 'Sales.Order#Draft')!;
        expect(draft.internal).toEqual([
            {
                id: 'Sales.Order:addItem|Sales.Order#Draft->Sales.Order#Draft',
                elementId: 'Sales.Order:addItem',
                label: anyLang({ name: 'addItem(item)', label: '明細を追加する', both: '明細を追加する addItem(item)' }),
            },
            {
                id: 'Sales.Order:changeNote|Sales.Order#Draft->Sales.Order#Draft',
                elementId: 'Sales.Order:changeNote',
                label: anyLang({ name: 'changeNote(note)', label: '備考を変更する', both: '備考を変更する changeNote(note)' }),
            },
        ]);
        expect(g.nodes.find((n) => n.id === 'Sales.Order#Confirmed')!.internal).toEqual([
            {
                id: 'Sales.Order:changeNote|Sales.Order#Confirmed->Sales.Order#Confirmed',
                elementId: 'Sales.Order:changeNote',
                label: anyLang({ name: 'changeNote(note)', label: '備考を変更する', both: '備考を変更する changeNote(note)' }),
            },
        ]);
    });

    test('aggregates without states list their commands in their one box', async () => {
        const model = await exampleModel();
        const g = buildStateGraph(model.elements['Sales.Customer'], model);
        expect(g.edges.map((e) => `${e.source}->${e.target}`)).toEqual(['Sales.Customer@new->Sales.Customer']);
        expect(g.nodes.find((n) => n.id === 'Sales.Customer')!.internal?.map((t) => t.label.en.name)).toEqual(['rename(name)']);
    });

    test('a command from several states is listed in each state it keeps, and drawn for the others', async () => {
        const m = (await check({ 'a.dt': MULTI })).model!;
        const g = buildStateGraph(m.elements['S.A'], m);
        const internal = Object.fromEntries(g.nodes.filter((n) => n.internal).map((n) => [n.id, n.internal!.map((t) => t.elementId)]));
        expect(internal).toEqual({ 'S.A#Open': ['S.A:touch', 'S.A:hold'], 'S.A#Held': ['S.A:touch'] });
        expect(g.edges.map((e) => e.id).filter((id) => /:(touch|hold)\|/.test(id))).toEqual([
            'S.A:touch|S.A#Open->S.A#Held',
            'S.A:touch|S.A#Held->S.A#Open',
            'S.A:hold|S.A#Held->S.A#Open',
        ]);
        expect(g.edges.find((e) => e.id.startsWith('S.A:hold'))!.events).toEqual(anyLang({ name: 'Held', label: '保留', both: '保留 Held' }));
    });

    test('each transition joins only its own sources and targets: self transitions per state, fan-in, branches', async () => {
        const m = (
            await check({
                'a.dt': `context S {
  id AId: UUID
  aggregate A {
    id: AId
    state Open
    state Held
    state Closed
    create command open() -> Open | Held
    command keep() Open -> Open, Held -> Held
    command step()
      Open -> Held
      Held -> Closed
    command close() Open | Held -> Closed
    command review() Held -> Held | Closed
  }
}`,
            })
        ).model!;
        const g = buildStateGraph(m.elements['S.A'], m);
        const internal = Object.fromEntries(g.nodes.filter((n) => n.internal).map((n) => [n.id, n.internal!.map((t) => t.id)]));
        expect(internal).toEqual({
            'S.A#Open': ['S.A:keep|S.A#Open->S.A#Open'],
            'S.A#Held': ['S.A:keep|S.A#Held->S.A#Held', 'S.A:review|S.A#Held->S.A#Held'],
        });
        expect(g.edges.map((e) => e.id)).toEqual([
            'S.A:open|S.A@new->S.A#Open',
            'S.A:open|S.A@new->S.A#Held',
            'S.A:step|S.A#Open->S.A#Held',
            'S.A:step|S.A#Held->S.A#Closed',
            'S.A:close|S.A#Open->S.A#Closed',
            'S.A:close|S.A#Held->S.A#Closed',
            'S.A:review|S.A#Held->S.A#Closed',
        ]);
    });

    test('state boxes grow by the rows of their internal transitions, as the labels show them', async () => {
        const m = (await check({ 'a.dt': MULTI })).model!;
        const height = (labels: TransitionLabels) => buildStateGraph(m.elements['S.A'], m, labels).nodes.find((n) => n.id === 'S.A#Open')!.height;
        const plain = buildStateGraph(m.elements['S.A'], m).nodes.find((n) => n.id === 'S.A#Closed')!.height;
        // touch (no events) and hold (raises Held): one line each, plus the events line of hold in both
        expect(height('command')).toBe(plain + 2 * INTERNAL_PADDING + 2 * LINE_HEIGHT);
        expect(height('event')).toBe(height('command'));
        expect(height('both')).toBe(height('command') + TRANSITION_SUB_LINE_HEIGHT);
    });

    test('labels show the command, the events (or the command, faded), or both', () => {
        const command = sameText('hold()');
        const events = sameText('Held');
        expect(transitionText(command, events, 'command')).toEqual({ main: command, faded: false });
        expect(transitionText(command, events, 'event')).toEqual({ main: events, faded: false });
        expect(transitionText(command, undefined, 'event')).toEqual({ main: command, faded: true });
        expect(transitionText(command, events, 'both')).toEqual({ main: command, sub: sameText('⇒ Held'), faded: false });
        expect(transitionText(command, undefined, 'both')).toEqual({ main: command, sub: undefined, faded: false });
    });

    test('self transitions are not laid out as edges; two-line labels get room for both lines', async () => {
        const m = (await check({ 'a.dt': MULTI })).model!;
        const both = await engine.layout(buildStateGraph(m.elements['S.A'], m, 'both'));
        const command = await engine.layout(buildStateGraph(m.elements['S.A'], m, 'command'));
        expect(Object.keys(both.edgeLayout).sort()).toEqual(both.edges.map((e) => e.id).sort());
        expect(Object.keys(both.edgeLayout).filter((id) => id.endsWith('Open->S.A#Open'))).toEqual([]);
        const id = 'S.A:hold|S.A#Held->S.A#Open';
        expect(both.edgeLayout[id].label!.height).toBeGreaterThan(command.edgeLayout[id].label!.height);
        expect(both.nodeLayout['S.A#Open'].height).toBe(both.nodes.find((n) => n.id === 'S.A#Open')!.height);
    });
});

const MULTI = `context S {
  id AId: UUID
  event Held "保留" { id: AId }
  aggregate A {
    id: AId
    create command open() -> Open
    state Open
    state Held
    state Closed
    command touch() Open | Held -> Open | Held
    command hold() Open | Held -> Open emits Held
    command close() Open -> Closed
  }
}`;

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
        const before = (await check({ 'a.dt': 'context S { id AId: UUID aggregate A { id: AId state X state Y command go() X -> Y } value V }' })).model!;
        const after = (await check({ 'a.dt': 'context S { id AId: UUID aggregate A { id: AId note: String? state X state Z command go() X -> Z } value W }' })).model!;
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
