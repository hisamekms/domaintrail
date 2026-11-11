// Votes and reactions (ADR 0026, appendix "Votes and reactions"): the pure rules of marks and the emoji of a reaction
// (the use case and the route: test/session-marks.test.ts; the migrations: infrastructure/migrations.test.ts).
import { describe, expect, test } from 'bun:test';
import { Collaboration as C } from '../generated/index.js';
import { readEmoji } from './emoji.js';
import {
    DONE,
    exclusiveGroup,
    guideMarksOf,
    laterRunOf,
    markChange,
    markCommands,
    markKey,
    markTargetStatus,
    makeEmoji,
    MAX_REACTION_EMOJI,
    reactionRoom,
    signFits,
    signKey,
    VOTE,
    type MarkRun,
    type MarkTargetData,
} from './marks.js';
import { knownAgentRunId, knownMarkId, knownSessionId } from './ids.js';

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
    return r.value;
};
const error = <E>(r: { ok: true } | { ok: false; error: E }): E => {
    if (r.ok) throw new Error('expected an error');
    return r.error;
};

/** As many different emoji as a message or a turn holds. */
const TWENTY: readonly string[] = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊', '😋', '😎', '😍', '😘', '🥰', '😗', '😙', '🥲', '😚', '🙂'];

/** A reaction's sign with an emoji (in the form kept). */
const react = (emoji: string): C.MarkSign => ({ kind: 'Reaction', emoji: value(makeEmoji(emoji)) });

// ---- the rules ----

/** A run as the rules read it. */
const run = (id: string, state: string, requests: string[], over: Partial<MarkRun> = {}): MarkRun => ({
    id,
    state,
    input: { requests: requests.map((request) => ({ request })) },
    baseRevision: state === 'Queued' ? undefined : 'base',
    ...over,
});
const asking: MarkRun['reply'] = {
    questions: [
        { id: 'q1', multiple: false, options: [{ id: 'a' }, { id: 'b' }] },
        { id: 'q2', multiple: true, options: [{ id: 'x' }, { id: 'y' }] },
    ],
    assumptions: [],
};
const assuming: MarkRun['reply'] = { questions: [], assumptions: [{ alternatives: [{ id: 'alt1' }, { id: 'alt2' }] }] };
const option = (o: string, q = 'q1', r = 'r1'): MarkTargetData => ({ kind: 'QuestionOption', run: r, question: q, option: o });
const choice = (alternative?: string, r = 'r1', assumption = 0): MarkTargetData => ({
    kind: 'AssumptionChoice',
    run: r,
    assumption,
    ...(alternative !== undefined && { alternative }),
});

describe('one emoji (a reaction)', () => {
    test.each([
        ['👍', '👍'],
        ['❤', '❤️'],
        ['❤️', '❤️'],
        ['👨‍👩‍👧‍👦', '👨‍👩‍👧‍👦'],
        ['👍🏽', '👍🏽'],
        ['☝🏽', '☝🏽'],
        ['🇯🇵', '🇯🇵'],
        ['1⃣', '1️⃣'],
        ['#️⃣', '#️⃣'],
        ['🏳‍🌈', '🏳️‍🌈'],
        ['🏃🏽‍♂', '🏃🏽‍♂️'],
        ['🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🏴󠁧󠁢󠁳󠁣󠁴󠁿'],
        [' 🎉 ', '🎉'],
    ])('%s, kept as %s, is an Emoji', (input, kept) => {
        expect(readEmoji(input)).toBe(kept);
        expect(String(value(makeEmoji(kept)))).toBe(kept);
    });

    test('❤ and ❤️ are the same reaction: only the kept form is an Emoji', () => {
        expect(readEmoji('❤')).toBe('❤️');
        expect(error(makeEmoji('❤'))).toMatchObject({ type: 'Collaboration.InvalidEmoji', invariant: 'singleEmoji' });
        expect(error(makeEmoji('x'.repeat(65)))).toMatchObject({ invariant: 'bounded' });
    });

    test(`at most ${MAX_REACTION_EMOJI} different emoji on a target; one already there always fits; votes are not limited`, () => {
        expect(TWENTY).toHaveLength(MAX_REACTION_EMOJI);
        const placed = TWENTY.map((e) => ({ sign: react(e) }));
        expect(reactionRoom(placed.slice(1), react('🙂'))).toBe(true);
        expect(reactionRoom(placed, react('🙃'))).toBe(false);
        expect(reactionRoom(placed, react('😀'))).toBe(true);
        expect(reactionRoom(placed, VOTE)).toBe(true);
    });
});

describe('the rules of marks', () => {
    const requests = [{ id: 'm1' }, { id: 'm2' }];

    test('a key per target, equal exactly for equal targets', () => {
        expect(markKey(choice())).not.toBe(markKey(choice('alt1')));
        expect(markKey(option('a'))).toBe(markKey({ ...option('a') }));
        expect(new Set([markKey({ kind: 'Message', request: 'x' }), markKey({ kind: 'Turn', run: 'x' })]).size).toBe(2);
    });

    test('votes go on options and assumptions, reactions on messages and turns', () => {
        expect(signFits(option('a'), VOTE)).toBe(true);
        expect(signFits(choice(), VOTE)).toBe(true);
        expect(signFits(option('a'), react('❤️'))).toBe(false);
        expect(signFits({ kind: 'Message', request: 'm1' }, react('👍'))).toBe(true);
        expect(signFits({ kind: 'Turn', run: 'r1' }, VOTE)).toBe(false);
    });

    test("done goes on a step of the guide only, a step the files cannot tell; one per session, the store's key apart", () => {
        const step = { kind: 'GuideStep', journey: 'j', step: 'bcSplit' } as const;
        expect(signFits(step, DONE)).toBe(true);
        for (const sign of [VOTE, react('👍')]) expect(signFits(step, sign)).toBe(false);
        for (const target of [option('a'), { kind: 'Message', request: 'm1' } as const]) expect(signFits(target, DONE)).toBe(false);
        expect(markKey(step)).toBe('guide:j|bcSplit|');
        expect(markKey({ ...step, step: 'contexts', context: 'Sales' })).toBe('guide:j|contexts|Sales');
        expect(signKey(DONE)).toBe('Done');
        expect(markTargetStatus(step, { requests: [], runs: [] })).toBe('open');
        // a step the files tell, or none of the map's: nothing to mark
        expect(markTargetStatus({ kind: 'GuideStep', journey: 'j', step: 'events' }, { requests: [], runs: [] })).toBe('missing');
        expect(markTargetStatus({ kind: 'GuideStep', journey: 'j', step: 'nope' }, { requests: [], runs: [] })).toBe('missing');
        // a BC row, under a rows step
        expect(markTargetStatus({ kind: 'GuideStep', journey: 'j', step: 'contexts', context: 'Sales' }, { requests: [], runs: [] })).toBe('open');
        // the guide's marks among the session's
        expect(
            guideMarksOf([
                { participant: 'p', target: step, sign: DONE },
                { participant: 'p', target: { kind: 'Message', request: 'm1' }, sign: react('👍') },
            ]),
        ).toEqual([{ journey: 'j', step: 'bcSplit' }]);
        expect(exclusiveGroup(step, [])).toBeUndefined();
        expect(reactionRoom([], DONE)).toBe(true);
    });

    test("a question's options are open while its run waits for an answer and nothing took over its requests", () => {
        const r1 = run('r1', 'NeedsClarification', ['m1'], { reply: asking });
        expect(markTargetStatus(option('a'), { requests, runs: [r1] })).toBe('open');
        expect(markTargetStatus(option('zz'), { requests, runs: [r1] })).toBe('missing');
        expect(markTargetStatus(option('a', 'q9'), { requests, runs: [r1] })).toBe('missing');
        expect(markTargetStatus(option('a', 'q1', 'r9'), { requests, runs: [r1] })).toBe('missing');
        // answered: the answering run, queued or later
        const answer = run('r2', 'Queued', ['m1'], { input: { requests: [{ request: 'm1' }], answer: { answerTo: 'r1' } } });
        expect(markTargetStatus(option('a'), { requests, runs: [r1, answer] })).toBe('closed');
        // the answer cancelled before it started: as if it had never been queued, the vote opens again
        expect(markTargetStatus(option('a'), { requests, runs: [r1, { ...answer, state: 'Cancelled' }] })).toBe('open');
        // a run cancelled while running did take over
        expect(markTargetStatus(option('a'), { requests, runs: [r1, { ...answer, state: 'Cancelled', baseRevision: 'b' }] })).toBe('closed');
        // superseded by a later run of an overlapping set of requests; another request's run does not count
        expect(markTargetStatus(option('a'), { requests, runs: [r1, run('r3', 'Running', ['m2', 'm1'])] })).toBe('closed');
        expect(markTargetStatus(option('a'), { requests, runs: [r1, run('r3', 'Completed', ['m2'])] })).toBe('open');
        // an earlier run of the same requests does not close a later one
        expect(markTargetStatus(option('a'), { requests, runs: [run('r0', 'Completed', ['m1']), r1] })).toBe('open');
        // not waiting for an answer
        expect(markTargetStatus(option('a'), { requests, runs: [{ ...r1, state: 'Completed' }] })).toBe('closed');
    });

    test("an assumption's choices are open while its completed run is the latest of its requests", () => {
        const r1 = run('r1', 'Completed', ['m1'], { reply: assuming });
        expect(markTargetStatus(choice(), { requests, runs: [r1] })).toBe('open');
        expect(markTargetStatus(choice('alt2'), { requests, runs: [r1] })).toBe('open');
        expect(markTargetStatus(choice('alt9'), { requests, runs: [r1] })).toBe('missing');
        expect(markTargetStatus(choice(undefined, 'r1', 1), { requests, runs: [r1] })).toBe('missing');
        // the facilitator picked an alternative: the same requests run again with a note
        expect(markTargetStatus(choice('alt1'), { requests, runs: [r1, run('r2', 'Queued', ['m1'])] })).toBe('closed');
        expect(markTargetStatus(choice(), { requests, runs: [{ ...r1, state: 'NeedsClarification' }] })).toBe('closed');
        // the facilitator approved the assumption: its choices close; another run's approval changes nothing
        const approved = (r: string, assumption = 0) => [{ assumption: { run: r, assumption } }];
        expect(markTargetStatus(choice('alt1'), { requests, runs: [r1], approvals: approved('r1') })).toBe('closed');
        expect(markTargetStatus(choice(), { requests, runs: [r1], approvals: approved('r1') })).toBe('closed');
        expect(markTargetStatus(choice(), { requests, runs: [r1], approvals: approved('r9') })).toBe('open');
    });

    test('reactions never close; their target only has to be in the session', () => {
        const r1 = run('r1', 'Failed', ['m1']);
        expect(markTargetStatus({ kind: 'Turn', run: 'r1' }, { requests, runs: [r1, run('r2', 'Completed', ['m1'])] })).toBe('open');
        expect(markTargetStatus({ kind: 'Turn', run: 'r9' }, { requests, runs: [r1] })).toBe('missing');
        expect(markTargetStatus({ kind: 'Message', request: 'm2' }, { requests, runs: [] })).toBe('open');
        expect(markTargetStatus({ kind: 'Message', request: 'm9' }, { requests, runs: [] })).toBe('missing');
    });

    test('the later run is the first that answers or overlaps, after the run', () => {
        const r1 = run('r1', 'NeedsClarification', ['m1', 'm2']);
        const r2 = run('r2', 'Completed', ['m2']);
        expect(laterRunOf(r1, [r1, r2])?.id).toBe('r2');
        expect(laterRunOf(r2, [r1, r2])).toBeUndefined();
    });

    test('exclusive groups: one per single-choice question and per assumption; none for multiple choice or reactions', () => {
        const runs = [run('r1', 'NeedsClarification', ['m1'], { reply: asking })];
        expect(exclusiveGroup(option('a'), runs)).toBe(exclusiveGroup(option('b'), runs));
        expect(exclusiveGroup(option('x', 'q2'), runs)).toBeUndefined();
        expect(exclusiveGroup(choice(), runs)).toBe(exclusiveGroup(choice('alt1'), runs));
        expect(exclusiveGroup(choice(undefined, 'r1', 1), runs)).not.toBe(exclusiveGroup(choice(), runs));
        expect(exclusiveGroup({ kind: 'Message', request: 'm1' }, runs)).toBeUndefined();
    });

    test('setting a mark: placed once, taken off, moved within its group; setting it as it is changes nothing', () => {
        const runs = [run('r1', 'NeedsClarification', ['m1'], { reply: asking })];
        const groupOf = (t: MarkTargetData): string | undefined => exclusiveGroup(t, runs);
        const mark = (target: MarkTargetData, sign: C.MarkSign = VOTE) => ({ participant: 'p', target, sign });
        expect(markChange([], option('a'), VOTE, true, groupOf)).toEqual({ place: true, remove: [] });
        expect(markChange([mark(option('a'))], option('a'), VOTE, true, groupOf)).toEqual({ place: false, remove: [] });
        expect(markChange([mark(option('a'))], option('a'), VOTE, false, groupOf)).toEqual({ place: false, remove: [mark(option('a'))] });
        expect(markChange([], option('a'), VOTE, false, groupOf)).toEqual({ place: false, remove: [] });
        // single choice: the vote moves
        expect(markChange([mark(option('a'))], option('b'), VOTE, true, groupOf)).toEqual({ place: true, remove: [mark(option('a'))] });
        // multiple choice: any number
        expect(markChange([mark(option('x', 'q2'))], option('y', 'q2'), VOTE, true, groupOf)).toEqual({ place: true, remove: [] });
        // reactions: each emoji on its own
        const message: MarkTargetData = { kind: 'Message', request: 'm1' };
        expect(markChange([mark(message, react('👍'))], message, react('❤️'), true, groupOf)).toEqual({ place: true, remove: [] });
        expect(markChange([mark(message, react('👍'))], message, react('👍'), false, groupOf).remove).toHaveLength(1);
    });

    test('the place command: the sign must fit the target, and the facilitator does not vote', () => {
        const at = new Date('2026-11-01T09:00:00Z');
        const id = knownMarkId('00000000-0000-4000-8000-000000000001');
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stands in for what the factories check
        const session = knownSessionId('00000000-0000-4000-8000-000000000002') as C.ActiveSession;
        const who = value(C.makeParticipantId('p'));
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stands in for what the factories check
        const open = (t: C.MarkTarget): C.OpenMarkTarget => t as C.OpenMarkTarget;
        const target: C.MarkTarget = {
            kind: 'QuestionOption',
            run: knownAgentRunId('00000000-0000-4000-8000-000000000003'),
            question: value(C.makeReplyKey('q1')),
            option: value(C.makeReplyKey('a')),
        };
        expect(error(markCommands.place({ id, session, participant: who, role: 'Facilitator', target: open(target), sign: VOTE, placedAt: at }))).toEqual({
            type: 'Collaboration.FacilitatorDoesNotVote',
        });
        expect(
            error(markCommands.place({ id, session, participant: who, role: 'Participant', target: open(target), sign: react('❤️'), placedAt: at })),
        ).toEqual({ type: 'Collaboration.MarkNotForTarget' });
        const placed = value(markCommands.place({ id, session, participant: who, role: 'Participant', target: open(target), sign: VOTE, placedAt: at })).Placed;
        expect(placed.aggregate).toMatchObject({ state: 'Placed', sign: VOTE, target });
        expect(placed.events['Collaboration.MarkPlaced']).toMatchObject({ type: 'Collaboration.MarkPlaced', markId: id, participant: who });
        const removed = value(markCommands.remove(placed.aggregate, { open: open(target), removedAt: at })).Removed;
        expect(removed.aggregate).toMatchObject({ state: 'Removed', removedAt: at });
        // the facilitator reacts like anyone
        const turn = open({ kind: 'Turn', run: target.run });
        expect(
            value(markCommands.place({ id, session, participant: who, role: 'Facilitator', target: turn, sign: react('👍'), placedAt: at })).Placed.aggregate
                .sign,
        ).toEqual(react('👍'));
        // a step of the guide is done by the facilitator only
        const step = open({ kind: 'GuideStep', journey: value(C.makeGuideJourneyKey('j')), step: value(C.makeGuideStepKey('bcSplit')) });
        expect(error(markCommands.place({ id, session, participant: who, role: 'Participant', target: step, sign: DONE, placedAt: at }))).toEqual({
            type: 'Collaboration.FacilitatorOnly',
        });
        expect(error(markCommands.place({ id, session, participant: who, role: 'Facilitator', target: step, sign: VOTE, placedAt: at }))).toEqual({
            type: 'Collaboration.MarkNotForTarget',
        });
        expect(
            value(markCommands.place({ id, session, participant: who, role: 'Facilitator', target: step, sign: DONE, placedAt: at })).Placed.aggregate.sign,
        ).toEqual(DONE);
    });
});
