import { describe, expect, test } from 'bun:test';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { MESSAGES } from '../i18n';
import { assumptionDecision, pickedAlternative, questionsState, runNumber } from './decisions';

type RunJson = SessionStateBody['runs'][number];

const at = (minute: number): string => `2026-10-31T09:${String(minute).padStart(2, '0')}:00.000Z`;
const frozen = (id: string): RunJson['input']['requests'][number] =>
    ({ request: id, author: 'dev:a', targets: [], body: id }) as RunJson['input']['requests'][number];
const run = (id: string, minute: number, requests: string[], state: object, input: object = {}, by = 'dev:f'): RunJson =>
    ({ id, session: 's', input: { requests: requests.map(frozen), ...input }, queuedBy: by, queuedAt: at(minute), ...state }) as unknown as RunJson;
const ended = (minute: number): object => ({ baseRevision: 'r0', startedAt: at(minute), resultRevision: 'r0', finishedAt: at(minute) });

const questions = [
    {
        id: 'when',
        text: 'Until when?',
        requests: ['m1'],
        options: [
            { id: 'before', label: 'Before shipping' },
            { id: 'day', label: 'Within a day', detail: 'Then ask support' },
        ],
        multiple: false,
    },
    {
        id: 'why',
        text: 'Which reasons?',
        requests: ['m1'],
        options: [
            { id: 'customer', label: 'Customer' },
            { id: 'stock', label: 'Out of stock' },
            { id: 'fraud', label: 'Fraud' },
        ],
        multiple: true,
    },
];
const asked = run('q', 1, ['m1'], {
    state: 'NeedsClarification',
    ...ended(2),
    question: 'Until when?',
    reply: { outcome: 'clarification', summary: 'A question.', requests: [], questions, assumptions: [] },
});
const answer = {
    answerTo: 'q',
    answers: [
        { question: 'when', text: 'Until when?', chosen: [questions[0].options[0]] },
        { question: 'why', text: 'Which reasons?', chosen: [questions[1].options[0], questions[1].options[2]], freeText: 'A wrong address' },
    ],
};
const assumptions = [
    { text: 'The amount includes tax', requests: ['m1'], alternatives: [] },
    {
        text: 'The amount is fixed',
        requests: ['m1'],
        alternatives: [
            { id: 'net', label: 'Without tax' },
            { id: 'switch', label: 'Per category' },
        ],
    },
];
const done = run('d', 1, ['m1'], {
    state: 'Completed',
    ...ended(2),
    changed: true,
    report: {},
    reply: { outcome: 'done', summary: 'Done.', requests: [], questions: [], assumptions },
});

describe('what became of a run’s questions', () => {
    test('open while no later run took over its requests', () => {
        expect(questionsState(asked, [asked])).toEqual({ kind: 'open' });
        // a run of other messages does not take them over
        expect(questionsState(asked, [asked, run('o', 3, ['m9'], { state: 'Queued' })])).toEqual({ kind: 'open' });
    });

    test('answered: the options chosen per question, the own words, who and when, the answering run and its number', () => {
        const answering = run('a', 3, ['m1'], { state: 'Queued' }, { answerTo: 'q', answer }, 'dev:facilitator');
        const state = questionsState(asked, [asked, answering]);
        expect(state.kind).toBe('answered');
        if (state.kind !== 'answered') return;
        expect(state.by).toEqual({ run: 'a', number: 2, by: 'dev:facilitator', at: at(3) });
        expect(state.answers.get('when')).toEqual({ chosen: ['before'] });
        expect(state.answers.get('why')).toEqual({ chosen: ['customer', 'fraud'], text: 'A wrong address' });
    });

    test('only own words: no option chosen', () => {
        const words = { answerTo: 'q', answers: [{ question: 'when', text: 'Until when?', chosen: [], freeText: 'Never' }] };
        const state = questionsState(asked, [asked, run('a', 3, ['m1'], { state: 'Queued' }, { answer: words })]);
        expect(state.kind === 'answered' && state.answers.get('when')).toEqual({ chosen: [], text: 'Never' });
        expect(state.kind === 'answered' && state.answers.has('why')).toBe(false);
    });

    test('left: a later run of the same messages without the answer', () => {
        expect(questionsState(asked, [asked, run('n', 3, ['m1'], { state: 'Queued' }, { note: 'Before shipping.' })])).toEqual({ kind: 'left' });
    });

    test('an answering run cancelled before it started does not count: open again', () => {
        const undone = run('a', 3, ['m1'], { state: 'Cancelled', cancelledAt: at(4), cancelledBy: 'dev:f' }, { answer });
        expect(questionsState(asked, [asked, undone])).toEqual({ kind: 'open' });
    });
});

describe('the alternative picked from a run’s assumptions', () => {
    const pickOf = (of: string, assumption: number, id: string, label: string): object => ({
        note: 'redo it',
        pick: { pickOf: of, assumption, text: assumptions[assumption].text, alternative: { id, label } },
    });

    test('the pick recorded in the input of the run that took over, with who, when and the run’s number', () => {
        const pick = run('p', 5, ['m1'], { state: 'Queued' }, pickOf('d', 1, 'switch', 'Per category'));
        expect(pickedAlternative(done, [done, pick])).toEqual({
            assumption: 1,
            alternative: 'switch',
            by: { run: 'p', number: 2, by: 'dev:f', at: at(5) },
        });
    });

    test('none while no later run took over, and when it was not a pick (applied again, or a note — even the page’s own words)', () => {
        expect(pickedAlternative(done, [done])).toBeUndefined();
        expect(pickedAlternative(done, [done, run('p', 5, ['m1'], { state: 'Queued' })])).toBeUndefined();
        // a note is never read as a pick: only the input's `pick` is (runs before it was recorded show no pick)
        for (const m of Object.values(MESSAGES)) {
            const note = m.session.chat.alternativeNote('The amount is fixed', 'Per category');
            expect(pickedAlternative(done, [done, run('p', 5, ['m1'], { state: 'Queued' }, { note })])).toBeUndefined();
        }
    });

    test('a run of a reply to it takes over without a pick: none', () => {
        const replying = {
            ...run('r', 5, [], { state: 'Queued' }),
            input: { requests: [{ ...frozen('m7'), replyTo: { kind: 'Run', run: 'd' } }] },
        } as unknown as RunJson;
        expect(pickedAlternative(done, [done, replying])).toBeUndefined();
    });

    test('a pick of another run does not count for this one', () => {
        const other = run('p', 5, ['m1'], { state: 'Queued' }, pickOf('x', 1, 'net', 'Without tax'));
        expect(pickedAlternative(done, [done, other])).toBeUndefined();
    });

    test('a pick cancelled before it started does not count', () => {
        const undone = run('p', 5, ['m1'], { state: 'Cancelled', cancelledAt: at(6), cancelledBy: 'dev:f' }, pickOf('d', 1, 'net', 'Without tax'));
        expect(pickedAlternative(done, [done, undone])).toBeUndefined();
    });

    test('a run’s number: by when it was queued, from 1', () => {
        const later = run('z', 9, ['m2'], { state: 'Queued' });
        expect(runNumber([later, done], 'z')).toBe(2);
        expect(runNumber([later, done], 'd')).toBe(1);
    });
});

describe('what became of one assumption', () => {
    const approval = (assumption: number, minute: number): SessionStateBody['approvals'][number] =>
        ({
            id: `a${assumption}`,
            session: 's',
            assumption: { run: 'd', assumption },
            approvedBy: 'dev:f',
            approvedAt: at(minute),
            state: 'Approved',
        }) as SessionStateBody['approvals'][number];
    const pick = run(
        'p',
        5,
        ['m1'],
        { state: 'Queued' },
        { pick: { pickOf: 'd', assumption: 1, text: 'The amount is fixed', alternative: { id: 'net', label: 'Without tax' } } },
    );

    test('open while neither approved nor taken over', () => {
        expect(assumptionDecision(done, 0, [done], [])).toEqual({ kind: 'open' });
        expect(assumptionDecision(done, 1, [done], undefined)).toEqual({ kind: 'open' });
        // another assumption's approval leaves it open
        expect(assumptionDecision(done, 1, [done], [approval(0, 3)])).toEqual({ kind: 'open' });
    });

    test('approved: who and when, from the approval', () => {
        expect(assumptionDecision(done, 0, [done], [approval(0, 3)])).toEqual({ kind: 'approved', by: 'dev:f', at: at(3) });
    });

    test('picked: the alternative, who, when and the run it queued; the run’s other assumptions are left', () => {
        expect(assumptionDecision(done, 1, [done, pick], [])).toEqual({
            kind: 'picked',
            alternative: 'net',
            by: { run: 'p', number: 2, by: 'dev:f', at: at(5) },
        });
        expect(assumptionDecision(done, 0, [done, pick], [])).toEqual({ kind: 'left' });
        // an approval made before stays what it was
        expect(assumptionDecision(done, 0, [done, pick], [approval(0, 3)])).toEqual({ kind: 'approved', by: 'dev:f', at: at(3) });
    });
});

describe('the assumptions of a run undone', () => {
    const undo = (state: object, minute = 7): RunJson =>
        ({
            ...run('u', minute, [], state),
            input: { requests: [{ ...frozen('m8'), undoes: 'd' }] },
        }) as unknown as RunJson;
    const reverted = undo({ state: 'Reverted', baseRevision: 'r1', resultRevision: 'r2', finishedAt: at(7) });

    test('closed as undone by a mechanical undo or a completed undo of the AI: the undo, who asked and when', () => {
        expect(assumptionDecision(done, 0, [done, reverted], [])).toEqual({ kind: 'undone', by: { run: 'u', number: 2, by: 'dev:f', at: at(7) } });
        const byAi = undo({ state: 'Completed', ...ended(8), changed: true, report: {} });
        expect(assumptionDecision(done, 1, [done, byAi], []).kind).toBe('undone');
    });

    test('open while the undo waits or runs, and again once it failed', () => {
        expect(assumptionDecision(done, 0, [done, undo({ state: 'Queued' })], [])).toEqual({ kind: 'open' });
        expect(assumptionDecision(done, 0, [done, undo({ state: 'Failed', ...ended(8), reason: 'AgentError' })], [])).toEqual({ kind: 'open' });
    });

    test('an assumption decided before stays as it was decided', () => {
        const approval = {
            id: 'a0',
            session: 's',
            assumption: { run: 'd', assumption: 0 },
            approvedBy: 'dev:f',
            approvedAt: at(3),
            state: 'Approved',
        } as SessionStateBody['approvals'][number];
        expect(assumptionDecision(done, 0, [done, reverted], [approval])).toEqual({ kind: 'approved', by: 'dev:f', at: at(3) });
    });
});
