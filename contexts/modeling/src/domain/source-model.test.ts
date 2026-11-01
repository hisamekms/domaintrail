import { describe, expect, test } from 'bun:test';
import { check } from '../test-helpers.js';
import {
    ANONYMOUS_CONSTRAINT,
    commandsOf,
    commonFields,
    discriminatorOf,
    duplicates,
    elementsOf,
    fieldSetsOf,
    fieldsOf,
    identityField,
    includedFields,
    invariantsOf,
    isShared,
    lookup,
    lookupVisible,
    primitiveInvariants,
    statesOf,
    typeRefsIn,
    variantFields,
    type AggregateDecl,
    type ElementDecl,
    type SourceModel,
} from './source-model.js';

const SOURCES = {
    'common.dt': `shared context Common {
  primitive Name: String
  enum Unit { KG G }
}
`,
    'sales.dt': `context Sales {
  id OrderId: UUID
  primitive Qty: Int { value > 0 }
  primitive Code: String { invariant short { length(value) < 4 } invariant documented "説明" }
  fields Audit { by: Name  at: Timestamp }
  fields More { note: String }
  enum Unit { BOX }
  union Pack { Box { size: Int  invariant positive { size > 0 } } Bag { weight: Int } }
  union Tagged by tag { One }
  aggregate Order with Audit, More, Audit {
    id: OrderId
    qty: Qty?
    invariant ok { qty == qty }
    create command place(id: OrderId, unit: Unit) -> Open
    state Open { since: Timestamp  invariant fresh { exists(qty) } }
    command close(qty: Qty[1..*]) Open -> Open
  }
  value Name { first: String }
}
`,
};

const model = async (): Promise<SourceModel> => (await check(SOURCES)).sourceModel!;
const named = (m: SourceModel, id: string): ElementDecl => lookup(m, id)!;

describe('the lookups of the model as written', () => {
    test('find elements by qualified name, and by simple name as seen from a context', async () => {
        const m = await model();
        expect(named(m, 'Sales.Qty').kind).toBe('primitive');
        expect(lookup(m, 'Sales.Nope')).toBeUndefined();
        // a context's own elements first, then the shared contexts'
        expect(lookupVisible(m, 'Sales', 'Unit')?.id).toBe('Sales.Unit');
        expect(lookupVisible(m, 'Sales', 'Name')?.context).toBe('Sales');
        expect(lookupVisible(m, 'Billing', 'Name')?.id).toBe('Common.Name');
        expect(elementsOf(m, 'Common').map((e) => e.name)).toEqual(['Name', 'Unit']);
        expect([isShared(m, 'Common'), isShared(m, 'Sales')]).toEqual([true, false]);
        expect(duplicates(m)).toEqual([]);
    });

    test('list duplicates by qualified name, the first of each name first', async () => {
        const m = (await check({ 'a.dt': 'context A { id X: UUID  enum X { Y }  id Z: UUID }' })).sourceModel!;
        expect(duplicates(m).map((d) => d.map((e) => e.kind))).toEqual([['id', 'enum']]);
        expect(lookup(m, 'A.X')?.kind).toBe('id');
    });
});

describe('the members of the model as written', () => {
    test('of an aggregate: fields, invariants, states, commands, the identity and the field sets', async () => {
        const m = await model();
        const order = named(m, 'Sales.Order') as AggregateDecl;
        expect(commonFields(order).map((f) => f.name)).toEqual(['id', 'qty']);
        expect(invariantsOf(order.members).map((i) => i.name)).toEqual(['ok']);
        expect(statesOf(order).map((s) => [s.id, fieldsOf(s.members).map((f) => f.name), invariantsOf(s.members).map((i) => i.name)])).toEqual([
            ['Sales.Order#Open', ['since'], ['fresh']],
        ]);
        expect(commandsOf(order).map((c) => [c.id, c.factory, c.params.map((p) => p.name)])).toEqual([
            ['Sales.Order:place', true, ['id', 'unit']],
            ['Sales.Order:close', false, ['qty']],
        ]);
        expect(identityField(order)?.name).toBe('id');
        // each field set once, in order; its fields before the element's own
        expect(order.fieldSets.map((r) => r.text)).toEqual(['Audit', 'More', 'Audit']);
        expect(fieldSetsOf(order).map((s) => s.name)).toEqual(['Audit', 'More']);
        expect(includedFields(order).map((x) => `${x.fieldSet.name}.${x.field.name}`)).toEqual(['Audit.by', 'Audit.at', 'More.note']);
        expect(includedFields(named(m, 'Sales.Audit') as never)).toEqual([]);
    });

    test('of a union and a domain primitive', async () => {
        const m = await model();
        const pack = named(m, 'Sales.Pack');
        const tagged = named(m, 'Sales.Tagged');
        expect(pack.kind === 'union' && [discriminatorOf(pack), variantFields(pack).map((f) => f.name)]).toEqual(['kind', ['size', 'weight']]);
        expect(tagged.kind === 'union' && discriminatorOf(tagged)).toBe('tag');
        const qty = named(m, 'Sales.Qty');
        const code = named(m, 'Sales.Code');
        if (qty.kind !== 'primitive' || code.kind !== 'primitive') throw new Error('not primitives');
        const [constraint] = primitiveInvariants(qty);
        expect(constraint.name).toBe(ANONYMOUS_CONSTRAINT);
        expect(constraint.decl).toBe(qty.constraint!);
        expect(constraint.at).toBe(qty.constraint!.at);
        expect(primitiveInvariants(code).map((i) => [i.name, i.label, i.expr?.k, i.decl === code.invariants.find((x) => x.name === i.name)])).toEqual([
            ['short', undefined, 'binary', true],
            ['documented', '説明', undefined, true],
        ]);
    });

    test('the type references inside an element, in the order of the source', async () => {
        const m = await model();
        expect(typeRefsIn(named(m, 'Sales.Order')).map((t) => t.primitive ?? t.decl?.text)).toEqual(['OrderId', 'Qty', 'OrderId', 'Unit', 'Timestamp', 'Qty']);
        expect(typeRefsIn(named(m, 'Sales.Pack')).map((t) => t.primitive ?? t.decl?.text)).toEqual(['Int', 'Int']);
        expect(typeRefsIn(named(m, 'Sales.Qty'))).toEqual([]);
    });
});
