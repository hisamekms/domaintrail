import { describe, expect, test } from 'bun:test';
import { buildStructureGraph } from './build.js';
import { check } from '../../test-helpers.js';

const FILES = {
    'common.dt': `shared context Common {
  primitive TenantId "テナントID": UUID
  /// 契約者ごとにデータを分ける。
  fields Tenanted "テナント所属" {
    tenant: TenantId "テナント"
  }
}`,
    'sales.dt': `context Sales {
  id OrderId: UUID
  id OrderItemId: UUID
  id StaffId: UUID

  fields Performed "実施記録" { performedBy: StaffId "実施者" }

  aggregate Order "注文" with Common.Tenanted {
    id: OrderId
    owns items: OrderItem[0..*]
    invariant sameTenant { all(items, i => i.tenant == tenant) }
    create command place(id: OrderId) -> Draft emits OrderPlaced
    command confirm() Draft -> Confirmed emits OrderConfirmed, Billing.Billed
    state Draft
    state Confirmed { confirmedAt: Timestamp }
  }

  entity OrderItem with Tenanted {
    id: OrderItemId
  }

  event OrderPlaced with Tenanted, Performed { orderId: OrderId }
  event OrderConfirmed { orderId: OrderId }
}`,
    'billing.dt': `context Billing {
  id InvoiceId: UUID
  aggregate Invoice with Sales.Performed {
    id: InvoiceId
    command bill() emits Billed
  }
  event Billed { invoiceId: InvoiceId orderId: Sales.OrderId }
}`,
};

describe('field sets: Live View', () => {
    test('the structure diagram lists the fields of field sets first, with the field set faded after them', async () => {
        const a = await check(FILES);
        const node = buildStructureGraph(a.model!).nodes.find((n) => n.id === 'Sales.Order')!;
        expect(node.lines.map((l) => l.key.ja.name)).toEqual(['tenant', 'id', '◆ items', '状態']);
        expect(node.lines[0].origin?.ja).toEqual({ name: 'Tenanted', label: 'テナント所属', both: 'テナント所属' });
        expect(node.lines.slice(1).every((l) => !l.origin)).toBe(true);
    });
});
