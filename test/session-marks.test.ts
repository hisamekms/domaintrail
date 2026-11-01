// Votes and reactions (ADR 0026, appendix "Votes and reactions"): one mechanism, "who marked what with which sign", with
// rules per kind of target; a reaction is any one emoji. The pure rules (domain/marks.ts), the use case over node:sqlite
// and the real workspace, the migrations of a database written before marks and before emoji, and the session server's
// route and WebSocket broadcast.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Collaboration as C } from '@domaintrail/collaboration/generated/index';
import type { CollaborationDeps } from '@domaintrail/collaboration/application/ports';
import { createCollaboration, type CollaborationUseCases } from '@domaintrail/collaboration/application/use-cases';
import {
    exclusiveGroup,
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
} from '@domaintrail/collaboration/domain/marks';
import { toAgentReply } from '@domaintrail/collaboration/domain/reply';
import { openSessionBlobs } from '@domaintrail/collaboration/infrastructure/blobs';
import { createUnitOfWork, MIGRATIONS, openDatabase } from '@domaintrail/collaboration/infrastructure/sqlite';
import { createModelValidator } from '@domaintrail/collaboration/infrastructure/validator';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { isNormalEmoji, isSingleEmoji, normalizeEmoji, readEmoji } from '@domaintrail/modeling/core/emoji';
import { createWorkspaceSnapshot } from '@domaintrail/workspace/infrastructure/snapshot';
import { startSessionServer, type SessionServer } from '@domaintrail/composition/session';
import { DEFAULT_AGENT_TOOLS } from '@domaintrail/modeling/core/config';
import {
    assumptionVoteLines,
    canVote,
    markIndex,
    names,
    questionVoteLines,
    quickReactions,
    reaction,
    reactionFits,
    reactionsOn,
    tallyOf,
} from '@domaintrail/web/session/marks';
import { applyEvent } from '@domaintrail/web/session/state';

const dirs: string[] = [];
afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
});

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
    ])('%s is one emoji, kept as %s', (input, kept) => {
        expect(readEmoji(input)).toBe(kept);
        expect(isNormalEmoji(kept)).toBe(true);
        expect(String(value(makeEmoji(kept)))).toBe(kept);
    });

    test.each([['ok'], ['1'], ['a'], ['👍👍'], ['👍 ❤️'], ['🇯'], ['👍\u0301'], [''], ['\u200D'], ['🏽'], ['👍'.repeat(20)]])('%j is not', (input) => {
        expect(readEmoji(input)).toBeUndefined();
    });

    test('❤ and ❤️ are the same reaction: only the kept form is an Emoji', () => {
        expect(normalizeEmoji('❤')).toBe(normalizeEmoji('❤️'));
        expect(isSingleEmoji('❤')).toBe(true);
        expect(error(makeEmoji('❤'))).toMatchObject({ type: 'InvalidEmoji', invariant: 'singleEmoji' });
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
        const id = C.makeMarkId('00000000-0000-4000-8000-000000000001');
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stands in for what the factories check
        const session = C.makeSessionId('00000000-0000-4000-8000-000000000002') as C.ActiveSession;
        const who = value(C.makeParticipantId('p'));
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stands in for what the factories check
        const open = (t: C.MarkTarget): C.OpenMarkTarget => t as C.OpenMarkTarget;
        const target: C.MarkTarget = {
            kind: 'QuestionOption',
            run: C.makeAgentRunId('00000000-0000-4000-8000-000000000003'),
            question: value(C.makeReplyKey('q1')),
            option: value(C.makeReplyKey('a')),
        };
        expect(error(markCommands.place(id, session, who, 'Facilitator', open(target), VOTE, at))).toEqual({ type: 'FacilitatorDoesNotVote' });
        expect(error(markCommands.place(id, session, who, 'Participant', open(target), react('❤️'), at))).toEqual({ type: 'MarkNotForTarget' });
        const placed = value(markCommands.place(id, session, who, 'Participant', open(target), VOTE, at)).Placed;
        expect(placed.aggregate).toMatchObject({ state: 'Placed', sign: VOTE, target });
        expect(placed.events.MarkPlaced).toMatchObject({ type: 'MarkPlaced', markId: id, participant: who });
        const removed = value(markCommands.remove(placed.aggregate, open(target), at)).Removed;
        expect(removed.aggregate).toMatchObject({ state: 'Removed', removedAt: at });
        // the facilitator reacts like anyone
        const turn = open({ kind: 'Turn', run: target.run });
        expect(value(markCommands.place(id, session, who, 'Facilitator', turn, react('👍'), at)).Placed.aggregate.sign).toEqual(react('👍'));
    });
});

// ---- the use case ----

const SALES = `context Sales {
  id OrderId: UUID

  aggregate Order {
    id: OrderId

    state Draft

    create command place(id: OrderId)
      -> Draft
  }
}
`;

async function workspace(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-marks-'));
    dirs.push(root);
    for (const [file, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), text);
    }
    return root;
}

const facilitator = value(C.makeParticipantId('facilitator'));
const ann = value(C.makeParticipantId('ann'));
const bob = value(C.makeParticipantId('bob'));
const name = value(C.makeDisplayName('Ada'));
const text = (t: string): C.Text => value(C.makeText(t));

interface Fixture {
    readonly use: CollaborationUseCases;
    readonly deps: CollaborationDeps;
    readonly id: C.SessionId;
    readonly message: C.RequestId;
}

async function fixture(): Promise<Fixture> {
    const root = await workspace({ 'sales/sales.dt': SALES });
    let n = 0;
    const deps: CollaborationDeps = {
        uow: createUnitOfWork(openDatabase(':memory:')),
        workspace: createWorkspaceSnapshot(root),
        blobs: await openSessionBlobs(root),
        validator: createModelValidator(),
        clock: { now: () => new Date('2026-11-01T09:00:00Z') },
        ids: { newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` },
    };
    const use = createCollaboration(deps);
    const { session } = value(await use.startSession({ facilitator, name }));
    for (const p of [ann, bob]) value(await use.joinSession({ session: session.id, participant: p, name }));
    const message = value(await use.sendRequest({ session: session.id, author: ann, targets: [], body: text('Add cancel.') })).id;
    return { use, deps, id: session.id, message };
}

/** Runs the message to an end: a clarification asking q1 (single) and q2 (multiple), or a completion with an assumption. */
async function ended(f: Fixture, how: 'clarification' | 'completed'): Promise<C.AgentRunId> {
    const queued = value(await f.use.queueRun({ session: f.id, requests: [f.message], queuedBy: facilitator }));
    const { lease } = value(await f.use.claimNextRun({ session: f.id, owner: 'agent', leaseMs: 30_000 }));
    value(await f.use.startRun({ run: queued.id, token: lease.token }));
    if (how === 'clarification') {
        const reply = toAgentReply({
            outcome: 'clarification',
            summary: 'Which?',
            requests: [{ request: f.message, status: 'question' }],
            questions: [
                {
                    id: 'q1',
                    text: 'Which state?',
                    requests: [f.message],
                    options: [
                        { id: 'a', label: 'A' },
                        { id: 'b', label: 'B' },
                    ],
                    multiple: false,
                },
                {
                    id: 'q2',
                    text: 'Which events?',
                    requests: [],
                    options: [
                        { id: 'x', label: 'X' },
                        { id: 'y', label: 'Y' },
                    ],
                    multiple: true,
                },
            ],
            assumptions: [],
        });
        value(await f.use.askClarification({ run: queued.id, token: lease.token, question: text('Which?'), reply }));
    } else {
        const reply = toAgentReply({
            outcome: 'done',
            summary: 'Done.',
            requests: [{ request: f.message, status: 'done' }],
            questions: [],
            assumptions: [{ text: 'Only drafts.', requests: [f.message], alternatives: [{ id: 'all', label: 'Any state' }] }],
        });
        value(await f.use.finishRun({ run: queued.id, token: lease.token, facts: { exitCode: 0, formatted: true, checked: true }, reply }));
    }
    return queued.id;
}

const key = (k: string): C.ReplyKey => value(C.makeReplyKey(k));

describe('setting marks', () => {
    test('a vote moves within a single-choice question, adds up in a multiple one, and is taken off by setting it off', async () => {
        const f = await fixture();
        const run = await ended(f, 'clarification');
        const opt = (q: string, o: string): C.MarkTarget => ({ kind: 'QuestionOption', run, question: key(q), option: key(o) });
        const set = (participant: C.ParticipantId, target: C.MarkTarget, placed = true) =>
            f.use.setMark({ session: f.id, participant, target, sign: VOTE, placed });

        const first = value(await set(ann, opt('q1', 'a')));
        expect(first.placed).toMatchObject({ participant: ann, target: opt('q1', 'a') });
        expect(first.removed).toEqual([]);
        // the same again changes nothing
        expect(value(await set(ann, opt('q1', 'a')))).toEqual({ placed: undefined, removed: [] });
        // moved to b
        const moved = value(await set(ann, opt('q1', 'b')));
        expect(moved.removed.map((m): string => m.id)).toEqual([String(first.placed?.id)]);
        value(await set(ann, opt('q2', 'x')));
        value(await set(ann, opt('q2', 'y')));
        value(await set(bob, opt('q1', 'b')));
        const marks = value(await f.use.sessionState({ session: f.id })).marks;
        expect(marks.map((m) => [m.participant, m.target.kind === 'QuestionOption' && `${m.target.question}:${m.target.option}`])).toEqual([
            [ann, 'q1:b'],
            [ann, 'q2:x'],
            [ann, 'q2:y'],
            [bob, 'q1:b'],
        ]);
        value(await set(ann, opt('q2', 'x'), false));
        expect(value(await f.use.sessionState({ session: f.id })).marks).toHaveLength(3);

        // each change is in the outbox: a move removes before it places
        const types = (await f.deps.uow.transaction((s) => s.outbox.readAfter(0, 200, f.id))).map((e) => e.event.type).filter((t) => t.startsWith('Mark'));
        expect(types).toEqual(['MarkPlaced', 'MarkRemoved', 'MarkPlaced', 'MarkPlaced', 'MarkPlaced', 'MarkPlaced', 'MarkRemoved']);
    });

    test('closed votes are frozen: the answer closes them, and nothing can be placed or taken off', async () => {
        const f = await fixture();
        const run = await ended(f, 'clarification');
        const target: C.MarkTarget = { kind: 'QuestionOption', run, question: key('q1'), option: key('a') };
        value(await f.use.setMark({ session: f.id, participant: ann, target, sign: VOTE, placed: true }));
        value(
            await f.use.queueRun({
                session: f.id,
                requests: [f.message],
                queuedBy: facilitator,
                answer: { answerTo: run, answer: { answers: [{ question: 'q1', options: ['a'] }] } },
            }),
        );
        expect(error(await f.use.setMark({ session: f.id, participant: bob, target, sign: VOTE, placed: true }))).toEqual({ type: 'MarkTargetClosed' });
        expect(error(await f.use.setMark({ session: f.id, participant: ann, target, sign: VOTE, placed: false }))).toEqual({ type: 'MarkTargetClosed' });
        expect(value(await f.use.sessionState({ session: f.id })).marks).toHaveLength(1);
    });

    test("an assumption's group: keep or an alternative, one per participant, closed by the re-run", async () => {
        const f = await fixture();
        const run = await ended(f, 'completed');
        const keep: C.MarkTarget = { kind: 'AssumptionChoice', run, assumption: value(C.makeTally(0)) };
        const all: C.MarkTarget = { ...keep, alternative: key('all') };
        value(await f.use.setMark({ session: f.id, participant: ann, target: keep, sign: VOTE, placed: true }));
        expect(value(await f.use.setMark({ session: f.id, participant: ann, target: all, sign: VOTE, placed: true })).removed).toHaveLength(1);
        value(await f.use.queueRun({ session: f.id, requests: [f.message], queuedBy: facilitator, note: text('前提「Only drafts.」は採らず…') }));
        expect(error(await f.use.setMark({ session: f.id, participant: bob, target: keep, sign: VOTE, placed: true }))).toEqual({ type: 'MarkTargetClosed' });
    });

    test('refused: the facilitator voting, a sign that does not fit, a target not in the session, a stranger, a closed session', async () => {
        const f = await fixture();
        const run = await ended(f, 'clarification');
        const target: C.MarkTarget = { kind: 'QuestionOption', run, question: key('q1'), option: key('a') };
        const set = (participant: C.ParticipantId, t: C.MarkTarget, sign: C.MarkSign) =>
            f.use.setMark({ session: f.id, participant, target: t, sign, placed: true });
        expect(error(await set(facilitator, target, VOTE))).toEqual({ type: 'FacilitatorDoesNotVote' });
        expect(error(await set(ann, target, react('👍')))).toEqual({ type: 'MarkNotForTarget' });
        expect(error(await set(ann, { kind: 'Message', request: f.message }, VOTE))).toEqual({ type: 'MarkNotForTarget' });
        expect(error(await set(ann, { ...target, option: key('zz') }, VOTE))).toEqual({ type: 'MarkTargetNotFound' });
        expect(error(await set(ann, { kind: 'Turn', run: C.makeAgentRunId('00000000-0000-4000-8000-0000000000ff') }, react('❤️')))).toEqual({
            type: 'MarkTargetNotFound',
        });
        expect(error(await set(value(C.makeParticipantId('stranger')), { kind: 'Message', request: f.message }, react('❤️')))).toMatchObject({
            type: 'NotAParticipant',
        });
        // anyone reacts, the facilitator too, with several signs on one message
        value(await set(facilitator, { kind: 'Message', request: f.message }, react('👍')));
        value(await set(facilitator, { kind: 'Message', request: f.message }, react('👀')));
        value(await set(ann, { kind: 'Turn', run }, react('🤔')));
        expect(value(await f.use.sessionState({ session: f.id })).marks.map((m) => signKey(m.sign))).toEqual(['👍', '👀', '🤔']);
        value(await f.use.closeSession({ session: f.id }));
        expect(error(await set(ann, { kind: 'Message', request: f.message }, react('❤️')))).toEqual({ type: 'SessionAlreadyClosed' });
    });

    test(`a message holds at most ${MAX_REACTION_EMOJI} different emoji: the next new one is refused, one already there is not`, async () => {
        const f = await fixture();
        const message: C.MarkTarget = { kind: 'Message', request: f.message };
        const set = (participant: C.ParticipantId, emoji: string) =>
            f.use.setMark({ session: f.id, participant, target: message, sign: react(emoji), placed: true });
        for (const [i, e] of TWENTY.entries()) value(await set(i % 2 === 0 ? ann : bob, e));
        expect(error(await set(ann, '🙃'))).toEqual({ type: 'ReactionLimitReached', limit: value(C.makeTally(MAX_REACTION_EMOJI)) });
        // joining an emoji there is fine; taking one off makes room
        value(await set(ann, '😁'));
        value(await f.use.setMark({ session: f.id, participant: ann, target: message, sign: react('😀'), placed: false }));
        value(await set(ann, '🙃'));
        // another target has its own room
        value(
            await f.use.setMark({
                session: f.id,
                participant: ann,
                target: { kind: 'Turn', run: await ended(f, 'completed') },
                sign: react('🙃'),
                placed: true,
            }),
        );
    });
});

// ---- persistence ----

describe('the marks table (migration 4) and reactions as emoji', () => {
    test('a database written before marks is upgraded in place: its session loads, and marks are kept from then on', async () => {
        const dir = await workspace({});
        const file = path.join(dir, 'session.db');
        // the schema before marks, with a session in it
        const old = new DatabaseSync(file);
        for (const m of MIGRATIONS.slice(0, 3)) old.exec(m);
        old.exec('PRAGMA user_version = 3');
        const id = '00000000-0000-4000-8000-000000000001';
        const session = {
            state: 'Open',
            id,
            facilitator: 'local:facilitator',
            participants: [{ id: 'local:facilitator', name: 'Facilitator', role: 'Facilitator', joinedAt: { $date: '2026-10-31T09:00:00.000Z' } }],
            startedAt: { $date: '2026-10-31T09:00:00.000Z' },
        };
        old.prepare('INSERT INTO sessions (id, state, data) VALUES (?, ?, ?)').run(id, 'Open', JSON.stringify(session));
        old.close();

        const db = openDatabase(file);
        expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
        const uow = createUnitOfWork(db);
        const sid = C.makeSessionId(id);
        expect(await uow.transaction((s) => [s.sessions.load(sid)?.state, s.marks.placedBySession(sid)])).toEqual(['Open', []]);

        // one placed mark per participant, target and sign, whatever the code above does
        const mark: C.PlacedMark = {
            state: 'Placed',
            id: C.makeMarkId('00000000-0000-4000-8000-000000000002'),
            session: sid,
            participant: value(C.makeParticipantId('ann')),
            target: { kind: 'Message', request: C.makeRequestId('00000000-0000-4000-8000-000000000003') },
            sign: react('❤️'),
            placedAt: new Date('2026-11-01T09:00:00Z'),
        };
        await uow.transaction((s) => s.marks.save(mark));
        const duplicate = await uow
            .transaction((s) => s.marks.save({ ...mark, id: C.makeMarkId('00000000-0000-4000-8000-000000000004') }))
            .then(
                () => 'saved',
                () => 'refused',
            );
        expect(duplicate).toBe('refused');
        // removed, it stays as a row; another can be placed
        await uow.transaction((s) => s.marks.save({ ...mark, state: 'Removed', removedAt: new Date('2026-11-01T09:01:00Z') }));
        await uow.transaction((s) => s.marks.save({ ...mark, id: C.makeMarkId('00000000-0000-4000-8000-000000000005') }));
        expect(await uow.transaction((s): unknown[] => [s.marks.placedBySession(sid).map((m): string => m.id), s.marks.load(mark.id)?.state])).toEqual([
            ['00000000-0000-4000-8000-000000000005'],
            'Removed',
        ]);
        db.close();
    });

    test('a database with the four named reactions: they become 👍 🤔 ❤️ 👀 in the marks and the outbox, votes stay votes', async () => {
        const dir = await workspace({});
        const file = path.join(dir, 'session.db');
        // the schema with marks, before emoji: the version that added the marks table
        const version = MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE marks')) + 1;
        const old = new DatabaseSync(file);
        for (const m of MIGRATIONS.slice(0, version)) old.exec(m);
        old.exec(`PRAGMA user_version = ${version}`);
        const sid = '00000000-0000-4000-8000-000000000001';
        const target = { kind: 'Message', request: '00000000-0000-4000-8000-000000000003' };
        const vote = { kind: 'QuestionOption', run: '00000000-0000-4000-8000-000000000009', question: 'q1', option: 'a' };
        const at = { $date: '2026-11-01T09:00:00.000Z' };
        const rows: [string, string, string, string, object][] = [
            ['1', 'ann', 'Agree', 'Placed', target],
            ['2', 'ann', 'Doubt', 'Placed', target],
            ['3', 'bob', 'Like', 'Placed', target],
            ['4', 'bob', 'Seen', 'Removed', target],
            ['5', 'bob', 'Vote', 'Placed', vote],
        ];
        old.prepare('INSERT INTO sessions (id, state, data) VALUES (?, ?, ?)').run(sid, 'Open', JSON.stringify({ state: 'Open', id: sid }));
        const insert = old.prepare('INSERT INTO marks (id, session_id, seq, participant, target_key, sign, state, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        const outbox = old.prepare('INSERT INTO outbox (session_id, type, payload, recorded_at) VALUES (?, ?, ?, ?)');
        for (const [n, participant, sign, state, t] of rows) {
            const id = `00000000-0000-4000-8000-00000000010${n}`;
            const data = { state, id, session: sid, participant, target: t, sign, placedAt: at, ...(state === 'Removed' && { removedAt: at }) };
            insert.run(id, sid, Number(n), participant, markKey(t as MarkTargetData), sign, state, JSON.stringify(data));
            const event = { type: 'MarkPlaced', markId: id, session: sid, participant, target: t, sign, placedAt: at };
            outbox.run(sid, 'MarkPlaced', JSON.stringify(event), '2026-11-01T09:00:00.000Z');
        }
        outbox.run(sid, 'RequestDismissed', JSON.stringify({ type: 'RequestDismissed', sign: 'Agree' }), '2026-11-01T09:00:00.000Z');
        old.close();

        const db = openDatabase(file);
        expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
        const columns = db.prepare('SELECT sign, state FROM marks ORDER BY seq').all();
        expect(columns.map((r) => [r.sign, r.state])).toEqual([
            ['👍', 'Placed'],
            ['🤔', 'Placed'],
            ['❤️', 'Placed'],
            ['👀', 'Removed'],
            ['Vote', 'Placed'],
        ]);
        const uow = createUnitOfWork(db);
        const id = C.makeSessionId(sid);
        const placed = await uow.transaction((s) => s.marks.placedBySession(id));
        expect(placed.map((m) => m.sign)).toEqual([react('👍'), react('🤔'), react('❤️'), VOTE]);
        expect(placed[0].placedAt).toEqual(new Date('2026-11-01T09:00:00.000Z'));
        const events = await uow.transaction((s) => s.outbox.readAfter(0, 100, id));
        expect(events.map((e): unknown => ('sign' in e.event ? e.event.sign : undefined))).toEqual([
            react('👍'),
            react('🤔'),
            react('❤️'),
            react('👀'),
            VOTE,
            // another event is left as it was
            'Agree',
        ]);
        // the unique index holds for the emoji: a second 👍 of ann's on the message is refused
        const again: C.PlacedMark = { ...placed[0], id: C.makeMarkId('00000000-0000-4000-8000-000000000200') };
        expect(
            await uow
                .transaction((s) => s.marks.save(again))
                .then(
                    () => 'saved',
                    () => 'refused',
                ),
        ).toBe('refused');
        db.close();
    });
});

// ---- the server ----

const DT = `context Shop {
  id OrderId: UUID

  aggregate Order {
    id: OrderId

    state Open

    create command start(id: OrderId) -> Open
  }
}
`;

describe('the marks route and its broadcast', () => {
    let root: string;
    let server: SessionServer;
    let ada: string;
    let bob: string;
    let cred: { url: string; token: string };
    const json = { 'content-type': 'application/json' };

    const join = async (who: string): Promise<string> => {
        const res = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name: who }) });
        return (res.headers.get('set-cookie') ?? '').split(';')[0];
    };
    const api = (cookie: string, p: string, body?: unknown): Promise<Response> =>
        fetch(`${server.url}api/session/${p}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { cookie, ...(body !== undefined && json) },
            ...(body !== undefined && { body: JSON.stringify(body) }),
        });
    const agent = (p: string, body: unknown): Promise<Response> =>
        fetch(`${cred.url}agent/${p}`, { method: 'POST', headers: { authorization: `Bearer ${cred.token}`, ...json }, body: JSON.stringify(body) });

    beforeAll(async () => {
        root = await workspace({ 'shop.dt': DT });
        server = await startSessionServer({
            root,
            debounceMs: 30,
            session: {
                port: 0,
                host: '127.0.0.1',
                identity: 'dev',
                agent: { port: 0, allowedTools: [...DEFAULT_AGENT_TOOLS], maxPreviousRunDiff: 20 * 1024 },
                maxParticipants: 50,
                quickReactions: ['👍', '👀', '🤔', '🎉', '❤️', '🙏'],
                classifier: { enabled: false, provider: 'cloudflare-clef', model: 'clef-flash', apiTokenEnv: 'CLOUDFLARE_API_TOKEN', threshold: 0.5 },
            },
        });
        await server.ready;
        ada = await join('Ada');
        bob = await join('Bob');
        expect((await fetch(server.facilitatorLink, { headers: { cookie: ada }, redirect: 'manual' })).status).toBe(303);
        cred = JSON.parse(await Bun.file(path.join(root, '.domaintrail', 'session', 'agent.json')).text());
    });
    afterAll(() => server?.stop());

    test('participants vote and react, the facilitator reacts but never votes; every page gets each change; a late page gets them in its state', async () => {
        const request = ((await (await api(bob, 'requests', { targets: [], body: 'Add cancel.' })).json()) as { request: { id: string } }).request.id;
        const run = ((await (await api(ada, 'runs', { requests: [request] })).json()) as { run: { id: string } }).run.id;
        const { lease } = (await (await agent('runs/claim', { owner: 'test' })).json()) as { lease: { token: string } };
        expect((await agent(`runs/${run}/start`, { token: lease.token })).status).toBe(200);
        const reply = {
            outcome: 'clarification',
            summary: 'Which?',
            requests: [{ request, status: 'question' }],
            questions: [
                {
                    id: 'q1',
                    text: 'Which?',
                    options: [
                        { id: 'a', label: 'A' },
                        { id: 'b', label: 'B' },
                    ],
                    multiple: false,
                },
            ],
        };
        expect((await agent(`runs/${run}/clarification`, { token: lease.token, question: 'Which?', reply })).status).toBe(200);

        // a page of the facilitator listens
        const ws = new WebSocket(server.url.replace('http', 'ws') + 'ws', { headers: { cookie: ada } } as never);
        const received: { type: string; [k: string]: unknown }[] = [];
        ws.onmessage = (ev) => received.push(JSON.parse(ev.data as string));
        await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = reject;
        });
        const waitFor = async (type: string, count: number): Promise<void> => {
            const deadline = Date.now() + 5000;
            while (received.filter((m) => m.type === type).length < count) {
                if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
                await Bun.sleep(10);
            }
        };
        try {
            await waitFor('session.state', 1);
            const vote = (o: string) => ({ target: { kind: 'QuestionOption', run, question: 'q1', option: o }, sign: { kind: 'Vote' }, placed: true });
            // the facilitator's answer is the decision
            const refused = await api(ada, 'marks', vote('a'));
            expect([refused.status, ((await refused.json()) as { error: { type: string } }).error.type]).toEqual([403, 'FacilitatorDoesNotVote']);
            const placed = await api(bob, 'marks', vote('a'));
            expect(placed.status).toBe(200);
            const moved = (await (await api(bob, 'marks', vote('b'))).json()) as { placed: { id: string }; removed: { id: string }[] };
            expect(moved.removed).toHaveLength(1);
            expect((await api(ada, 'marks', { target: { kind: 'Message', request }, sign: { kind: 'Reaction', emoji: '❤' }, placed: true })).status).toBe(200);
            await waitFor('mark.placed', 3);
            await waitFor('mark.removed', 1);
            const events = received.filter((m) => m.type.startsWith('mark.')).map((m) => [m.type, signKey((m.event as { sign: C.MarkSign }).sign)]);
            expect(events).toEqual([
                ['mark.placed', 'Vote'],
                ['mark.removed', 'Vote'],
                ['mark.placed', 'Vote'],
                // ❤ (text presentation) is kept as ❤️
                ['mark.placed', '❤️'],
            ]);
            // a page that loads now sees the marks
            const state = (await (await api(bob, 'state')).json()) as SessionStateBody;
            expect(state.marks.map((m) => [m.sign, m.target.kind])).toEqual([
                [{ kind: 'Vote' }, 'QuestionOption'],
                [{ kind: 'Reaction', emoji: '❤️' }, 'Message'],
            ]);
            // the quick reactions of the config (the default here) come with the state
            expect(state.quickReactions).toEqual(['👍', '👀', '🤔', '🎉', '❤️', '🙏']);
        } finally {
            ws.close();
        }

        // inputs are checked at the boundary; nothing without an identity
        const bad = async (body: unknown): Promise<[number, string]> => {
            const res = await api(bob, 'marks', body);
            const e = ((await res.json()) as { error: { type: string; field?: string } }).error;
            return [res.status, e.field ?? e.type];
        };
        const like = { kind: 'Reaction', emoji: '👍' };
        const turn = { kind: 'Turn', run };
        expect(await bad({ target: turn, sign: 'Like', placed: true })).toEqual([400, 'sign']);
        expect(await bad({ target: turn, sign: { kind: 'Wave' }, placed: true })).toEqual([400, 'sign.kind']);
        expect(await bad({ target: turn, sign: { kind: 'Vote', emoji: '👍' }, placed: true })).toEqual([400, 'sign.emoji']);
        expect(await bad({ target: turn, sign: { ...like, size: 2 }, placed: true })).toEqual([400, 'sign.size']);
        for (const emoji of ['ok', '👍👍', '1', '', 7, '👍'.repeat(40)])
            expect(await bad({ target: turn, sign: { kind: 'Reaction', emoji }, placed: true })).toEqual([400, 'sign.emoji']);
        expect(await bad({ target: { kind: 'Turn', run: 'x' }, sign: like, placed: true })).toEqual([400, 'target.run']);
        expect(await bad({ target: { kind: 'Turn', run, extra: 1 }, sign: like, placed: true })).toEqual([400, 'target.extra']);
        expect(await bad({ target: turn, sign: like })).toEqual([400, 'placed']);
        expect(await bad({ target: turn, sign: { kind: 'Vote' }, placed: true })).toEqual([400, 'MarkNotForTarget']);
        expect(await bad({ target: { kind: 'Turn', run: crypto.randomUUID() }, sign: like, placed: true })).toEqual([404, 'MarkTargetNotFound']);
        // a ZWJ sequence, a skin tone, a flag and a keycap are one emoji each
        for (const emoji of ['👨‍👩‍👧‍👦', '👍🏽', '🇯🇵', '1️⃣'])
            expect((await api(bob, 'marks', { target: turn, sign: { kind: 'Reaction', emoji }, placed: true })).status).toBe(200);
        expect((await fetch(`${server.url}api/session/marks`, { method: 'POST', headers: json, body: '{}' })).status).toBe(401);

        // answered: closed
        expect((await api(ada, 'runs', { requests: [request], answerTo: run, answer: { answers: [{ question: 'q1', options: ['b'] }] } })).status).toBe(201);
        expect(await bad({ target: { kind: 'QuestionOption', run, question: 'q1', option: 'a' }, sign: { kind: 'Vote' }, placed: true })).toEqual([
            409,
            'MarkTargetClosed',
        ]);
    });
});

// ---- the page ----

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

    test("the lines that keep a closed vote's counts in a tooltip", () => {
        const index = markIndex({ marks }, 'me');
        const question = {
            id: 'q1',
            options: [
                { id: 'a', label: 'A' },
                { id: 'b', label: 'B' },
            ],
        };
        expect(questionVoteLines(index, 'r1', question, nameOf, ', ')).toEqual(['A ♡ 2: ANN, BOB']);
        const kept = markIndex({ marks: [mark('6', 'ann', { kind: 'AssumptionChoice', run: 'r2', assumption: 0 }, VOTE)] }, 'me');
        expect(assumptionVoteLines(kept, 'r2', 0, [{ id: 'x', label: 'X' }], 'As is', nameOf, ', ')).toEqual(['As is ♡ 1: ANN']);
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
