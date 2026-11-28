// `==` in generated checks follows the Semantic IR's comparison fact (ADR 0016).
import { expect, test } from 'bun:test';
import { generateFromAnalysis, check } from '../test-helpers.js';

test('value objects, unions, entities and guarded optionals compare by their equality functions', async () => {
    const a = await check({
        'eq.dt': `context Eq {
  id PartId: UUID
  id AggId: UUID
  value Tag { name: String }
  union Form { CIRCLE { r: Int } SQUARE { s: Int } }
  entity Part { id: PartId  n: Int }
  value Pair {
    a: Tag  b: Tag
    s: Form  t: Form
    o: Tag?
    invariant sameTag { a == b }
    invariant sameForm { s == t }
    invariant optTag { !(exists(o)) || o == a }
  }
  aggregate Agg { id: AggId  owns p: Part  owns q: Part  invariant samePart { p == q } }
}`,
    });
    expect(a.diagnostics).toEqual([]);
    const out = generateFromAnalysis(a).find((f) => f.path === 'Eq.ts')!.content;
    expect(out).toContain(`if (!(equalTag(pair.a, pair.b))) violated.push('sameTag');`);
    expect(out).toContain(`if (!(equalForm(pair.s, pair.t))) violated.push('sameForm');`);
    expect(out).toContain(`if (pair.o !== undefined && !(equalTag(pair.o, pair.a))) violated.push('optTag');`);
    expect(out).toContain(`if (!(equalPart(agg.p, agg.q))) violated.push('samePart');`);
});
