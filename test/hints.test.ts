import { describe, expect, test } from 'bun:test';
import { formatDiagnostic, jsonDiagnostic } from '@domaintrail/modeling/core/diagnostics';
import { closest, distance } from '@domaintrail/modeling/core/suggest';
import { check, checkSales, only } from './helpers.js';

const hints = (a: Awaited<ReturnType<typeof check>>, code: string): (string | undefined)[] => only(a, code).map((d) => d.hint);

describe('edit distance', () => {
    test('counts insertions, deletions, substitutions and swaps of neighbors', () => {
        expect(distance('confirm', 'confirm')).toBe(0);
        expect(distance('confirmd', 'confirmed')).toBe(1);
        expect(distance('cnofirm', 'confirm')).toBe(1);
        expect(distance('kitten', 'sitting')).toBe(3);
    });

    test('suggests at most 3 names within a third of the length, best first, ignoring case', () => {
        expect(closest('Ordr', ['Order', 'Orders', 'Odor', 'Customer'])).toEqual(['Order']);
        expect(closest('OrderLne', ['Order', 'OrderLines', 'OrderLone', 'OrderLine', 'OrderLane'])).toEqual(['OrderLane', 'OrderLine', 'OrderLone']);
        expect(closest('status', ['Status', 'stats'])).toEqual(['Status']); // another letter case only: the one suggestion
        expect(closest('Payment', ['Customer', 'Order'])).toEqual([]);
        expect(closest('x', ['y'])).toEqual([]);
    });

    test('an exact match of a name of another context is the only suggestion', () => {
        expect(closest('OrderId', [{ name: 'Order' }, { name: 'Sales.OrderId', key: 'OrderId' }])).toEqual(['Sales.OrderId']);
    });
});

describe('did you mean', () => {
    test('types: of this context, shared contexts and primitives by simple name, other contexts qualified', async () => {
        const a = await check({
            'common.dt': 'shared context Common { value Money { amount: Decimal } }',
            'sales.dt': `context Sales {
  id OrderId: UUID
  aggregate Order { id: OrderId total: Mony name: Strng }
}`,
            'billing.dt': `context Billing {
  id InvoiceId: UUID
  aggregate Invoice { id: InvoiceId order: OrderId other: Sales.OrdrId }
}`,
        });
        expect(only(a, 'M001').map((d) => [d.message, d.hint])).toEqual([
            ["Cannot resolve type 'OrderId' in this context (use Context.Name for other contexts).", "did you mean 'Sales.OrderId'?"],
            ["Cannot resolve type 'Sales.OrdrId'.", "did you mean 'Sales.OrderId' or 'Sales.Order'?"],
            ["Cannot resolve type 'Mony' in this context (use Context.Name for other contexts).", "did you mean 'Money'?"],
            ["Cannot resolve type 'Strng' in this context (use Context.Name for other contexts).", "did you mean 'String'?"],
        ]);
    });

    test('states, events, errors, field sets and aggregates: only names of that kind', async () => {
        const a = await checkSales(`
  id OrderId: UUID
  id CustomerId: UUID
  fields Audit { note: String }
  aggregate Order with Audt {
    id: OrderId
    references customer: CustomerId -> Ordr
    state Draft
    state Confirmed
    command confirm() Draft -> Confirmd emits OrderConfirmd errors OrderNotFond
  }
  event OrderConfirmed { orderId: OrderId }
  error OrderNotFound`);
        expect(a.diagnostics.filter((d) => d.severity === 'error').map((d) => [d.code, d.hint])).toEqual([
            ['M016', "did you mean 'Audit'?"],
            ['M001', "did you mean 'Order'?"],
            ['M006', "did you mean 'Confirmed'?"],
            ['M007', "did you mean 'OrderConfirmed'?"],
            ['M007', "did you mean 'OrderNotFound'?"],
        ]);
    });

    test('a state that is not close to any lists the states of the aggregate', async () => {
        const a = await checkSales(`
  id OrderId: UUID
  aggregate Order { id: OrderId state Draft state Confirmed command ship() Confirmed -> Shipped }`);
        expect(hints(a, 'M006')).toEqual(["use a state of 'Order': Draft, Confirmed"]);
    });

    test('names in expressions: fields, parameters, lambda parameters, enums and their values', async () => {
        const a = await checkSales(`
  id OrderId: UUID
  enum Status { Open, Closed }
  value Line { sku: String quantity: Int }
  aggregate Order {
    id: OrderId
    status: Status
    lines: Line[0..*]
    invariant a { all(lines, line => line.quantty > 0) }
    invariant b { all(lines, line => lne.quantity > 0) }
    invariant c { stats == Status.Open }
    invariant d { status == Status.Opne }
    invariant e { status == Statu.Open }
    command add(quantity: Int) requires r { quantiy > 0 } else Invalid
  }
  error Invalid`);
        expect(only(a, 'M001').map((d) => [d.message, d.hint])).toEqual([
            ["'Line' has no field 'quantty'.", "did you mean 'quantity'?"],
            ["Cannot resolve name 'lne'.", "did you mean 'line'?"],
            ["Cannot resolve name 'stats'.", "did you mean 'status' or 'Status'?"],
            ["Enum 'Status' has no value 'Opne'.", "did you mean 'Open'?"],
            ["Cannot resolve name 'Statu'.", "did you mean 'status' or 'Status'?"],
            ["Cannot resolve name 'quantiy'.", "did you mean 'quantity'?"],
        ]);
    });

    test('names in expressions: enums of other contexts are suggested qualified', async () => {
        const a = await check({
            'sales.dt': 'context Sales { enum Status { Open, Closed } }',
            'billing.dt': `context Billing {
  id InvoiceId: UUID
  aggregate Invoice { id: InvoiceId open: Bool invariant a { open implies Status.Open == Sales.Status.Opn } }
}`,
        });
        expect(only(a, 'M001').map((d) => [d.message, d.hint])).toEqual([
            ["Cannot resolve name 'Status'.", "did you mean 'Sales.Status'?"],
            ["Enum 'Status' has no value 'Opn'.", "did you mean 'Open'?"],
        ]);
        const b = await check({
            'sales.dt': 'context Sales { enum Status { Open, Closed } }',
            'billing.dt': `context Billing {
  id InvoiceId: UUID
  aggregate Invoice { id: InvoiceId open: Bool invariant a { open implies Sales.Stats.Open == Sales.Status.Opn } }
}`,
        });
        expect(only(b, 'M001').map((d) => d.hint)).toEqual(["did you mean 'Status'?", "did you mean 'Open'?"]);
    });

    test('no hint when nothing is close', async () => {
        const a = await checkSales(`
  id OrderId: UUID
  aggregate Order { id: OrderId total: Payment invariant a { somethingElse } }`);
        expect(only(a, 'M001').map((d) => d.hint)).toEqual([undefined, undefined]);
    });
});

describe('fix hints', () => {
    test('M004, M005, M013: ownership, references and identity', async () => {
        const a = await checkSales(`
  id OrderId: UUID
  id CustomerId: UUID
  aggregate Customer { id: CustomerId }
  aggregate Order {
    id: OrderId
    owns customer: Customer
    references buyer: OrderId -> Customer
  }
  aggregate Cart { name: String }`);
        expect(hints(a, 'M004')).toEqual(["write 'references customer: CustomerId -> Customer' instead"]);
        expect(hints(a, 'M005')).toEqual(["change the type to 'CustomerId', or point '->' at the aggregate that 'OrderId' identifies"]);
        expect(hints(a, 'M013')).toEqual(["declare 'id CartId: UUID' in the context and add the field 'id: CartId'"]);
    });

    test('M006: transitions on an aggregate without states', async () => {
        const a = await checkSales(`
  id OrderId: UUID
  aggregate Order { id: OrderId command c() A -> B }`);
        expect(hints(a, 'M006')).toContain("remove the transitions, or declare the states of 'Order' with 'state Name'");
    });

    test('M010: state-only fields in invariants and requirements', async () => {
        const a = await checkSales(`
  id OrderId: UUID
  aggregate Order {
    id: OrderId
    invariant a { exists(paidAt) }
    state Draft
    state Paid { paidAt: Timestamp? }
    command refund() Draft | Paid -> Draft requires r { exists(paidAt) } else Invalid
  }
  error Invalid`);
        expect(hints(a, 'M010')).toEqual([
            "move the field to the common fields of 'Order', or use it only in the invariants of state 'Paid'",
            "declare 'paidAt' with the same type in every source state of 'refund' (or among the common fields), or split the command by source state",
        ]);
    });

    test('M016, M018, M019: field sets, declared invariants and parameter names', async () => {
        const a = await checkSales(`
  id OrderId: UUID
  fields Audit { id: OrderId }
  aggregate Order {
    id: OrderId
    note: String
    invariant documented
    command edit(note: String) requires r { note != "" } else Invalid
  }
  error Invalid`);
        expect(hints(a, 'M016')).toEqual(["remove 'id' from 'Audit' and declare it in each aggregate and entity with an ID type of its own"]);
        expect(hints(a, 'M018')).toEqual([`write 'invariant documented "…"', put a /// line above it, or add an expression in '{ … }'`]);
        expect(hints(a, 'M019')).toEqual(["rename the parameter (e.g. 'newNote'), so that 'note' in a requirement means the field"]);
    });

    test('L001, L002, L003: Japanese names', async () => {
        const a = await check({
            'a.dt': `context Sales "販売" {
  terms { note: "備考" notes: "メモ" }
  value V { note: String "注文メモ" a: String "同じ" b: String "同じ" }
}`,
            'b.dt': 'context Sales "営業" { }',
        });
        expect(hints(a, 'L001')).toEqual([
            'remove the label to use the term, or rename the field if it means something else',
            'use one name for the context in every file, or omit it here',
        ]);
        expect(hints(a, 'L002')).toEqual(["did you mean 'note'?"]);
        expect(hints(a, 'L003')).toEqual(['give one of them another Japanese name (with a label, or a term)']);
    });
});

describe('output of a diagnostic', () => {
    const d = {
        file: 'sales/order.dt',
        start: { line: 8, column: 32 },
        end: { line: 8, column: 40 },
        severity: 'error' as const,
        code: 'M009' as const,
        message: "count() requires a collection, but got 'Money'.",
    };

    test('text: the hint on an indented second line', () => {
        expect(formatDiagnostic(d)).toBe("sales/order.dt:8:32 - error M009: count() requires a collection, but got 'Money'.");
        expect(formatDiagnostic({ ...d, hint: 'x' })).toBe("sales/order.dt:8:32 - error M009: count() requires a collection, but got 'Money'.\n  hint: x");
    });

    test('JSON: 1-based start and end, hint only when there is one', () => {
        expect(jsonDiagnostic({ ...d, elementId: 'Sales.Order' })).toEqual({
            file: 'sales/order.dt',
            line: 8,
            column: 32,
            endLine: 8,
            endColumn: 40,
            severity: 'error',
            code: 'M009',
            message: "count() requires a collection, but got 'Money'.",
        });
        expect(jsonDiagnostic({ ...d, hint: 'x' }).hint).toBe('x');
    });
});
