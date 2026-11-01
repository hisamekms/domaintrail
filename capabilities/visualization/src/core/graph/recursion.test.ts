// Recursive value types (M012 lets values and unions be recursive when they have a finite value): every view of the
// model ends, with one edge per field however deep the values nest.
import { describe, expect, test } from 'bun:test';
import { aggregateDependencies, owningAggregates } from '@domaintrail/modeling';
import { buildStateGraph, buildStructureGraph } from './build.js';
import { buildContextMapGraph } from './context-map.js';
import { check } from '../../test-helpers.js';

const MODEL = `context M {
  union Expr {
    lit { value: Int }
    not { operand: Expr }
    rule { rule: Rule }
  }
  value Rule { expr: Expr  children: Rule[0..*] }
  id DocId: UUID
  aggregate Doc {
    id: DocId
    owns rule: Rule
    state Open { draft: Expr? }
    create command start(id: DocId, rule: Rule) -> Open
  }
}
context N {
  value Wrap { rule: M.Rule  next: Wrap? }
}
`;

describe('recursive value types', () => {
    test('the structure, state and context map views and the dependencies end', async () => {
        const a = await check({ 'm.dt': MODEL });
        expect(a.diagnostics).toEqual([]);
        const model = a.model!;
        for (const level of ['overview', 'aggregates', undefined] as const)
            expect(buildStructureGraph(model, level ? { level } : {}).nodes.length).toBeGreaterThan(0);
        expect(
            buildStructureGraph(model)
                .edges.map((e) => e.id)
                .sort(),
        ).toEqual(
            ['M.Doc.draft', 'M.Doc.rule', 'M.Expr.not.operand', 'M.Expr.rule.rule', 'M.Rule.children', 'M.Rule.expr', 'N.Wrap.next', 'N.Wrap.rule'].sort(),
        );
        expect(buildStateGraph(model.elements['M.Doc'], model).nodes.length).toBeGreaterThan(0);
        expect(
            buildContextMapGraph(model)
                .nodes.map((n) => n.id)
                .sort(),
        ).toEqual(['map:M', 'map:N']);
        expect(aggregateDependencies(model)).toEqual([]);
        const elements = Object.values(model.elements);
        expect([...owningAggregates(elements, new Map(elements.map((e) => [e.id, e]))).keys()].sort()).toEqual(['M.Expr', 'M.Rule']);
    });
});
