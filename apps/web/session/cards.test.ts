import { describe, expect, test } from 'bun:test';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { cardMenuItems, obstacleText, queueAhead, quoteDisplay, type CardRun } from './cards';
import { MESSAGES } from '../i18n';

type RunJson = SessionStateBody['runs'][number];

const run = (id: string, state: object, reverts?: string): RunJson =>
    ({
        id,
        session: 's',
        input: { requests: [{ request: `m-${id}`, author: 'dev:a', targets: [], body: 'x', ...(reverts && { reverts }) }] },
        queuedBy: 'dev:f',
        queuedAt: '2026-11-03T09:00:00.000Z',
        ...state,
    }) as unknown as RunJson;
const changed = run('r', { state: 'Completed', baseRevision: 'b', resultRevision: 'c', changed: true });

describe("a card's menu", () => {
    test('この作業を打ち消す and 変更を見る for a unit that changed files, while the collab is open', () => {
        expect(cardMenuItems(changed, [changed], true)).toEqual(['revert', 'changes']);
        // a mechanical revert and a run failed by the rule with a result are units that changed files too
        const reverted = run('v', { state: 'Reverted', baseRevision: 'c', resultRevision: 'd' }, 'x');
        expect(cardMenuItems(reverted, [reverted], true)).toEqual(['revert', 'changes']);
        const failed = run('f', { state: 'Failed', reason: 'RuleNotMet', baseRevision: 'b', resultRevision: 'c' });
        expect(cardMenuItems(failed, [failed], true)).toEqual(['revert', 'changes']);
    });

    test('no menu for a unit that changed nothing, or has no result', () => {
        expect(cardMenuItems(run('n', { state: 'Completed', baseRevision: 'b', resultRevision: 'b', changed: false }), [], true)).toEqual([]);
        expect(cardMenuItems(run('q', { state: 'Queued' }), [], true)).toEqual([]);
        expect(cardMenuItems(run('c', { state: 'Cancelled', baseRevision: 'b' }), [], true)).toEqual([]);
    });

    test('変更を見る only once it is reverted or being reverted, or the collab ended', () => {
        const pending = run('u', { state: 'Queued' }, 'r');
        expect(cardMenuItems(changed, [changed, pending], true)).toEqual(['changes']);
        const reverted = run('u', { state: 'Reverted', baseRevision: 'c', resultRevision: 'e' }, 'r');
        expect(cardMenuItems(changed, [changed, reverted], true)).toEqual(['changes']);
        expect(cardMenuItems(changed, [changed], false)).toEqual(['changes']);
        // a revert that failed can be asked again
        const failed = run('u', { state: 'Failed', reason: 'AgentError', baseRevision: 'c' }, 'r');
        expect(cardMenuItems(changed, [changed, failed], true)).toEqual(['revert', 'changes']);
    });
});

describe('a queued run and why a revert waits for the AI', () => {
    const revert = (state: object): RunJson => run('v', state, 'r');
    const running = run('a', { state: 'Running', baseRevision: 'b', startedAt: '2026-11-03T09:01:00.000Z' });
    const before = run('b', { state: 'Queued' });

    test('queued behind the run in progress and the queued ones before it; nothing ahead once they are gone', () => {
        const queued = revert({ state: 'Queued' });
        expect(queueAhead('v', [changed, running, before, queued])).toBe(2);
        expect(queueAhead('b', [changed, running, before, queued])).toBe(1);
        expect(queueAhead('v', [changed, queued])).toBe(0);
        // a revert left to the AI still waits its turn
        expect(queueAhead('v', [running, revert({ state: 'Queued', revertObstacle: { kind: 'Unreadable' } })])).toBe(1);
    });

    test('nothing to count unless it is queued, or while the page does not have it', () => {
        expect(queueAhead('a', [running, before])).toBeUndefined();
        expect(queueAhead('v', [revert({ state: 'Reverted', baseRevision: 'c', resultRevision: 'd', changed: true })])).toBeUndefined();
        expect(queueAhead('v', [changed])).toBeUndefined();
    });

    test('why it went to the AI, in words (the tooltip on its state)', () => {
        const ja = MESSAGES.ja.session.chat.revertObstacle;
        expect(obstacleText({ kind: 'Conflict', paths: ['a.dt', 'b.dtes'] }, ja)).toBe(ja.conflict('a.dt, b.dtes'));
        expect(obstacleText({ kind: 'Check', newDtErrors: 1, unparsedDtes: [] } as never, ja)).toBe(ja.check);
        expect(obstacleText({ kind: 'Unreadable' }, ja)).toBe(ja.unreadable);
    });
});

describe('the quotes of the messages a run applied', () => {
    const cardRun = (r: RunJson, progress?: 'Done'): CardRun =>
        ({
            run: r,
            number: 1,
            quotes: r.input.requests.map((request) => ({ request, ...(progress && { progress }) })),
            message: { kind: 'queued' },
            at: r.queuedAt,
        }) as unknown as CardRun;

    test('quoted on the first run, and on a later one that says what it did of them', () => {
        const first = cardRun(run('a', { state: 'Queued' }));
        expect(quoteDisplay([first], 0)).toEqual({ quotes: true, perRequest: false });
        const again = cardRun({ ...run('b', { state: 'Completed' }), input: first.run.input } as RunJson);
        expect(quoteDisplay([first, again], 1)).toEqual({ quotes: false, perRequest: false });
        const done = cardRun({ ...run('b', { state: 'Completed' }), input: first.run.input } as RunJson, 'Done');
        expect(quoteDisplay([first, done], 1)).toEqual({ quotes: true, perRequest: false });
    });

    test('never in Solo: the only person asked them all', () => {
        const first = cardRun(run('a', { state: 'Queued' }));
        const done = cardRun({ ...run('b', { state: 'Completed' }), input: first.run.input } as RunJson, 'Done');
        expect(quoteDisplay([first], 0, true)).toEqual({ quotes: false, perRequest: false });
        expect(quoteDisplay([first, done], 1, true)).toEqual({ quotes: false, perRequest: false });
    });
});
