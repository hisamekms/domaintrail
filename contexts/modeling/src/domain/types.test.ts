import { describe, expect, test } from 'bun:test';
import { check } from '../test-helpers.js';
import * as model from './types.js';
import type { AggregateMember, DataMember, FieldDecl, ParamDecl, SourceModel } from './source-model.js';

/** The fields and parameters of the model as written. */
function membersOf(m: SourceModel): (FieldDecl | ParamDecl)[] {
    return m.elements
        .flatMap((el): (DataMember | ParamDecl)[] => {
            if (el.kind === 'union') return el.variants.flatMap((v) => v.members);
            if (!('members' in el)) return [];
            return (el.members as AggregateMember[]).flatMap((x): (DataMember | ParamDecl)[] =>
                x.kind === 'state' ? x.members : x.kind === 'command' ? x.params : [x],
            );
        })
        .filter((x): x is FieldDecl | ParamDecl => x.kind !== 'invariant');
}

const SOURCES = {
    'a.dt': `context A {
  id XId: UUID
  primitive P: Int
  verified V of P for E
  verified W of V
  enum E { One }
  value O { n: Int? }
  entity N { id: NId  ps: P[1..*]  qs: P[0..1]  rs: P[1..1]  ts: P[2..5] }
  id NId: UUID
  union U { M { n: Int } }
  aggregate X { id: XId  owns ns: N[0..*]  references other: XId -> X  u: U?  o: O
    create command make(id: XId, v: W, e: E[0..*], loose: Undefined) }
}
`,
};

describe('the static types of the model as written', () => {
    test('compare declarations by identity', async () => {
        const m = (await check(SOURCES)).sourceModel!;
        const named = (name: string): FieldDecl | ParamDecl => membersOf(m).find((f) => f.name === name)!;
        // a verified type is its base type, past other verified types
        expect(model.sameType(model.baseType(named('v').type), model.baseType(named('ps').type))).toBe(true);
        expect(model.sameType(model.memberType(named('ps')), model.memberType(named('ts')))).toBe(true);
        expect(model.sameType(model.memberType(named('ps')), model.memberType(named('qs')))).toBe(false);
        expect(model.showType(model.memberType(named('loose')))).toBe('<error>');
        expect(model.basePrimitive(model.memberType(named('rs')))).toBe('Int');
        expect([model.isDomainPrimitive(model.memberType(named('rs'))), model.isNumeric(model.memberType(named('n')))]).toEqual([true, false]);
    });
});
