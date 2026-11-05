import { describe, expect, test } from 'bun:test';
import { check, checkSales, only, type Checked } from '../../test-helpers.js';

/** The diagnostics of a rule as `line:column severity message (hint)`. */
const lines = (a: Checked, code: string): string[] => only(a, code).map((d) => `${d.start.line}:${d.start.column} ${d.severity} ${d.message} (${d.hint})`);

describe('a union without fields (M026)', () => {
    test('a union none of whose variants has a field is a warning on its name, with the enum to write', async () => {
        const a = await checkSales(`  union Status { DRAFT ACTIVE "有効" CLOSED }`);
        expect(a.ok).toBe(true);
        expect(lines(a, 'M026')).toEqual([
            "2:9 warning No variant of union 'Status' has a field: a closed set of values is an enum. (write 'enum Status { DRAFT ACTIVE CLOSED }' instead)",
        ]);
        expect(only(a, 'M026')[0].elementId).toBe('Sales.Status');
    });

    test('a union bound to an enum whose variants have no field: use the enum itself', async () => {
        const a = await checkSales(`  enum Kind { A B }\n  union Tagged by kind: Kind { A B }`);
        expect(lines(a, 'M026')).toEqual([
            "3:9 warning No variant of union 'Tagged' has a field: a closed set of values is an enum. (use the enum 'Kind' itself where 'Tagged' is used, and remove the union)",
        ]);
    });

    test('a union with one variant that has a field, an enum, or a union with no variant (M015) is no M026', async () => {
        const a = await checkSales(`  union Payer { ANONYMOUS  NAMED { name: String } }
  enum Status { DRAFT ACTIVE }`);
        expect(only(a, 'M026')).toEqual([]);
        expect(only(await checkSales(`  union Empty { }`), 'M026')).toEqual([]);
    });
});

describe('an ID kept as a primitive (M027)', () => {
    const SALES = `  id CustomerId: UUID
  id OrderId: UUID
  id TicketNo: Int
  aggregate Customer { id: CustomerId }
  aggregate Ticket { id: TicketNo }
`;

    test('a field named after an ID type, typed String or UUID: use the ID type, `references` in an aggregate', async () => {
        const a = await checkSales(`${SALES}
  aggregate Order {
    id: OrderId
    customerId: String
    watcherIDs: UUID[0..*]
    command assign(customerId: String) changes customerId
  }
  value Line { orderId: String? }
  event Assigned { orderId: OrderId  customerId: UUID }`);
        expect(a.ok).toBe(true);
        expect(lines(a, 'M027')).toEqual([
            "10:17 warning Field 'customerId' holds an ID but is typed String: use the ID type 'CustomerId'. (write 'references customer: CustomerId -> Customer')",
            "12:32 warning Parameter 'customerId' holds an ID but is typed String: use the ID type 'CustomerId'. (write 'customerId: CustomerId')",
            "14:25 warning Field 'orderId' holds an ID but is typed String: use the ID type 'OrderId'. (write 'orderId: OrderId?')",
            "15:50 warning Field 'customerId' holds an ID but is typed UUID: use the ID type 'CustomerId'. (write 'customerId: CustomerId')",
        ]);
    });

    test('a stem that names an aggregate takes the type of its identity, also of its base type', async () => {
        const a = await checkSales(`${SALES}
  aggregate Order {
    id: OrderId
    ticketIds: Int[0..*]
    customers: String[0..*]
  }`);
        expect(lines(a, 'M027')).toEqual([
            "10:16 warning Field 'ticketIds' holds an ID but is typed Int: use the ID type 'TicketNo'. (write 'references tickets: TicketNo[0..*] -> Ticket')",
        ]);
    });

    test('an ID of another context is named qualified; one in several other contexts is not reported', async () => {
        const billing = `context Billing {
  id InvoiceId: UUID
  aggregate Invoice {
    id: InvoiceId
    orderId: String
    customerId: String
  }
}
`;
        const sales = `context Sales {
  id OrderId: UUID
  aggregate Order { id: OrderId }
}
`;
        const crm = (ctx: string) => `context ${ctx} {
  id CustomerId: UUID
  aggregate Customer { id: CustomerId }
}
`;
        const a = await check({ 'billing.dt': billing, 'sales.dt': sales, 'crm.dt': crm('Crm'), 'shop.dt': crm('Shop') });
        expect(only(a, 'M027').map((d) => [d.file, d.message, d.hint])).toEqual([
            [
                'billing.dt',
                "Field 'orderId' holds an ID but is typed String: use the ID type 'Sales.OrderId'.",
                "write 'references order: Sales.OrderId -> Sales.Order'",
            ],
        ]);
    });

    test('a shared context is matched against itself only (it depends on no other context)', async () => {
        const a = await check({
            'common.dt': 'shared context Common {\n  value Ref { orderId: String }\n}\n',
            'sales.dt': 'context Sales {\n  id OrderId: UUID\n  aggregate Order { id: OrderId }\n}\n',
        });
        expect(only(a, 'M027')).toEqual([]);
    });

    test('no warning: the identity, an ID type already, another primitive, a stem without a type, a domain primitive', async () => {
        const a = await checkSales(`${SALES}
  primitive ExternalCode: String
  aggregate Order {
    id: OrderId
    customer: CustomerId
    customerId2: String
    salesforceId: String
    externalCustomerId: String
    orderId: Int
    customerCode: String
    partnerId: ExternalCode
    identifier: String
  }`);
        expect(only(a, 'M027')).toEqual([]);
    });
});
