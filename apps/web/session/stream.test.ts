import { describe, expect, test } from 'bun:test';
import type { Me, Presence, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { COMPOSER_DRAFT, composerScope, createMemoryDrafts, newDraft, scopeKey } from './drafts';
import { NO_PEERS } from './presence';
import { targetName, WORKSPACE_TARGET, type NamingContext } from './targets';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { type DomainModel } from '@domaintrail/modeling';
import { analyze } from '@domaintrail/analysis';
import { exampleSources } from '../test-helpers';
import { applyEvent } from './state';
import {
    agentStatus,
    elapsed,
    filesChanged,
    headerParticipants,
    isFacilitator,
    oneLine,
    participantNames,
    streamItems,
    agentMessage,
    revisionLookup,
    speakerName,
    targetsSummary,
    targetText,
} from './stream';

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
        targets: [{ target: { kind: 'DtElement', element: `Sales.${id}` }, label: `Sales.${id}`, sourceRevision: 'r1' }],
        body: `body of ${id}`,
        sentAt: at(minute),
        state: 'Sent',
        ...extra,
    }) as unknown as RequestJson;
const frozen = (r: RequestJson): RunJson['input']['requests'][number] => ({ request: r.id, author: r.author, targets: r.targets, body: r.body });
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

    test('the session start, every message, one card per run and the runs continuing it, and the revisions confirmed or restored, oldest first', () => {
        const items = streamItems({ revisions, runs: [run2, run1], requests: [q1, q2, q3] });
        expect(items.map((i) => [i.kind, i.at])).toEqual([
            ['session-start', at(0)],
            ['message', at(1)],
            ['message', at(2)],
            ['message', at(3)],
            ['card', at(5)],
            ['confirmed', at(9)],
            ['restored', at(21)],
        ]);
        // run 2 queued the requests of run 1 again after its question: one card, where run 1 was queued, updated since
        const card = items[4];
        expect(card.kind === 'card' && [card.unit.runs.map((r) => r.number), card.updatedAt]).toEqual([[1, 2], at(12)]);
        expect(items[5]).toMatchObject({ kind: 'confirmed', revision: 3, by: 'local:facilitator' });
        expect(items[6]).toMatchObject({ kind: 'restored', revision: 5, from: 1 });
        // every message is in the stream, applied or not
        expect(items.filter((i) => i.kind === 'message').map((i) => i.kind === 'message' && i.request.id)).toEqual(['q1', 'q2', 'q3']);
    });

    test("one agent message per run, at the run's latest change of state", () => {
        const lookup = revisionLookup({ revisions, runs: [] });
        const message = (r: RunJson): unknown => agentMessage(r, lookup);
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

    test("the agent's reply: the requests it names resolved to the run's, the files changed measured from the revisions", () => {
        const file = (p: string, hash: string): object => ({ path: p, language: 'Dt', hash, bytes: 1 });
        const before = rev('b', 1, { kind: 'RunBase', run: 'x' }, { files: [file('a.dt', '1'), file('b.dt', '2'), file('c.dt', '3')] });
        const after = rev('a', 2, { kind: 'RunResult', run: 'x' }, { files: [file('a.dt', '1'), file('b.dt', '9'), file('d.dt', '4')] });
        expect(filesChanged(before, after)).toBe(3);
        expect(filesChanged(before, before)).toBe(0);
        expect(filesChanged(before, undefined)).toBeUndefined();
        const message = (state: object): unknown => agentMessage(run('x', 1, [q1, q2], state), revisionLookup({ revisions: [before, after], runs: [] }));
        const ended = { baseRevision: 'b', startedAt: at(1), resultRevision: 'a', finishedAt: at(3) };
        const reply = {
            summary: 'Added.',
            requests: [
                { request: 'q2', status: 'Partial', note: 'Only one.' },
                { request: 'elsewhere', status: 'Done' },
            ],
            questions: [],
            assumptions: [{ text: 'Open only.', requests: ['q1'], alternatives: [{ id: 'all', label: 'All' }] }],
        };
        expect(message({ state: 'Completed', ...ended, changed: true, report: {}, reply })).toMatchObject({
            message: {
                kind: 'completed',
                files: 3,
                reply: {
                    summary: 'Added.',
                    // a request the run does not have is left out
                    requests: [{ request: { number: 2, request: { request: 'q2', author: 'dev:b' } }, status: 'Partial', note: 'Only one.' }],
                    assumptions: [{ text: 'Open only.', requests: [{ number: 1 }], alternatives: [{ id: 'all', label: 'All' }] }],
                },
            },
        });
        const question = { id: 'q', text: 'Which?', requests: ['q1'], options: [{ id: 'o', label: 'O' }], multiple: true };
        expect(message({ state: 'NeedsClarification', ...ended, question: 'Which?', reply: { ...reply, questions: [question] } })).toMatchObject({
            message: { kind: 'clarification', question: 'Which?', reply: { questions: [{ id: 'q', requests: [{ number: 1 }], multiple: true }] } },
        });
        expect(message({ state: 'Declined', ...ended, resultRevision: 'b', reply: { ...reply, summary: 'Not about the model.' } })).toMatchObject({
            message: { kind: 'declined', files: 0, reply: { summary: 'Not about the model.' } },
        });
        // an old run without a reply shows as before
        expect(message({ state: 'NeedsClarification', ...ended, question: 'Which?' })).toMatchObject({
            message: { kind: 'clarification', question: 'Which?', result: 2, files: 3 },
        });
        expect(JSON.stringify(message({ state: 'NeedsClarification', ...ended, question: 'Which?' }))).not.toContain('reply');
        // a declined run is not waiting for anyone
        expect(agentStatus([run('x', 1, [q1], { state: 'Declined', ...ended, reply })])).toEqual({ kind: 'idle' });
    });

    test('a structured ending asks for the state again: its reply is not in the event', () => {
        const state = {
            session: {},
            requests: [],
            revisions: [],
            seq: 1,
            runs: [run('x', 1, [q1], { state: 'Running', baseRevision: 'r1', startedAt: at(2) })],
        } as unknown as SessionStateBody;
        const asked = applyEvent(state, {
            type: 'run.needs_clarification',
            seq: 2,
            event: { type: 'RunNeedsClarification', runId: 'x', question: 'Which?', resultRevision: 'r1', finishedAt: at(3) },
        });
        expect([asked.state.runs[0]?.state, asked.refetch]).toEqual(['NeedsClarification', true]);
        const declined = applyEvent(state, {
            type: 'run.declined',
            seq: 2,
            event: { type: 'RunDeclined', runId: 'x', resultRevision: 'r1', finishedAt: at(3) },
        });
        expect(declined.refetch).toBe(true);
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

describe('the names of the chat', () => {
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

    test("a message's author: 「あなた」 for my own, else their name; the facilitator and its holder are the facilitator", () => {
        const nameOf = (id: string): string => participantNames(state, NO_PEERS, me).get(id) ?? id;
        expect(speakerName('dev:a', me.participant.id, nameOf, 'あなた')).toBe('あなた');
        expect(speakerName('dev:b', me.participant.id, nameOf, 'あなた')).toBe('Bob');
        expect(isFacilitator(state, 'local:facilitator')).toBe(true);
        expect(isFacilitator(state, 'dev:host')).toBe(true);
        expect(isFacilitator(state, 'dev:b')).toBe(false);
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

const SAMPLE = await readFile(path.join(import.meta.dir, '..', '..', '..', 'test', 'fixtures', 'dtes', 'delivery-cancellation.dtes'), 'utf8');
const { stormings: parsed } = (await analyze([{ path: 'es.dtes', text: SAMPLE }])).stormings;
const storming = parsed[0];
const model = (await analyze(await exampleSources())).model as DomainModel;

describe('targets named in the display setting', () => {
    const stormings = [{ id: storming.id, storming }];
    const naming = (mode: NamingContext['mode']): NamingContext => ({ mode, model, stormings });
    const order = { target: { kind: 'DtElement', element: 'Sales.Order' }, label: '注文 (Sales.Order)' } as const;
    const occurrence = {
        kind: 'DtesOccurrence',
        storming: 'DeliveryCancellation',
        timeline: 'Normal',
        eventName: 'ShipmentCancelled',
        occurrence: '0',
    } as const;

    test('a .dt element, state or command as the inspector names it, in each mode', () => {
        expect(targetName(order.target, naming('label'))).toBe('注文');
        expect(targetName(order.target, naming('name'))).toBe('Order');
        expect(targetName(order.target, naming('both'))).toBe('注文 (Order)');
        expect(targetName({ kind: 'DtElement', element: 'Sales.Order#Draft' }, naming('label'))).toBe('注文.下書き');
        expect(targetText(order, 'All', naming('name'))).toBe('Order');
    });

    test('a storming element or occurrence as the storming view names it', () => {
        const element = { kind: 'DtesElement', storming: 'DeliveryCancellation', local: 'ShipmentCancelled' } as const;
        expect(targetName(element, naming('label'))).toBe('配送キャンセル / 配送がキャンセルされた');
        expect(targetName(element, naming('name'))).toBe('DeliveryCancellation / ShipmentCancelled');
        expect(targetName(occurrence, naming('label'))).toBe('配送キャンセル / 配送がキャンセルされた @ 通常キャンセル #1');
        expect(targetName(occurrence, naming('both'))).toBe(
            '配送キャンセル (DeliveryCancellation) / 配送がキャンセルされた (ShipmentCancelled) @ 通常キャンセル (Normal) #1',
        );
    });

    test("a request's targets on one line: the first one and how many more; none is the whole workspace", () => {
        const customer = { target: { kind: 'DtElement', element: 'Sales.Customer' } } as const;
        expect(targetsSummary([order, customer, customer], 'All', naming('label'))).toBe('注文 +2');
        expect(targetsSummary([order], 'All', naming('name'))).toBe('Order');
        expect(targetsSummary([], 'All', naming('label'))).toBe('All');
    });

    test('a target no longer in the sources keeps the label it was taken with; the workspace its word', () => {
        const gone = { target: { kind: 'DtElement', element: 'Sales.Gone' }, label: 'なくなった (Sales.Gone)' } as const;
        expect(targetName(gone.target, naming('name'))).toBeUndefined();
        expect(targetText(gone, 'All', naming('name'))).toBe('なくなった (Sales.Gone)');
        expect(targetText({ target: { kind: 'DtesElement', storming: 'Nope', local: 'X' } }, 'All', naming('label'))).toBe('dtes:Nope/X');
        expect(targetText(WORKSPACE_TARGET, 'All', naming('label'))).toBe('All');
        expect(targetText(order, 'All', { ...naming('label'), model: null })).toBe('注文 (Sales.Order)');
    });
});
