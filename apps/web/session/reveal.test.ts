// How what arrives in the chat is revealed: the history clamped and what arrives live in full, and where the stream
// scrolls when the AI's answer arrives.
import { describe, expect, test } from 'bun:test';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { arrival, clamps, createRevealStore, followTop, revealKeys } from './reveal';

type State = Pick<SessionStateBody, 'requests' | 'proposals' | 'runs'>;

const state = (requests: string[], proposals: string[], runs: [string, string][]): State =>
    ({
        requests: requests.map((id) => ({ id })),
        proposals: proposals.map((id) => ({ id })),
        runs: runs.map(([id, s]) => ({ id, state: s })),
    }) as unknown as State;

describe('the history clamped, what arrives live in full', () => {
    test('the texts a state holds: its messages, its proposals, and the replies of runs no longer queued or running', () => {
        const keys = revealKeys(
            state(
                ['m1', 'a1'],
                ['p1'],
                [
                    ['r1', 'Completed'],
                    ['r2', 'Running'],
                    ['r3', 'Queued'],
                    ['r4', 'Declined'],
                ],
            ),
        );
        expect(keys).toEqual(['message:m1', 'message:a1', 'proposal:p1', 'run:r1', 'run:r4']);
    });

    test('a text there at load is clamped until it is opened; one that arrived live never is', () => {
        const history = new Set(['message:old']);
        expect(clamps('message:old', history, new Set())).toBe(true);
        expect(clamps('message:old', history, new Set(['message:old']))).toBe(false);
        expect(clamps('message:new', history, new Set())).toBe(false);
    });

    test('the history is what the page first had of the session: what arrives later is not added to it', () => {
        const store = createRevealStore();
        const first = store.history('s', () => ['message:a']);
        expect(store.history('s', () => ['message:a', 'message:b'])).toBe(first);
        expect([...first]).toEqual(['message:a']);
        // another session (another page's state) has its own
        expect([...store.history('t', () => ['message:c'])]).toEqual(['message:c']);
    });

    test('a reload is a new record: everything there then is history', () => {
        const before = createRevealStore();
        before.history('s', () => ['message:a']);
        before.opened.add('message:a');
        const after = createRevealStore();
        const history = after.history('s', () => ['message:a', 'message:b']);
        expect(clamps('message:a', history, after.opened)).toBe(true);
        expect(clamps('message:b', history, after.opened)).toBe(true);
    });

    test('a run still running at load has its reply arrive live', () => {
        const store = createRevealStore();
        const history = store.history('s', () => revealKeys(state([], [], [['r1', 'Running']])));
        expect(clamps('run:r1', history, store.opened)).toBe(false);
    });
});

describe('the scroll as the AI answers', () => {
    test('at the bottom: the stream follows it; scrolled up: a pill, unless its head is in sight', () => {
        expect(arrival(true, true)).toBe('follow');
        expect(arrival(true, false)).toBe('follow');
        expect(arrival(false, false)).toBe('pill');
        expect(arrival(false, true)).toBe('none');
    });

    test('following goes to the bottom, but not past the head of the answer', () => {
        // a short answer: all of it fits, the bottom
        expect(followTop(100, 180, 200)).toBe(180);
        // a long one: its head at the top, the rest below
        expect(followTop(100, 900, 200)).toBe(200);
        // no answer to keep: the bottom
        expect(followTop(100, 900, undefined)).toBe(900);
    });

    test('following never scrolls back up', () => {
        expect(followTop(300, 900, 200)).toBe(300);
    });
});
