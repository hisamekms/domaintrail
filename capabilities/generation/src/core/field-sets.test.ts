// What field sets make of the generated TypeScript, and the generator's check of their names (M011) (the DSL and its
// checks: contexts/modeling/src/domain/rules/field-sets.test.ts).
import { beforeAll, describe, expect, test } from 'bun:test';
import { generateTypeScript } from './typescript.js';
import { check, checkSales, only } from '../test-helpers.js';

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

const ts = (files: Awaited<ReturnType<typeof check>>, ctx: string): string => generateTypeScript(files.model!).find((f) => f.path === `${ctx}.ts`)!.content;

describe('field sets: the name check of the generator (M011)', () => {
    test('M011: an event field named type from a field set; the new unions collide like other names', async () => {
        const a = await checkSales(`
  id AId: UUID
  fields Typed { type: String }
  aggregate A { id: AId command c() emits Ev }
  event Ev with Typed { aId: AId }
  value AEvent
  value DomainEvent`);
        expect(only(a, 'M011').map((d) => d.message)).toEqual([
            "Generated TypeScript name 'DomainEvent' for the union of the events collides with value object 'DomainEvent'.",
            "Field 'type' of field set 'Typed' is reserved for the discriminant of generated event types.",
            "Generated TypeScript name 'AEvent' for value object 'AEvent' collides with the union of the events of 'A'.",
        ]);
    });
});

describe('field sets: generated TypeScript', () => {
    let a: Awaited<ReturnType<typeof check>>;
    beforeAll(async () => {
        a = await check(FILES);
    });

    test('a field set is an interface that the elements using it extend', () => {
        expect(ts(a, 'Common')).toContain(
            '/**\n * テナント所属\n * 契約者ごとにデータを分ける。\n * Fields taken on with `with Tenanted`.\n * @see common.dt:4\n */\nexport interface Tenanted {\n    /** テナント */\n    readonly tenant: TenantId;\n}',
        );
        const sales = ts(a, 'Sales');
        expect(sales).toContain("import type * as Common from './Common.js';");
        expect(sales).toMatch(
            /export interface OrderCommon extends Common\.Tenanted \{\n    readonly id: OrderId;\n    readonly items: readonly OrderItem\[\];\n\}/,
        );
        expect(sales).toContain('export interface ConfirmedOrder extends OrderCommon {');
        expect(sales).toMatch(/export interface OrderItem extends Common\.Tenanted \{\n    readonly id: OrderItemId;\n\}/);
        expect(sales).toMatch(
            /export interface OrderPlaced extends Common\.Tenanted, Performed \{\n    readonly type: 'Sales.OrderPlaced';\n    readonly orderId: OrderId;\n\}/,
        );
        expect(sales).toContain('export interface OrderConfirmed {');
        expect(ts(a, 'Billing')).toMatch(/export interface Invoice extends Sales\.Performed \{\n    readonly id: InvoiceId;\n\}/);
    });

    test('a value object takes field sets: it extends them, its equality and checks see their fields', async () => {
        const v = await checkSales(`
  fields Described { label: String  doc: String? }
  value Term with Described {
    name: String
    invariant named { length(name) > 0 and length(label) > 0 }
  }`);
        expect(v.diagnostics).toEqual([]);
        const sales = ts(v, 'Sales');
        expect(sales).toMatch(/export interface Term extends Described \{\n    readonly name: string;\n\}/);
        expect(sales).toContain('return a.label === b.label && sameOptional(a.doc, b.doc, ($0: string, $1: string) => $0 === $1) && a.name === b.name;');
        expect(sales).toContain("if (!((Array.from(term.name).length > 0) && (Array.from(term.label).length > 0))) violated.push('named');");
    });

    test('unions of the events, the aggregates and the events of each aggregate', () => {
        const sales = ts(a, 'Sales');
        expect(sales).toContain(
            '/**\n * Events that the commands of Order may emit.\n * @see sales.dt:8\n */\nexport type OrderEvent = OrderPlaced | OrderConfirmed | Billing.Billed;',
        );
        expect(sales).toContain('/** Events of Sales. */\nexport type DomainEvent = OrderPlaced | OrderConfirmed;');
        expect(sales).toContain('/** Aggregates of Sales. */\nexport type Aggregate = Order;');
        const common = ts(a, 'Common');
        expect(common).not.toContain('DomainEvent');
        expect(common).not.toContain('Aggregate');
    });
});
