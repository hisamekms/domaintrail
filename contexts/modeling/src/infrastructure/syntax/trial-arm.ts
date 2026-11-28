// The arms of the Phase 2 AI syntax trial (docs/plans/formal-verification/trial/README.md). `DOMAINTRAIL_TRIAL_ARM`
// selects one for a trial build; without it the language is A0, the adopted one, and the other spellings are errors.
// M2 and M3 vary only the spelling of `match`, Q2 only the names of the quantifiers; all of them build the same model.

export type TrialArm = 'A0' | 'M2' | 'M3' | 'Q2';

const ARMS: readonly TrialArm[] = ['A0', 'M2', 'M3', 'Q2'];

/** The arm of this process: `DOMAINTRAIL_TRIAL_ARM`, else A0. */
export function trialArm(): TrialArm {
    const env = typeof process === 'undefined' ? undefined : process.env['DOMAINTRAIL_TRIAL_ARM'];
    return ARMS.find((a) => a === env) ?? 'A0';
}

export type MatchSpelling = 'A0' | 'M2' | 'M3';

/** The `match` spelling of an arm: Q2 keeps A0's. */
export const matchSpellingOf = (arm: TrialArm): MatchSpelling => (arm === 'M2' || arm === 'M3' ? arm : 'A0');

/** How `match` is written in an arm, for the diagnostics of another spelling. */
export const MATCH_USAGE: Record<MatchSpelling, string> = {
    A0: 'match (x) { Variant { field, … } => value, … }',
    M2: 'match (x) { when { kind: Union.Variant, field, … }: value; … }',
    M3: 'match(x).with({ kind: Union.Variant }, v => value)….exhaustive()',
};

/** The quantifier methods of an arm: `every`/`some`, or Q2's `forall`/`exists`. */
export const quantifiersOf = (arm: TrialArm): { readonly all: string; readonly any: string } =>
    arm === 'Q2' ? { all: 'forall', any: 'exists' } : { all: 'every', any: 'some' };
