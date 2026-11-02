import { describe, expect, test } from 'bun:test';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { answerBody } from './actions';
import { cardRuns, messageMarks, quoteDisplay, updatedCards } from './cards';
import { changedPaths, changeUnits, cutList, requestersOf, requestHead, shownUnits, unitName } from './history';
import { latestAt, revisionLookup, streamItems, unreadCount } from './stream';

type RunJson = SessionStateBody['runs'][number];
type RequestJson = SessionStateBody['requests'][number];
type RevisionJson = SessionStateBody['revisions'][number];

const at = (minute: number): string => `2026-10-31T09:${String(minute).padStart(2, '0')}:00.000Z`;
const v = { dtErrors: 0, dtesErrors: 0, dtesWarnings: 0, linkWarnings: 0, stale: false };
const rev = (id: string, minute: number, files: Record<string, string>): RevisionJson =>
    ({
        id,
        session: 's',
        origin: { kind: 'Manual', by: 'x' },
        contentHash: id,
        files: Object.entries(files).map(([path, hash]) => ({ path, hash, language: 'Dt' })),
        validation: v,
        takenAt: at(minute),
        state: 'Recorded',
    }) as unknown as RevisionJson;
const request = (id: string, author: string): RequestJson =>
    ({ id, session: 's', author, targets: [], body: `body of ${id}`, sentAt: at(0), state: 'Sent' }) as unknown as RequestJson;
const frozen = (r: RequestJson): RunJson['input']['requests'][number] => ({ request: r.id, author: r.author, targets: r.targets, body: r.body });
const run = (id: string, minute: number, requests: RequestJson[], state: object, input: object = {}): RunJson =>
    ({
        id,
        session: 's',
        input: { requests: requests.map(frozen), ...input },
        queuedBy: 'local:facilitator',
        queuedAt: at(minute),
        ...state,
    }) as unknown as RunJson;
const reply = (summary: string): object => ({ reply: { outcome: 'done', summary, requests: [], questions: [], assumptions: [] } });

const revisions = [
    rev('r0', 0, { 'a.dt': '1', 'b.dt': '1' }),
    rev('r1', 3, { 'a.dt': '2', 'b.dt': '1' }),
    rev('r2', 6, { 'a.dt': '3', 'b.dt': '2', 'c.dt': '1' }),
];
const qa = request('qa', 'dev:a');
const qb = request('qb', 'dev:b');
const qc = request('qc', 'dev:a');

describe('the history of changes', () => {
    test('the paths two revisions differ by: changed, added and removed', () => {
        expect([...(changedPaths(revisions[0], revisions[2]) ?? [])].sort()).toEqual(['a.dt', 'b.dt', 'c.dt']);
        expect([...(changedPaths(revisions[2], revisions[0]) ?? [])].sort()).toEqual(['a.dt', 'b.dt', 'c.dt']);
        expect(changedPaths(revisions[1], revisions[1])?.size).toBe(0);
        expect(changedPaths(undefined, revisions[1])).toBeUndefined();
    });

    test('a run that asked, and the run queued again with the same requests, are one unit; the files counted once', () => {
        const asked = run('run1', 1, [qa, qb], {
            state: 'NeedsClarification',
            baseRevision: 'r0',
            startedAt: at(1),
            question: 'Which one?',
            resultRevision: 'r1',
            finishedAt: at(3),
        });
        const answered = run(
            'run2',
            4,
            [qa, qb],
            {
                state: 'Completed',
                baseRevision: 'r1',
                startedAt: at(4),
                resultRevision: 'r2',
                changed: true,
                report: {},
                finishedAt: at(6),
                ...reply('Did it.'),
            },
            { note: 'The first.' },
        );
        const other = run('run3', 7, [qc], {
            state: 'Completed',
            baseRevision: 'r2',
            startedAt: at(7),
            resultRevision: 'r2',
            changed: false,
            report: {},
            finishedAt: at(8),
        });
        const units = changeUnits({ runs: [other, answered, asked], revisions });
        expect(units.map((u) => [u.key, u.runs.map((r) => r.number), u.outcome, u.files])).toEqual([
            ['run3', [3], 'unchanged', 0],
            ['run1', [1, 2], 'changed', 3],
        ]);
        expect(units[1]).toMatchObject({ at: at(6), summary: 'Did it.', requesters: ['dev:a', 'dev:b'] });
        // by default, only the units that changed files
        expect(shownUnits(units, false).map((u) => u.key)).toEqual(['run1']);
        expect(shownUnits(units, true).map((u) => u.key)).toEqual(['run3', 'run1']);
    });

    test('a run answering another (answerTo) joins its unit, whatever its requests; one after a completed run does not', () => {
        const asked = run('run1', 1, [qa], {
            state: 'NeedsClarification',
            baseRevision: 'r0',
            startedAt: at(1),
            question: 'Which one?',
            resultRevision: 'r0',
            finishedAt: at(2),
        });
        const answer = { answer: { answerTo: 'run1', answers: [{ question: 'q1', text: 'Which one?', chosen: [{ id: 'o1', label: 'This' }] }] } };
        const answering = run('run2', 3, [qb], { state: 'Running', baseRevision: 'r0', startedAt: at(4) }, answer);
        const again = run('run3', 5, [qb], { state: 'Queued' });
        const units = changeUnits({ runs: [asked, answering, again], revisions });
        expect(units.map((u) => [u.key, u.runs.map((r) => r.run.id), u.outcome])).toEqual([
            ['run3', ['run3'], 'queued'],
            ['run1', ['run1', 'run2'], 'running'],
        ]);
        // the question is what a unit waiting for an answer says
        expect(changeUnits({ runs: [asked], revisions })[0]).toMatchObject({ outcome: 'clarification', summary: 'Which one?', files: 0 });
    });

    test('the same messages queued again after a completed run continue its card; after a failure or a cancel they start one', () => {
        const failed = run('run1', 1, [qa], { state: 'Failed', baseRevision: 'r0', startedAt: at(1), reason: 'AgentError', finishedAt: at(2) });
        const cancelled = run('run2', 3, [qa], { state: 'Cancelled', cancelledBy: 'local:facilitator', cancelledAt: at(4) });
        const units = changeUnits({ runs: [failed, cancelled], revisions });
        expect(units.map((u) => [u.key, u.outcome, u.files])).toEqual([
            ['run2', 'cancelled', undefined],
            ['run1', 'failed', undefined],
        ]);
        expect(shownUnits(units, false)).toEqual([]);
        const done = run('run1', 1, [qa, qb], {
            state: 'Completed',
            baseRevision: 'r0',
            startedAt: at(1),
            resultRevision: 'r1',
            changed: true,
            report: {},
            finishedAt: at(2),
        });
        const alternative = run('run2', 3, [qb, qa], { state: 'Queued' }, { note: 'The other way.' });
        const fewer = run('run3', 4, [qa], { state: 'Queued' });
        expect(changeUnits({ runs: [done, alternative, fewer], revisions }).map((u) => u.runs.map((r) => r.number))).toEqual([[3], [1, 2]]);
        expect(changeUnits({ runs: [done, alternative], revisions })[0].start).toBe(at(1));
        // an alternative picked joins the card of the run it picked from (`pick.pickOf`)
        const picked = run(
            'run4',
            5,
            [qa, qb],
            { state: 'Queued' },
            { pick: { pickOf: 'run1', assumption: 0, text: 'x', alternative: { id: 'a', label: 'A' } } },
        );
        expect(changeUnits({ runs: [done, fewer, picked], revisions }).map((u) => u.runs.map((r) => r.number))).toEqual([[1, 3], [2]]);
    });

    describe('a chunk is named, not numbered', () => {
        const titled = (title: string | undefined, summary: string): object => ({
            reply: { ...(title !== undefined && { title }), outcome: 'done', summary, requests: [], questions: [], assumptions: [] },
        });
        const completed = (minute: number, base: string, result: string, more: object = {}): object => ({
            state: 'Completed',
            baseRevision: base,
            startedAt: at(minute),
            resultRevision: result,
            changed: base !== result,
            report: {},
            finishedAt: at(minute + 1),
            ...more,
        });
        const asking = (minute: number, base: string, result: string, title?: string): object => ({
            state: 'NeedsClarification',
            baseRevision: base,
            startedAt: at(minute),
            question: 'Which?',
            resultRevision: result,
            finishedAt: at(minute + 1),
            reply: { ...(title !== undefined && { title }), outcome: 'clarification', summary: 'Which?', requests: [], questions: [], assumptions: [] },
        });

        test("its title is the first run's that has one; the runs continuing it never rename it", () => {
            const first = run('run1', 1, [qa, qb], asking(1, 'r0', 'r1', '請求書の税区分'));
            const second = run('run2', 3, [qa, qb], completed(3, 'r1', 'r2', titled('別の題', 'Done.')));
            const [unit] = changeUnits({ runs: [first, second], revisions });
            expect(unit.title).toBe('請求書の税区分');
            expect(unitName(unit)).toEqual({ kind: 'title', text: '請求書の税区分' });
            // the first run without a title (it asked before titles, or is still running): the next run's title names it
            const untitledFirst = run('run1', 1, [qa, qb], asking(1, 'r0', 'r1'));
            expect(changeUnits({ runs: [untitledFirst, second], revisions })[0].title).toBe('別の題');
        });

        test('without any title (legacy replies, or no reply yet): the head of the first message, on one line, mentions as names', () => {
            const mentioning = {
                ...request('qm', 'dev:a'),
                body: '#請求書[1] の\n税区分を  @佐藤[p1] と見直す',
                targets: [{ target: { kind: 'DtElement', element: 'Billing.Invoice' }, sourceRevision: 'r0', label: '請求書' }],
            } as unknown as RequestJson;
            const legacy = run(
                'run1',
                1,
                [mentioning, qb],
                completed(1, 'r0', 'r1', { reply: { summary: 'Done.', requests: [], questions: [], assumptions: [] } }),
            );
            const [unit] = changeUnits({ runs: [legacy], revisions });
            expect(unit.title).toBeUndefined();
            expect(unitName(unit)).toEqual({ kind: 'request', text: '請求書 の 税区分を 佐藤 と見直す' });
            // a token past the request's targets stays as written; one written before `#`, with `@`, is an element too
            expect(requestHead({ body: '#x[2] stays', targets: [] })).toBe('#x[2] stays');
            expect(requestHead({ body: '@請求書[1] old', targets: mentioning.targets })).toBe('請求書 old');
            const queued = run('run2', 2, [qc], { state: 'Queued' });
            expect(unitName(changeUnits({ runs: [queued], revisions })[0])).toEqual({ kind: 'request', text: 'body of qc' });
        });

        test("the heading's facts: whose requests (the first run's), how many runs, the files changed across the chunk and its span", () => {
            const first = run('run1', 1, [qa, qb], asking(1, 'r0', 'r1', 't'));
            // a reply by someone else continues the chunk: it is still the first run's requesters' chunk
            const qd = request('qd', 'dev:d');
            const second = run('run2', 3, [qa, qb], completed(3, 'r1', 'r2'));
            const third = run('run3', 8, [qd], completed(8, 'r2', 'r2'), { requests: [{ ...frozen(qd), replyTo: { kind: 'Run', run: 'run2' } }] });
            const [unit] = changeUnits({ runs: [first, second, third], revisions });
            expect(unit.runs.map((r) => r.run.id)).toEqual(['run1', 'run2', 'run3']);
            expect(unit.requesters).toEqual(['dev:a', 'dev:b']);
            expect(unit.paths).toEqual(['a.dt', 'b.dt', 'c.dt']);
            expect(unit.files).toBe(3);
            expect(unit.span).toEqual({ base: 'r0', result: 'r2' });
            // no run recorded revisions: neither files nor span
            const cancelled = run('run4', 9, [qc], { state: 'Cancelled', cancelledBy: 'x', cancelledAt: at(9) });
            expect(changeUnits({ runs: [cancelled], revisions })[0]).toMatchObject({ paths: undefined, span: undefined });
            // up to two people by name, else the first and how many others
            expect(requestersOf([])).toEqual({ kind: 'none' });
            expect(requestersOf(['佐藤', '鈴木'])).toEqual({ kind: 'names', names: ['佐藤', '鈴木'] });
            expect(requestersOf(['佐藤', '鈴木', '田中'])).toEqual({ kind: 'more', first: '佐藤', others: 2 });
            // the changed files on one line: the first few and 「ほか n」
            expect(cutList(['a', 'b', 'c'], 3)).toEqual({ shown: ['a', 'b', 'c'], more: 0 });
            expect(cutList(['a', 'b', 'c', 'd', 'e'], 3)).toEqual({ shown: ['a', 'b', 'c'], more: 2 });
        });
    });
});

describe('the floating chat button', () => {
    test('counts the messages sent and the cards that moved on since the chat was last shown', () => {
        const items = streamItems({
            revisions,
            requests: [qa, qb],
            runs: [
                run('run1', 1, [qa], {
                    state: 'Completed',
                    baseRevision: 'r0',
                    startedAt: at(1),
                    resultRevision: 'r1',
                    changed: true,
                    report: {},
                    finishedAt: at(3),
                }),
                run('run2', 4, [qb], { state: 'Running', baseRevision: 'r1', startedAt: at(5) }, { note: 'Go.' }),
            ],
        });
        expect(latestAt(items)).toBe(at(5));
        expect(unreadCount(items, undefined)).toBe(0);
        expect(unreadCount(items, at(2))).toBe(2);
        expect(unreadCount(items, at(3))).toBe(1);
        expect(unreadCount(items, at(5))).toBe(0);
    });
});

describe('the cards of the chat', () => {
    const asked = run('run1', 1, [qa, qb], {
        state: 'NeedsClarification',
        baseRevision: 'r0',
        startedAt: at(1),
        question: 'Which?',
        resultRevision: 'r1',
        finishedAt: at(3),
        reply: {
            outcome: 'clarification',
            summary: 'Which one?',
            requests: [
                { request: 'qa', status: 'Done' },
                { request: 'qb', status: 'Question', note: 'Which total?' },
            ],
            questions: [{ id: 'x', text: 'Which total?', requests: ['qb'], options: [{ id: 'gross', label: 'Gross' }], multiple: false }],
            assumptions: [],
        },
    });
    const answer = { answerTo: 'run1', answers: [{ question: 'x', text: 'Which total?', chosen: [{ id: 'gross', label: 'Gross' }] }] };
    const answered = run('run2', 4, [qa, qb], { state: 'Running', baseRevision: 'r1', startedAt: at(5) }, { answer });

    test('a card holds its runs one under the other: the quotes with what the reply says of each, the note or answer, the agent', () => {
        const [unit] = changeUnits({ runs: [asked, answered], revisions });
        const runs = cardRuns(unit, revisionLookup({ revisions, runs: [asked, answered] }));
        expect(runs.map((r) => [r.number, r.message.kind])).toEqual([
            [1, 'clarification'],
            [2, 'running'],
        ]);
        expect(runs[0].quotes).toEqual([
            { request: frozen(qa), progress: 'Done' },
            { request: frozen(qb), progress: 'Question', note: 'Which total?' },
        ]);
        expect(runs[1]).toMatchObject({ answer, quotes: [{ request: frozen(qa) }, { request: frozen(qb) }] });
    });

    test('a run quotes its messages unless the run before applied the same; a line per message only for several', () => {
        const [unit] = changeUnits({ runs: [asked, answered], revisions });
        const runs = cardRuns(unit, revisionLookup({ revisions, runs: [asked, answered] }));
        expect(quoteDisplay(runs, 0)).toEqual({ quotes: true, perRequest: true });
        expect(quoteDisplay(runs, 1)).toEqual({ quotes: false, perRequest: true });
        const one = run('run3', 9, [qc], { state: 'Failed', baseRevision: 'r0', startedAt: at(9), reason: 'AgentError', finishedAt: at(10) });
        const [single] = changeUnits({ runs: [one], revisions });
        expect(quoteDisplay(cardRuns(single, revisionLookup({ revisions, runs: [one] })), 0)).toEqual({ quotes: true, perRequest: false });
    });

    test("an applied message shows its latest run's state, and the card it is on with its name; a message never applied none", () => {
        const units = changeUnits({ runs: [asked], revisions });
        expect(Object.fromEntries(messageMarks(units))).toEqual({
            qa: { state: 'done', card: 'run1', name: 'body of qa' },
            qb: { state: 'question', card: 'run1', name: 'body of qa' },
        });
        const later = changeUnits({ runs: [asked, answered], revisions });
        expect(messageMarks(later).get('qb')).toEqual({ state: 'running', card: 'run1', name: 'body of qa' });
        expect(messageMarks(later).has('qc')).toBe(false);
        const failed = run('run3', 9, [qc], { state: 'Failed', baseRevision: 'r0', startedAt: at(9), reason: 'AgentError', finishedAt: at(10) });
        expect(messageMarks(changeUnits({ runs: [failed], revisions })).get('qc')).toEqual({ state: 'failed', card: 'run3', name: 'body of qc' });
    });

    test('the cards that moved on since the reader last saw them', () => {
        const seen = new Map([
            ['card:a', at(1)],
            ['card:b', at(2)],
        ]);
        expect(
            updatedCards(
                [
                    { key: 'card:a', updatedAt: at(1) },
                    { key: 'card:b', updatedAt: at(4) },
                    { key: 'card:c', updatedAt: at(5) },
                ],
                seen,
            ),
        ).toEqual(['card:b']);
    });

    test("the facilitator's answer: the questions answered only, by option or in own words", () => {
        const questions = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
        expect(
            answerBody(questions, {
                x: { options: ['gross'] },
                y: { options: [], other: true, text: '  net, after discounts ' },
                z: { options: [], other: true, text: ' ' },
            }),
        ).toEqual({
            answers: [
                { question: 'x', options: ['gross'] },
                { question: 'y', options: [], text: 'net, after discounts' },
            ],
        });
        expect(answerBody(questions, {})).toBeUndefined();
    });

    test("the facilitator's answer: その他 counts only while it is selected with words", () => {
        const questions = [{ id: 'x' }, { id: 'y', multiple: true }];
        // written, then an option chosen: the words are kept but not sent
        expect(answerBody(questions, { x: { options: ['gross'], other: false, text: 'net' } })).toEqual({
            answers: [{ question: 'x', options: ['gross'] }],
        });
        expect(answerBody(questions, { x: { options: [], other: false, text: 'net' }, y: { options: [], text: 'both' } })).toBeUndefined();
        // selected without words: as if not selected
        expect(answerBody(questions, { x: { options: [], other: true, text: '   ' } })).toBeUndefined();
        expect(answerBody(questions, { y: { options: ['a'], other: true } })).toEqual({ answers: [{ question: 'y', options: ['a'] }] });
    });

    test("the facilitator's answer: one option or own words for a single-choice question, both for a multiple-choice one", () => {
        const questions = [
            { id: 'x', multiple: false },
            { id: 'y', multiple: true },
        ];
        expect(
            answerBody(questions, {
                x: { options: ['gross'], other: true, text: 'net' },
                y: { options: ['a', 'b'], other: true, text: ' and c ' },
            }),
        ).toEqual({
            answers: [
                { question: 'x', options: [], text: 'net' },
                { question: 'y', options: ['a', 'b'], text: 'and c' },
            ],
        });
        // a single-choice question never sends more than one option
        expect(answerBody(questions, { x: { options: ['gross', 'net'] } })).toEqual({ answers: [{ question: 'x', options: ['gross'] }] });
    });
});
