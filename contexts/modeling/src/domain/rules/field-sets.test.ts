import { describe, expect, test } from 'bun:test';
import { check, checkSales, codes, only } from '../../test-helpers.js';

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

describe('field sets', () => {
    test('a valid model checks clean; elements get the fields of their field sets first', async () => {
        const a = await check(FILES);
        expect(a.diagnostics).toEqual([]);
        const els = a.model!.elements;
        expect(els['Common.Tenanted'].kind).toBe('fieldSet');
        expect(els['Common.Tenanted'].fields.map((f) => [f.name, f.label])).toEqual([['tenant', 'テナント']]);
        expect(els['Sales.Order'].fieldSets).toEqual(['Common.Tenanted']);
        expect(els['Sales.Order'].fields.map((f) => [f.name, f.fieldSet])).toEqual([
            ['tenant', 'Common.Tenanted'],
            ['id', undefined],
            ['items', undefined],
        ]);
        expect(els['Sales.OrderPlaced'].fields.map((f) => f.name)).toEqual(['tenant', 'performedBy', 'orderId']);
        expect(els['Sales.OrderConfirmed'].fieldSets).toBeUndefined();
    });

    test('`fields` and `with` stay usable as field names', async () => {
        const a = await checkSales('value V { fields: String with: Int }');
        expect(a.diagnostics).toEqual([]);
        expect(a.model!.elements['Sales.V'].fields.map((f) => f.name)).toEqual(['fields', 'with']);
    });

    test('M016: with only on aggregates, entities and events', async () => {
        const a = await checkSales(`
  fields F { x: Int }
  fields G with F { y: Int }
  value V with F { v: Int }
  error E with F`);
        expect(only(a, 'M016').map((d) => d.message)).toEqual([
            "'with' is only for aggregates, entities and events; field set 'G' cannot include other field sets.",
            "'with' is only for aggregates, entities and events; value object 'V' cannot take field sets.",
            "'with' is only for aggregates, entities and events; error 'E' cannot take field sets.",
        ]);
    });

    test('M016: a field set holds plain fields only, and no id', async () => {
        const a = await checkSales(`
  id AId: UUID
  aggregate A { id: AId }
  value Money { amount: Decimal }
  fields F {
    id: AId
    owns money: Money
    references a: AId -> A
    invariant positive { true }
  }`);
        expect(only(a, 'M016').map((d) => d.message)).toEqual([
            "Field set 'F' cannot declare 'id'; the identity is declared by each aggregate and entity itself.",
            "A field set holds plain fields only; 'money' is declared with 'owns'.",
            "A field set holds plain fields only; 'a' is declared with 'references'.",
            "Field set 'F' cannot hold invariants; write invariant 'positive' in the elements that use it.",
        ]);
    });

    test('M016: each field name comes from one place', async () => {
        const a = await checkSales(`
  id AId: UUID
  fields F { x: Int y: Int }
  fields G { y: Int }
  aggregate A with F, G {
    id: AId
    x: String
    state S { y: Bool }
  }
  event Ev with F, F { aId: AId }`);
        expect(only(a, 'M016').map((d) => `${d.severity} ${d.message}`)).toEqual([
            "error Field 'y' of field set 'G' is also declared in field set 'F', both used by 'A'.",
            "error Field 'x' of 'A' is already taken from field set 'F'.",
            "error Field 'y' of state 'S' shadows the field of field set 'F' in 'A'.",
            "warning Field set 'F' is listed more than once.",
        ]);
    });

    test('M016: an unknown field set; a type is not a field set', async () => {
        const a = await checkSales(`
  id AId: UUID
  value V { x: Int }
  aggregate A with Missing, V { id: AId }`);
        expect(only(a, 'M016').map((d) => d.message)).toEqual([
            "Cannot resolve field set 'Missing' in this context (use Context.Name for other contexts).",
            "Cannot resolve field set 'V' in this context (use Context.Name for other contexts).",
        ]);
    });

    test('the fields of field sets are plain fields: no entities or aggregates as values (M004)', async () => {
        const a = await checkSales(`
  id AId: UUID
  id EId: UUID
  aggregate A { id: AId owns e: E }
  entity E { id: EId }
  fields F { e: E }`);
        expect(only(a, 'M004').map((d) => d.message)).toEqual(["Entity 'E' cannot be embedded as a plain field; declare it with 'owns' inside its aggregate."]);
    });

    test('invariants see the fields of field sets; state-specific fields stay in their states', async () => {
        const a = await checkSales(`
  id AId: UUID
  fields Limited { limit: Int }
  aggregate A with Limited {
    id: AId
    owns b: B
    used: Int
    invariant withinLimit { used <= limit }
    state S
  }
  entity B with Limited { id: AId2 invariant positive { limit > 0 } }
  id AId2: UUID`);
        expect(a.diagnostics).toEqual([]);
        const bad = await checkSales(`
  id AId: UUID
  fields Limited { limit: Int }
  aggregate A with Limited { id: AId invariant x { limit == "a" } }`);
        expect(codes(bad)).toEqual(['M009']);
    });

    test('shared contexts may hold field sets, which depend only on shared contexts (M014)', async () => {
        const a = await check({
            'common.dt': 'shared context Common { fields F { order: Sales.OrderId } }',
            'sales.dt': 'context Sales { id OrderId: UUID }',
        });
        expect(only(a, 'M014').map((d) => d.message)).toEqual(["Shared context 'Common' cannot depend on 'Sales.OrderId' of a non-shared context."]);
    });

    test('labels: fields of field sets are named in their own context, and share the namespace of the element (L003)', async () => {
        const a = await checkSales(`
  id AId: UUID
  fields F { tenant: String "所属" }
  aggregate A with F { id: AId org: String "所属" }`);
        expect(only(a, 'L003').map((d) => d.message)).toEqual(["'org' and 'tenant' are both named '所属' in 'A'."]);
    });
});

describe('M017: events carry the ID of their aggregate', () => {
    test('warns when an emitted event has no field of the aggregate ID type', async () => {
        const a = await checkSales(`
  id AId: UUID
  aggregate A { id: AId command c() emits Ev, Ok  command d() emits Ev }
  event Ev { note: String }
  event Ok { a: AId? }`);
        expect(only(a, 'M017').map((d) => `${d.severity} ${d.elementId} ${d.message}`)).toEqual([
            "warning Sales.A:c Event 'Ev' emitted by 'A.c' has no field of type 'AId' to tell which 'A' it is about.",
        ]);
        expect(only(a, 'M017')[0].hint).toBe("add a field such as 'aId: AId' to event 'Ev'");
    });

    test('a field from a field set counts; an event of several aggregates needs the ID of each', async () => {
        const a = await check({
            'sales.dt': `context Sales {
  id AId: UUID
  id BId: UUID
  fields OfA { a: AId }
  aggregate A { id: AId command c() emits Ev, Billing.Shared }
  aggregate B { id: BId command c() emits Ev }
  event Ev with OfA { }
}`,
            'billing.dt': 'context Billing { event Shared { a: Sales.AId } }',
        });
        expect(only(a, 'M017').map((d) => d.message)).toEqual(["Event 'Ev' emitted by 'B.c' has no field of type 'BId' to tell which 'B' it is about."]);
        const b = await check({
            'billing.dt': 'context Billing { id IId: UUID aggregate I { id: IId command c() emits Sales.Ev } }',
            'sales.dt': 'context Sales { event Ev }',
        });
        expect(only(b, 'M017').map((d) => [d.message, d.hint])).toEqual([
            ["Event 'Ev' emitted by 'I.c' has no field of type 'IId' to tell which 'I' it is about.", "add a field such as 'iId: Billing.IId' to event 'Ev'"],
        ]);
    });
});
