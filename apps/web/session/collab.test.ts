// The collab menu and the end of a collab (apps/web/session/collab.ts): what the menu offers to whom, what is unfinished
// when the facilitator ends it, and the summary everyone sees then.
import { describe, expect, test } from 'bun:test';
import type { Me, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { collabMenuItems, collabSummary, hasUnfinished, hoursMinutes, inviteLink, unfinishedWork, unitTitle } from './collab';
import { changeUnits } from './history';
import { NO_PEERS } from './presence';

type RunJson = SessionStateBody['runs'][number];
type RequestJson = SessionStateBody['requests'][number];
type RevisionJson = SessionStateBody['revisions'][number];

const at = (minute: number): string => `2026-10-31T09:${String(minute).padStart(2, '0')}:00.000Z`;
const v = { dtErrors: 0, dtesErrors: 0, dtesWarnings: 0, linkWarnings: 0, stale: false };
const rev = (id: string, minute: number, files: Record<string, string>, extra: object = {}): RevisionJson =>
    ({
        id,
        session: 's',
        origin: { kind: 'Manual', takenBy: 'x' },
        contentHash: id,
        files: Object.entries(files).map(([path, hash]) => ({ path, hash, language: 'Dt' })),
        validation: v,
        takenAt: at(minute),
        state: 'Recorded',
        ...extra,
    }) as unknown as RevisionJson;
const result = (id: string, minute: number, files: Record<string, string>, run: string): RevisionJson =>
    rev(id, minute, files, { origin: { kind: 'RunResult', run } });
const target = { target: { kind: 'Workspace' }, label: '注文' };
const request = (id: string, author: string, body = `body of ${id}`): RequestJson =>
    ({ id, session: 's', author, targets: body.includes('[1]') ? [target] : [], body, sentAt: at(0), state: 'Sent' }) as unknown as RequestJson;
const frozen = (r: RequestJson): RunJson['input']['requests'][number] => ({ request: r.id, author: r.author, targets: r.targets, body: r.body });
const run = (id: string, minute: number, requests: RequestJson[], state: object): RunJson =>
    ({ id, session: 's', input: { requests: requests.map(frozen) }, queuedBy: 'local:facilitator', queuedAt: at(minute), ...state }) as unknown as RunJson;
const completed = (base: string, resultRevision: string, minute: number): object => ({
    state: 'Completed',
    baseRevision: base,
    startedAt: at(minute),
    resultRevision,
    changed: base !== resultRevision,
    report: {},
    finishedAt: at(minute + 1),
});

const session = (state: 'Open' | 'Closed'): SessionStateBody['session'] =>
    ({
        id: 's',
        facilitator: 'local:facilitator',
        participants: [
            { id: 'local:facilitator', name: 'Facilitator', role: 'Facilitator', joinedAt: at(0) },
            { id: 'dev:a', name: 'Ann', role: 'Participant', joinedAt: at(0) },
            { id: 'dev:b', name: 'Bob', role: 'Participant', joinedAt: at(0) },
            { id: 'dev:host', name: 'Hana', role: 'Participant', joinedAt: at(0) },
        ],
        startedAt: at(0),
        state,
        ...(state === 'Closed' && { closedAt: '2026-10-31T10:35:00.000Z' }),
    }) as unknown as SessionStateBody['session'];
const me = { session: 's', participant: { id: 'dev:a', name: 'Ann', role: 'participant' } } as unknown as Me;

const qa = request('qa', 'dev:a', '#注文[1] に  キャンセルの\nイベントを足してください');
const qb = request('qb', 'dev:b');
const qc = request('qc', 'dev:a');
const qd = request('qd', 'dev:b');
const revisions = [
    rev('r0', 0, { 'a.dt': '1' }),
    result('r1', 2, { 'a.dt': '2' }, 'run1'),
    result('r2', 4, { 'a.dt': '2', 'b.dt': '1' }, 'run2'),
    result('r3', 6, { 'a.dt': '3', 'b.dt': '1' }, 'run3'),
];
const runs = [
    run('run1', 1, [qa], completed('r0', 'r1', 1)),
    run('run2', 3, [qb], completed('r1', 'r2', 3)),
    run('run3', 5, [qc, qd], completed('r2', 'r3', 5)),
    run('run4', 7, [request('qe', 'dev:a')], {
        state: 'NeedsClarification',
        baseRevision: 'r3',
        startedAt: at(7),
        question: 'Which?',
        resultRevision: 'r3',
        finishedAt: at(8),
    }),
    run('run5', 9, [request('qf', 'dev:b')], { state: 'Running', baseRevision: 'r3', startedAt: at(9) }),
    run('run6', 10, [request('qg', 'dev:b')], { state: 'Queued' }),
    run('run7', 11, [request('qh', 'dev:b')], { state: 'Queued' }),
];
const state = (s: 'Open' | 'Closed'): SessionStateBody => ({ session: session(s), runs, revisions, requests: [] }) as unknown as SessionStateBody;

describe('the collab menu', () => {
    test('the facilitator copies the invite link, records, restores an earlier state, downloads the sources, hands over and ends; no 退出', () => {
        expect(collabMenuItems('facilitator', true)).toEqual(['invite', 'record', 'restore', 'download-sources', 'hand-over', 'end']);
    });

    test('a participant copies the invite link, downloads the sources and leaves', () => {
        expect(collabMenuItems('participant', true)).toEqual(['invite', 'download-sources', 'leave']);
    });

    test('link: the facilitator makes the invite link (and stops a live one); a participant has none to copy', () => {
        expect(collabMenuItems('facilitator', true, false, { inviteLive: false })).toEqual([
            'invite',
            'record',
            'restore',
            'download-sources',
            'hand-over',
            'end',
        ]);
        expect(collabMenuItems('facilitator', true, false, { inviteLive: true })).toEqual([
            'invite',
            'stop-invite',
            'record',
            'restore',
            'download-sources',
            'hand-over',
            'end',
        ]);
        expect(collabMenuItems('participant', true, false, { inviteLive: true })).toEqual(['download-sources', 'leave']);
    });

    test('once ended (or signed out), the menu only lists the participants', () => {
        expect(collabMenuItems('facilitator', false)).toEqual([]);
        expect(collabMenuItems('participant', false)).toEqual([]);
    });

    test('the invite link is the page origin', () => {
        expect(inviteLink('http://127.0.0.1:4321')).toBe('http://127.0.0.1:4321/');
        expect(inviteLink('https://session.example.com/')).toBe('https://session.example.com/');
    });
});

describe('ending a collab', () => {
    test('counts the runs queued and running and the questions unanswered', () => {
        const u = unfinishedWork(state('Open'));
        expect(u).toEqual({ queued: 2, running: 1, clarification: 1 });
        expect(hasUnfinished(u)).toBe(true);
    });

    test('a question answered by a later run is not waiting any more', () => {
        const answered = run('run8', 12, [request('qe', 'dev:a')], { ...completed('r3', 'r3', 12) });
        const reply = { ...answered, input: { ...answered.input, answer: { answerTo: 'run4' } } } as unknown as RunJson;
        const s = { ...state('Open'), runs: [...runs.slice(0, 4), reply] };
        expect(unfinishedWork(s).clarification).toBe(0);
    });

    test('with nothing left, nothing is unfinished: results of runs are not', () => {
        const done = unfinishedWork({ runs: runs.slice(0, 3), revisions });
        expect(done).toEqual({ queued: 0, running: 0, clarification: 0 });
        expect(hasUnfinished(done)).toBe(false);
    });
});

describe('the summary of a collab', () => {
    test("a unit is titled by its name: the AI's title, else its first request on one line, cut at 60 characters", () => {
        const units = changeUnits(state('Open'));
        const first = units.find((u) => u.key === 'run1');
        expect(first && unitTitle(first)).toBe('注文 に キャンセルの イベントを足してください');
        if (first) expect(unitTitle({ ...first, title: '注文の取消' })).toBe('注文の取消');
        const long = changeUnits({ runs: [run('x', 1, [request('ql', 'dev:a', 'あ'.repeat(80))], { state: 'Queued' })], revisions: [] })[0];
        expect(unitTitle(long)).toBe(`${'あ'.repeat(59)}…`);
    });

    test('lists the units that changed files in the order they started, who asked, who took part and how long', () => {
        const summary = collabSummary(state('Closed'), me, NO_PEERS);
        expect(summary.units).toEqual([
            { key: 'run1', title: '注文 に キャンセルの イベントを足してください', files: 1, requesters: ['Ann'] },
            { key: 'run2', title: 'body of qb', files: 1, requesters: ['Bob'] },
            { key: 'run3', title: 'body of qc', files: 1, requesters: ['Ann', 'Bob'] },
        ]);
        expect(summary.others).toBe(4);
        expect(summary.participants.map((p) => [p.name, p.facilitator])).toEqual([
            ['Facilitator', true],
            ['Ann', false],
            ['Bob', false],
            ['Hana', false],
        ]);
        expect(summary.duration).toBe(95 * 60_000);
        // the avatar of whoever's page tells one, as in the header
        const mine = { ...me, participant: { ...me.participant, avatarUrl: 'https://x/me' } } as Me;
        expect(collabSummary(state('Closed'), mine, NO_PEERS).participants.find((p) => p.id === mine.participant.id)?.avatarUrl).toBe('https://x/me');
        expect(hoursMinutes(summary.duration ?? 0)).toEqual({ hours: 1, minutes: 35 });
    });

    test('without the end event, the duration runs to when the page saw the end; unknown without either', () => {
        expect(collabSummary(state('Open'), me, NO_PEERS, at(30)).duration).toBe(30 * 60_000);
        expect(collabSummary(state('Open'), me, NO_PEERS).duration).toBeUndefined();
    });

    test('a duration is at least a minute', () => {
        expect(hoursMinutes(0)).toEqual({ hours: 0, minutes: 1 });
        expect(hoursMinutes(59 * 60_000)).toEqual({ hours: 0, minutes: 59 });
    });
});
