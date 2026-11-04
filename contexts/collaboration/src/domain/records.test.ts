// The records' facts and texts (records.ts): each record in Japanese and English, the ✓ merge rule, what an act
// records, and the summary of the journey file changed outside dt.
import { describe, expect, test } from 'bun:test';
import { Collaboration as C, type Result } from '../generated/index.js';
import type { JourneyFile } from './journey.js';
import { actFact, journeyActOf, journeyFileChanges, MAX_FILE_CHANGES, mergedMarks, recordText, requestedAct } from './records.js';

const value = <T, E>(r: Result<T, E>): T => {
    if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
    return r.value;
};

const NAMES: Record<string, string> = { 'local:facilitator': '大山', 'dev:sato': '佐藤' };
const nameOf = (id: string): string => NAMES[id] ?? id;
const ada = value(C.makeParticipantId('local:facilitator'));
const sato = value(C.makeParticipantId('dev:sato'));
const journey = (key: string, label: string): C.RecordedJourney => ({ journey: value(C.makeGuideJourneyKey(key)), label: value(C.makeJourneyLabel(label)) });
const step = (s: string): C.GuideStepKey => value(C.makeGuideStepKey(s));
const ES = journey('es:Issue', '交付');
const MODEL = journey('billing', 'Billing の深掘り');
const REQUEST = value(C.makeJourneyRequestId('00000000-0000-4000-8000-000000000001'));
const INTERVIEW = value(C.makeInterviewId('00000000-0000-4000-8000-000000000002'));

const text = (by: C.ParticipantId | undefined, fact: C.RecordFact): { ja: string; en: string } => ({
    ja: recordText({ ...(by && { by }), fact }, 'Ja', nameOf),
    en: recordText({ ...(by && { by }), fact }, 'En', nameOf),
});

const FILE: JourneyFile = {
    version: 1,
    stormings: { Issue: { purpose: '交付の流れ', participants: [], use: 'modeling', level: 'BigPicture', state: 'active', marks: [] } },
    modeling: [
        {
            id: 'billing',
            name: 'Billing の深掘り',
            purpose: '請求を深める',
            participants: [],
            pattern: 'OneContext',
            from: { context: 'Billing' },
            goal: 'invariants',
            state: 'active',
            marks: { steps: [], contexts: {} },
        },
    ],
};

describe('the records’ texts', () => {
    test('a goal changed: the journey named only when it is not the current one', () => {
        expect(text(ada, { kind: 'GoalChanged', journey: ES, from: step('BigPicture'), to: step('DesignLevel'), other: false })).toEqual({
            ja: '大山 がゴールを ビッグピクチャー → デザインレベル に変えました',
            en: '大山 changed the goal: Big Picture → Design Level',
        });
        expect(text(ada, { kind: 'GoalChanged', journey: MODEL, from: step('aggregates'), to: step('invariants'), other: true })).toEqual({
            ja: '大山 が「Billing の深掘り」のゴールを 集約 → 不変条件 に変えました',
            en: '大山 changed the goal of “Billing の深掘り”: Aggregates → Invariants',
        });
    });

    test('marks set and cleared, several in one row, a BC row by its context', () => {
        const marks = [{ step: step('exceptions') }, { step: step('questions') }] as const;
        expect(text(ada, { kind: 'MarksChanged', journey: ES, done: true, marks: [...marks], other: false })).toEqual({
            ja: '大山 が「例外」「問い」を済みにしました',
            en: '大山 marked “Exceptions”, “Questions” done',
        });
        expect(text(ada, { kind: 'MarksChanged', journey: ES, done: false, marks: [{ step: step('exceptions') }], other: false })).toEqual({
            ja: '大山 が「例外」の済みを外しました',
            en: '大山 unmarked “Exceptions”',
        });
        const bc = { step: step('contexts'), context: value(C.makeContextName('Billing')) };
        expect(text(ada, { kind: 'MarksChanged', journey: MODEL, done: true, marks: [bc], other: true })).toEqual({
            ja: '大山 が「Billing の深掘り」の「Billing」を済みにしました',
            en: '大山 marked “Billing” done in “Billing の深掘り”',
        });
    });

    test('done, archived, brought back; the current journey chosen', () => {
        expect(text(ada, { kind: 'StateChanged', journey: ES, state: 'Done' })).toEqual({
            ja: '大山 が「交付」を完了にしました',
            en: '大山 marked “交付” complete',
        });
        expect(text(ada, { kind: 'StateChanged', journey: ES, state: 'Archived' })).toEqual({
            ja: '大山 が「交付」をしまいました',
            en: '大山 archived “交付”',
        });
        expect(text(ada, { kind: 'StateChanged', journey: ES, state: 'Active' })).toEqual({ ja: '大山 が「交付」を戻しました', en: '大山 restored “交付”' });
        expect(text(ada, { kind: 'CurrentChosen', journey: MODEL })).toEqual({
            ja: '大山 がいまのジャーニーを「Billing の深掘り」にしました',
            en: '大山 made “Billing の深掘り” the current journey',
        });
    });

    test('a request, then its outcome on the same row', () => {
        const asked: C.RecordFact = { kind: 'JourneyRequested', request: REQUEST, act: { kind: 'Goal', journey: ES, goal: step('DesignLevel') } };
        expect(text(sato, asked)).toEqual({
            ja: '佐藤 が「交付」のゴールを デザインレベル にするようお願いしています',
            en: '佐藤 asks to set the goal of “交付” to Design Level',
        });
        expect(text(sato, { ...asked, outcome: 'Approved', decidedBy: ada })).toEqual({
            ja: '佐藤 が「交付」のゴールを デザインレベル にするようお願いしました。大山 が承認しました',
            en: '佐藤 asked to set the goal of “交付” to Design Level; 大山 approved it',
        });
        expect(text(sato, { ...asked, outcome: 'Denied', decidedBy: ada }).ja).toEndWith('大山 が却下しました');
        expect(text(sato, { ...asked, outcome: 'Withdrawn', decidedBy: sato }).ja).toEndWith('佐藤 が取り下げました');
        const others: [C.RequestedJourneyAct, string, string][] = [
            [{ kind: 'Choose', journey: MODEL }, 'いまのジャーニーを「Billing の深掘り」にするよう', 'make “Billing の深掘り” the current journey'],
            [{ kind: 'State', journey: ES, state: 'Done' }, '「交付」を完了にするよう', 'mark “交付” complete'],
            [{ kind: 'State', journey: ES, state: 'Archived' }, '「交付」をしまうよう', 'archive “交付”'],
            [
                { kind: 'Mark', journey: ES, mark: { step: step('questions') }, done: true },
                '「交付」の「問い」を済みにするよう',
                'mark “Questions” done in “交付”',
            ],
        ];
        for (const [act, ja, en] of others)
            expect(text(sato, { kind: 'JourneyRequested', request: REQUEST, act })).toEqual({ ja: `佐藤 が${ja}お願いしています`, en: `佐藤 asks to ${en}` });
    });

    test('an interview stopped, a brief rejected (with its note)', () => {
        expect(text(sato, { kind: 'InterviewStopped', interview: INTERVIEW })).toEqual({ ja: '佐藤 が中止しました', en: '佐藤 stopped it' });
        const note = value(C.makeText('範囲が広すぎます'));
        expect(text(ada, { kind: 'BriefRejected', interview: INTERVIEW, note })).toEqual({
            ja: '大山 が却下しました（範囲が広すぎます）',
            en: '大山 rejected the brief (範囲が広すぎます)',
        });
        expect(text(ada, { kind: 'BriefRejected', interview: INTERVIEW }).ja).toBe('大山 が却下しました');
    });

    test('the journey file changed outside dt, with what changed', () => {
        const fact: C.RecordFact = {
            kind: 'FileChangedOutside',
            changes: [
                { kind: 'Added', journey: MODEL },
                { kind: 'Goal', journey: ES, from: 'BigPicture', to: 'DesignLevel' },
                { kind: 'State', journey: ES, from: 'Active', to: 'Done' },
                { kind: 'Marks', journey: ES },
            ],
            more: value(C.makeTally(2)),
            unreadable: false,
        };
        expect(text(undefined, fact)).toEqual({
            ja: 'ジャーニーファイルが外で変わりました（「Billing の深掘り」が増えた、「交付」のゴール ビッグピクチャー → デザインレベル、「交付」が完了、「交付」の済み、ほか 2 件）',
            en: 'The journey file changed outside dt (added “Billing の深掘り”, goal of “交付”: Big Picture → Design Level, “交付” done, marks of “交付”, 2 more)',
        });
        expect(text(undefined, { kind: 'FileChangedOutside', changes: [], more: value(C.makeTally(0)), unreadable: true }).ja).toBe(
            'ジャーニーファイルが外で変わりました（読めません）',
        );
    });
});

describe('the ✓ merge', () => {
    const marks = (done: boolean, ...steps: string[]): Extract<C.RecordFact, { kind: 'MarksChanged' }> => {
        const [first, ...rest] = steps.map((s) => ({ step: step(s) }));
        if (!first) throw new Error('no step');
        return { kind: 'MarksChanged', journey: ES, done, marks: [first, ...rest], other: false };
    };

    test('the same person, journey and direction, nothing in between: one row', () => {
        expect(mergedMarks({ by: ada, fact: marks(true, 'exceptions') }, ada, marks(true, 'questions'), false)?.marks).toEqual([
            { step: step('exceptions') },
            { step: step('questions') },
        ]);
        // a step already in the row is not named twice
        expect(mergedMarks({ by: ada, fact: marks(true, 'exceptions') }, ada, marks(true, 'exceptions'), false)?.marks).toHaveLength(1);
    });

    test('another person, another direction, another journey, or something in between: a row of its own', () => {
        const last = { by: ada, fact: marks(true, 'exceptions') };
        expect(mergedMarks(last, sato, marks(true, 'questions'), false)).toBeUndefined();
        expect(mergedMarks(last, ada, marks(false, 'questions'), false)).toBeUndefined();
        expect(mergedMarks(last, ada, { ...marks(true, 'questions'), journey: MODEL }, false)).toBeUndefined();
        expect(mergedMarks(last, ada, marks(true, 'questions'), true)).toBeUndefined();
        expect(mergedMarks({ by: ada, fact: { kind: 'StateChanged', journey: ES, state: 'Done' } }, ada, marks(true, 'questions'), false)).toBeUndefined();
        expect(mergedMarks(undefined, ada, marks(true, 'questions'), false)).toBeUndefined();
    });
});

describe('what an act records', () => {
    test('the goal from the file before; another journey named; the default choice not recorded', () => {
        expect(actFact({ act: { kind: 'goal', journey: 'es:Issue', goal: 'DesignLevel' }, before: FILE, current: 'es:Issue' })).toEqual({
            kind: 'GoalChanged',
            journey: journey('es:Issue', 'Issue'),
            from: step('BigPicture'),
            to: step('DesignLevel'),
            other: false,
        });
        // none chosen: the file's default (the last active modeling journey) is the current one
        expect(actFact({ act: { kind: 'goal', journey: 'es:Issue', goal: 'DesignLevel' }, before: FILE, labels: () => '交付' })).toMatchObject({
            journey: ES,
            other: true,
        });
        expect(actFact({ act: { kind: 'choose', journey: null }, before: FILE })).toBeUndefined();
        expect(actFact({ act: { kind: 'choose', journey: 'billing' }, before: FILE })).toEqual({ kind: 'CurrentChosen', journey: MODEL });
        expect(actFact({ act: { kind: 'state', journey: 'billing', state: 'archived' }, before: FILE })).toEqual({
            kind: 'StateChanged',
            journey: MODEL,
            state: 'Archived',
        });
    });

    test('a request kept as its record and read back as the act', () => {
        const acts = [
            { kind: 'choose', journey: 'billing' },
            { kind: 'choose', journey: null },
            { kind: 'goal', journey: 'es:Issue', goal: 'DesignLevel' },
            { kind: 'state', journey: 'billing', state: 'done' },
            { kind: 'mark', journey: 'billing', step: 'contexts', context: 'Billing', done: true },
        ] as const;
        for (const act of acts) {
            const kept = requestedAct(act, FILE);
            expect(kept).toBeDefined();
            if (kept) expect(journeyActOf(kept)).toEqual(act);
        }
    });
});

describe('the journey file changed outside dt', () => {
    test('journeys added and removed, goals, states, marks, briefs', () => {
        const after: JourneyFile = {
            ...FILE,
            stormings: { Issue: { ...FILE.stormings.Issue!, level: 'DesignLevel', marks: ['questions'], purpose: '交付の流れ全体' } },
            modeling: [{ ...FILE.modeling[0]!, id: 'whole', name: '全体' }],
        };
        const { changes, more } = journeyFileChanges(FILE, after, (key) => (key === 'es:Issue' ? '交付' : undefined));
        expect(changes.map((c) => [c.kind, c.journey.label, c.from, c.to])).toEqual([
            ['Goal', '交付', 'BigPicture', 'DesignLevel'],
            ['Marks', '交付', undefined, undefined],
            ['Brief', '交付', undefined, undefined],
            ['Added', '全体', undefined, undefined],
            ['Removed', 'Billing の深掘り', undefined, undefined],
        ]);
        expect(more).toBe(0);
        expect(journeyFileChanges(FILE, { ...FILE, modeling: [{ ...FILE.modeling[0]!, state: 'done' }] }, undefined).changes).toEqual([
            { kind: 'State', journey: MODEL, from: 'Active', to: 'Done' },
        ]);
    });

    test('nothing that matters: none; many: the first named, the rest counted', () => {
        expect(journeyFileChanges(FILE, FILE).changes).toEqual([]);
        const many: JourneyFile = {
            ...FILE,
            modeling: Array.from({ length: MAX_FILE_CHANGES + 3 }, (_, i) => ({ ...FILE.modeling[0]!, id: `j-${i}`, name: `J${i}` })),
        };
        const { changes, more } = journeyFileChanges(FILE, many);
        expect(changes).toHaveLength(MAX_FILE_CHANGES);
        // the 13 added and the one removed
        expect(more).toBe(4);
    });
});
