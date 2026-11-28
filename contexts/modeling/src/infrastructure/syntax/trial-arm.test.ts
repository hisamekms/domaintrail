// The prototype spellings of the Phase 2 AI trial (trial-arm.ts): each arm reads its own spelling only, and every arm
// builds the same model.
import { afterEach, describe, expect, test } from 'bun:test';
import { analyzeDomain } from '../../application/analyze.js';

const model = (hours: string, positive: string) => `context Rota {
  union Shift {
    Staffed { worker: String hours: Int }
    Open { role: String hours: Int }
  }
  id RotaId: UUID
  aggregate Rota {
    id: RotaId
    shift: Shift
    shifts: Shift[0..*]
    invariant hoursPositive { ${hours} > 0 }
    invariant allPositive { ${positive} }
  }
}
`;

const A0 = model('match (shift) { Staffed { hours } => hours, Open { hours } => hours }', 'shifts.every(s => s.kind != Shift.Open)');
const M2 = model(
    'match (shift) { when { kind: Shift.Staffed, hours }: hours; when { kind: Shift.Open, hours }: hours; }',
    'shifts.every(s => s.kind != Shift.Open)',
);
const M3 = model(
    'match(shift).with({ kind: Shift.Staffed }, s => s.hours).with({ kind: Shift.Open }, s => s.hours).exhaustive()',
    'shifts.every(s => s.kind != Shift.Open)',
);
const Q2 = model('match (shift) { Staffed { hours } => hours, Open { hours } => hours }', 'shifts.forall(s => s.kind != Shift.Open)');

async function errors(text: string, arm?: string): Promise<string[]> {
    if (arm) process.env['DOMAINTRAIL_TRIAL_ARM'] = arm;
    else delete process.env['DOMAINTRAIL_TRIAL_ARM'];
    const a = await analyzeDomain([{ path: 'r.dt', text }]);
    return a.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
}

/** The Typed Model without the source text and positions, which differ by spelling. */
async function typed(text: string, arm: string): Promise<unknown> {
    process.env['DOMAINTRAIL_TRIAL_ARM'] = arm;
    const a = await analyzeDomain([{ path: 'r.dt', text }]);
    const strip = (v: unknown): unknown =>
        Array.isArray(v)
            ? v.map(strip)
            : v && typeof v === 'object'
              ? Object.fromEntries(
                    Object.entries(v)
                        .filter(([k]) => !['text', 'expression', 'location', 'source', 'line', 'column'].includes(k))
                        .map(([k, x]) => [k, strip(x)]),
                )
              : v;
    return strip(a.model);
}

afterEach(() => {
    delete process.env['DOMAINTRAIL_TRIAL_ARM'];
});

describe('the arms of the AI trial', () => {
    test('without an arm the language is A0: the trial spellings are errors that show the A0 spelling', async () => {
        expect(await errors(A0)).toEqual([]);
        expect(await errors(M2)).toEqual(["SYNTAX This form of 'match' is not DomainTrail syntax: write match (x) { Variant { field, … } => value, … }."]);
        expect(await errors(M3)).toEqual(["SYNTAX This form of 'match' is not DomainTrail syntax: write match (x) { Variant { field, … } => value, … }."]);
        expect(await errors(Q2)).toEqual([
            "M001 'forall' is not a method: the methods are every, some, includes, unique, matches, round, map, filter and sum.",
        ]);
    });

    test('each arm reads its own spelling only, and its messages show only its own', async () => {
        expect(await errors(M2, 'M2')).toEqual([]);
        expect(await errors(A0, 'M2')).toEqual([
            "SYNTAX This form of 'match' is not DomainTrail syntax: write match (x) { when { kind: Union.Variant, field, … }: value; … }.",
        ]);
        expect(await errors(M3, 'M3')).toEqual([]);
        expect(await errors(M2, 'M3')).toEqual([
            "SYNTAX This form of 'match' is not DomainTrail syntax: write match(x).with({ kind: Union.Variant }, v => value)….exhaustive().",
        ]);
        expect(await errors(Q2, 'Q2')).toEqual([]);
        expect(await errors(A0, 'Q2')).toEqual([
            "M001 'every' is not a method: the methods are forall, exists, includes, unique, matches, round, map, filter and sum.",
        ]);
    });

    test('every arm builds the same model', async () => {
        const a0 = await typed(A0, 'A0');
        expect(await typed(M2, 'M2')).toEqual(a0);
        expect(await typed(M3, 'M3')).toEqual(a0);
        expect(await typed(Q2, 'Q2')).toEqual(a0);
    });

    test('a tag of another union or key, a chain without exhaustive(), the variant used whole, are errors', async () => {
        expect(
            await errors(model('match (shift) { when { tag: Shift.Staffed, hours }: hours; when { kind: Shift.Open, hours }: hours; }', 'true'), 'M2'),
        ).toEqual(["M009 The tag of union 'Shift' is 'kind', not 'tag'."]);
        expect(
            await errors(model('match(shift).with({ kind: Shift.Staffed }, s => s.hours).with({ kind: Shift.Open }, s => s.hours).done()', 'true'), 'M3'),
        ).toEqual(["SYNTAX A 'match(x).with(…)' chain ends with '.exhaustive()'."]);
        expect(
            await errors(model('match(shift).with({ kind: Shift.Staffed }, s => s.hours).with({ kind: Shift.Open }, s => s.hourz).exhaustive()', 'true'), 'M3'),
        ).toEqual(["M009 Variant 'Open' has no field 'hourz'."]);
        expect(
            await errors(model('match(shift).with({ kind: Shift.Staffed }, s => s.hours).with({ kind: Shift.Open }, s => s).exhaustive()', 'true'), 'M3'),
        ).toContain("M009 's' is the matched variant: read its fields as 's.field'.");
        expect(await errors(model('shifts.forall(s => s.hours)', 'true'), 'Q2')).toContain(
            "M009 'hours' exists only in variant 'Staffed', 'Open' of union 'Shift'; only 'kind' is accessible from outside.",
        );
    });
});
