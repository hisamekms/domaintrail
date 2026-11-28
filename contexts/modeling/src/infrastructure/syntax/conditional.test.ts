// `test ? then : else` (Phase 2): the loosest expression, typed by its branches, which see what the test shows.
import { describe, expect, test } from 'bun:test';
import { analyzeDomain } from '../../application/analyze.js';

const model = (members: string) => `context C {
  value V {
    note: String?
    express: Bool
    days: Int
    limit: Int
${members}
  }
}`;

async function errors(members: string): Promise<string[]> {
    const a = await analyzeDomain([{ path: 'c.dt', text: model(members) }]);
    return a.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
}

describe('conditional expressions', () => {
    test('valid uses: as a value, as a condition, with narrowing in a branch', async () => {
        expect(
            await errors(`    invariant a { days <= (express ? 2 : limit) }
    invariant b { express ? days <= 2 : days <= limit }
    invariant c { note != null ? note.length > 0 : days > 0 }
    invariant d { note == null ? true : note.length <= 80 }
    invariant e { days <= (express ? 1 : days > 10 ? 5 : limit) }`),
        ).toEqual([]);
    });

    test('a test that is not Bool and branches of two types are errors', async () => {
        expect(
            await errors(`    invariant a { (days ? 1 : 2) > 0 }
    invariant b { (express ? 1 : "x") != 1 }`),
        ).toEqual([
            "M009 The condition of '? :' must be Bool, but has type 'Int'.",
            "M009 '? :' gives 'Int' or 'String': both branches must have the same type.",
        ]);
    });
});
