// Dependencies between aggregates, through what an aggregate holds (the aggregates level of the Structure View draws them).
import { describe, expect, test } from 'bun:test';
import { aggregateDependencies } from './aggregates.js';
import type { DomainModel } from './model.js';
import { check } from '../test-helpers.js';

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
