import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { analyzeDomain } from '../application/analyze.js';
import { exampleSources } from '../test-helpers.js';
import { validStatesFor } from './model.js';
import { stateId } from './ids.js';
import { buildSemanticIR, SEMANTIC_IR_VERSION } from './semantic.js';
import { checkInvariants } from './rules/expressions.js';
import { RuleSink } from './diagnostics.js';

const allExamples = async () => {
    const root = path.join(import.meta.dir, '..', '..', '..', '..', 'examples');
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!['node_modules', '.git', '.domaintrail', 'generated'].includes(entry.name)) await walk(path.join(directory, entry.name));
            } else if (entry.name.endsWith('.dt')) files.push(path.relative(root, path.join(directory, entry.name)));
        }
    };
    await walk(root);
    return Promise.all(files.sort().map(async (file) => ({ path: file, text: await readFile(path.join(root, file), 'utf8') })));
};

describe('Semantic IR', () => {
    test('expression facts sink preserves checker diagnostics on all examples and a representative fixture', async () => {
        const analyses = [
            await analyzeDomain(await allExamples()),
            await analyzeDomain([
                {
                    path: 'fixture.dt',
                    text: `context Fixture { id ItemId: UUID aggregate Item { id: ItemId state Start state RetailDone kind Retail { initial Start on finish { outcome done: Start -> RetailDone } } command finish() { } } }`,
                },
            ]),
        ];
        for (const analysis of analyses) {
            const model = analysis.sourceModel!;
            const withoutSink = new RuleSink();
            const withSink = new RuleSink();
            checkInvariants(model, withoutSink);
            checkInvariants(model, withSink, () => {});
            expect(withSink.items).toEqual(withoutSink.items);
        }
    });
    test('projects the shop lifecycle facts as state IDs', async () => {
        const analysis = await analyzeDomain(await exampleSources());
        const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
        const lifecycle = (id: string) => ir.aggregates.find((aggregate) => aggregate.id === id)!.kinds;
        expect(lifecycle('Sales.Order')).toEqual([
            {
                kind: '*',
                initialStates: ['Sales.Order#Draft'],
                validStates: ['Sales.Order#Draft', 'Sales.Order#Confirmed', 'Sales.Order#Cancelled'],
                onCases: [],
            },
        ]);
        expect(lifecycle('Sales.Customer')).toEqual([{ kind: '*', initialStates: [], validStates: [], onCases: [] }]);
        expect(lifecycle('Billing.Invoice')).toEqual([
            { kind: '*', initialStates: ['Billing.Invoice#Open'], validStates: ['Billing.Invoice#Open', 'Billing.Invoice#Paid'], onCases: [] },
        ]);
    });

    test('projects exact resolved symbols and static types for shop expressions', async () => {
        const analysis = await analyzeDomain(await exampleSources());
        const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
        const flat = (nodes: readonly import('../generated/Modeling.js').SemanticExpression[]): import('../generated/Modeling.js').SemanticExpression[] =>
            nodes.flatMap((node) => [node, ...flat(node.children)]);
        const nodes = flat(ir.expressions);
        const source = (text: string) => nodes.find((node) => node.source === text);
        expect(source('items')?.symbol).toEqual({ id: 'Sales.Order.items', kind: 'field', name: 'items' });
        expect(source('items')?.type).toEqual({ name: 'OrderItem', cardinality: 'many' });
        expect(nodes.find((node) => node.symbol?.id === 'Sales.Order:cancel(reason)')?.symbol).toEqual({
            id: 'Sales.Order:cancel(reason)',
            kind: 'parameter',
            name: 'reason',
        });
        expect(source('CancelReason.Other')?.symbol).toEqual({ id: 'Sales.CancelReason=Other', kind: 'enumValue', name: 'Other' });
        expect(source('item.quantity')?.symbol).toEqual({ id: 'Sales.OrderItem.quantity', kind: 'field', name: 'quantity' });
        expect(source('item.unitPrice.currency')?.symbol).toEqual({ id: 'Common.Money.currency', kind: 'field', name: 'currency' });
        expect(source('note')?.type).toEqual({ name: 'String', cardinality: 'optional' });
        const lambda = nodes.find((node) => node.symbol?.kind === 'lambda');
        expect(lambda?.symbol).toEqual({ id: expect.stringContaining(':expression:'), kind: 'lambda', name: 'item' });
        expect(lambda?.type).toEqual({ name: 'OrderItem', cardinality: 'one' });
    });

    test('projects a focused value object member and guarded optional field', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'fixture.dt',
                text: `context Fixture {
              value Address { city: String }
              entity Customer {
                address: Address?
                invariant hasCity { exists(address) and address.city != "" }
              }
            }`,
            },
        ]);
        const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
        const flatten = (nodes: readonly import('../generated/Modeling.js').SemanticExpression[]): import('../generated/Modeling.js').SemanticExpression[] =>
            nodes.flatMap((node) => [node, ...flatten(node.children)]);
        const nodes = flatten(ir.expressions);
        expect(nodes.find((node) => node.source === 'address')?.symbol).toEqual({ id: 'Fixture.Customer.address', kind: 'field', name: 'address' });
        expect(nodes.find((node) => node.source === 'address.city')?.symbol).toEqual({ id: 'Fixture.Address.city', kind: 'field', name: 'city' });
    });

    test('keeps lifecycle initials separate for each kind', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'sales.dt',
                text: `context Sales {
              id ItemId: UUID
              aggregate Item {
                id: ItemId
                state Draft
                state Ready
                state Archived
                kind Retail { initial Draft }
                kind Wholesale { initial Ready }
              }
            }`,
            },
        ]);
        const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
        expect(ir.aggregates[0]?.kinds.map(({ kind, initialStates, validStates }) => ({ kind, initialStates, validStates }))).toEqual([
            { kind: 'Retail', initialStates: ['Sales.Item#Draft'], validStates: ['Sales.Item#Draft'] },
            { kind: 'Wholesale', initialStates: ['Sales.Item#Ready'], validStates: ['Sales.Item#Ready'] },
        ]);
    });

    test('matches Typed Model reachability on a two-kind fixture and examples/shop', async () => {
        const fixture = await analyzeDomain([
            {
                path: 'fixture.dt',
                text: `context Fixture { id ItemId: UUID aggregate Item { id: ItemId state Start state RetailDone state WholesaleDone kind Retail { initial Start on finish { outcome done: Start -> RetailDone } } kind Wholesale { initial Start on finish { outcome done: Start -> WholesaleDone } } command finish() { } } }`,
            },
        ]);
        const shop = await analyzeDomain(await exampleSources());
        for (const analysis of [fixture, shop]) {
            expect(analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
            const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
            for (const model of analysis.model!.elements.filter((element): element is import('./model.js').AggregateModel => element.kind === 'aggregate')) {
                const projected = ir.aggregates.find((aggregate) => aggregate.id === model.id)!;
                for (const kind of model.kinds.map((item) => item.name))
                    expect(projected.kinds.find((item) => item.kind === kind)?.validStates).toEqual(
                        validStatesFor(model, kind).map((name) => stateId(model.id, name)),
                    );
            }
        }
    });

    test('projects examples/shop declarations and keeps 1-based source columns', async () => {
        const analysis = await analyzeDomain(await exampleSources());
        expect(analysis.sourceModel).toBeDefined();
        const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
        expect(ir.version).toBe(SEMANTIC_IR_VERSION);
        expect(ir.declarations.some((decl) => decl.id === 'Sales.Order')).toBe(true);
        expect(ir.aggregates.some((agg) => agg.id === 'Sales.Order')).toBe(true);
        expect(ir.declarations.every((decl) => decl.site.startColumn > 0)).toBe(true);
        const outcomes = Object.fromEntries(
            analysis
                .model!.elements.filter((element) => element.kind === 'aggregate')
                .map((aggregate) => [
                    aggregate.id,
                    Object.fromEntries(
                        aggregate.commands.map((command) => [
                            command.id,
                            ir.aggregates
                                .find((item) => item.id === aggregate.id)!
                                .outcomes.filter((item) => item.command === command.id)
                                .map(({ from, to, changes }) => ({ from, to, changes })),
                        ]),
                    ),
                ]),
        );
        expect(outcomes).toEqual({
            'Billing.Invoice': {
                'Billing.Invoice:issue': [{ from: [], to: 'Billing.Invoice#Open', changes: [] }],
                'Billing.Invoice:pay': [{ from: ['Billing.Invoice#Open'], to: 'Billing.Invoice#Paid', changes: [] }],
            },
            'Sales.Customer': {
                'Sales.Customer:register': [{ from: [], to: undefined, changes: [] }],
                'Sales.Customer:rename': [{ from: [], to: undefined, changes: ['name'] }],
                'Sales.Customer:changeEmail': [{ from: [], to: undefined, changes: ['email'] }],
            },
            'Sales.Order': {
                'Sales.Order:place': [{ from: [], to: 'Sales.Order#Draft', changes: [] }],
                'Sales.Order:addItem': [{ from: ['Sales.Order#Draft'], to: 'Sales.Order#Draft', changes: ['items'] }],
                'Sales.Order:confirm': [{ from: ['Sales.Order#Draft'], to: 'Sales.Order#Confirmed', changes: [] }],
                'Sales.Order:cancel': [
                    { from: ['Sales.Order#Draft'], to: 'Sales.Order#Cancelled', changes: [] },
                    { from: ['Sales.Order#Confirmed'], to: 'Sales.Order#Cancelled', changes: [] },
                ],
                'Sales.Order:changeNote': [
                    { from: ['Sales.Order#Draft'], to: 'Sales.Order#Draft', changes: ['note'] },
                    { from: ['Sales.Order#Confirmed'], to: 'Sales.Order#Confirmed', changes: ['note'] },
                ],
            },
        });
        expect(ir.unspecified.map(({ kind, declaration, field }) => [kind, declaration, field])).toEqual([
            ['createField', 'Billing.Invoice:issue->Open', 'id'],
            ['createField', 'Billing.Invoice:issue->Open', 'order'],
            ['createField', 'Billing.Invoice:issue->Open', 'billedAmount'],
            ['targetOnlyField', 'Billing.Invoice:pay->Paid', 'paidAt'],
            ['createField', 'Sales.Customer:register->*', 'id'],
            ['createField', 'Sales.Customer:register->*', 'name'],
            ['createField', 'Sales.Customer:register->*', 'email'],
            ['changesWithoutExpression', 'Sales.Customer:rename->*', 'name'],
            ['changesWithoutExpression', 'Sales.Customer:changeEmail->*', 'email'],
            ['createField', 'Sales.Order:place->Draft', 'id'],
            ['createField', 'Sales.Order:place->Draft', 'items'],
            ['createField', 'Sales.Order:place->Draft', 'customer'],
            ['createField', 'Sales.Order:place->Draft', 'note'],
            ['changesWithoutExpression', 'Sales.Order:addItem->Draft', 'items'],
            ['targetOnlyField', 'Sales.Order:confirm->Confirmed', 'confirmedAt'],
            ['targetOnlyField', 'Sales.Order:cancel->Cancelled', 'reason'],
            ['targetOnlyField', 'Sales.Order:cancel->Cancelled', 'reason'],
            ['changesWithoutExpression', 'Sales.Order:changeNote->Draft', 'note'],
            ['changesWithoutExpression', 'Sales.Order:changeNote->Confirmed', 'note'],
        ]);
        const outcomeIds = new Set(ir.aggregates.flatMap((aggregate) => aggregate.outcomes.map((item) => item.id)));
        expect(ir.unspecified.filter((fact) => fact.declaration.includes('->')).every((fact) => outcomeIds.has(fact.declaration))).toBe(true);
        expect(
            ir.unspecified.filter((fact) => fact.declaration === 'Sales.Order:cancel->Cancelled' && fact.field === 'reason').map(({ source }) => source),
        ).toEqual(['Sales.Order#Draft', 'Sales.Order#Confirmed']);
    });

    test('projects a kind on-case outcome from the Typed Model', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'sales.dt',
                text: `context Sales {
          id OrderId: UUID
          aggregate Order {
            id: OrderId
            state Draft
            state Done
            command finish()
            kind Retail {
              on finish {
                outcome completed: Draft -> Done
              }
            }
          }
        }`,
            },
        ]);
        const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
        expect(ir.aggregates[0]?.kinds[0]?.onCases.map(({ id, command, from, to, changes }) => ({ id, command, from, to, changes }))).toEqual([
            {
                id: 'Sales.Order/Retail:on:finish->completed',
                command: 'Sales.Order:finish',
                from: ['Sales.Order#Draft'],
                to: 'Sales.Order#Done',
                changes: [],
            },
        ]);
    });

    test('projects each on-case outcome, requirement and unspecified fact once', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'sales.dt',
                text: `context Sales {
          id OrderId: UUID
          error NotReady
          aggregate Order {
            id: OrderId
            state Draft
            state Done { note: String marker: String }
            initial Draft
            command finish()
            kind Retail {
              on finish {
                requires ready "order is ready" else NotReady
                outcome completed: Draft -> Done changes note
              }
            }
          }
        }`,
            },
        ]);
        expect(analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
        const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
        const aggregate = ir.aggregates[0]!;
        expect(aggregate.outcomes.map(({ id }) => id)).toEqual(['Sales.Order/Retail:on:finish->completed']);
        expect(aggregate.requirements.map(({ id }) => id)).toEqual(['Sales.Order/Retail:on:finish.requires.ready']);
        expect(ir.unspecified.map(({ kind, declaration, field, source }) => [kind, declaration, field, source])).toEqual([
            ['expressionFreeRequirement', 'Sales.Order/Retail:on:finish.requires.ready', undefined, undefined],
            ['changesWithoutExpression', 'Sales.Order/Retail:on:finish->completed', 'note', 'Sales.Order#Draft'],
            ['targetOnlyField', 'Sales.Order/Retail:on:finish->completed', 'marker', 'Sales.Order#Draft'],
        ]);
        for (const id of ['Sales.Order/Retail:on:finish->completed', 'Sales.Order/Retail:on:finish.requires.ready']) {
            expect(aggregate.outcomes.filter((item) => item.id === id)).toHaveLength(id.endsWith('completed') ? 1 : 0);
            expect(aggregate.requirements.filter((item) => item.id === id)).toHaveLength(id.endsWith('ready') ? 1 : 0);
            expect(ir.unspecified.filter((item) => item.declaration === id)).toHaveLength(id.endsWith('completed') ? 2 : 1);
        }
    });

    test('records external and natural-language obligations and unspecified changes', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'sales.dt',
                text: `context Sales {
          id OrderId: UUID
          aggregate Order {
            id: OrderId
            state Draft
            state Done { amount: Int }
            initial Draft
            command finish() {
              requires reviewed else Error
              outcome complete: Draft -> Done changes amount
            }
          }
          error Error
        }`,
            },
        ]);
        const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
        expect(ir.unspecified.some((fact) => fact.kind === 'expressionFreeRequirement')).toBe(true);
        expect(ir.unspecified.some((fact) => fact.kind === 'changesWithoutExpression' && fact.field === 'amount')).toBe(true);
        expect(ir.aggregates[0]?.outcomes[0]).toMatchObject({ set: ['amount'], carried: ['id'], dropped: [] });
        expect(ir.obligations.some((item) => item.kind === 'naturalLanguage')).toBe(true);
    });

    test('uses typed frames for differing field types and multi-source outcomes', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'sales.dt',
                text: `context Sales {
                  id ItemId: UUID
                  aggregate Item {
                    id: ItemId
                    state A { value: String }
                    state B { value: Int }
                    state C { value: String }
                    state Done {
                      value: String
                      added: Int
                    }
                    initial A
                    command finish()
                      A | B -> Done
                  }
                }`,
            },
        ]);
        const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
        const outcome = ir.aggregates[0]?.outcomes.find((item) => item.from[0] === 'Sales.Item#B');
        expect(outcome).toMatchObject({ set: ['value', 'added'], carried: ['id'], dropped: ['value'] });
        const sameId = ir.aggregates[0]?.outcomes.filter((item) => item.id === 'Sales.Item:finish->Done');
        expect(sameId?.map((item) => item.from)).toEqual([['Sales.Item#A'], ['Sales.Item#B']]);
    });

    test('does not report a changed common field as target-only', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'sales.dt',
                text: `context Sales { id ItemId: UUID aggregate Item {
                  id: ItemId
                  total: Int
                  state Ready
                  initial Ready
                  command revise() { outcome revised: Ready -> Ready changes total }
                } }`,
            },
        ]);
        const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
        expect(ir.unspecified.some((fact) => fact.kind === 'targetOnlyField' && fact.field === 'total')).toBe(false);
        expect(ir.unspecified.some((fact) => fact.kind === 'changesWithoutExpression' && fact.field === 'total')).toBe(true);
    });

    test('reports unresolved choices separately and records select kinds', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'sales.dt',
                text: `context Sales { id ItemId: UUID aggregate Item {
              id: ItemId state Start state A state B initial Start
              command single() { outcome only: Start -> A }
              command choose() { outcome first: Start -> A outcome second: Start -> B }
              command selected() { outcome first: Start -> A select { true } outcome second: Start -> B }
              command described() { outcome first: Start -> A select "first option" outcome second: Start -> B select "second option" @externalCheck("decide externally") }
            } }`,
            },
        ]);
        const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
        const aggregate = ir.aggregates[0]!;
        expect(ir.unspecified.some((fact) => 'nondeterministicChoice' in fact)).toBe(false);
        expect(aggregate.choices).toEqual([
            { kind: '*', source: 'Sales.Item#Start', outcomes: ['Sales.Item:choose->first', 'Sales.Item:choose->second'] },
            { kind: '*', source: 'Sales.Item#Start', outcomes: ['Sales.Item:described->first', 'Sales.Item:described->second'] },
        ]);
        expect(aggregate.outcomes.filter((item) => item.command === 'Sales.Item:described').map((item) => item.selectKind)).toEqual([
            'naturalLanguage',
            'externalCheck',
        ]);
        expect(
            ir.obligations.filter((item) => item.declaration.includes('described')).map(({ kind, declaration, reason }) => ({ kind, declaration, reason })),
        ).toEqual([
            { kind: 'naturalLanguage', declaration: 'Sales.Item:described->first', reason: 'first option' },
            { kind: 'externalCheck', declaration: 'Sales.Item:described->second', reason: 'decide externally' },
        ]);
    });

    test('keys choices by kind and resolves legacy and on-case outcome IDs', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'sales.dt',
                text: `context Sales { id ItemId: UUID aggregate Item {
                  id: ItemId state Start state A state B state C
                  kind Retail { on choose { outcome yes: Start -> A outcome no: Start -> B } }
                  kind Wholesale { on choose { outcome accept: Start -> B outcome reject: Start -> C } }
                  command choose() { }
                } }`,
            },
        ]);
        const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
        expect(ir.aggregates[0]!.choices).toEqual([
            { kind: 'Retail', source: 'Sales.Item#Start', outcomes: ['Sales.Item/Retail:on:choose->yes', 'Sales.Item/Retail:on:choose->no'] },
            { kind: 'Wholesale', source: 'Sales.Item#Start', outcomes: ['Sales.Item/Wholesale:on:choose->accept', 'Sales.Item/Wholesale:on:choose->reject'] },
        ]);
        const legacy = await analyzeDomain([
            {
                path: 'legacy.dt',
                text: `context Legacy { id ItemId: UUID aggregate Item { id: ItemId state A state B state C command change() A -> B | C } }`,
            },
        ]);
        expect(buildSemanticIR(legacy.sourceModel!, legacy.model!).aggregates[0]!.choices).toEqual([
            { kind: '*', source: 'Legacy.Item#A', outcomes: ['Legacy.Item:change->B', 'Legacy.Item:change->C'] },
        ]);
    });

    test('keeps one shared-command choice for each kind', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'sales.dt',
                text: `context Sales { id ItemId: UUID aggregate Item { id: ItemId state Start state A state B kind Retail { initial Start } kind Wholesale { initial Start } command choose() { outcome first: Start -> A outcome second: Start -> B } } }`,
            },
        ]);
        const choices = buildSemanticIR(analysis.sourceModel!, analysis.model!).aggregates[0]!.choices;
        expect(choices.map((choice) => choice.kind)).toEqual(['Retail', 'Wholesale']);
    });

    test('preserves externalReason on requirements', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'sales.dt',
                text: `context Sales { id ItemId: UUID aggregate Item { id: ItemId command review() { requires approved @externalCheck("approval is external") else Error } } error Error }`,
            },
        ]);
        const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
        expect(ir.aggregates[0]!.requirements[0]).toMatchObject({ externalReason: 'approval is external' });
        expect(ir.obligations).toContainEqual(expect.objectContaining({ kind: 'externalCheck', reason: 'approval is external' }));
    });

    test('keys external invariant obligations by stable declaration ID without duplicates', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'sales.dt',
                text: `context Sales {
              id ItemId: UUID
              primitive Code: String { invariant valid "check code" @externalCheck("check code") }
              union Value { variant Text { invariant accepted "review text" @externalCheck("review text") } }
              aggregate Item {
                id: ItemId
                state Ready { invariant permitted "review state" @externalCheck("review state") }
                kind Retail { invariant permitted "review kind" @externalCheck("review kind") }
              }
            }`,
            },
        ]);
        const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
        const obligations = ir.obligations;
        expect(obligations.map(({ declaration, reason }) => ({ declaration, reason }))).toEqual([
            { declaration: 'Sales.Code.invariant.valid', reason: 'check code' },
            { declaration: 'Sales.Value|Text.invariant.accepted', reason: 'review text' },
            { declaration: 'Sales.Item#Ready.invariant.permitted', reason: 'review state' },
            { declaration: 'Sales.Item/Retail.invariant.permitted', reason: 'review kind' },
        ]);
        expect(new Set(obligations.map((item) => item.declaration)).size).toBe(obligations.length);
    });

    test('marks create fields from a field set as unspecified', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'sales.dt',
                text: `context Sales {
              id ItemId: UUID
              fields Audited { createdAt: Timestamp }
              aggregate Item with Audited { id: ItemId state Ready create command create(id: ItemId) -> Ready }
            }`,
            },
        ]);
        const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
        expect(ir.unspecified.filter((fact) => fact.kind === 'createField').map((fact) => fact.field)).toContain('createdAt');
    });

    test('declares enum values, primitive constraints and on-cases, resolving requirement errors', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'sales.dt',
                text: `context Sales {
                  primitive Quantity: Int { value > 0 }
                  enum Status { Open Closed }
                  error EmptyOrder
                  aggregate Order {
                    id: OrderId
                    command finish() { requires ready else EmptyOrder }
                    kind Retail { on finish { outcome completed: Draft -> Done } }
                    state Draft state Done
                  }
                  id OrderId: UUID
                }`,
            },
        ]);
        const ir = buildSemanticIR(analysis.sourceModel!, analysis.model!);
        const ids = ir.declarations.map((declaration) => declaration.id);
        expect(ids).toContain('Sales.Quantity.invariant.valid');
        expect(ids).toContain('Sales.Status=Open');
        expect(ids).toContain('Sales.Status=Closed');
        expect(ids).toContain('Sales.Order/Retail:on:finish');
        expect(ids).toContain('Sales.Order/Retail:on:finish->completed');
        expect(ir.aggregates[0]?.requirements[0]?.error).toBe('Sales.EmptyOrder');
    });
});
