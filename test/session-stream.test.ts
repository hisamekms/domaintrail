import { describe, expect, test } from 'bun:test';
import type { Me, Presence, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { COMPOSER_DRAFT, composerScope, createMemoryDrafts, newDraft, scopeKey } from '@domaintrail/web/session/drafts';
import { NO_PEERS } from '@domaintrail/web/session/presence';
import { WORKSPACE_TARGET } from '@domaintrail/web/session/targets';
import { agentStatus, elapsed, headerParticipants, oneLine, participantNames, pendingRequests, streamItems, targetText } from '@domaintrail/web/session/stream';

type RunJson = SessionStateBody['runs'][number];
type RequestJson = SessionStateBody['requests'][number];
type RevisionJson = SessionStateBody['revisions'][number];

const at = (minute: number, second = 0): string => `2026-10-31T09:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
const v = { dtErrors: 0, dtesErrors: 0, dtesWarnings: 0, linkWarnings: 0, stale: false };
const rev = (id: string, minute: number, origin: Record<string, string>, extra: object = {}): RevisionJson =>
    ({ id, session: 's', origin, contentHash: id, files: [], validation: v, takenAt: at(minute), state: 'Recorded', ...extra }) as unknown as RevisionJson;
const request = (id: string, author: string, minute: number, extra: object = {}): RequestJson =>
    ({
        id,
        session: 's',
        author,
        target: { target: { kind: 'DtElement', element: `Sales.${id}` }, label: `Sales.${id}`, sourceRevision: 'r1' },
        body: `body of ${id}`,
        sentAt: at(minute),
        state: 'Sent',
        ...extra,
    }) as unknown as RequestJson;
const frozen = (r: RequestJson): RunJson['input']['requests'][number] => ({ request: r.id, author: r.author, target: r.target, body: r.body });
const run = (id: string, minute: number, requests: RequestJson[], state: object, note?: string): RunJson =>
    ({
        id,
        session: 's',
        input: { requests: requests.map(frozen), ...(note && { note }) },
        queuedBy: 'local:facilitator',
        queuedAt: at(minute),
        ...state,
    }) as unknown as RunJson;

describe('the main stream', () => {
    const q1 = request('q1', 'dev:a', 1);
    const q2 = request('q2', 'dev:b', 2);
    const q3 = request('q3', 'dev:a', 3);
    const revisions = [
        rev('r1', 0, { kind: 'SessionStart', session: 's' }),
        rev('r2', 5, { kind: 'RunBase', run: 'run1' }),
        rev('r3', 7, { kind: 'RunResult', run: 'run1' }, { state: 'Confirmed', confirmedBy: 'local:facilitator', confirmedAt: at(9) }),
        rev('r4', 20, { kind: 'PreRestore', restoring: 'r1' }),
        rev('r5', 21, { kind: 'Restored', restoredFrom: 'r1', preRestore: 'r4' }),
    ];
    const run1 = run('run1', 5, [q1, q2], {
        state: 'NeedsClarification',
        baseRevision: 'r2',
        startedAt: at(5, 10),
        question: 'Which?',
        resultRevision: 'r3',
        finishedAt: at(7),
    });
    const run2 = run(
        'run2',
        10,
        [q1, q2],
        { state: 'Completed', baseRevision: 'r3', startedAt: at(10, 5), resultRevision: 'r3', changed: false, report: {}, finishedAt: at(12) },
        'The first one.',
    );

    test('the session start, each run with its requests, the note and the agent, and the revisions confirmed or restored, oldest first', () => {
        const items = streamItems({ revisions, runs: [run2, run1] });
        expect(items.map((i) => [i.kind, i.at])).toEqual([
            ['session-start', at(0)],
            ['queued', at(5)],
            ['agent', at(7)],
            ['confirmed', at(9)],
            ['queued', at(10)],
            ['note', at(10)],
            ['agent', at(12)],
            ['restored', at(21)],
        ]);
        expect(items[1]).toMatchObject({ kind: 'queued', run: 1, by: 'local:facilitator' });
        expect(items[1].kind === 'queued' && items[1].requests.map((r) => r.request)).toEqual(['q1', 'q2']);
        expect(items[2]).toMatchObject({ kind: 'agent', run: 1, message: { kind: 'clarification', question: 'Which?', result: 3 } });
        expect(items[3]).toMatchObject({ kind: 'confirmed', revision: 3, by: 'local:facilitator' });
        expect(items[5]).toMatchObject({ kind: 'note', run: 2, text: 'The first one.' });
        expect(items[6]).toMatchObject({ kind: 'agent', run: 2, message: { kind: 'completed', changed: false, result: 3 } });
        expect(items[7]).toMatchObject({ kind: 'restored', revision: 5, from: 1 });
        // pending requests are not part of the stream
        expect(JSON.stringify(streamItems({ revisions, runs: [run1, run2] }))).not.toContain(q3.id);
    });

    test("one agent message per run, at the run's latest change of state", () => {
        const message = (r: RunJson): unknown => streamItems({ revisions, runs: [r] }).find((i) => i.kind === 'agent');
        expect(message(run('x', 1, [q1], { state: 'Queued' }))).toMatchObject({ at: at(1), message: { kind: 'queued' } });
        expect(message(run('x', 1, [q1], { state: 'Running', baseRevision: 'r1', startedAt: at(2) }))).toMatchObject({
            at: at(2),
            message: { kind: 'running', since: at(2) },
        });
        expect(message(run('x', 1, [q1], { state: 'Failed', baseRevision: 'r1', startedAt: at(2), reason: 'AgentError', finishedAt: at(3) }))).toMatchObject({
            at: at(3),
            message: { kind: 'failed', reason: 'AgentError' },
        });
        expect(message(run('x', 1, [q1], { state: 'Cancelled', cancelledBy: 'local:facilitator', cancelledAt: at(4) }))).toMatchObject({
            at: at(4),
            message: { kind: 'cancelled', by: 'local:facilitator' },
        });
        expect(
            message(
                run('x', 1, [q1], {
                    state: 'Completed',
                    baseRevision: 'r1',
                    startedAt: at(2),
                    resultRevision: 'r5',
                    changed: true,
                    report: {},
                    finishedAt: at(3),
                }),
            ),
        ).toMatchObject({ message: { kind: 'completed', changed: true, result: 5 } });
    });

    test('the status: running, else queued, else waiting for an answer when the latest run asked, else idle', () => {
        const running = run('a', 1, [q1], { state: 'Running', baseRevision: 'r1', startedAt: at(2) });
        const queued = run('b', 3, [q1], { state: 'Queued' });
        expect(agentStatus([])).toEqual({ kind: 'idle' });
        expect(agentStatus([queued, running])).toEqual({ kind: 'running', since: at(2) });
        expect(agentStatus([run1, queued])).toEqual({ kind: 'queued' });
        expect(agentStatus([run1])).toEqual({ kind: 'clarification' });
        // answered: the run after the question is the latest
        expect(agentStatus([run1, run2])).toEqual({ kind: 'idle' });
    });

    test('elapsed time as m:ss, h:mm:ss from an hour on', () => {
        const start = at(0);
        expect(elapsed(start, Date.parse(start) + 42_000)).toBe('0:42');
        expect(elapsed(start, Date.parse(start) + 605_000)).toBe('10:05');
        expect(elapsed(start, Date.parse(start) + 3_725_000)).toBe('1:02:05');
        expect(elapsed(start, Date.parse(start) - 5_000)).toBe('0:00');
    });
});

describe('the requests waiting for approval', () => {
    const state = {
        requests: [
            request('old-mine', 'dev:a', 1),
            request('in-run', 'dev:a', 2),
            request('theirs', 'dev:b', 3),
            request('dismissed', 'dev:a', 4, { state: 'Dismissed', dismissedBy: 'dev:a', dismissedAt: at(5) }),
            request('new-mine', 'dev:a', 6),
            request('newer-theirs', 'dev:c', 7),
            request('newest-theirs', 'dev:b', 8),
        ],
        runs: [run('run1', 3, [request('in-run', 'dev:a', 2)], { state: 'Queued' })],
    };

    test('sent and in no run: mine first, newest first within each, a preview of three and how many more', () => {
        const pending = pendingRequests(state, 'dev:a');
        expect(pending.all.map((p) => [p.request.id, p.mine])).toEqual([
            ['new-mine', true],
            ['old-mine', true],
            ['newest-theirs', false],
            ['newer-theirs', false],
            ['theirs', false],
        ]);
        expect(pending.preview.map((p) => p.request.id)).toEqual(['new-mine', 'old-mine', 'newest-theirs']);
        expect(pending.more).toBe(2);
        expect(pendingRequests(state, 'dev:z').all[0].request.id).toBe('newest-theirs');
        expect(pendingRequests({ requests: [], runs: [] }, 'dev:a')).toEqual({ all: [], preview: [], more: 0 });
    });

    test('a one-line row and a target as the chat names it', () => {
        expect(oneLine('  first line\n\n second\tline ')).toBe('first line second line');
        expect(targetText(WORKSPACE_TARGET, 'All')).toBe('All');
        expect(targetText({ target: { kind: 'DtElement', element: 'Sales.Order' }, label: 'Order (注文)' }, 'All')).toBe('Order (注文)');
        expect(targetText({ target: { kind: 'DtesElement', storming: 'S', local: 'E' } }, 'All')).toBe('dtes:S/E');
    });
});

describe('the participants of the header', () => {
    const state = {
        session: {
            id: 's',
            facilitator: 'local:facilitator',
            participants: [
                { id: 'local:facilitator', name: 'Facilitator', role: 'Facilitator', joinedAt: at(0) },
                { id: 'dev:host', name: 'Hana', role: 'Participant', joinedAt: at(0) },
                { id: 'dev:b', name: 'Bob', role: 'Participant', joinedAt: at(1) },
                { id: 'dev:c', name: 'Carol', role: 'Participant', joinedAt: at(2) },
                { id: 'dev:a', name: 'Ann', role: 'Participant', joinedAt: at(3) },
            ],
            startedAt: at(0),
            state: 'Open',
        },
        facilitatorHolder: 'dev:host',
    } as unknown as Pick<SessionStateBody, 'session' | 'facilitatorHolder'>;
    const me = { session: 's', participant: { id: 'dev:a', name: 'Ann', role: 'participant' } } as unknown as Me;
    const peer = (id: string, name: string): Presence =>
        ({
            connection: `c-${id}`,
            participant: { id, name, role: 'participant', avatarUrl: `https://x/${id}` },
            location: { kind: 'dt', viewKey: 'v', layoutKey: 'l' },
        }) as unknown as Presence;
    const peers = new Map([['c-dev:c', peer('dev:c', 'Carol C.')]]);

    test('me first, then those online, then those away; the facilitator under its holder', () => {
        expect(headerParticipants(state, peers, me).map((p) => [p.name, p.role, p.online, p.me, p.avatarUrl])).toEqual([
            ['Ann', 'participant', true, true, undefined],
            ['Carol C.', 'participant', true, false, 'https://x/dev:c'],
            ['Bob', 'participant', false, false, undefined],
            ['Hana', 'facilitator', false, false, undefined],
        ]);
        expect(participantNames(state, NO_PEERS, me).get('local:facilitator')).toBe('Hana');
    });
});

describe("the composer's draft", () => {
    test("is kept in a scope of its own, never among the participant's drafts", async () => {
        const storage = createMemoryDrafts();
        const scope = { session: 's', participant: 'dev:a' };
        await storage.save(composerScope(scope), { ...newDraft(COMPOSER_DRAFT, WORKSPACE_TARGET, 1), body: 'unsent' });
        expect(await storage.load(scope)).toEqual([]);
        expect((await storage.load(composerScope(scope))).map((d) => d.body)).toEqual(['unsent']);
        expect(scopeKey(composerScope(scope))).not.toBe(scopeKey(scope));
    });
});
