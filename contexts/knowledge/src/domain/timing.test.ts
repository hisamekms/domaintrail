// When a session's knowledge is extracted (ADR 0031, section 3): 30 s after a person's message without another, right
// after the AI's answer, at the end; at most once a minute, one at a time; held operations settled on their own.
import { describe, expect, test } from 'bun:test';
import { decideExtraction, type TalkState } from './timing.js';

const timing = { quietMs: 30_000, minIntervalMs: 60_000 };
const t = (s: number): Date => new Date(Date.UTC(2026, 10, 5, 9, 0, 0) + s * 1000);
const talk = (over: Partial<TalkState> = {}): TalkState => ({ personWaiting: false, running: false, ended: false, endDone: false, ...over });

describe('the timing of the extraction', () => {
    test('nothing new: nothing to do', () => {
        expect(decideExtraction(talk(), t(0), timing)).toEqual({ kind: 'idle' });
    });

    test("a person's message: wait until 30 s pass without a message, then extract", () => {
        const state = talk({ personWaiting: true, lastMessageAt: t(10) });
        expect(decideExtraction(state, t(20), timing)).toEqual({ kind: 'wait', at: t(40) });
        expect(decideExtraction(state, t(40), timing)).toEqual({ kind: 'extract', trigger: 'quiet' });
        // another message moves the quiet on
        expect(decideExtraction({ ...state, lastMessageAt: t(35) }, t(40), timing)).toEqual({ kind: 'wait', at: t(65) });
    });

    test("the AI's answer: at once", () => {
        expect(decideExtraction(talk({ answeredAt: t(5), lastMessageAt: t(5) }), t(5), timing)).toEqual({ kind: 'extract', trigger: 'answer' });
        // the answer comes first, before the person's quiet
        const both = talk({ personWaiting: true, answeredAt: t(12), lastMessageAt: t(12) });
        expect(decideExtraction(both, t(12), timing)).toEqual({ kind: 'extract', trigger: 'answer' });
    });

    test('at most one per minute: a trigger before then waits for it', () => {
        const state = talk({ lastExtractionAt: t(0), answeredAt: t(20), lastMessageAt: t(20) });
        expect(decideExtraction(state, t(20), timing)).toEqual({ kind: 'wait', at: t(60) });
        expect(decideExtraction(state, t(60), timing)).toEqual({ kind: 'extract', trigger: 'answer' });
        const quiet = talk({ lastExtractionAt: t(0), personWaiting: true, lastMessageAt: t(5) });
        expect(decideExtraction(quiet, t(35), timing)).toEqual({ kind: 'wait', at: t(60) });
    });

    test('one at a time: while one runs, nothing', () => {
        expect(decideExtraction(talk({ running: true, answeredAt: t(0) }), t(10), timing)).toEqual({ kind: 'idle' });
        expect(decideExtraction(talk({ running: true, ended: true, personWaiting: true }), t(10), timing)).toEqual({ kind: 'idle' });
    });

    test('the session end: at once, whatever the interval; what is held is settled; once', () => {
        expect(decideExtraction(talk({ ended: true, personWaiting: true, lastExtractionAt: t(0), lastMessageAt: t(1) }), t(2), timing)).toEqual({
            kind: 'extract',
            trigger: 'end',
        });
        expect(decideExtraction(talk({ ended: true, settleAt: t(500) }), t(2), timing)).toEqual({ kind: 'settle' });
        expect(decideExtraction(talk({ ended: true }), t(2), timing)).toEqual({ kind: 'idle' });
        expect(decideExtraction(talk({ ended: true, endDone: true, personWaiting: true }), t(2), timing)).toEqual({ kind: 'idle' });
    });

    test('held operations settle when their time comes, the earlier of that and an extraction waited for', () => {
        expect(decideExtraction(talk({ settleAt: t(120) }), t(60), timing)).toEqual({ kind: 'wait', at: t(120) });
        expect(decideExtraction(talk({ settleAt: t(120) }), t(120), timing)).toEqual({ kind: 'settle' });
        expect(decideExtraction(talk({ settleAt: t(120), personWaiting: true, lastMessageAt: t(70) }), t(80), timing)).toEqual({ kind: 'wait', at: t(100) });
        // an extraction due goes first: it settles what it can itself
        expect(decideExtraction(talk({ settleAt: t(100), answeredAt: t(100) }), t(130), timing)).toEqual({ kind: 'extract', trigger: 'answer' });
    });
});
