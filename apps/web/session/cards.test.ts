import { describe, expect, test } from 'bun:test';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { cardMenuItems } from './cards';

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
    test('この作業を打ち消す… and 変更を見る for a unit that changed files, while the collab is open', () => {
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
