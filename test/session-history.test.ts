import { describe, expect, test } from 'bun:test';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { changedPaths, changeUnits, shownUnits } from '@domaintrail/web/session/history';
import { latestAt, streamItems, unreadCount } from '@domaintrail/web/session/stream';

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

    test('failed, declined and cancelled runs are units of their own, without files', () => {
        const failed = run('run1', 1, [qa], { state: 'Failed', baseRevision: 'r0', startedAt: at(1), reason: 'AgentError', finishedAt: at(2) });
        const cancelled = run('run2', 3, [qa], { state: 'Cancelled', cancelledBy: 'local:facilitator', cancelledAt: at(4) });
        const units = changeUnits({ runs: [failed, cancelled], revisions });
        expect(units.map((u) => [u.key, u.outcome, u.files])).toEqual([
            ['run2', 'cancelled', undefined],
            ['run1', 'failed', undefined],
        ]);
        expect(shownUnits(units, false)).toEqual([]);
    });
});

describe('the floating chat button', () => {
    test('counts the runs queued, the notes and the messages of the agent since the chat was last shown', () => {
        const items = streamItems({
            revisions,
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
        expect(unreadCount(items, at(3))).toBe(3);
        expect(unreadCount(items, at(5))).toBe(0);
    });
});
