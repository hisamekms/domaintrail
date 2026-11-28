// Design D (Phase 2): `changes x` (may change, value not determined), `changes x = expr` (its value, over the
// parameters and `before.x`), and `ensures { … }` (a relation over `before.x`, `after.x` and the parameters).
import { describe, expect, test } from 'bun:test';
import { analyzeDomain } from '../../application/analyze.js';

const model = (commands: string) => `context R {
  id RotaId: UUID
  value Shift { hours: Int }
  aggregate Rota {
    id: RotaId
    revision: Int
    shifts: Shift[0..*]
    initial Draft
    state Draft
    state Published { publishedAt: Timestamp }
${commands}
  }
}`;

async function errors(commands: string): Promise<string[]> {
    const a = await analyzeDomain([{ path: 'r.dt', text: model(commands) }]);
    return a.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
}

describe('changes x = expr and ensures', () => {
    test('valid contracts: named outcomes, a create, the shorthand form', async () => {
        expect(
            await errors(`    create command open(id: RotaId) {
      outcome opened: -> Draft
        changes id = id, revision = 0, shifts = []
    }
    command addShift(shift: Shift) {
      outcome added: Draft -> Draft
        changes shifts = [...before.shifts, shift], revision
        ensures { after.revision > before.revision }
    }
    command publish(at: Timestamp) {
      requires nonEmpty { shifts.length > 0 } else Empty
      outcome published: Draft -> Published
        changes publishedAt = at
        ensures { after.shifts.length == before.shifts.length }
    }
    command touch() Draft -> Draft
      changes revision = before.revision + 1
      ensures { after.revision > before.revision }
    errors Empty`).then((e) => e.filter((x) => !x.includes('Empty'))),
        ).toEqual([]);
    });

    test('errors: a value of another type, a field before has not, before in a create, a lone equality, a non-Bool ensures', async () => {
        expect(
            (
                await errors(`    create command open(id: RotaId) {
      outcome opened: -> Draft
        changes id = id, revision = before.revision, shifts = []
    }
    command addShift(shift: Shift) {
      outcome added: Draft -> Draft
        changes revision = "x", shifts
        ensures { after.revision == before.revision + 1 }
    }
    command publish(at: Timestamp) {
      outcome published: Draft -> Published
        changes publishedAt = at
        ensures { before.publishedAt == at }
    }
    command count() Draft -> Draft
      changes revision
      ensures { after.revision + 1 }`)
            ).sort(),
        ).toEqual(
            [
                "M001 Cannot resolve name 'before'.",
                "M021 'revision' is a 'Int', but '\"x\"' is a 'String'.",
                "M021 'after.revision == before.revision + 1' determines 'revision': write 'changes revision = before.revision + 1' instead.",
                "M001 'before.publishedAt': the aggregate has no field 'publishedAt' before this outcome.",
                "M021 'ensures' must be a Bool expression, but has type 'Int'.",
            ].sort(),
        );
    });
});
