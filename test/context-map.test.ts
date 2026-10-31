import { describe, expect, test } from 'bun:test';
import { buildStructureGraph, focusGraphId } from '../src/visualization/domain/graph/build.js';
import { CONTEXT_MAP_ALL_GRAPH_ID, buildContextMapGraph, contextNodeId } from '../src/visualization/domain/graph/context-map.js';
import { contextDependencies, groupByContext, supportingContexts } from '../src/modeling/model/dependencies.js';
import { perLang } from '../src/visualization/domain/graph/ir.js';
import type { DomainModel } from '../src/modeling/model/model.js';
import { check } from './helpers.js';

const FILES = {
    'common.dt': 'shared context Common { primitive Quantity: Int { value >= 0 } }',
    'identity.dt': 'context Identity { id UserId: UUID }',
    'sales.dt': `context Sales {
  id OrderId: UUID
  enum Channel { WEB SHOP }
  value Address { city: String }
  aggregate Order {
    id: OrderId
    quantity: Quantity
    createdBy: Identity.UserId
    channel: Channel
    command place(by: Identity.UserId) emits OrderPlaced
  }
  event OrderPlaced { orderId: OrderId }
}`,
    'billing.dt': `context Billing {
  id InvoiceId: UUID
  union Origin { ORDER { orderId: Sales.OrderId } MANUAL { channel: Sales.Channel } }
  aggregate Invoice {
    id: InvoiceId
    references orderId: Sales.OrderId -> Sales.Order
    origin: Origin
    shipTo: Sales.Address?
  }
}`,
};

async function model(): Promise<DomainModel> {
    const a = await check(FILES);
    expect(a.diagnostics).toEqual([]);
    return a.model!;
}

describe('context dependencies', () => {
    test('every use of another context, with its kind and where it is', async () => {
        const deps = contextDependencies(await model()).map((d) => `${d.source} ${d.path} -> ${d.target} (${d.kind})`);
        expect(deps).toEqual([
            'Sales.Order quantity -> Common.Quantity (type)',
            'Sales.Order createdBy -> Identity.UserId (id)',
            'Sales.Order place(by) -> Identity.UserId (id)',
            'Billing.Origin ORDER.orderId -> Sales.OrderId (id)',
            'Billing.Origin MANUAL.channel -> Sales.Channel (type)',
            'Billing.Invoice orderId -> Sales.Order (id)',
            'Billing.Invoice shipTo -> Sales.Address (type)',
        ]);
    });

    test('grouped by pair of contexts, with counts', async () => {
        const groups = groupByContext(contextDependencies(await model())).map((g) => [g.from, g.to, g.ids, g.types]);
        expect(groups).toEqual([
            ['Sales', 'Common', 0, 1],
            ['Sales', 'Identity', 2, 0],
            ['Billing', 'Sales', 2, 2],
        ]);
    });

    test('shared contexts and contexts with only IDs are supporting contexts', async () => {
        expect([...supportingContexts(await model())].sort()).toEqual(['Common', 'Identity']);
    });
});

describe('Context Map', () => {
    test('one node per domain context and one edge per dependency, supporting contexts left out', async () => {
        const g = buildContextMapGraph(await model());
        expect(g.nodes.map((n) => [n.id, n.kind, n.elementId, n.stereotype?.en.name])).toEqual([
            ['map:Billing', 'boundedContext', 'Billing', '«bounded context»'],
            ['map:Sales', 'boundedContext', 'Sales', '«bounded context»'],
        ]);
        expect(g.nodes[1].lines.map((l) => `${l.key.en.name} ${l.value?.en.name}`)).toEqual([
            'aggregates 1',
            'value objects 1',
            'enums 1',
            'IDs 1',
            'events 1',
        ]);
        expect(g.edges).toEqual([
            {
                id: 'Billing|Sales',
                kind: 'dependsOn',
                source: contextNodeId('Billing'),
                target: contextNodeId('Sales'),
                label: perLang({ ja: 'ID 2 · 型 2', en: 'ID 2 · type 2' }),
            },
        ]);
    });

    test('with all, supporting contexts are shown and edges that only use IDs are references', async () => {
        const g = buildContextMapGraph(await model(), { all: true });
        expect(g.id).toBe(CONTEXT_MAP_ALL_GRAPH_ID);
        expect(g.nodes.map((n) => n.stereotype?.en.name)).toEqual(['«bounded context»', '«shared kernel»', '«external»', '«bounded context»']);
        expect(g.edges.map((e) => [e.id, e.kind])).toEqual([
            ['Sales|Common', 'dependsOn'],
            ['Sales|Identity', 'references'],
            ['Billing|Sales', 'dependsOn'],
        ]);
    });
});

describe('focused Structure View', () => {
    test('draws one context in detail and its dependencies both ways as stubs', async () => {
        const g = buildStructureGraph(await model(), { focus: ['Billing'] });
        expect(g.id).toBe(focusGraphId(['Billing']));
        const nodes = g.nodes.map((n) => `${n.id} ${n.kind}${n.parent ? ` in ${n.parent}` : ''}`);
        expect(nodes).toEqual([
            'Billing context',
            'Sales context',
            'Billing.Origin union in Billing.Invoice@boundary',
            'Billing.Invoice@boundary aggregateBoundary in Billing',
            'Billing.Invoice aggregate in Billing.Invoice@boundary',
            // an ID stands for the aggregate it identifies
            'Sales.Order stub in Sales',
            'Sales.Channel stub in Sales',
            'Sales.Address stub in Sales',
        ]);
        expect(g.edges.map((e) => [e.id, e.kind, e.label?.en.name])).toEqual([
            ['Billing.Invoice.origin', 'value', 'origin'],
            ['Billing.Origin=>Sales.Order', 'references', 'ORDER.orderId'],
            ['Billing.Origin=>Sales.Channel', 'value', 'MANUAL.channel'],
            ['Billing.Invoice=>Sales.Order', 'references', 'orderId'],
            ['Billing.Invoice=>Sales.Address', 'value', 'shipTo'],
        ]);
    });

    test('elements of other contexts that use the focused one appear as stubs pointing at it', async () => {
        const g = buildStructureGraph(await model(), { focus: ['Sales'] });
        // an enum of the focused context is not drawn in the Structure View, so the one in use appears as a stub in it
        expect(g.nodes.filter((n) => n.kind === 'stub').map((n) => `${n.id} in ${n.parent}`)).toEqual([
            'Billing.Origin in Billing',
            'Sales.Channel in Sales',
            'Billing.Invoice in Billing',
        ]);
        // supporting contexts (Common, Identity) are not drawn
        expect(g.nodes.some((n) => n.id === 'Identity' || n.id === 'Common')).toBe(false);
        expect(g.edges.filter((e) => e.target.startsWith('Sales.')).map((e) => e.id)).toEqual([
            'Billing.Origin=>Sales.Order',
            'Billing.Origin=>Sales.Channel',
            'Billing.Invoice=>Sales.Order',
            'Billing.Invoice=>Sales.Address',
        ]);
    });

    test('several focused contexts: dependencies between them join their elements, without stubs', async () => {
        const g = buildStructureGraph(await model(), { focus: ['Sales', 'Billing'] });
        expect(g.id).toBe(focusGraphId(['Billing', 'Sales']));
        expect(g.nodes.filter((n) => n.kind === 'stub').map((n) => n.id)).toEqual(['Sales.Channel']);
        expect(g.edges.map((e) => e.id)).toEqual([
            'Billing.Invoice.origin',
            'Billing.Origin=>Sales.Order',
            'Billing.Origin=>Sales.Channel',
            'Billing.Invoice=>Sales.Order',
            'Billing.Invoice=>Sales.Address',
        ]);
        const ids = new Set(g.nodes.map((n) => n.id));
        expect(g.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
    });

    test('hidden contexts: their stubs and the dependencies on and from them are left out', async () => {
        const g = buildStructureGraph(await model(), { focus: ['Billing'], hidden: ['Sales'] });
        expect(g.id).toBe('structure-focus:Billing:hide=Sales');
        expect(g.nodes.some((n) => n.kind === 'stub' || n.id === 'Sales')).toBe(false);
        expect(g.edges.map((e) => e.id)).toEqual(['Billing.Invoice.origin']);
        // a focused context is never hidden
        const focused = buildStructureGraph(await model(), { focus: ['Sales'], hidden: ['Sales', 'Billing'] });
        expect(focused.id).toBe('structure-focus:Sales:hide=Billing');
        // Sales.Channel is drawn only because Billing uses it
        expect(focused.nodes.filter((n) => n.kind === 'stub')).toEqual([]);
    });

    test('the overview of focused contexts has names only, in larger text', async () => {
        const g = buildStructureGraph(await model(), { focus: ['Billing'], level: 'overview' });
        expect(g.id).toBe('structure-focus:Billing:overview');
        expect(g.textScale).toBeGreaterThan(1);
        expect(g.nodes.every((n) => n.lines.length === 0)).toBe(true);
        expect(g.nodes.filter((n) => n.kind === 'stub').length).toBe(3);
    });
});
