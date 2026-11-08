import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { commandsOf, contextDependencies, elementOf } from '@domaintrail/modeling';
import { OutcomeCard } from './behavior';
import { MESSAGES } from './i18n';
import { catalogSections, fieldSetUsers, namer } from './model-utils';
import { usagesOf } from './usages';
import { check } from './test-helpers';

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
    test("an event card's payload marks the fields of field sets", async () => {
        const model = (await check(FILES)).model!;
        const order = elementOf(model, 'Sales.Order')!;
        const html = renderToStaticMarkup(
            <OutcomeCard
                id="Sales.OrderPlaced"
                commands={commandsOf(order).slice(0, 1)}
                model={model}
                names={namer('label', model)}
                tx={MESSAGES.ja}
                onSelect={() => {}}
            />,
        );
        expect(html.match(/class="field-origin"[^>]*>[^<]*</g)?.map((m) => m.replace(/.*>/, '').replace('<', ''))).toEqual(['テナント所属', '実施記録']);
    });

    test('a field set is used by its elements and counts its field types once', async () => {
        const a = await check(FILES);
        const model = a.model!;
        expect(fieldSetUsers(model, 'Common.Tenanted').map((e): string => e.id)).toEqual(['Sales.Order', 'Sales.OrderItem', 'Sales.OrderPlaced']);
        expect(usagesOf(model, 'Common.TenantId').map((u) => u.key)).toEqual(['Common.Tenanted.tenant']);
        expect(usagesOf(model, 'Sales.StaffId').map((u) => u.key)).toEqual(['Sales.Performed.performedBy']);
        const deps = contextDependencies(model).filter((d) => d.path === 'with');
        expect(deps.map((d) => `${d.source} -> ${d.target}`)).toEqual([
            'Sales.Order -> Common.Tenanted',
            'Sales.OrderItem -> Common.Tenanted',
            'Sales.OrderPlaced -> Common.Tenanted',
            'Billing.Invoice -> Sales.Performed',
        ]);
        const sets = catalogSections(model).find((s) => s.key === 'fieldSets')!;
        expect(sets.groups.map((g) => [g.context, g.items.map((e) => e.name)])).toEqual([
            ['Common', ['Tenanted']],
            ['Sales', ['Performed']],
        ]);
    });
});
