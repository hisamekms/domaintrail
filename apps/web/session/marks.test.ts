import { describe, expect, test } from 'bun:test';
import { VOTE } from '@domaintrail/collaboration';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { canVote, markIndex, names, quickReactions, reaction, reactionFits, reactionsOn, tallyOf } from './marks';
import { applyEvent } from './state';

/** As many different emoji as a message or a turn holds. */
const TWENTY: readonly string[] = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊', '😋', '😎', '😍', '😘', '🥰', '😗', '😙', '🥲', '😚', '🙂'];

/** A run as the state holds it (the rules' view of one: contexts/collaboration/src/domain/marks.test.ts). */
const run = (id: string, state: string, requests: string[], over: object = {}): object => ({
    id,
    state,
    input: { requests: requests.map((request) => ({ request })) },
    baseRevision: state === 'Queued' ? undefined : 'base',
    ...over,
});
const asking = {
    questions: [
        { id: 'q1', multiple: false, options: [{ id: 'a' }, { id: 'b' }] },
        { id: 'q2', multiple: true, options: [{ id: 'x' }, { id: 'y' }] },
    ],
    assumptions: [],
};

describe("the page's derivations", () => {
    type MarkJson = SessionStateBody['marks'][number];
    const mark = (id: string, participant: string, target: MarkJson['target'], sign: MarkJson['sign']): MarkJson => ({
        state: 'Placed',
        id,
        session: 's',
        participant,
        target,
        sign,
        placedAt: '2026-11-01T09:00:00.000Z',
    });
    const message = { kind: 'Message', request: 'm1' } as const;
    const marks = [
        mark('1', 'ann', message, reaction('❤️')),
        mark('2', 'bob', message, reaction('👍')),
        mark('3', 'me', message, reaction('👍')),
        mark('4', 'ann', { kind: 'QuestionOption', run: 'r1', question: 'q1', option: 'a' }, VOTE),
        mark('5', 'bob', { kind: 'QuestionOption', run: 'r1', question: 'q1', option: 'a' }, VOTE),
    ];
    const nameOf = (id: string): string => id.toUpperCase();

    test('counts, who in the order they marked, and mine; the emoji in the order each first appeared', () => {
        const index = markIndex({ marks }, 'me');
        expect(tallyOf(index, message, reaction('👍'))).toEqual({ count: 2, who: ['bob', 'me'], mine: true });
        expect(tallyOf(index, message, reaction('👀'))).toEqual({ count: 0, who: [], mine: false });
        expect(reactionsOn(index, message).map((r) => [r.emoji, r.tally.count, r.tally.mine])).toEqual([
            ['❤️', 1, false],
            ['👍', 2, true],
        ]);
        // votes are not reactions
        expect(reactionsOn(index, { kind: 'QuestionOption', run: 'r1', question: 'q1', option: 'a' })).toEqual([]);
        expect(names(tallyOf(index, message, reaction('👍')), nameOf, '、')).toBe('BOB、ME');
        // a state from before marks has none
        expect(markIndex({} as Pick<SessionStateBody, 'marks'>, 'me').size).toBe(0);
    });

    test('whether an emoji fits: any while a target has fewer than the limit, then only those there', () => {
        const full = markIndex({ marks: TWENTY.map((e, i) => mark(String(i), 'ann', message, reaction(e))) }, 'me');
        expect(reactionFits(full, message, '😀')).toBe(true);
        expect(reactionFits(full, message, '🙃')).toBe(false);
        expect(reactionFits(markIndex({ marks }, 'me'), message, '🙃')).toBe(true);
    });

    test("the quick reactions: the session's, or the default ones (a state from before them)", () => {
        expect(quickReactions({ quickReactions: ['🔥', '✅'] })).toEqual(['🔥', '✅']);
        expect(quickReactions({})).toEqual(['👍', '👀', '🤔', '🎉', '❤️', '🙏']);
    });

    test('a participant votes while the run waits; the facilitator and a closed session only see', () => {
        const state = { requests: [{ id: 'm1' }], runs: [run('r1', 'NeedsClarification', ['m1'], { reply: asking })] } as unknown as Pick<
            SessionStateBody,
            'requests' | 'runs'
        >;
        const target = { kind: 'QuestionOption', run: 'r1', question: 'q1', option: 'a' } as const;
        expect(canVote(target, state, 'participant', true)).toBe(true);
        expect(canVote(target, state, 'facilitator', true)).toBe(false);
        expect(canVote(target, state, 'participant', false)).toBe(false);
        expect(canVote(message, state, 'participant', true)).toBe(false);
    });

    test('mark events are applied to the state once, after its seq', () => {
        const base = { seq: 1, marks: [] } as unknown as SessionStateBody;
        const placed = {
            type: 'mark.placed',
            seq: 2,
            event: {
                type: 'MarkPlaced',
                markId: '9',
                session: 's',
                participant: 'ann',
                target: message,
                sign: reaction('❤️'),
                placedAt: '2026-11-01T09:00:00.000Z',
            },
        } as const;
        const once = applyEvent(base, placed).state;
        expect(once.marks).toEqual([mark('9', 'ann', message, reaction('❤️'))]);
        expect(applyEvent(once, placed).state).toBe(once);
        const removed = {
            type: 'mark.removed',
            seq: 3,
            event: { type: 'MarkRemoved', markId: '9', participant: 'ann', target: message, sign: reaction('❤️'), removedAt: '2026-11-01T09:01:00.000Z' },
        } as const;
        expect(applyEvent(once, removed)).toEqual({ state: { ...once, seq: 3, marks: [] }, refetch: false });
    });
});
