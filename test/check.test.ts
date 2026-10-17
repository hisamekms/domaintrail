import { describe, expect, test } from 'bun:test';
import { analyze } from '../src/core/analyze.js';
import { loadWorkspace } from '../src/core/files.js';
import { EXAMPLES, check, checkSales, codes, only } from './helpers.js';

const ORDER = `
  id OrderId: UUID
  id LineId: UUID
  aggregate Order {
    id: OrderId
    owns lines: Line[0..*]
    state Draft
    state Done { doneAt: Timestamp }
    command finish(at: Timestamp) from Draft to Done
  }
  entity Line { id: LineId  quantity: Int }
`;

describe('examples', () => {
    test('the shop example is valid across multiple files and contexts', async () => {
        const a = await analyze(await loadWorkspace(EXAMPLES));
        expect(a.files.length).toBe(4);
        expect(a.diagnostics).toEqual([]);
        expect(a.ok).toBe(true);
    });

    test('a context can be split across files; other contexts need qualified names', async () => {
        const a = await check({
            'a.dt': 'context Sales { id CustomerId: UUID }',
            'b.dt': `context Sales { aggregate Customer { id: CustomerId } }
                         context Billing { id InvoiceId: UUID aggregate Invoice { id: InvoiceId references c: CustomerId -> Customer } }`,
        });
        expect(only(a, 'M001').map((d) => d.message)).toEqual([
            "Cannot resolve type 'CustomerId' in this context (use Context.Name for other contexts).",
            "Cannot resolve aggregate 'Customer' in this context (use Context.Name for other contexts).",
        ]);
    });
});

describe('diagnostics carry file position and rule ID', () => {
    test('syntax errors', async () => {
        const a = await checkSales('aggregate Order { id: }');
        expect(a.syntaxOk).toBe(false);
        expect(a.diagnostics[0]).toMatchObject({ file: 'sales.dt', code: 'SYNTAX', severity: 'error', start: { line: 2 } });
    });

    test('M001 unresolved type reference', async () => {
        const a = await checkSales(`${ORDER} value V { x: Nope }`);
        const [d] = only(a, 'M001');
        expect(d).toMatchObject({ file: 'sales.dt', start: { line: 13 }, elementId: 'Sales.V' });
        expect(d.message).toContain("'Nope'");
    });
});

describe('naming (M002)', () => {
    test('duplicate declarations across files of the same context', async () => {
        const a = await check({ 'a.dt': 'context S { id X: UUID }', 'b.dt': 'context S { id X: Int }' });
        expect(codes(a)).toEqual(['M002']);
    });

    test('duplicate fields, states and state fields shadowing common fields', async () => {
        const a = await checkSales(`
  id OrderId: UUID
  aggregate Order {
    id: OrderId
    note: String
    note: String
    state A { note: String }
    state A
  }`);
        expect(codes(a).sort()).toEqual(['M002', 'M002', 'M002']);
    });
});

describe('ownership (M003, M004, M012)', () => {
    test('M003 an entity owned by two aggregates', async () => {
        const a = await checkSales(`${ORDER}
  id OtherId: UUID
  aggregate Other { id: OtherId owns lines: Line[0..*] }`);
        expect(codes(a)).toEqual(['M003']);
    });

    test('M003 warning for an entity owned by no aggregate', async () => {
        const a = await checkSales(`${ORDER} id OrphanId: UUID entity Orphan { id: OrphanId }`);
        expect(a.ok).toBe(true);
        expect(only(a, 'M003')[0]).toMatchObject({ severity: 'warning' });
    });

    test('M004 entity embedded as a plain field / aggregate owned by another aggregate', async () => {
        const a = await checkSales(`${ORDER}
  id OtherId: UUID
  aggregate Other { id: OtherId line: Line owns order: Order }`);
        expect(codes(a)).toEqual(['M004', 'M004']);
        expect(a.diagnostics.map((d) => d.message).join('\n')).toContain("declare it with 'owns'");
    });

    test('M004 entity of another context cannot be owned', async () => {
        const a = await check({
            'a.dt': `context Sales { ${ORDER} }`,
            'b.dt': 'context Billing { id BId: UUID aggregate B { id: BId owns lines: Sales.Line[0..*] } }',
        });
        expect(codes(a)).toContain('M004');
    });

    test('M012 ownership cycle', async () => {
        const a = await checkSales(`${ORDER} value A { owns b: B } value B { c: C } value C { owns a: A? }`);
        const [d] = only(a, 'M012');
        expect(d.message).toBe('Ownership cycle: A -> B -> C -> A.');
    });
});

describe('references (M005)', () => {
    test('reference type must match the identity of the target aggregate', async () => {
        const a = await checkSales(`${ORDER}
  id CustomerId: UUID
  aggregate Customer { id: CustomerId }
  aggregate Invoice { id: InvoiceId references order: CustomerId -> Order references c: String -> Customer }
  id InvoiceId: UUID`);
        expect(codes(a)).toEqual(['M005', 'M005']);
        expect(only(a, 'M005')[0].message).toContain("'Order' is identified by 'OrderId'");
    });
});

describe('commands (M006, M007)', () => {
    test('M006 non-existent state', async () => {
        const a = await checkSales(ORDER.replace('to Done', 'to Shipped'));
        const [d] = only(a, 'M006');
        expect(d.message).toBe("Cannot resolve state 'Shipped' in this aggregate.");
        expect(d.elementId).toBe('Sales.Order:finish');
    });

    test('M006 command shape rules', async () => {
        const a = await checkSales(`${ORDER}
  id CId: UUID
  aggregate C {
    id: CId
    command a() from X
  }`.replace('command finish(at: Timestamp) from Draft to Done', `command finish(at: Timestamp) from Draft to Done
    command noFrom() to Done
    command noTo() from Draft
    create command make() from Draft to Draft
    create command make2()`));
        expect(only(a, 'M006').map((d) => d.message)).toEqual([
            "Command 'noFrom' must declare its input state(s) with 'from' (or be declared with 'create command').",
            "Command 'noTo' must declare its output state(s) with 'to'.",
            "Factory command 'make' creates a new 'Order' and cannot have input states ('from').",
            "Factory command 'make2' must declare its output state(s) with 'to'.",
            "Cannot resolve state 'X' in this aggregate.",
            "Command 'a' declares states, but aggregate 'C' has no states.",
        ]);
    });

    test('M007 events and errors must exist and be of the right kind', async () => {
        const a = await checkSales(`${ORDER.replace('to Done', 'to Done emits Ghost, Oops errors Done2')} error Oops`);
        expect(only(a, 'M007').map((d) => d.message)).toEqual([
            "Cannot resolve event 'Ghost' in this context (use Context.Name for other contexts).",
            "Cannot resolve event 'Oops' in this context (use Context.Name for other contexts).",
            "Cannot resolve error 'Done2' in this context (use Context.Name for other contexts).",
        ]);
    });
});

describe('generated TypeScript names (M011)', () => {
    test('collision between a generated command type and a declared type', async () => {
        const a = await checkSales(`${ORDER} value FinishOrder`);
        expect(only(a, 'M011')[0].message).toBe(
            "Generated TypeScript name 'FinishOrder' for value object 'FinishOrder' collides with command 'Order.finish'.",
        );
    });

    test('reserved discriminant and parameter names', async () => {
        const a = await checkSales(`${ORDER.replace('finish(at: Timestamp)', 'finish(order: Timestamp, default: Int)')} event E { type: String }`);
        expect(only(a, 'M011').map((d) => d.message)).toEqual([
            "Parameter 'order' of FinishOrder collides with the aggregate parameter 'order'.",
            "Parameter name 'default' is a reserved word in TypeScript.",
            "Field 'type' is reserved for the discriminant of generated event types.",
        ]);
    });
});

describe('identity (M013)', () => {
    test('aggregates and entities need their own ID type', async () => {
        const a = await checkSales(`${ORDER} entity Other { id: LineId } value V { id: String }`);
        expect(only(a, 'M013').map((d) => d.message)).toEqual([
            "ID type 'LineId' already identifies 'Line'; each Aggregate/Entity needs its own ID type.",
        ]);
        const b = await checkSales('aggregate NoId { name: String }');
        expect(codes(b)).toEqual(['M013']);
    });
});
