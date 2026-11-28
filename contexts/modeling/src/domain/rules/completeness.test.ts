// Design D (Phase 2): an outcome lists in `changes` every non-optional field it makes exist, with or without a value.
import { describe, expect, test } from 'bun:test';
import { analyzeDomain } from '../../application/analyze.js';
import { completeChanges } from '../../infrastructure/syntax/complete-changes.js';

const model = (commands: string) => `context R {
  id RotaId: UUID
  aggregate Rota {
    id: RotaId
    title: String
    note: String?
    shifts: Int[0..*]
    initial Draft
    state Draft
    state Published { publishedAt: Timestamp by: String? }
${commands}
  }
}
`;

async function m021(commands: string): Promise<string[]> {
    const a = await analyzeDomain([{ path: 'r.dt', text: model(commands) }]);
    return a.diagnostics.filter((d) => d.code === 'M021').map((d) => `${d.message} | ${d.hint}`);
}

describe('an outcome lists the fields it makes exist (M021)', () => {
    test('a create lists every non-optional field, a transition the new ones of its target; a value is optional', async () => {
        expect(
            await m021(`    create command open(id: RotaId, title: String) -> Draft changes id = id, title, shifts = []
    command publish(at: Timestamp) Draft -> Published changes publishedAt = at
    command touch() Draft -> Draft`),
        ).toEqual([]);
    });

    test('a missing field is reported per outcome, with the parameter of its name as the value to write', async () => {
        expect(
            await m021(`    create command open(id: RotaId, title: String) -> Draft changes id = id
    command publish(at: Timestamp) {
      outcome published: Draft -> Published
    }`),
        ).toEqual([
            "Outcome 'open' makes field 'title' exist, but does not list it in 'changes'. | write 'changes title = title'",
            "Outcome 'open' makes field 'shifts' exist, but does not list it in 'changes'. | write 'changes shifts = …', or 'changes shifts' when the model leaves its value open (or make the field optional, '?', to start as null)",
            "Outcome 'published' makes field 'publishedAt' exist, but does not list it in 'changes'. | write 'changes publishedAt = …', or 'changes publishedAt' when the model leaves its value open (or make the field optional, '?', to start as null)",
        ]);
    });

    test('a field the source already has is not new: a self-transition lists nothing', async () => {
        expect(
            await m021(`    create command open(id: RotaId, title: String) -> Draft changes id = id, title = title, shifts = []
    command publish(at: Timestamp) Draft -> Published changes publishedAt = at
    command republish() Published -> Published`),
        ).toEqual([]);
    });

    test('a kind create lists the common fields and its kind’s; a common create would not see them', async () => {
        const a = await analyzeDomain([
            {
                path: 's.dt',
                text: `context S {
  id SiteId: UUID
  aggregate Site {
    id: SiteId
    name: String
    kind Store {
      code: String
      create command registerStore(id: SiteId, name: String, code: String) changes id = id, name = name
    }
  }
}
`,
            },
        ]);
        expect(a.diagnostics.filter((d) => d.code === 'M021').map((d) => d.message)).toEqual([
            "Outcome 'registerStore' makes field 'code' exist, but does not list it in 'changes'.",
        ]);
    });
});

describe('dt migrate domain completes changes', () => {
    const complete = async (text: string) => completeChanges(await analyzeDomain([{ path: 'r.dt', text }]))[0];

    test('adds what is missing: `f = f` for a parameter of that name, `f` otherwise; a clause on its own line', async () => {
        const done = await complete(
            model(`    create command open(id: RotaId, title: String) -> Draft changes id = id
    command publish(at: Timestamp) {
      outcome published: Draft -> Published
        emits Nothing
    }`).replace('  }\n}\n', '  }\n  event Nothing\n}\n'),
        );
        expect(done?.added.map((x) => [x.outcome, x.changes])).toEqual([
            ['open', 'title = title, shifts'],
            ['published', 'publishedAt'],
        ]);
        expect(done?.text).toContain('-> Draft changes id = id, title = title, shifts\n');
        expect(done?.text).toContain('      outcome published: Draft -> Published\n        changes publishedAt\n        emits Nothing\n');
        // a second run has nothing to add
        expect(await complete(done!.text)).toBeUndefined();
    });
});
