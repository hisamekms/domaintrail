import { describe, expect, test } from 'bun:test';
import { AstUtils, type AstNode } from 'langium';
import { analyzeDomain } from '../../application/analyze.js';
import { exampleSources, siteKey, check } from '../../test-helpers.js';
import * as model from '../../domain/types.js';
import type { AggregateMember, DataMember, FieldDecl, ParamDecl, SourceModel } from '../../domain/source-model.js';
import { isField, isOwnsField, isParameter, isReferenceField, type Parameter } from './generated/ast.js';
import { siteOf } from './diagnostic-sink.js';
import type { FieldLike } from './model-index.js';
import * as syntax from './types.js';

/** The fields and parameters of the model as written, by the site of each. */
function membersBySite(m: SourceModel): Map<string, FieldDecl | ParamDecl> {
    const out = new Map<string, FieldDecl | ParamDecl>();
    const members = m.elements.flatMap((el): (DataMember | ParamDecl)[] => {
        if (el.kind === 'union') return el.variants.flatMap((v) => v.members);
        if (!('members' in el)) return [];
        return (el.members as AggregateMember[]).flatMap((x): (DataMember | ParamDecl)[] =>
            x.kind === 'state' ? x.members : x.kind === 'command' ? x.params : [x],
        );
    });
    for (const x of members) if (x.kind !== 'invariant') out.set(siteKey(x.at), x);
    return out;
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
    test('agree with those of the syntax for every field and parameter', async () => {
        for (const a of [await analyzeDomain(await exampleSources()), await check(SOURCES)]) {
            const bySite = membersBySite(a.sourceModel!);
            const nodes = a.documents
                .flatMap((d) => [...AstUtils.streamAllContents(d.parseResult.value)])
                .filter((n: AstNode): n is FieldLike | Parameter => isField(n) || isOwnsField(n) || isReferenceField(n) || isParameter(n));
            expect(nodes.length).toBe(bySite.size);
            for (const n of nodes) {
                const decl = bySite.get(siteKey(siteOf(n, a.resolveFile)))!;
                expect([model.showType(model.memberType(decl)), model.multiplicityText(decl.multiplicity), model.cardinality(decl.multiplicity)]).toEqual([
                    syntax.showType(syntax.memberType(n)),
                    syntax.multiplicityText(n.multiplicity),
                    syntax.cardinality(n.multiplicity),
                ]);
            }
        }
    });

    test('compare declarations by identity', async () => {
        const m = (await check(SOURCES)).sourceModel!;
        const bySite = [...membersBySite(m).values()];
        const named = (name: string): FieldDecl | ParamDecl => bySite.find((f) => f.name === name)!;
        // a verified type is its base type, past other verified types
        expect(model.sameType(model.baseType(named('v').type), model.baseType(named('ps').type))).toBe(true);
        expect(model.sameType(model.memberType(named('ps')), model.memberType(named('ts')))).toBe(true);
        expect(model.sameType(model.memberType(named('ps')), model.memberType(named('qs')))).toBe(false);
        expect(model.showType(model.memberType(named('loose')))).toBe('<error>');
        expect(model.basePrimitive(model.memberType(named('rs')))).toBe('Int');
        expect([model.isDomainPrimitive(model.memberType(named('rs'))), model.isNumeric(model.memberType(named('n')))]).toEqual([true, false]);
    });
});
