// `match` over the aggregate (state match A): `match (before)` / `match (after)` in `changes x = …` and `ensures`,
// `match (this)` in `requires`, choice rules and the aggregate's own invariants; cases name states or kinds (ADR 0037),
// exhaustively over those the aggregate can be in there. The generated TypeScript: generation's state-match.test.ts.
import { describe, expect, test } from 'bun:test';
import { analyzeDomain } from '../../application/analyze.js';

/** An order with states, `members` added to the aggregate. */
const order = (members: string) => `context S {
  id OrderId: UUID
  aggregate Order {
    id: OrderId
    note: String?
    total: Int
    initial Draft
    state Draft
    state Confirmed { confirmedAt: Timestamp }
    state Cancelled { reason: String }
    create command open(id: OrderId) {
      outcome opened: -> Draft
        changes id = id, total = 0
    }
    command confirm(at: Timestamp) {
      outcome confirmed: Draft -> Confirmed
        changes confirmedAt = at
    }
${members}
  }
  error TooLate
}`;

/** A site with kinds and states, `members` added to the aggregate. */
const site = (members: string) => `context S {
  id SiteId: UUID
  aggregate Site {
    id: SiteId
    score: Int
    state Active
    state Paused { reason: String }
    command pause(why: String)
${members}
    kind Store {
      hours: Int
      create command openStore(id: SiteId, hours: Int) {
        outcome opened: -> Active
          changes id = id, hours = hours, score = 0
      }
      on pause {
        outcome paused: Active -> Paused
          changes reason = why
      }
    }
    kind Center {
      docks: Int
      create command openCenter(id: SiteId, docks: Int) {
        outcome opened: -> Active
          changes id = id, docks = docks, score = 0
      }
      on pause {
        outcome paused: Active -> Paused
          changes reason = why
      }
    }
  }
  error TooLate
}`;

async function errors(text: string): Promise<string[]> {
    const a = await analyzeDomain([{ path: 's.dt', text }]);
    return a.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}${d.hint ? ` | ${d.hint}` : ''}`);
}

describe('match over the states of the aggregate', () => {
    test('match (this) in requires and invariants, match (before) / match (after) in changes and ensures, with bindings', async () => {
        expect(
            await errors(
                order(`    invariant reasonGiven { match (this) { Draft => true, Confirmed => total > 0, Cancelled { reason, note } => reason != "" || note != null } }
    command cancel(why: String, at: Timestamp) {
      requires notLate { match (this) { Draft => true, Confirmed { confirmedAt } => confirmedAt <= at } } else TooLate
      outcome cancelled: Draft | Confirmed -> Cancelled
        changes reason = match (before) { Draft => why, Confirmed => "late" }, total
        ensures {
          match (before) { Draft => after.total == 0, Confirmed { total } => after.total == total }
            && match (after) { Cancelled { reason } => reason != "" }
        }
    }
    command amend(n: Int) Draft -> Draft
      Confirmed -> Confirmed
      requires positive { match (this) { Draft => n >= 0, Confirmed => n > 0 } } else TooLate
      changes total = match (before) { Draft => n, Confirmed => before.total + n }
      ensures { match (after) { Draft => true, Confirmed { confirmedAt, total } => total >= 0 } }`),
            ),
        ).toEqual([]);
    });

    test('a choice rule matches over the source states of its outcome', async () => {
        expect(
            await errors(
                order(`    command close(n: Int) {
      outcome kept: Draft | Confirmed -> Confirmed select { match (this) { Draft => n > 0, Confirmed => true } }
        changes confirmedAt
      outcome dropped: Draft | Confirmed -> Cancelled select { match (this) { Draft => n <= 0, Confirmed => false } }
        changes reason = "dropped"
    }`),
            ),
        ).toEqual([]);
    });

    test('the cases are exactly the states the aggregate can be in there: a missing one, one not among them, an unknown one, one twice', async () => {
        expect(
            await errors(
                order(`    invariant complete { match (this) { Draft => true, Confirmed => true } }
    command cancel(why: String) {
      requires a { match (this) { Draft => true, Confirmed => true, Cancelled => false } } else TooLate
      requires b { match (this) { Draft => true, Confirmd => true } } else TooLate
      requires c { match (this) { Draft => true, Draft => true, Confirmed => true } } else TooLate
      outcome cancelled: Draft | Confirmed -> Cancelled
        changes reason = why
        ensures { match (after) { Cancelled => true, Draft => true } }
    }`),
            ),
        ).toEqual([
            "M009 'match (this)' has no case for 'Cancelled': it has one case for each of the states of 'Order' ('Draft', 'Confirmed', 'Cancelled').",
            "M009 State 'Cancelled' is not among the source states of command 'cancel' ('Draft', 'Confirmed'): 'match (this)' has a case for each of them, and only for them. | remove the case 'Cancelled'",
            "M009 'match (this)' has no case for 'Confirmed': it has one case for each of the source states of command 'cancel' ('Draft', 'Confirmed').",
            "M009 'Order' has no state 'Confirmd'. | did you mean 'Confirmed'?",
            "M009 State 'Draft' has two cases.",
            "M009 State 'Draft' is not among the target states of outcome 'cancelled' ('Cancelled'): 'match (after)' has a case for each of them, and only for them. | remove the case 'Draft'",
        ]);
    });

    test('a binding names a field of its state or a common one, and not a parameter; the cases have one type', async () => {
        expect(
            await errors(
                order(`    command cancel(why: String, confirmedAt: Timestamp) {
      requires a { match (this) { Draft { reason } => true, Confirmed => true } } else TooLate
      requires b { match (this) { Draft => true, Confirmed { confirmedAt } => true } } else TooLate
      requires c { match (this) { Draft => 1 > 0, Confirmed => "x" } } else TooLate
      outcome cancelled: Draft | Confirmed -> Cancelled
        changes reason = why
    }`),
            ),
        ).toEqual([
            "M009 State 'Draft' of 'Order' has no field 'reason'.",
            "M019 The binding 'confirmedAt' in the case 'Confirmed' of 'match (this)' has the name of a parameter, which it would hide. | rename the parameter (e.g. 'newConfirmedAt'), so that 'confirmedAt' in the case means the field",
            "M009 The cases of 'match' give 'Bool' and 'String': every case must have the same type.",
        ]);
    });

    test("'this' is a match subject only, its fields are read by name, and it is not in scope in changes, ensures, a create's rules or a state's invariants", async () => {
        expect(
            await errors(
                order(`    invariant a { this.note != null }
    invariant b { this == this }
    state Held { holder: String invariant c { match (this) { Held => true } } invariant d { this.holder != "" } }
    command cancel(why: String) {
      outcome cancelled: Draft | Confirmed -> Cancelled
        changes reason = match (this) { Draft => why, Confirmed => why }
        ensures { this.note == null }
    }
    create command make(id: OrderId) {
      requires x { match (this) { Draft => true } } else TooLate
      outcome made: -> Draft changes id = id, total = 0
    }`),
            ).then((e) => e.filter((x) => !x.includes('M028'))),
        ).toEqual([
            "M001 'this.note': the fields of the aggregate are read by name here. | write 'note'",
            "M009 'this' is the aggregate itself, which is read only as the subject of 'match (this) { … }'. | read the fields by name, or choose by its state or kind with 'match (this) { … }'",
            "M009 'this' is the aggregate itself, which is read only as the subject of 'match (this) { … }'. | read the fields by name, or choose by its state or kind with 'match (this) { … }'",
            "M001 'this' is not in scope in an invariant of state 'Held', which holds in that one state: its fields are read by name. | read the fields by name, or write the rule as an invariant of 'Order' with 'match (this) { Held { … } => …, … }'",
            "M001 'this' is not in scope in an invariant of state 'Held', which holds in that one state: its fields are read by name. | write 'holder'",
            "M001 'this' is not in scope in 'changes x = …' and 'ensures', where it would be ambiguous: 'before' is the aggregate before the outcome, 'after' the aggregate after it (in 'ensures'). | write 'before', e.g. 'match (before) { … }'",
            "M001 'this' is not in scope in 'changes x = …' and 'ensures', where it would be ambiguous: 'before' is the aggregate before the outcome, 'after' the aggregate after it (in 'ensures'). | write 'before.note' or 'after.note'",
            "M001 'this' is not in scope in the rules of 'create command make': there is no aggregate before it is made. | decide by the parameters of 'make'",
        ]);
    });

    test('an aggregate without states or kinds has nothing to match on; a value that is not a union or the aggregate is not matched', async () => {
        expect(
            await errors(`context S {
  id PlainId: UUID
  aggregate Plain { id: PlainId n: Int invariant p { match (this) { A => true } } invariant q { match (n) { A => true } } }
}`),
        ).toEqual([
            "M009 'match (this)' chooses by the state or the kind of 'Plain', which has neither. | read the fields of 'Plain' by name",
            "M009 'match' takes a union value or the aggregate ('this', 'before', 'after'), but 'n' is a 'Int'.",
        ]);
    });
});

describe('before and after of one transition', () => {
    test('a case of after narrows before to the sources of the transitions into its state, and before.x reads their fields', async () => {
        expect(
            await errors(
                order(`    command amend(n: Int) Draft -> Draft
      Confirmed -> Confirmed
      ensures {
        match (after) {
          Draft => match (before) { Draft => n >= 0 },
          Confirmed { confirmedAt } => match (before) { Confirmed => confirmedAt == before.confirmedAt }
        }
      }`),
            ),
        ).toEqual([]);
        expect(
            await errors(
                order(`    command amend(n: Int) Draft -> Draft
      Confirmed -> Confirmed
      ensures { match (after) { Draft => true, Confirmed => match (before) { Draft => n > 0, Confirmed => true } } }`),
            ),
        ).toEqual([
            "M009 State 'Draft' is not among the source states of command 'amend' where 'after' is in state 'Confirmed' ('Confirmed'): 'match (before)' has a case for each of them, and only for them. | remove the case 'Draft'",
        ]);
    });
});

describe('this is reserved', () => {
    test('a field, a parameter, a lambda parameter or a binding is not named this', async () => {
        expect(
            await errors(`context S {
  id OId: UUID
  union U { A { this: Int } B }
  aggregate O {
    id: OId
    this: Int
    xs: Int[0..*]
    u: U
    invariant a { this > 0 }
    invariant b { xs.every(this => this > 0) }
    invariant c { match (u) { A { this } => this > 0, B => true } }
    create command mk(id: OId, u: U) changes id = id, this = 1, xs = [], u = u
    command go(this: Int) changes xs
  }
}`).then((e) => e.filter((x) => !x.includes('M011') && !x.includes('M009'))),
        ).toEqual([
            "M030 Field 'this' of 'O' has the name of the aggregate itself: 'this' is the 'O' in 'match (this) { … }'. | rename the field",
            "M021 'this' is the aggregate in 'match (this)': it cannot name a lambda parameter or a binding. | give it another name",
            "M021 'this' is the aggregate in 'match (this)': it cannot name a lambda parameter or a binding. | give it another name",
            "M030 Parameter 'this' of command 'go' has the name of the aggregate itself: 'this' is the 'O' in 'match (this) { … }'. | rename the parameter",
        ]);
    });
});

describe('the hints name what is in scope', () => {
    test('a create has no before, changes has no after, and a state-only field in requires is bound in a case', async () => {
        expect(
            await errors(
                order(`    create command make(id: OrderId) {
      outcome made: -> Draft
        changes id = this.id, total = 0
        ensures { match (this) { Draft => true } }
    }
    command touch(n: Int) {
      outcome touched: Draft -> Draft
        changes total = this.total + n
    }
    command late(at: Timestamp) {
      requires r { confirmedAt <= at } else TooLate
      outcome lated: Draft | Confirmed -> Cancelled
        changes reason = "late"
    }`),
            ).then((e) => e.filter((x) => !x.includes('M028'))),
        ).toEqual([
            "M001 'this' is not in scope in 'changes x = …' and 'ensures', where it would be ambiguous: 'before' is the aggregate before the outcome, 'after' the aggregate after it (in 'ensures'). | give the value by the parameters, or state it in 'ensures' with 'after.id'",
            "M001 'this' is not in scope in 'changes x = …' and 'ensures', where it would be ambiguous: 'before' is the aggregate before the outcome, 'after' the aggregate after it (in 'ensures'). | write 'after' (a create has no 'before'), e.g. 'match (after) { … }'",
            "M001 'this' is not in scope in 'changes x = …' and 'ensures', where it would be ambiguous: 'before' is the aggregate before the outcome, 'after' the aggregate after it (in 'ensures'). | write 'before.total'",
            "M010 Field 'confirmedAt' is in state 'Confirmed' only; the requirements of command 'late' see the fields that every source state has (with the same type). | bind it in a case of 'match (this)': 'match (this) { Confirmed { confirmedAt } => … }'; or declare 'confirmedAt' with the same type in every source state of 'late' (or among the common fields)",
        ]);
    });
});

describe('match over the kinds of the aggregate (ADR 0037)', () => {
    test('kind cases with their fields, a state match inside a kind case, in invariants, requires, choices, changes and ensures', async () => {
        expect(
            await errors(
                site(`    invariant positive {
      match (this) {
        Store { hours } => hours > 0,
        Center { docks } => match (this) { Active => docks >= 0, Paused { reason } => docks > 0 || reason != "" }
      }
    }
    command rate(by: Int) {
      requires sensible { match (this) { Store { hours } => by <= hours, Center => true } } else TooLate
      outcome rated: Active -> Active select { match (this) { Store => true, Center { docks } => docks > 0 } }
        changes score = match (before) { Store => before.score + by, Center => before.score }
        ensures { match (after) { Store { hours } => hours > 0, Center => true } }
    }`),
            ),
        ).toEqual([]);
    });

    test('a common command decided in on cases from other states per kind: the cases follow its (kind, state) pairs', async () => {
        const model = (requires: string) =>
            site(`    command resume(by: Int) {
      requires sensible { ${requires} } else TooLate
    }`)
                .replace(
                    '      on pause {\n        outcome paused: Active -> Paused\n          changes reason = why\n      }\n    }\n    kind Center',
                    '      on pause {\n        outcome paused: Active -> Paused\n          changes reason = why\n      }\n      on resume { outcome resumed: Paused -> Active }\n    }\n    kind Center',
                )
                .replace(
                    /(changes reason = why\n      \}\n    \}\n  \}\n  error)/,
                    'changes reason = why\n      }\n      on resume { outcome resumed: Active -> Active }\n    }\n  }\n  error',
                );
        // Store resumes from Paused, Center from Active
        expect(await errors(model(`match (this) { Store => match (this) { Paused { reason } => reason != "" }, Center => by > 0 }`))).toEqual([]);
        expect(await errors(model(`match (this) { Paused => match (this) { Store => true }, Active => match (this) { Center => by > 0 } }`))).toEqual([]);
        expect(await errors(model(`match (this) { Store => match (this) { Active => by > 0, Paused => true }, Center => true }`))).toEqual([
            "M009 State 'Active' is not among the source states of command 'resume' where 'this' is of kind 'Store' ('Paused'): 'match (this)' has a case for each of them, and only for them. | remove the case 'Active'",
        ]);
    });

    test('a kind case names a kind of the command; states and kinds do not mix; a kind invariant has no this', async () => {
        expect(
            await errors(
                site(`    invariant mix { match (this) { Store => true, Active => true } }
    invariant missing { match (this) { Store => true } }
    command rate(by: Int) {
      outcome rated: Active -> Active
        changes score = by
        ensures { match (after) { Store { docks } => docks > 0, Center => true } }
    }`)
                    .replace('      hours: Int\n', '      hours: Int\n      invariant k { match (this) { Store => true } }\n')
                    .replace('      on pause {\n', '      on pause {\n        requires r { match (this) { Store => true, Center => true } } else TooLate\n'),
            ),
        ).toEqual([
            "M009 'match (this)' names states ('Active') and kinds ('Store'): one 'match' chooses by the state or by the kind, not both. | match on one of them, and write a 'match (this)' over the other inside a case",
            "M009 'match (this)' has no case for 'Center': it has one case for each of the kinds of 'Site' ('Store', 'Center').",
            "M009 Kind 'Store' of 'Site' has no field 'docks' that every state it can be in here has.",
            "M001 'this' is not in scope in an invariant of kind 'Store', which holds in that one kind: its fields are read by name. | read the fields by name, or write the rule as an invariant of 'Site' with 'match (this) { Store { … } => …, … }'",
            "M009 Kind 'Center' is not among the kinds of 'on pause' of kind 'Store' ('Store'): 'match (this)' has a case for each of them, and only for them. | remove the case 'Center'",
        ]);
    });
});
