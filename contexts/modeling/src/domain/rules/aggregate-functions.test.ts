// Functions of the aggregate (state match B): a function's parameter may be one aggregate of its context
// (`function isOpen(o: Order): Bool { match (o) { … } }`), the aggregate in any of its states and kinds, called with
// `this`, `before`, `after` or another such parameter. The generated TypeScript: generation's aggregate-functions.test.ts.
import { describe, expect, test } from 'bun:test';
import { analyzeDomain } from '../../application/analyze.js';
import { semanticIROf } from '../semantic.js';

/** An order with states, `fns` added to the context and `members` to the aggregate. */
const order = (fns: string, members = '') => `context S {
  id OrderId: UUID
  id InvoiceId: UUID
${fns}
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
  aggregate Invoice {
    id: InvoiceId
    references order: OrderId -> Order
  }
  error TooLate
}`;

const IS_OPEN = `  function isOpen(o: Order): Bool { match (o) { Draft => true, Confirmed => true, Cancelled => false } }`;

async function errors(text: string): Promise<string[]> {
    const a = await analyzeDomain([{ path: 's.dt', text }]);
    return a.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}${d.hint ? ` | ${d.hint}` : ''}`);
}

describe('a function of the aggregate', () => {
    test('called with this, before, after and its own parameter; o.x of a common field, a state field in its case', async () => {
        expect(
            await errors(
                order(
                    `${IS_OPEN}
  /// the total of an open order, the confirmed one's only after it was confirmed
  function openTotal(o: Order, at: Timestamp): Int {
    isOpen(o) ? match (o) { Draft => o.total, Confirmed { confirmedAt } => confirmedAt <= at ? o.total : 0, Cancelled => 0 } : 0
  }
  function noted(o: Order): Bool { o.note != null && match (o) { Draft => true, Confirmed => o.confirmedAt != "2026-01-01T00:00:00Z", Cancelled { reason } => reason != "" } }
  function anyPositive(o: Order, xs: Int[0..*]): Bool { xs.some(o => o > 0) }`,
                    `    invariant openOrNoted { isOpen(this) || noted(this) }
    command cancel(why: String, at: Timestamp) {
      requires open { isOpen(this) && openTotal(this, at) >= 0 } else TooLate
      outcome cancelled: Draft | Confirmed -> Cancelled select { isOpen(this) }
        changes reason = isOpen(before) ? why : "closed"
        ensures { isOpen(before) && !isOpen(after) && anyPositive(after, [after.total]) == anyPositive(before, [before.total]) }
    }`,
                ),
            ),
        ).toEqual([]);
    });

    test('kinds with states: the cases name every kind (or state), and a case narrows a match inside it', async () => {
        expect(
            await errors(`context S {
  id SiteId: UUID
  function busy(s: Site): Bool {
    match (s) { Store { hours } => hours > 8, Center => match (s) { Active => s.docks > 0, Paused { reason } => reason != "" } }
  }
  aggregate Site {
    id: SiteId
    state Active
    state Paused { reason: String }
    invariant sane { busy(this) || true }
    command pause(why: String) {
      requires notBusy { !busy(this) } else TooLate
    }
    kind Store {
      hours: Int
      create command openStore(id: SiteId, hours: Int) {
        outcome opened: -> Active
          changes id = id, hours = hours
          ensures { busy(after) || hours <= 8 }
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
          changes id = id, docks = docks
      }
      on pause {
        outcome paused: Active -> Paused
          changes reason = why
      }
    }
  }
  error TooLate
}`),
        ).toEqual([]);
    });

    test('match on the parameter has a case for every state: the function does not know where it is called', async () => {
        expect(await errors(order(`  function isOpen(o: Order): Bool { match (o) { Draft => true, Confirmed => true } }`))).toEqual([
            "M009 'match (o)' has no case for 'Cancelled': it has one case for each of the states of 'Order' ('Draft', 'Confirmed', 'Cancelled').",
        ]);
    });

    test('o.x reads the fields every state has; a state field is read in its case', async () => {
        expect(
            await errors(
                order(`  function f(o: Order): Bool { o.confirmedAt != "2026-01-01T00:00:00Z" && o.totl > 0 }
  function g(o: Order): Bool { match (o) { Draft => o.reason != "", Confirmed => true, Cancelled => o.reason != "" } }`),
            ),
        ).toEqual([
            "M001 'o.confirmedAt': 'Order' has 'confirmedAt' in 'Confirmed' only, not in every state and kind 'o' can be in here. | read it in a case of 'match (o)': 'match (o) { Confirmed { confirmedAt } => … }'",
            "M001 'o.totl': 'Order' has no field 'totl'. | did you mean 'total'?",
            "M001 'o.reason': 'Order' has 'reason' in 'Cancelled' only, and 'o' is in 'Draft' here. | read it in the case 'Cancelled' of 'match (o)'",
        ]);
    });

    test('a field of every state with different types is read in a case, where it has one', async () => {
        expect(
            await errors(`context S {
  id OrderId: UUID
  function f(o: Order): Bool { o.x > 0 }
  function g(o: Order): Bool { match (o) { Draft { x } => x > 0, Confirmed { x } => x != "" } }
  aggregate Order {
    id: OrderId
    initial Draft
    state Draft { x: Int }
    state Confirmed { x: String }
    invariant i { f(this) && g(this) }
    create command open(id: OrderId) { outcome opened: -> Draft changes id = id, x = 0 }
    command c() { outcome y: Draft -> Confirmed changes x = "a" }
  }
}`),
        ).toEqual([
            "M001 'o.x': the states and kinds 'o' can be in here have 'x' of different types ('Draft': 'Int', 'Confirmed': 'String'). | read it in a case of 'match (o)', where it has one type: 'match (o) { Draft { x } => … }'",
        ]);
    });

    test('an optional field of the aggregate is narrowed by a comparison with null: of a parameter, before and after', async () => {
        expect(
            await errors(
                order(
                    `  function noted(o: Order): Bool { o.note != null && o.note.length > 0 }
  function unnoted(o: Order): Bool { o.note == null || o.note.length == 0 }
  function bare(o: Order): Bool { o.note.length > 0 }`,
                    `    invariant n { noted(this) || unnoted(this) || bare(this) }
    command amend(n: String) {
      outcome amended: Draft -> Draft
        changes note = n
        ensures { (before.note == null || before.note.length >= 0) && after.note != null && after.note.length > 0 }
    }`,
                ),
            ),
        ).toEqual(["M009 '.length' is the size of a list or a string, not of 'String?'."]);
    });

    test('match on an aggregate without states or kinds: its fields are read through the name', async () => {
        expect(
            await errors(`context S {
  id AccId: UUID
  function pos(a: Acc): Bool { match (a) { Open => a.bal >= 0 } }
  aggregate Acc {
    id: AccId
    bal: Int
    invariant p { pos(this) }
    command dep(n: Int)
      changes bal = before.bal + n
      ensures { match (before) { Open => true } }
  }
}`),
        ).toEqual([
            "M009 'match (a)' chooses by the state or the kind of 'Acc', which has neither. | read its fields as 'a.bal'",
            "M009 'match (before)' chooses by the state or the kind of 'Acc', which has neither. | read its fields as 'before.bal'",
        ]);
    });

    test('the aggregate is not a value: no case of match or branch of ? : gives it, so an argument is a name', async () => {
        const notValue = (x: string) =>
            `M009 The aggregate itself ('${x}') is not a value here: an element of a list, a case of 'match' and a branch of '? :' give values. | give the value of one of its fields ('${x}.<field>'), or pass the aggregate to a function by its name`;
        expect(
            await errors(
                order(
                    `${IS_OPEN}
  function chosen(o: Order, c: Bool): Int { (c ? o : o).total }
  function cased(o: Order): Bool { isOpen(match (o) { Draft => o, Confirmed => o, Cancelled => o }) }`,
                    `    invariant i { chosen(this, true) >= 0 && cased(this) }
    command cancel(why: String) {
      outcome cancelled: Draft | Confirmed -> Cancelled
        changes reason = why
        ensures { isOpen(match (after) { Cancelled => before }) && match (after) { Cancelled => before }.total >= 0 }
    }`,
                ),
            ),
        ).toEqual([notValue('o'), notValue('o'), notValue('o'), notValue('o'), notValue('o'), notValue('before'), notValue('before')]);
    });

    test('an aggregate parameter is one aggregate of the context, and a function returns no aggregate', async () => {
        expect(
            await errors(
                order(`  function many(os: Order[0..*]): Bool { true }
  function maybe(o: Order?): Bool { true }
  function self(o: Order): Order { o }`),
            ),
        ).toEqual([
            "M032 Parameter 'os' of function 'many' is 'Order[0..*]': an aggregate parameter is one 'Order', the aggregate the calling rule is about. | write 'os: Order', and call the function with 'this', 'before' or 'after'",
            "M032 Parameter 'o' of function 'maybe' is 'Order?': an aggregate parameter is one 'Order', the aggregate the calling rule is about. | write 'o: Order', and call the function with 'this', 'before' or 'after'",
            "M032 Function 'self' returns aggregate 'Order': a function returns a value, and takes the aggregate only as a parameter. | return what the caller needs of it, e.g. a Bool or the value of a field",
        ]);
        expect(
            await errors(`context A {
  id OrderId: UUID
  aggregate Order { id: OrderId }
}
context B {
  function f(o: A.Order): Bool { true }
}`),
        ).toEqual([
            "M032 Parameter 'o' of function 'f' is aggregate 'A.Order' of another context: a function takes an aggregate of its own context 'B', the one the rules calling it are about. | declare the function in context 'A'",
        ]);
    });

    test('the argument is the aggregate the rule is about: not an ID, a value, another aggregate or a list of it', async () => {
        const hint =
            "pass the 'Order' the expression is about: 'this' (in 'requires', 'select' and the invariants of 'Order'), 'before' or 'after' (in 'changes' and 'ensures'), or a parameter of type 'Order'; an aggregate it references by ID is out of reach";
        expect(
            await errors(
                order(
                    `${IS_OPEN}
  function listed(o: Order): Bool { [o].length > 0 }`,
                    `    invariant byId { isOpen(id) && isOpen(total) }`,
                ).replace(
                    '    references order: OrderId -> Order',
                    '    references order: OrderId -> Order\n    invariant ofOrder { isOpen(this) && isOpen(order) }',
                ),
            ),
        ).toEqual([
            "M009 The aggregate itself ('o') is not a value here: an element of a list, a case of 'match' and a branch of '? :' give values. | give the value of one of its fields ('o.<field>'), or pass the aggregate to a function by its name",
            `M032 Argument 'o' of 'isOpen' is the aggregate 'Order', but 'id' is a 'OrderId'. | ${hint}`,
            `M032 Argument 'o' of 'isOpen' is the aggregate 'Order', but 'total' is a 'Int'. | ${hint}`,
            `M032 Argument 'o' of 'isOpen' is the aggregate 'Order', but 'this' is the aggregate 'Invoice'. | ${hint}`,
            `M032 Argument 'o' of 'isOpen' is the aggregate 'Order', but 'order' is a 'OrderId'. | ${hint}`,
        ]);
    });

    test("'this' is not in scope in a function, nor in the rules where it is not the aggregate", async () => {
        expect(
            await errors(
                order(
                    `  function f(o: Order): Bool { match (this) { Draft => true, Confirmed => true, Cancelled => false } && this.total > 0 }
  function g(n: Int): Bool { this.total > n }
  function h(os: Order[0..*], o2: Order): Bool { this.total > 0 }
  function isOpen(o: Order): Bool { match (o) { Draft => true, Confirmed => true, Cancelled => false, Held => true } }`,
                    `    state Held { holder: String invariant held { isOpen(this) } }
    command cancel(why: String) {
      outcome cancelled: Draft | Confirmed -> Cancelled
        changes reason = isOpen(this) ? why : ""
    }`,
                ),
            ).then((e) => e.filter((x) => !x.includes('M028'))),
        ).toEqual([
            "M001 'this' is not in scope in function 'f', which reads only its parameters. | write 'o', the 'Order' it takes",
            "M001 'this' is not in scope in function 'f', which reads only its parameters. | write 'o.total'",
            "M001 'this' is not in scope in function 'g', which reads only its parameters. | take the aggregate as a parameter, e.g. 'function g(o: <Aggregate>, …)', and read 'o.total'",
            "M032 Parameter 'os' of function 'h' is 'Order[0..*]': an aggregate parameter is one 'Order', the aggregate the calling rule is about. | write 'os: Order', and call the function with 'this', 'before' or 'after'",
            "M001 'this' is not in scope in function 'h', which reads only its parameters. | write 'o2.total'",
            "M001 'this' is not in scope in an invariant of state 'Held', which holds in that one state: its fields are read by name. | read the fields by name, or write the rule as an invariant of 'Order' with 'match (this) { Held { … } => …, … }'",
            "M001 'this' is not in scope in 'changes x = …' and 'ensures', where it would be ambiguous: 'before' is the aggregate before the outcome, 'after' the aggregate after it (in 'ensures'). | write 'before', e.g. 'match (before) { … }'",
        ]);
    });

    test('a binding named like a parameter would hide it; functions of the aggregate do not recurse', async () => {
        expect(
            await errors(
                order(`  function f(o: Order, reason: String): Bool { match (o) { Draft => true, Confirmed => true, Cancelled { reason } => reason != "" } }
  function a(o: Order): Bool { b(o) }
  function b(o: Order): Bool { a(o) }`),
            ),
        ).toEqual([
            "M019 The binding 'reason' in the case 'Cancelled' of 'match (o)' has the name of a parameter, which it would hide. | read the field as 'o.reason' without binding it, or rename the parameter",
            "M032 Function 'a' calls itself: a -> b -> a; functions cannot recurse.",
        ]);
    });

    test('the Semantic IR: the parameter is a parameter of the aggregate type, its fields are fields', async () => {
        const a = await analyzeDomain([{ path: 's.dt', text: order(`  function big(o: Order): Bool { o.total > 0 }`) }]);
        const ir = semanticIROf(a);
        const root = ir.expressions.find((x) => x.root === 'S.big' && x.path === '');
        expect(root?.source).toBe('o.total > 0');
        const member = root!.children[0]!;
        expect(member.symbol).toMatchObject({ kind: 'field', name: 'total' });
        expect(member.children[0]).toMatchObject({
            source: 'o',
            symbol: { id: 'S.big(o)', kind: 'parameter', name: 'o' },
            type: { name: 'S.Order', cardinality: 'one' },
        });
        // the function and its parameter are declarations (ADR 0040)
        expect(ir.declarations.filter((d) => d.id.startsWith('S.big'))).toMatchObject([
            { id: 'S.big', kind: 'function', name: 'big' },
            { id: 'S.big(o)', kind: 'parameter', name: 'o' },
        ]);
    });

    test('a function is named apart from the functions and the elements of its context, and its parameters apart', async () => {
        expect(
            await errors(
                order(`  function f(n: Int): Bool { n > 0 }
  function f(n: Int): Bool { n > 1 }
  function OrderId(n: Int): Bool { n > 0 }
  function g(n: Int, n: Int): Bool { n > 0 }`),
            ),
        ).toEqual([
            "M002 Function 'f' is declared more than once in context 'S'.",
            "M002 Function 'OrderId' has the name of 'S.OrderId', declared in context 'S'. | rename the function",
            "M002 Parameter 'n' is declared more than once in function 'g'.",
        ]);
    });
});
