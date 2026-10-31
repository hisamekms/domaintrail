import { afterAll, describe, expect, test } from 'bun:test';
import { aggregateDependencies, buildStructureGraph, wrapText } from '@domaintrail/visualization/domain/graph/build';
import { ElkLayoutEngine } from '@domaintrail/visualization/infrastructure/elk';
import type { DomainModel } from '@domaintrail/modeling/model/model';
import { check } from './helpers.js';

const engine = new ElkLayoutEngine();
afterAll(() => engine.dispose());

const FILES = {
    'common.dt': 'shared context Common { value Money { amount: Decimal } }',
    'identity.dt': 'context Identity { id UserId: UUID }',
    'sales.dt': `/// 受注から出荷まで、顧客とのやり取りをすべて扱う。
context Sales "販売" {
  id OrderId: UUID
  id OrderItemId: UUID
  id CustomerId: UUID
  id ProductId: UUID

  /// 注文する人。
  aggregate Customer "顧客" {
    id: CustomerId
  }

  aggregate Product {
    id: ProductId
  }

  /// 顧客からの購入依頼。
  aggregate Order "注文" {
    id: OrderId
    owns items: OrderItem[0..*]
    references customer: CustomerId -> Customer
    createdBy: Identity.UserId
  }

  entity OrderItem {
    id: OrderItemId
    detail: ItemDetail
    owns price: Money
  }

  value ItemDetail {
    product: ProductId
  }
}`,
    'billing.dt': `context Billing {
  id InvoiceId: UUID
  union Origin { ORDER { item: Sales.OrderItemId } MANUAL { note: String } }
  aggregate Invoice {
    id: InvoiceId
    references order: Sales.OrderId -> Sales.Order
    origin: Origin
  }
}`,
    'catalog.dt': `/// まだ集約のない BC。
context Catalog { value Tag { name: String } }`,
};

async function model(): Promise<DomainModel> {
    const a = await check(FILES);
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    return a.model!;
}

describe('dependencies between aggregates', () => {
    test('through references, IDs, and the entities, value objects and unions an aggregate holds', async () => {
        const deps = aggregateDependencies(await model()).map((d) => `${d.source} -> ${d.target} (${d.type ? 'type' : 'id'}): ${d.paths.join(', ')}`);
        expect(deps).toEqual([
            'Sales.Order -> Sales.Customer (id): customer',
            'Sales.Order -> Sales.Product (id): items.detail.product',
            // an ID of an entity stands for the aggregate that owns it
            'Billing.Invoice -> Sales.Order (id): order, origin.item',
        ]);
    });
});

describe('Structure View levels', () => {
    test('the aggregates level draws the aggregates with their descriptions, in their contexts', async () => {
        const g = buildStructureGraph(await model(), { level: 'aggregates' });
        expect(g.id).toBe('structure-aggregates');
        expect(g.textScale).toBe(1.5);
        expect(g.nodes.map((n) => `${n.kind} ${n.id} < ${n.parent ?? ''}`)).toEqual([
            // the shared context is left out; contexts without aggregates stay as empty frames
            'context Billing < ',
            'context Catalog < ',
            'context Identity < ',
            'context Sales < ',
            'aggregate Sales.Customer < Sales',
            'aggregate Sales.Product < Sales',
            'aggregate Sales.Order < Sales',
            'aggregate Billing.Invoice < Billing',
        ]);
        const node = (id: string) => g.nodes.find((n) => n.id === id)!;
        expect(node('Sales.Order').label.ja.label).toBe('注文');
        expect(node('Sales.Order').stereotype?.ja.name).toBe('«集約»');
        expect(node('Sales.Order').lines.map((l) => l.key.ja.label)).toEqual(['顧客からの購入依頼。']);
        expect(node('Sales.Product').lines).toEqual([]);
        expect(node('Sales').lines.map((l) => l.key.en.name)).toEqual(['受注から出荷まで、顧客とのやり取りをすべて扱う。']);
        expect(node('Catalog').lines.map((l) => l.key.en.name)).toEqual(['まだ集約のない BC。']);
        expect(node('Catalog').height).toBeGreaterThan(0);
    });

    test('one edge per pair of aggregates, also through the hidden elements', async () => {
        const g = buildStructureGraph(await model(), { level: 'aggregates' });
        expect(g.edges.map((e) => `${e.kind}:${e.source}->${e.target}`)).toEqual([
            'references:Sales.Order->Sales.Customer',
            'references:Sales.Order->Sales.Product',
            'references:Billing.Invoice->Sales.Order',
        ]);
    });

    test('a focused aggregates level draws the aggregates of other contexts as stubs', async () => {
        const g = buildStructureGraph(await model(), { level: 'aggregates', focus: ['Billing'] });
        expect(g.id).toBe('structure-focus:Billing:aggregates');
        expect(g.nodes.map((n) => `${n.kind} ${n.id}`)).toEqual(['context Billing', 'context Sales', 'aggregate Billing.Invoice', 'stub Sales.Order']);
        expect(g.edges.map((e) => e.id)).toEqual(['Billing.Invoice=>Sales.Order']);
        const hidden = buildStructureGraph(await model(), { level: 'aggregates', focus: ['Billing'], hidden: ['Sales'] });
        expect(hidden.id).toBe('structure-focus:Billing:hide=Sales:aggregates');
        expect(hidden.nodes.map((n) => n.id)).toEqual(['Billing', 'Billing.Invoice']);
        expect(hidden.edges).toEqual([]);
    });

    test('the aggregates level can be laid out, with room for the descriptions of contexts', async () => {
        const g = buildStructureGraph(await model(), { level: 'aggregates' });
        const layout = await engine.layout(g);
        expect(Object.keys(layout.nodeLayout).sort()).toEqual(g.nodes.map((n) => n.id).sort());
        // the description is drawn between the label and the aggregates
        expect(layout.nodeLayout['Sales.Order'].y - layout.nodeLayout['Sales'].y).toBeGreaterThanOrEqual(46 * 1.5 + 21);
        expect(layout.nodeLayout['Catalog'].height).toBeGreaterThanOrEqual(46 * 1.5 + 21);
        // a context is at least as wide as its description, even when its aggregates are narrower
        const focused = buildStructureGraph(await model(), { level: 'aggregates', focus: ['Billing'] });
        const sales = focused.nodes.find((n) => n.id === 'Sales')!;
        expect(sales.width).toBeGreaterThan(focused.nodes.find((n) => n.id === 'Sales.Order')!.width + 40);
        expect((await engine.layout(focused)).nodeLayout['Sales'].width).toBeGreaterThanOrEqual(sales.width);
    });
});

describe('wrapText', () => {
    test('breaks after a space where there is one, and anywhere in text without spaces', () => {
        expect(wrapText('one two three four', 9)).toEqual(['one two', 'three', 'four']);
        expect(wrapText('あいうえおかきくけこ', 6)).toEqual(['あいう', 'えおか', 'きくけ', 'こ']);
        expect(wrapText('first\n\nsecond', 20)).toEqual(['first', 'second']);
        expect(wrapText('あいうえ。かき', 6)).toEqual(['あいう', 'え。か', 'き']);
        expect(wrapText('あいう。えお', 6)).toEqual(['あいう。', 'えお']);
    });
});
