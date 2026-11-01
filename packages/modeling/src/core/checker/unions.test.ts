import { describe, expect, test } from 'bun:test';
import { check, checkSales, codes, only } from '../../test-helpers.js';

const SALES = `context Sales "販売" {
  id UserId: UUID
  id PartnerId: UUID
  primitive PartyName: String { length(value) > 0 }
  enum Process { DELIVERY "配達" PRINTING "印刷" }

  /// 実際の行為者。
  union Actor "行為者" {
    INTERNAL_USER "社内" { userId: UserId }
    EXTERNAL_PARTY "社外" { name: PartyName  partnerId: PartnerId? }
  }

  value DeliverySpec { planned: Int? }
  value PrintingSpec { copies: Int? }
  union Details "工程別の仕様" by type: Process {
    DELIVERY { details: DeliverySpec }
    PRINTING { details: PrintingSpec }
  }

  union Coverage by form { DESCRIPTION { text: String  invariant notBlank { length(text) > 0 } } }

  id SpecId: UUID
  aggregate Spec "仕様" {
    id: SpecId
    process: Process
    owns details: Details
    actor: Actor
    coverage: Coverage?
    invariant detailsMatchProcess { details.type == process }
    invariant internalOnly { actor.kind == Actor.INTERNAL_USER }
    command change(details: Details) emits Changed
  }
  event Changed { specId: SpecId details: Details }
}
`;

describe('unions', () => {
    test('a valid union model checks clean and lands in the Typed Model', async () => {
        const a = await check({ 'sales.dt': SALES });
        expect(a.diagnostics).toEqual([]);
        const actor = a.model!.elements['Sales.Actor'];
        expect(actor).toMatchObject({ kind: 'union', discriminator: 'kind', label: '行為者', doc: '実際の行為者。' });
        expect(actor.variants!.map((v) => [v.name, v.label, v.fields.map((f) => f.name)])).toEqual([
            ['INTERNAL_USER', '社内', ['userId']],
            ['EXTERNAL_PARTY', '社外', ['name', 'partnerId']],
        ]);
        const details = a.model!.elements['Sales.Details'];
        expect(details).toMatchObject({ discriminator: 'type', tagType: 'Sales.Process' });
        // a variant without a label takes the label of its enum value
        expect(details.variants!.map((v) => v.label)).toEqual(['配達', '印刷']);
        expect(a.model!.elements['Sales.Coverage'].variants![0].invariants.map((i) => i.name)).toEqual(['notBlank']);
        expect(a.model!.elements['Sales.Spec'].fields.find((f) => f.name === 'details')!.type).toMatchObject({ target: 'union' });
    });

    test('M015 a union bound to an enum has exactly its values as variants', async () => {
        const a = await checkSales(`
  enum Process { DELIVERY PRINTING TRANSPORT }
  union Details by type: Process { DELIVERY PRINTING SHIPPING }`);
        expect(only(a, 'M015').map((d) => d.message)).toEqual([
            "Union 'Details' is bound to enum 'Process' but has no variant for 'TRANSPORT'.",
            "Variant 'SHIPPING' of union 'Details' is not a value of enum 'Process'.",
        ]);
    });

    test('M015 empty unions and fields named like the discriminator', async () => {
        const a = await checkSales(`
  union Empty {}
  union Tagged by type { A { type: String } B { kind: String } }`);
        expect(only(a, 'M015').map((d) => d.message)).toEqual([
            "Union 'Empty' must declare at least one variant.",
            "Field 'type' of variant 'Tagged.A' collides with the discriminator 'type'.",
        ]);
    });

    test('M002 duplicate variants and duplicate fields within a variant', async () => {
        const a = await checkSales('union U { A { x: Int x: Int } A }');
        expect(only(a, 'M002').map((d) => d.message)).toEqual([
            "Field 'x' is declared more than once in variant 'U.A'.",
            "Variant 'A' is declared more than once in 'U'.",
        ]);
    });

    test('M004 variants hold values, not entities or aggregates', async () => {
        const a = await checkSales(`
  id OrderId: UUID
  id LineId: UUID
  entity Line { id: LineId }
  aggregate Order { id: OrderId owns lines: Line[0..*] }
  union U { A { line: Line } B { owns line: Line } C { order: Order } D { references order: OrderId -> Order } }`);
        expect(only(a, 'M004').map((d) => d.message)).toEqual([
            "Entity 'Line' cannot be embedded as a plain field; declare it with 'owns' inside its aggregate.",
            "Union 'U' cannot own entity 'Line'.",
            "Aggregate 'Order' cannot be embedded in 'U'; use 'references order: <Id> -> Order'.",
        ]);
    });

    test('M012 cycles through unions', async () => {
        const a = await checkSales('value V { u: U } union U { A { v: V } }');
        expect(codes(a)).toContain('M012');
    });

    test('M009 variant fields are not accessible from outside, tags compare with their own union', async () => {
        const a = await checkSales(`
  enum E { A B }
  union U { A { x: Int } B }
  union W { A }
  value V {
    u: U
    w: W
    invariant field { u.x > 0 }
    invariant otherUnion { u.kind == W.A }
    invariant enumValue { u.kind == E.A }
    invariant noVariant { u.kind == U.C }
    invariant ok { u.kind != U.B and w.kind == W.A }
  }`);
        expect(only(a, 'M009').map((d) => d.message)).toEqual([
            "'x' exists only in variant 'A' of union 'U'; only 'kind' is accessible from outside.",
            "Operator '==' cannot be applied to 'tag of U' and 'tag of W'.",
            "Operator '==' cannot be applied to 'tag of U' and 'E'.",
        ]);
        expect(only(a, 'M001').map((d) => d.message)).toEqual(["Union 'U' has no variant 'C'."]);
    });

    test('unions may live in shared contexts and are used by simple name', async () => {
        const a = await check({
            'common.dt': 'shared context Common { union Coverage { DESCRIPTION { text: String } } }',
            'sales.dt': 'context Sales { id AId: UUID aggregate A { id: AId coverage: Coverage } }',
        });
        expect(a.diagnostics).toEqual([]);
        expect(a.model!.elements['Sales.A'].fields[1].type).toMatchObject({ ref: 'Common.Coverage', target: 'union' });
    });

    test('a doc comment above a variant does not leak into fields on the same line', async () => {
        const a = await checkSales(`
  union U {
    /// 説明
    A { x: Int }
  }`);
        const v = a.model!.elements['Sales.U'].variants![0];
        expect(v.doc).toBe('説明');
        expect(v.fields[0].doc).toBeUndefined();
    });
});
