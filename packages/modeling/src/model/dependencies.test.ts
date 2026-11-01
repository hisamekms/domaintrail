import { describe, expect, test } from 'bun:test';
import { contextDependencies, groupByContext, supportingContexts } from './dependencies.js';
import type { DomainModel } from './model.js';
import { check } from '../test-helpers.js';

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
