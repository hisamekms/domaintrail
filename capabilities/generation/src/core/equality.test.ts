// `==` in generated checks follows the Semantic IR's comparison fact (ADR 0016); owned entities compare by all their
// fields, as value objects do (ADR 0042).
import { expect, test } from 'bun:test';
import { generateFromAnalysis, check } from '../test-helpers.js';

test('value objects, unions, owned entities and guarded optionals compare by their equality functions', async () => {
    const a = await check({
        'eq.dt': `context Eq {
  id PartId: UUID
  id AggId: UUID
  value Tag { name: String }
  union Form { CIRCLE { r: Int } SQUARE { s: Int } }
  id PieceId: UUID
  entity Piece { id: PieceId  tag: Tag }
  entity Part { id: PartId  n: Int  owns pieces: Piece[0..*] }
  value Pair {
    a: Tag  b: Tag
    s: Form  t: Form
    o: Tag?
    invariant sameTag { a == b }
    invariant sameForm { s == t }
    invariant optTag { o == null || o == a }
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
    // an owned entity by all its fields, nested values and entities by their own equality
    expect(out).toContain('return a.id === b.id && a.n === b.n && sameList(a.pieces, b.pieces, equalPiece);');
    expect(out).toContain('return a.id === b.id && equalTag(a.tag, b.tag);');
});
