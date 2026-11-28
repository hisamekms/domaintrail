import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { analyzeDomain } from '../application/analyze.js';
import { exampleSources } from '../test-helpers.js';
import { validStatesFor } from './model.js';
import { invariantId, kindId, onCaseId, outcomeId, requirementId, stateId, variantId } from './ids.js';
import { semanticIROf, exprModelIndex, SEMANTIC_IR_VERSION } from './semantic.js';
import type { ExprModel } from './model.js';
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

function assertExpressionParity(typed: import('./model.js').DomainModel, ir: ReturnType<typeof semanticIROf>): void {
    const index = exprModelIndex(ir, typed);
    const roots: { id: string; expr: ExprModel }[] = [];
    const invariants = (owner: string, items: readonly import('./model.js').InvariantModel[]) =>
        items.forEach((item) => item.expr && roots.push({ id: invariantId(owner, item.name), expr: item.expr }));
    const requirements = (owner: string, items: readonly import('./model.js').RequirementModel[]) =>
        items.forEach((item) => item.expr && roots.push({ id: requirementId(owner, item.name), expr: item.expr }));
    const outcomes = (owner: string, items: readonly import('./model.js').OutcomeModel[]) =>
        items.forEach((item) => item.select?.kind === 'expression' && roots.push({ id: outcomeId(owner, item.name), expr: item.select.expr }));
    for (const element of typed.elements) {
        if ('invariants' in element) invariants(element.id, element.invariants);
        if (element.kind === 'union') for (const variant of element.variants) invariants(variantId(element.id, variant.name), variant.invariants);
        if (element.kind !== 'aggregate') continue;
        for (const state of element.states) invariants(state.id, state.invariants);
        for (const kind of element.kinds) {
            invariants(kindId(element.id, kind.name), kind.invariants);
            for (const c of kind.cases) {
                const caseOwner = onCaseId(kindId(element.id, kind.name), c.command);
                requirements(caseOwner, c.requires);
                outcomes(caseOwner, c.outcomes);
            }
        }
        for (const command of element.commands) {
            requirements(command.id, command.requires);
            outcomes(command.id, command.outcomes);
        }
    }
    const children = (expr: ExprModel): ExprModel[] => {
        switch (expr.k) {
            case 'member':
                return [expr.receiver];
            case 'not':
            case 'exists':
            case 'length':
            case 'matches':
                return [expr.operand];
            case 'round':
                return [expr.operand, expr.scale];
            case 'binary':
                return [expr.left, expr.right];
            case 'range':
                return [expr.operand, expr.lower, expr.upper];
            case 'count':
                return [expr.collection];
            case 'unique':
                return [expr.collection, ...expr.keys];
            case 'contains':
                return [expr.collection, expr.element];
            case 'quantifier':
                return [expr.collection, expr.body];
            default:
                return [];
        }
    };
    const walk = (root: string, expr: ExprModel, path = ''): void => {
        const found = index.get(expr);
        expect(found, `${root} at ${path || '<root>'}`).toBeDefined();
        expect(found!.syntaxKind).toBe(expr.k);
        if (expr.k === 'binary') {
            const operator = {
                eq: '==',
                ne: '!=',
                lt: '<',
                le: '<=',
                gt: '>',
                ge: '>=',
                implies: 'implies',
                and: '&&',
                or: '||',
                coalesce: '??',
                add: '+',
                sub: '-',
                mul: '*',
                div: '/',
            }[expr.op];
            expect(found!.source).toContain(operator);
        }
        if (expr.k === 'name') expect(found!.source).toBe(expr.name);
        children(expr).forEach((child, index) => walk(root, child, path ? `${path}.${index}` : `${index}`));
    };
    for (const { id, expr } of roots) walk(id, expr);
}

describe('Semantic IR', () => {
    test('projects facts collected by analysis without changing diagnostics', async () => {
        const analysis = await analyzeDomain([{ path: 'facts.dt', text: 'context Facts { primitive Count: Int { value > 0 } }' }]);
        const diagnostics = structuredClone(analysis.diagnostics);
        expect(analysis.expressionFacts.size).toBeGreaterThan(0);
        semanticIROf(analysis);
        expect(analysis.diagnostics).toEqual(diagnostics);
    });

    test('field set symbols use the element that owns each access', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'fields.dt',
                text: `context Sales {
          fields Audit { createdAt: Int }
          id OId: UUID
          aggregate O with Audit { id: OId
            state S { x: Int invariant si { createdAt > x } }
            command go(n: Int) S -> S requires r { createdAt > n } else Bad
          }
          error Bad
          value V with Audit { n: Int }
          value W { v: V invariant m { v.createdAt > 0 } }
        }`,
            },
        ]);
        const ir = semanticIROf(analysis);
        const symbols = (root: string, source: string) => {
            const walk = (node: (typeof ir.expressions)[number]): string | undefined => {
                if (node.source === source) return node.symbol?.id;
                for (const child of node.children) {
                    const found = walk(child);
                    if (found) return found;
                }
                return undefined;
            };
            return walk(ir.expressions.find((expression) => expression.root === root)!);
        };
        expect(symbols('Sales.O#S.invariant.si', 'createdAt')).toBe('Sales.O.createdAt');
        expect(symbols('Sales.O:go.requires.r', 'createdAt')).toBe('Sales.O.createdAt');
        expect(symbols('Sales.W.invariant.m', 'v.createdAt')).toBe('Sales.V.createdAt');
    });
    test('records symbols on keyword and union member expressions', async () => {
        const fixtures = [
            `context Model {
  enum BinaryOp { implies or and eq not in true false String state command }
  union TypeExpr { primitive { name: String } ref { ref: String target: String? } }
  value Use {
    context: String event: String? errors: String[0..*] op: BinaryOp type: TypeExpr
    invariant k { !(op != BinaryOp.and) || event != null }
    invariant p { type.kind == TypeExpr.primitive || errors.length > 0 }
  }
}`,
            `context Sales {
  id UserId: UUID
  id PartnerId: UUID
  enum Process { DELIVERY PRINTING }
  union Actor { INTERNAL_USER { userId: UserId } EXTERNAL_PARTY { name: String partnerId: PartnerId? } }
  value DeliverySpec { planned: Int? }
  value PrintingSpec { copies: Int? }
  union Details by type: Process { DELIVERY { details: DeliverySpec } PRINTING { details: PrintingSpec } }
  union Coverage by form { DESCRIPTION { text: String invariant notBlank { text.length > 0 } } }
  id SpecId: UUID
  aggregate Spec { id: SpecId process: Process owns details: Details actor: Actor coverage: Coverage?
    invariant detailsMatchProcess { details.type == process }
    invariant internalOnly { actor.kind == Actor.INTERNAL_USER }
  }
}`,
            `shared context Common { enum Currency { JPY USD } value Money { amount: Decimal currency: Currency } }
context Shop { id CustomerId: UUID aggregate Customer { id: CustomerId balance: Common.Money preferred: Common.Currency invariant yen { preferred == Common.Currency.USD } } }`,
            `context M {
  fields Audit { level: Int }
  value V with Audit { x: Int }
  id AId: UUID
  aggregate A with Audit {
    id: AId
    n: Int
    state Open { o: V invariant oo { o.level > 0 && o.x > 0 && level > 0 } }
    state Done
    kind P {
      w: V
      invariant pw { w.level > n && w.x > 0 && level > 0 }
      create command mkP(id: AId, n: Int, w: V, level: Int, o: V) { outcome made: -> Open changes level = level, id = id, n = n, w = w, o = o }
      command fin() { outcome f: Open -> Done requires q { w.level > 0 && o.level > 0 } else Bad }
    }
    kind Q { create command mkQ(id: AId, n: Int, level: Int, o: V) { outcome made: -> Open changes level = level, id = id, n = n, o = o } }
  }
  error Bad
}`,
        ];
        const analyses = await Promise.all(fixtures.map((text, index) => analyzeDomain([{ path: `probe-${index}.dt`, text }])));
        analyses.push(await analyzeDomain(await exampleSources()));
        for (const [index, analysis] of analyses.entries()) {
            const ir = semanticIROf(analysis);
            const missing = ir.expressions.flatMap((root) => {
                const nodes: import('../generated/Modeling.js').SemanticExpression[] = [];
                const visit = (node: import('../generated/Modeling.js').SemanticExpression) => {
                    nodes.push(node);
                    node.children.forEach(visit);
                };
                visit(root);
                return nodes.filter((node) => (node.syntaxKind === 'member' || node.syntaxKind === 'name') && !node.symbol).map((node) => node.source);
            });
            expect(missing, `fixture ${index === fixtures.length ? 'examples/shop' : index}`).toEqual([]);
            const declaredFieldIds = new Set(
                ir.declarations
                    .filter((declaration) => declaration.kind === 'field' || declaration.kind === 'variantField')
                    .map((declaration) => declaration.id),
            );
            const fieldSymbols = ir.expressions.flatMap((root) => {
                const nodes: import('../generated/Modeling.js').SemanticExpression[] = [];
                const visit = (node: import('../generated/Modeling.js').SemanticExpression) => {
                    nodes.push(node);
                    node.children.forEach(visit);
                };
                visit(root);
                return nodes.filter((node) => node.symbol?.kind === 'field').map((node) => node.symbol!.id);
            });
            expect(
                fieldSymbols.every((id) => declaredFieldIds.has(id)),
                `field symbols in fixture ${index}`,
            ).toBe(true);
        }
    });
    test('keeps Typed Model invariant, requirement and select trees in parity with IR paths', async () => {
        const modelingRoot = path.join(import.meta.dir, '..', '..', 'model');
        const modelingFiles: string[] = [];
        const walk = async (directory: string): Promise<void> => {
            for (const entry of await readdir(directory, { withFileTypes: true })) {
                if (entry.isDirectory()) await walk(path.join(directory, entry.name));
                else if (entry.name.endsWith('.dt')) modelingFiles.push(path.relative(modelingRoot, path.join(directory, entry.name)));
            }
        };
        await walk(modelingRoot);
        const modelingSources = await Promise.all(
            modelingFiles.sort().map(async (file) => ({ path: file, text: await readFile(path.join(modelingRoot, file), 'utf8') })),
        );
        for (const sources of [await exampleSources(), modelingSources]) {
            const analysis = await analyzeDomain(sources);
            expect(analysis.model).toBeDefined();
            expect(analysis.sourceModel).toBeDefined();
            assertExpressionParity(analysis.model!, semanticIROf(analysis));
        }
    });
    test('keeps Bool types on invariant, requirement and select roots', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'root-types.dt',
                text: `context Fixture {
                  id ItemId: UUID
                  aggregate Item {
                    id: ItemId
                    state Ready
                    state Done
                    initial Ready
                    invariant valid { true }
                    command finish() {
                      requires ready { true } else Error
                      outcome done: Ready -> Done select { true }
                    }
                  }
                  error Error
                }`,
            },
        ]);
        expect(analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
        const ir = semanticIROf(analysis);
        const flatten = (nodes: readonly import('../generated/Modeling.js').SemanticExpression[]): import('../generated/Modeling.js').SemanticExpression[] =>
            nodes.flatMap((node) => [node, ...flatten(node.children)]);
        const boolRoots = flatten(ir.expressions).filter((node) => node.source === 'true');
        expect(boolRoots).toHaveLength(3);
        expect(boolRoots.map(({ type }) => type)).toEqual([
            { name: 'Bool', cardinality: 'one', tag: false },
            { name: 'Bool', cardinality: 'one', tag: false },
            { name: 'Bool', cardinality: 'one', tag: false },
        ]);
    });
    test('projects per-source field and choice provenance', async () => {
        const analysis = await analyzeDomain(await exampleSources());
        const ir = semanticIROf(analysis);
        const provenance = ir.provenance;
        const confirmedCancel = provenance.filter((fact) => fact.declaration === 'Sales.Order:cancel->Cancelled' && fact.source === 'Sales.Order#Confirmed');
        expect(confirmedCancel.filter((fact) => fact.field).map(({ kind, field }) => [kind, field])).toEqual([
            ['carried', 'id'],
            ['carried', 'items'],
            ['carried', 'customer'],
            ['carried', 'note'],
            ['parameter', 'reason'],
        ]);
        expect(confirmedCancel.some((fact) => fact.field === 'confirmedAt')).toBe(false);
        // `changes id = id, items = [], customer = customer`; `note` is optional and starts as null
        expect(provenance.filter((fact) => fact.declaration === 'Sales.Order:place->Draft' && fact.field).map(({ kind, field }) => [kind, field])).toEqual([
            ['parameter', 'id'],
            ['explicitAssignment', 'items'],
            ['parameter', 'customer'],
        ]);
        const choiceAnalysis = await analyzeDomain([
            {
                path: 'choice.dt',
                text: `context ChoiceTest { id ItemId: UUID aggregate Item { id: ItemId state Start state A state B initial Start command choose() { outcome first: Start -> A outcome second: Start -> B } } }`,
            },
        ]);
        expect(semanticIROf(choiceAnalysis).provenance.some((fact) => fact.kind === 'selectedChoice')).toBe(true);
    });
    test('expression facts sink preserves checker diagnostics on all examples and a representative fixture', async () => {
        const analyses = [
            await analyzeDomain(await allExamples()),
            await analyzeDomain([
                {
                    path: 'fixture.dt',
                    text: `context Fixture { id ItemId: UUID aggregate Item { id: ItemId state Start state RetailDone kind Retail { initial Start on finish { outcome done: Start -> RetailDone } } command finish() { } } }`,
                },
            ]),
            ...(await Promise.all(
                [
                    `context BadBool { aggregate Item { invariant invalid { 1 } } }`,
                    `context BadOptional { aggregate Item { note: String? invariant invalid { note.length > 0 } } }`,
                    `context BadScope { aggregate Item { state A { hidden: String } state B invariant invalid { hidden == "x" } } }`,
                ].map((text, index) => analyzeDomain([{ path: `bad-${index}.dt`, text }])),
            )),
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
    test('records comparison kinds for value comparisons and collection membership', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'fixture.dt',
                text: `context Fixture {
                  id PersonId: UUID
                  entity Person { id: PersonId }
                  value Address { city: String }
                  union Choice { Text { value: String } Count { value: Int } }
                  id HolderId: UUID
                  aggregate Holder {
                    id: HolderId
                    owns first: Person
                    owns second: Person
                    home: Address
                    office: Address
                    choice: Choice
                    otherChoice: Choice
                    owns people: Person[0..*]
                    invariant comparisons {
                      first == second && home == office && choice == otherChoice &&
                      home.city < office.city && people.includes(first)
                    }
                  }
                }`,
            },
        ]);
        expect(analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
        const ir = semanticIROf(analysis);
        const flatten = (nodes: readonly import('../generated/Modeling.js').SemanticExpression[]): import('../generated/Modeling.js').SemanticExpression[] =>
            nodes.flatMap((node) => [node, ...flatten(node.children)]);
        const nodes = flatten(ir.expressions);
        expect(nodes.filter((node) => node.comparison).map((node) => node.comparison)).toEqual([
            'entityStructural',
            'valueObjectStructural',
            'unionStructural',
            'ordered',
            'entityStructural',
        ]);
    });
    test('projects optional presence facts on guarded right operands, on both edges', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'fixture.dt',
                text: `context Fixture {
                  aggregate Item {
                    note: String?
                    invariant conjunction { note != null && note.length > 0 }
                    invariant implication { note == null || note.length > 0 }
                    invariant disjunction { note == null || note.length > 0 }
                  }
                }`,
            },
        ]);
        const ir = semanticIROf(analysis);
        const facts = ir.presence;
        // `exists(note) && …` holds; `note == null || …` and `note == null || …` do not hold on the left
        expect(facts.filter((fact) => fact.path === 'note')).toHaveLength(3);
        expect(facts.every((fact) => fact.path === 'note')).toBe(true);
        for (const scope of ir.scopes) {
            const root = ir.expressions.find((expression) => expression.id === scope.expression);
            expect(root?.site).toEqual(scope.site);
        }
        expect(ir.scopes.every((scope) => !('presence' in scope))).toBe(true);
    });
    test('projects the shop lifecycle facts as state IDs', async () => {
        const analysis = await analyzeDomain(await exampleSources());
        const ir = semanticIROf(analysis);
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
        const ir = semanticIROf(analysis);
        const flat = (nodes: readonly import('../generated/Modeling.js').SemanticExpression[]): import('../generated/Modeling.js').SemanticExpression[] =>
            nodes.flatMap((node) => [node, ...flat(node.children)]);
        const nodes = flat(ir.expressions);
        const source = (text: string) => nodes.find((node) => node.source === text);
        expect(source('items')?.symbol).toEqual({ id: 'Sales.Order.items', kind: 'field', name: 'items' });
        expect(source('items')?.type).toEqual({ name: 'Sales.OrderItem', cardinality: 'many', tag: false });
        expect(nodes.find((node) => node.symbol?.id === 'Sales.Order:cancel(reason)')?.symbol).toEqual({
            id: 'Sales.Order:cancel(reason)',
            kind: 'parameter',
            name: 'reason',
        });
        expect(source('CancelReason.Other')?.symbol).toEqual({ id: 'Sales.CancelReason=Other', kind: 'enumValue', name: 'Other' });
        expect(source('item.quantity')?.symbol).toEqual({ id: 'Sales.OrderItem.quantity', kind: 'field', name: 'quantity' });
        expect(source('item.unitPrice.currency')?.symbol).toEqual({ id: 'Common.Money.currency', kind: 'field', name: 'currency' });
        expect(source('note')?.type).toEqual({ name: 'String', cardinality: 'optional', tag: false });
        const lambda = nodes.find((node) => node.symbol?.kind === 'lambda' && node.symbol.name === 'item');
        expect(lambda?.symbol).toEqual({ id: expect.stringContaining(':expression:'), kind: 'lambda', name: 'item' });
        expect(lambda?.type).toEqual({ name: 'Sales.OrderItem', cardinality: 'one', tag: false });
    });

    test('projects union tags, context qualifiers, and field set fields under the using element ID', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'symbols.dt',
                text: `context Shared {
                  enum Status { Open Closed }
                }
                context Shop {
                  fields Tenanted { tenant: Int }
                  value Order with Tenanted { status: Shared.Status invariant valid { status == Shared.Status.Open && tenant > 0 } }
                  id UserId: UUID
                  id AccessId: UUID
                  enum Process { DELIVERY PRINTING }
                  union Actor { INTERNAL_USER { userId: UserId } EXTERNAL_PARTY { n: Int } }
                  value DeliverySpec { planned: Int }
                  value PrintingSpec { copies: Int }
                  union Details by type: Process { DELIVERY { details: DeliverySpec } PRINTING { details: PrintingSpec } }
                  aggregate Access { id: AccessId actor: Actor details: Details invariant internal { actor.kind == Actor.INTERNAL_USER && details.type == Process.DELIVERY } }
                }`,
            },
        ]);
        const ir = semanticIROf(analysis);
        const flatten = (nodes: readonly import('../generated/Modeling.js').SemanticExpression[]): import('../generated/Modeling.js').SemanticExpression[] =>
            nodes.flatMap((node) => [node, ...flatten(node.children)]);
        const nodes = flatten(ir.expressions);
        expect(nodes.find((node) => node.source === 'Actor.INTERNAL_USER')?.symbol).toEqual({
            id: 'Shop.Actor|INTERNAL_USER',
            kind: 'unionTag',
            name: 'INTERNAL_USER',
        });
        expect(nodes.find((node) => node.source === 'actor.kind')?.type).toEqual({ name: 'Shop.Actor', cardinality: 'one', tag: true });
        expect(nodes.find((node) => node.source === 'Actor.INTERNAL_USER')?.type).toEqual({ name: 'Shop.Actor', cardinality: 'one', tag: true });
        expect(nodes.find((node) => node.source === 'details.type')?.type).toEqual({ name: 'Shop.Process', cardinality: 'one', tag: false });
        expect(nodes.find((node) => node.source === 'Shared')?.symbol).toEqual({ id: 'Shared', kind: 'context', name: 'Shared' });
        expect(nodes.find((node) => node.source === 'tenant')?.symbol).toEqual({ id: 'Shop.Order.tenant', kind: 'field', name: 'tenant' });
    });

    test('projects declared, primitive, enum, optional, list and non-empty types', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'types.dt',
                text: `context Types {
                  primitive Quantity: Int
                  enum Status { Open Closed }
                  entity Item { quantity: Quantity plain: Int invariant positive { quantity > 0 && plain > 0 } }
                  aggregate Cart {
                    item: Item?
                    items: Item[0..*]
                    requiredItems: Item[1..*]
                    status: Status
                    invariant values { item != null && items.length >= 0 && requiredItems.length >= 0 && status == Status.Open }
                  }
                }`,
            },
        ]);
        const ir = semanticIROf(analysis);
        const flatten = (nodes: readonly import('../generated/Modeling.js').SemanticExpression[]): import('../generated/Modeling.js').SemanticExpression[] =>
            nodes.flatMap((node) => [node, ...flatten(node.children)]);
        const nodes = flatten(ir.expressions);
        const source = (text: string) => nodes.find((node) => node.source === text);
        expect(source('quantity')?.type).toEqual({ name: 'Types.Quantity', cardinality: 'one', tag: false });
        expect(source('plain')?.type).toEqual({ name: 'Int', cardinality: 'one', tag: false });
        expect(source('item')?.type).toEqual({ name: 'Types.Item', cardinality: 'optional', tag: false });
        expect(source('items')?.type).toEqual({ name: 'Types.Item', cardinality: 'many', tag: false });
        expect(source('requiredItems')?.type).toEqual({ name: 'Types.Item', cardinality: 'nonEmpty', tag: false });
        expect(source('Status')?.type).toBeUndefined();
        expect(source('Status.Open')?.symbol).toEqual({ id: 'Types.Status=Open', kind: 'enumValue', name: 'Open' });
        expect(source('Status.Open')?.type).toEqual({ name: 'Types.Status', cardinality: 'one', tag: false });
    });

    test('projects a focused value object member and guarded optional field', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'fixture.dt',
                text: `context Fixture {
              value Address { city: String }
              entity Customer {
                address: Address?
                invariant hasCity { address != null && address.city != "" }
              }
            }`,
            },
        ]);
        const ir = semanticIROf(analysis);
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
        const ir = semanticIROf(analysis);
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
            const ir = semanticIROf(analysis);
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
        const ir = semanticIROf(analysis);
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
                'Billing.Invoice:issue': [{ from: [], to: 'Billing.Invoice#Open', changes: ['id', 'order', 'billedAmount'] }],
                'Billing.Invoice:pay': [{ from: ['Billing.Invoice#Open'], to: 'Billing.Invoice#Paid', changes: ['paidAt'] }],
            },
            'Sales.Customer': {
                'Sales.Customer:register': [{ from: [], to: undefined, changes: ['id', 'name', 'email'] }],
                'Sales.Customer:rename': [{ from: [], to: undefined, changes: ['name'] }],
                'Sales.Customer:changeEmail': [{ from: [], to: undefined, changes: ['email'] }],
            },
            'Sales.Order': {
                'Sales.Order:place': [{ from: [], to: 'Sales.Order#Draft', changes: ['id', 'items', 'customer'] }],
                'Sales.Order:addItem': [{ from: ['Sales.Order#Draft'], to: 'Sales.Order#Draft', changes: ['items'] }],
                'Sales.Order:confirm': [{ from: ['Sales.Order#Draft'], to: 'Sales.Order#Confirmed', changes: ['confirmedAt'] }],
                'Sales.Order:cancel': [
                    { from: ['Sales.Order#Draft'], to: 'Sales.Order#Cancelled', changes: ['reason'] },
                    { from: ['Sales.Order#Confirmed'], to: 'Sales.Order#Cancelled', changes: ['reason'] },
                ],
                'Sales.Order:changeNote': [
                    { from: ['Sales.Order#Draft'], to: 'Sales.Order#Draft', changes: ['note'] },
                    { from: ['Sales.Order#Confirmed'], to: 'Sales.Order#Confirmed', changes: ['note'] },
                ],
            },
        });
        // design D: what each outcome lists with a value is given; only `changes x` without one is left open
        expect(ir.unspecified.map(({ kind, declaration, field }) => [kind, declaration, field])).toEqual([
            ['changesWithoutExpression', 'Sales.Customer:rename->*', 'name'],
            ['changesWithoutExpression', 'Sales.Customer:changeEmail->*', 'email'],
            ['changesWithoutExpression', 'Sales.Order:addItem->Draft', 'items'],
            ['changesWithoutExpression', 'Sales.Order:changeNote->Draft', 'note'],
            ['changesWithoutExpression', 'Sales.Order:changeNote->Confirmed', 'note'],
        ]);
        const outcomeIds = new Set(ir.aggregates.flatMap((aggregate) => aggregate.outcomes.map((item) => item.id)));
        expect(ir.unspecified.filter((fact) => fact.declaration.includes('->')).every((fact) => outcomeIds.has(fact.declaration))).toBe(true);
        expect(
            ir.provenance
                .filter((fact) => fact.declaration === 'Sales.Order:cancel->Cancelled' && fact.field === 'reason')
                .map(({ kind, source }) => [kind, source]),
        ).toEqual([
            ['parameter', 'Sales.Order#Draft'],
            ['parameter', 'Sales.Order#Confirmed'],
        ]);
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
        const ir = semanticIROf(analysis);
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
                outcome completed: Draft -> Done changes note, marker
              }
            }
          }
        }`,
            },
        ]);
        expect(analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
        const ir = semanticIROf(analysis);
        const aggregate = ir.aggregates[0]!;
        expect(aggregate.outcomes.map(({ id }) => id)).toEqual(['Sales.Order/Retail:on:finish->completed']);
        expect(aggregate.requirements.map(({ id }) => id)).toEqual(['Sales.Order/Retail:on:finish.requires.ready']);
        expect(ir.unspecified.map(({ kind, declaration, field, source }) => [kind, declaration, field, source])).toEqual([
            ['expressionFreeRequirement', 'Sales.Order/Retail:on:finish.requires.ready', undefined, undefined],
            ['changesWithoutExpression', 'Sales.Order/Retail:on:finish->completed', 'note', 'Sales.Order#Draft'],
            ['changesWithoutExpression', 'Sales.Order/Retail:on:finish->completed', 'marker', 'Sales.Order#Draft'],
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
        const ir = semanticIROf(analysis);
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
                      A | B -> Done changes added
                  }
                }`,
            },
        ]);
        const ir = semanticIROf(analysis);
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
        const ir = semanticIROf(analysis);
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
        const ir = semanticIROf(analysis);
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
        const ir = semanticIROf(analysis);
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
        expect(semanticIROf(legacy).aggregates[0]!.choices).toEqual([
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
        const choices = semanticIROf(analysis).aggregates[0]!.choices;
        expect(choices.map((choice) => choice.kind)).toEqual(['Retail', 'Wholesale']);
    });

    test('preserves externalReason on requirements', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'sales.dt',
                text: `context Sales { id ItemId: UUID aggregate Item { id: ItemId command review() { requires approved @externalCheck("approval is external") else Error } } error Error }`,
            },
        ]);
        const ir = semanticIROf(analysis);
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
        const ir = semanticIROf(analysis);
        const obligations = ir.obligations;
        expect(obligations.map(({ declaration, reason }) => ({ declaration, reason }))).toEqual([
            { declaration: 'Sales.Code.invariant.valid', reason: 'check code' },
            { declaration: 'Sales.Value|Text.invariant.accepted', reason: 'review text' },
            { declaration: 'Sales.Item#Ready.invariant.permitted', reason: 'review state' },
            { declaration: 'Sales.Item/Retail.invariant.permitted', reason: 'review kind' },
        ]);
        expect(new Set(obligations.map((item) => item.declaration)).size).toBe(obligations.length);
    });

    test('a create field from a field set, listed without a value, is unspecified', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'sales.dt',
                text: `context Sales {
              id ItemId: UUID
              fields Audited { createdAt: Timestamp }
              aggregate Item with Audited { id: ItemId state Ready create command create(id: ItemId) -> Ready changes createdAt, id = id }
            }`,
            },
        ]);
        const ir = semanticIROf(analysis);
        expect(ir.unspecified.filter((fact) => fact.kind === 'changesWithoutExpression').map((fact) => fact.field)).toEqual(['createdAt']);
        expect(ir.provenance.filter((fact) => fact.field === 'id').map((fact) => fact.kind)).toEqual(['parameter']);
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
        const ir = semanticIROf(analysis);
        const ids = ir.declarations.map((declaration) => declaration.id);
        expect(ids).toContain('Sales.Quantity.invariant.valid');
        expect(ids).toContain('Sales.Status=Open');
        expect(ids).toContain('Sales.Status=Closed');
        expect(ids).toContain('Sales.Order/Retail:on:finish');
        expect(ids).toContain('Sales.Order/Retail:on:finish->completed');
        expect(ir.aggregates[0]?.requirements[0]?.error).toBe('Sales.EmptyOrder');
    });

    test('projects primitive invariant roots and their implicit value binding', async () => {
        const analysis = await analyzeDomain([{ path: 'sales.dt', text: `context Sales { primitive Quantity: Int { value > 0 } }` }]);
        const ir = semanticIROf(analysis);
        const root = ir.expressions.find((expression) => expression.source === 'value > 0')!;
        const value = root.children[0]!;
        expect(value.symbol).toEqual({ id: 'Sales.Quantity', kind: 'value', name: 'value' });
        expect(ir.scopes).toContainEqual(
            expect.objectContaining({
                expression: root.id,
                lambdas: [{ id: root.id, kind: 'lambda', name: 'value' }],
            }),
        );
    });

    test('records a quantified optional object path on an implication right operand', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'sales.dt',
                text: `context Sales {
                  id ItemId: UUID
                  value Details { note: String? }
                  aggregate Item {
                    id: ItemId
                    owns items: Details[0..*]
                    invariant notesPresent { items.every(x => x.note == null || x.note.length > 0) }
                  }
                }`,
            },
        ]);
        const ir = semanticIROf(analysis);
        expect(ir.presence).toContainEqual(expect.objectContaining({ path: 'x.note' }));
    });

    test('projects every visible name in a state invariant scope', async () => {
        const analysis = await analyzeDomain(await exampleSources());
        expect(analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
        const ir = semanticIROf(analysis);
        const scope = ir.scopes.find((fact) => fact.owner === 'Sales.Order#Confirmed' && fact.fields.some((field) => field.name === 'items'))!;
        expect(scope).toEqual({
            expression: scope.expression,
            site: scope.site,
            owner: 'Sales.Order#Confirmed',
            fields: [
                { id: 'Sales.Order.id', kind: 'field', name: 'id' },
                { id: 'Sales.Order.items', kind: 'field', name: 'items' },
                { id: 'Sales.Order.customer', kind: 'field', name: 'customer' },
                { id: 'Sales.Order.note', kind: 'field', name: 'note' },
                { id: 'Sales.Order#Confirmed.confirmedAt', kind: 'field', name: 'confirmedAt' },
            ],
            parameters: [],
            lambdas: [],
            sourceStates: ['Sales.Order#Confirmed'],
        });
    });

    test('projects every visible name and lambda binding of a command requirement', async () => {
        const analysis = await analyzeDomain(await exampleSources());
        expect(analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
        const ir = semanticIROf(analysis);
        const flatten = (nodes: readonly import('../generated/Modeling.js').SemanticExpression[]): import('../generated/Modeling.js').SemanticExpression[] =>
            nodes.flatMap((node) => [node, ...flatten(node.children)]);
        const nodes = flatten(ir.expressions);
        const reference = nodes.find((expression) => expression.symbol?.kind === 'lambda' && expression.symbol.name === 'i')!;
        // The binding is the quantifier expression that binds `i`: the root expression containing the reference.
        const lambda = ir.expressions.find((root) => flatten([root]).includes(reference))!;
        const scope = ir.scopes.find((fact) => fact.command === 'Sales.Order:addItem')!;
        expect(scope).toEqual({
            expression: scope.expression,
            site: scope.site,
            owner: 'Sales.Order',
            command: 'Sales.Order:addItem',
            fields: [
                { id: 'Sales.Order.id', kind: 'field', name: 'id' },
                { id: 'Sales.Order.items', kind: 'field', name: 'items' },
                { id: 'Sales.Order.customer', kind: 'field', name: 'customer' },
                { id: 'Sales.Order.note', kind: 'field', name: 'note' },
            ],
            parameters: [{ id: 'Sales.Order:addItem(item)', kind: 'parameter', name: 'item' }],
            lambdas: [{ id: lambda.id, kind: 'lambda', name: 'i' }],
            sourceStates: ['Sales.Order#Draft'],
        });
    });

    test('projects every visible name in an on-case requirement scope', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'scope.dt',
                text: `context Sales { id OrderId: UUID error Unavailable aggregate Order { id: OrderId state Ready state Done kind Retail { initial Ready dockCount: Int on ship { requires available { dockCount > 0 } else Unavailable outcome shipped: Ready -> Done } } command ship() } }`,
            },
        ]);
        expect(analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
        const ir = semanticIROf(analysis);
        const scope = ir.scopes.find((fact) => fact.onCase === 'Sales.Order/Retail:on:ship')!;
        expect(scope).toEqual({
            expression: scope.expression,
            site: scope.site,
            owner: 'Sales.Order/Retail',
            command: 'Sales.Order:ship',
            onCase: 'Sales.Order/Retail:on:ship',
            kind: 'Sales.Order/Retail',
            fields: [
                { id: 'Sales.Order.id', kind: 'field', name: 'id' },
                { id: 'Sales.Order/Retail.dockCount', kind: 'field', name: 'dockCount' },
            ],
            parameters: [],
            lambdas: [],
            sourceStates: ['Sales.Order#Ready'],
        });
    });

    test('projects the exact scope of an outcome select', async () => {
        const analysis = await analyzeDomain([
            {
                path: 'scope.dt',
                text: `context Sales { id OrderId: UUID aggregate Order { id: OrderId state Ready state Done initial Ready command ship() { outcome shipped: Ready -> Done select { true } } } }`,
            },
        ]);
        expect(analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
        const ir = semanticIROf(analysis);
        const scope = ir.scopes.find((fact) => fact.targetOutcome === 'Sales.Order:ship->shipped')!;
        expect(scope).toEqual({
            expression: scope.expression,
            site: scope.site,
            owner: 'Sales.Order',
            command: 'Sales.Order:ship',
            targetOutcome: 'Sales.Order:ship->shipped',
            fields: [{ id: 'Sales.Order.id', kind: 'field', name: 'id' }],
            parameters: [],
            lambdas: [],
            sourceStates: ['Sales.Order#Ready'],
        });
    });
});
