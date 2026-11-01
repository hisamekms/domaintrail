import { describe, expect, test } from 'bun:test';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { MESSAGES } from '@domaintrail/web/i18n';
import { pickedAlternative, questionsState, runNumber } from '@domaintrail/web/session/decisions';

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
const notes = Object.values(MESSAGES).map((m) => m.session.chat.alternativeNote);

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
    test('recognized by the note the page writes, in either language, with who, when and the run’s number', () => {
        for (const note of notes) {
            const pick = run('p', 5, ['m1'], { state: 'Queued' }, { note: note('The amount is fixed', 'Per category') });
            expect(pickedAlternative(done, [done, pick], notes)).toEqual({
                assumption: 1,
                alternative: 'switch',
                by: { run: 'p', number: 2, by: 'dev:f', at: at(5) },
            });
        }
    });

    test('none while no later run took over, and when it was not a pick (applied again, or a note of its own)', () => {
        expect(pickedAlternative(done, [done], notes)).toBeUndefined();
        expect(pickedAlternative(done, [done, run('p', 5, ['m1'], { state: 'Queued' })], notes)).toBeUndefined();
        expect(pickedAlternative(done, [done, run('p', 5, ['m1'], { state: 'Queued' }, { note: 'Without tax, please.' })], notes)).toBeUndefined();
    });

    test('a run of a reply to it takes over without a pick: none, unless its note is a pick', () => {
        const replying = (note?: string): RunJson =>
            ({
                ...run('r', 5, [], { state: 'Queued' }, note === undefined ? {} : { note }),
                input: { requests: [{ ...frozen('m7'), replyTo: 'd' }], ...(note !== undefined && { note }) },
            }) as unknown as RunJson;
        expect(pickedAlternative(done, [done, replying()], notes)).toBeUndefined();
        expect(pickedAlternative(done, [done, replying(notes[0]('The amount is fixed', 'Without tax'))], notes)?.alternative).toBe('net');
    });

    test('a pick cancelled before it started does not count', () => {
        const note = notes[0]('The amount is fixed', 'Without tax');
        const undone = run('p', 5, ['m1'], { state: 'Cancelled', cancelledAt: at(6), cancelledBy: 'dev:f' }, { note });
        expect(pickedAlternative(done, [done, undone], notes)).toBeUndefined();
    });

    test('a run’s number: by when it was queued, from 1', () => {
        const later = run('z', 9, ['m2'], { state: 'Queued' });
        expect(runNumber([later, done], 'z')).toBe(2);
        expect(runNumber([later, done], 'd')).toBe(1);
    });
});
