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
    command finish(at: Timestamp) Draft -> Done
  }
  entity Line { id: LineId  quantity: Int }
`;

describe('examples', () => {
    test('the shop example is valid across multiple files and contexts, with its stormings', async () => {
        const a = await analyze(await loadWorkspace(EXAMPLES));
        expect(a.files).toEqual([
            'billing/context.dt',
            'billing/invoice.dt',
            'common/context.dt',
            'sales/context.dt',
            'sales/customer.dt',
            'sales/order.dt',
            'stormings/order-to-cash.dtes',
            'stormings/returns.dtes',
        ]);
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

    test('an unexpected end of file is named as such, not as an empty token', async () => {
        const unclosed = await analyze([{ path: 'a.dt', text: 'context Shop {\n  aggregate Order {' }]);
        expect(unclosed.diagnostics.map((d) => d.message)).toEqual(["Expecting token of type '}' but found end of file."]);
        const noAlternative = await analyze([{ path: 'a.dt', text: 'context Shop {\n  aggregate Order {\n    command' }]);
        expect(noAlternative.diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/\nbut found end of file$/)]);
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
    test('transitions are separated by line breaks or commas; sources and targets take several states', async () => {
        const a = await checkSales(`
  id WorkId: UUID
  event WorkChanged { workId: WorkId }
  error NotReady
  aggregate Work {
    id: WorkId
    state Draft
    state InProgress
    state Completed
    state Cancelled

    create command open(id: WorkId) -> Draft

    command change()
      Draft -> Draft
      InProgress -> InProgress
      emits WorkChanged

    command start() Draft -> InProgress
    command finish() InProgress -> Completed errors NotReady
    command cancel() Draft | InProgress -> Cancelled
    command review() InProgress -> InProgress | Completed
    command edit() Draft -> Draft, InProgress -> InProgress
    note: String?
  }`);
        expect(a.diagnostics).toEqual([]);
        const work = a.model!.elements['Sales.Work'];
        expect(Object.fromEntries(work.commands!.map((c) => [c.name, c.transitions]))).toEqual({
            open: [{ from: [], to: ['Draft'] }],
            change: [
                { from: ['Draft'], to: ['Draft'] },
                { from: ['InProgress'], to: ['InProgress'] },
            ],
            start: [{ from: ['Draft'], to: ['InProgress'] }],
            finish: [{ from: ['InProgress'], to: ['Completed'] }],
            cancel: [{ from: ['Draft', 'InProgress'], to: ['Cancelled'] }],
            review: [{ from: ['InProgress'], to: ['InProgress', 'Completed'] }],
            edit: [
                { from: ['Draft'], to: ['Draft'] },
                { from: ['InProgress'], to: ['InProgress'] },
            ],
        });
        expect(work.commands!.find((c) => c.name === 'change')!.emits).toEqual([
            { event: 'Sales.WorkChanged', cardinality: 'one', multiplicity: '', lower: 1, upper: 1 },
        ]);
        expect(work.fields.map((f) => f.name)).toContain('note');
    });

    test('the old from/to syntax is a syntax error', async () => {
        const a = await checkSales(ORDER.replace('Draft -> Done', 'from Draft to Done'));
        expect(codes(a)).toContain('SYNTAX');
    });

    test('M006 non-existent state', async () => {
        const a = await checkSales(ORDER.replace('-> Done', '-> Shipped'));
        const [d] = only(a, 'M006');
        expect(d.message).toBe("Cannot resolve state 'Shipped' in this aggregate.");
        expect(d.elementId).toBe('Sales.Order:finish');
    });

    test('M006 command shape rules', async () => {
        const a = await checkSales(
            `${ORDER}
  id CId: UUID
  aggregate C {
    id: CId
    command a() X -> X
  }`.replace(
                'command finish(at: Timestamp) Draft -> Done',
                `command finish(at: Timestamp) Draft -> Done
    command none()
    command noSource() -> Done
    command mixed() Draft -> Done, -> Draft
    create command make() Draft -> Draft
    create command make2()
    create command make3() -> Draft, -> Done`,
            ),
        );
        expect(only(a, 'M006').map((d) => d.message)).toEqual([
            "Command 'none' must declare its state transitions, e.g. 'Draft -> Submitted' (or be declared with 'create command').",
            "Command 'noSource' has a transition without source states; write 'State -> ...' (only a 'create command' starts with '->').",
            "Command 'mixed' has a transition without source states; write 'State -> ...' (only a 'create command' starts with '->').",
            "Factory command 'make' creates a new 'Order' and cannot have source states; write '-> Draft'.",
            "Factory command 'make2' must declare exactly one transition to its initial state(s), e.g. '-> Draft'.",
            "Factory command 'make3' must declare exactly one transition to its initial state(s), e.g. '-> Draft'.",
            "Cannot resolve state 'X' in this aggregate.",
            "Command 'a' declares state transitions, but aggregate 'C' has no states.",
            "Cannot resolve state 'X' in this aggregate.",
        ]);
    });

    test('M006 a state is the source of one transition only; a target listed twice is a warning', async () => {
        const a = await checkSales(ORDER.replace('Draft -> Done', 'Draft -> Draft\n    Done | Draft -> Done | Done'));
        expect(only(a, 'M006').map((d) => [d.severity, d.message, d.start.line])).toEqual([
            [
                'error',
                "State 'Draft' is the source of more than one transition of command 'finish'; its outcome must be decided by one transition (use 'A -> B | C').",
                11,
            ],
            ['warning', "State 'Done' is listed more than once.", 11],
        ]);
    });

    test('M007 events and errors must exist and be of the right kind', async () => {
        const a = await checkSales(`${ORDER.replace('-> Done', '-> Done emits Ghost, Oops errors Done2')} error Oops`);
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
        expect(only(a, 'M011')[0].message).toBe("Generated TypeScript name 'FinishOrder' for value object 'FinishOrder' collides with command 'Order.finish'.");
    });

    test('collision with the decision of a command, and with the shape of an aggregate', async () => {
        const a = await checkSales(`${ORDER} value FinishOrderDecision value OrderShape`);
        expect(only(a, 'M011').map((d) => d.message)).toEqual([
            "Generated TypeScript name 'FinishOrderDecision' for value object 'FinishOrderDecision' collides with the decision of 'Order.finish'.",
            "Generated TypeScript name 'OrderShape' for value object 'OrderShape' collides with the shape of 'Order'.",
        ]);
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
        expect(only(a, 'M013').map((d) => d.message)).toEqual(["ID type 'LineId' already identifies 'Line'; each Aggregate/Entity needs its own ID type."]);
        const b = await checkSales('aggregate NoId { name: String }');
        expect(codes(b)).toEqual(['M013']);
    });
});
