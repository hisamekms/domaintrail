// The AI's side of the chat (ADR 0030): Solo, where an addressed message stands, the answers given up, the AI's
// presence, whether a draft reaches the AI, the proposals; and how the page's state takes the agents' presence.
import { describe, expect, test } from 'bun:test';
import type { Me, SessionStateBody } from '@domaintrail/collaboration/protocol';
import {
    aiPresence,
    awaitsAnswerer,
    givenUpTriages,
    isSolo,
    messageAi,
    openProposals,
    proposalContent,
    triagesByRequest,
    willAddress,
    type TriageJson,
} from './ai';
import { messageMarks } from './cards';
import { collabMenuItems } from './collab';
import { changeUnits } from './history';
import { adopt, INITIAL_SESSION, receive } from './state';
import { participantNames, streamItems } from './stream';
import { NO_PEERS } from './presence';

type RequestJson = SessionStateBody['requests'][number];
type ProposalJson = NonNullable<SessionStateBody['proposals']>[number];
type RunJson = SessionStateBody['runs'][number];

const at = (minute: number): string => `2026-11-03T09:${String(minute).padStart(2, '0')}:00.000Z`;
const message = (id: string, author: string, minute: number, extra: object = {}): RequestJson =>
    ({ id, session: 's', author, targets: [], body: `body of ${id}`, sentAt: at(minute), state: 'Sent', mentions: [], ...extra }) as unknown as RequestJson;
const pending = (id: string, request: string, minute = 0): TriageJson =>
    ({
        id,
        session: 's',
        request,
        addressedBy: 'Mention',
        addressedByParticipant: 'p',
        steps: [],
        openedAt: at(minute),
        state: 'Pending',
    }) as unknown as TriageJson;
const decided = (id: string, request: string, kind: string, outcome?: object, minute = 1, extra: object = {}): TriageJson =>
    ({
        ...pending(id, request),
        state: 'Decided',
        kind,
        decidedBy: 'Model',
        decidedAt: at(minute),
        ...(outcome && { outcome }),
        ...extra,
    }) as unknown as TriageJson;
const proposal = (id: string, state: string, extra: object = {}): ProposalJson =>
    ({
        id,
        session: 's',
        triage: `t-${id}`,
        request: `m-${id}`,
        requestedBy: 'p',
        content: { what: 'what', where: 'where', how: 'how' },
        proposedAt: at(2),
        state,
        ...extra,
    }) as unknown as ProposalJson;
const queuedRun = (id: string): RunJson =>
    ({ id, session: 's', input: { requests: [] }, queuedBy: 'f', queuedAt: at(3), state: 'Queued' }) as unknown as RunJson;
const state = (extra: Partial<Record<keyof SessionStateBody, unknown>> = {}): SessionStateBody =>
    ({
        session: { id: 's', facilitator: 'f', participants: [{ id: 'f', name: 'Fumi', role: 'Facilitator' }], mode: 'Collab', state: 'Open' },
        requests: [message('mf', 'f', 0), message('mp', 'p', 0)],
        runs: [],
        revisions: [],
        marks: [],
        approvals: [],
        quickReactions: [],
        seq: 1,
        ...extra,
    }) as unknown as SessionStateBody;

describe('the mode', () => {
    test('a Solo session is dt open: no one to mention, only the workspace in the menu', () => {
        expect(isSolo(state())).toBe(false);
        const solo = state({ session: { ...state().session, mode: 'Solo' } });
        expect(isSolo(solo)).toBe(true);
        expect(collabMenuItems('facilitator', true, true)).toEqual(['record', 'restore']);
        expect(collabMenuItems('facilitator', true)).toEqual(['invite', 'record', 'restore', 'hand-over', 'end']);
        expect(collabMenuItems('facilitator', false, true)).toEqual([]);
    });

    test('the AI is named AI wherever a participant is named', () => {
        const me = { session: 's', participant: { id: 'f', name: 'Fumi', role: 'facilitator' } } as unknown as Me;
        expect(participantNames(state(), NO_PEERS, me).get('ai')).toBe('AI');
    });
});

describe('where an addressed message stands', () => {
    test('not addressed, triaging, waiting for the answerer, then where it went; nothing for "neither"', () => {
        expect(messageAi(undefined)).toEqual({ kind: 'none' });
        expect(messageAi(pending('t', 'm', 4))).toEqual({ kind: 'working', since: at(4) });
        expect(messageAi(decided('t', 'm', 'Consultation'))).toEqual({ kind: 'working', since: at(0) });
        expect(messageAi(decided('t', 'm', 'Consultation', { kind: 'Answer', answer: 'a1' }))).toEqual({ kind: 'answer', answer: 'a1' });
        expect(messageAi(decided('t', 'm', 'ChangeRequest', { kind: 'Proposal', proposal: 'x' }))).toEqual({ kind: 'proposal', proposal: 'x' });
        expect(messageAi(decided('t', 'm', 'ChangeRequest', { kind: 'Run', run: 'r' }))).toEqual({ kind: 'run', run: 'r' });
        expect(messageAi(decided('t', 'm', 'NotForAi'))).toEqual({ kind: 'neither' });
        expect(messageAi(decided('t', 'm', 'Consultation'), new Set(['t']))).toEqual({ kind: 'given-up' });
        // a participant's page gets the outcome without the steps: read the same
        const outcome = {
            id: 't',
            session: 's',
            request: 'm',
            addressedBy: 'Reply',
            addressedByParticipant: 'p',
            openedAt: at(0),
            state: 'Decided',
            kind: 'Consultation',
        };
        expect(messageAi(outcome as unknown as TriageJson)).toEqual({ kind: 'working', since: at(0) });
        expect(triagesByRequest(state({ triages: [pending('t', 'mp')] })).get('mp')?.id).toBe('t');
    });

    test("the answerer is awaited for a 相談 and a participant's 依頼, not for the facilitator's (queued at once)", () => {
        const s = state();
        expect(awaitsAnswerer(decided('t', 'mp', 'Consultation'), s)).toBe(true);
        expect(awaitsAnswerer(decided('t', 'mp', 'ChangeRequest'), s)).toBe(true);
        expect(awaitsAnswerer(decided('t', 'mf', 'ChangeRequest'), s)).toBe(false);
        expect(awaitsAnswerer(decided('t', 'mp', 'ChangeRequest', undefined, 1, { addressedBy: 'Facilitator' }), s)).toBe(false);
        expect(awaitsAnswerer(decided('t', 'mp', 'NotForAi'), s)).toBe(false);
        expect(awaitsAnswerer(decided('t', 'mp', 'Consultation', { kind: 'Answer', answer: 'a' }), s)).toBe(false);
        expect(awaitsAnswerer(pending('t', 'mp'), s)).toBe(false);
    });

    test('given up: the jobs the page sees waiting beyond what the presence counts, the oldest first', () => {
        const triages = [decided('t1', 'mp', 'Consultation', undefined, 1), decided('t2', 'mf', 'Consultation', undefined, 2), pending('t3', 'mp')];
        const presence = (waiting: number) => ({ connected: { answer: 1, run: 1 }, waiting });
        // the two answers and the triage at stage 3 wait, and the queued run: nothing given up
        expect(givenUpTriages(state({ triages, runs: [queuedRun('r')], agent: presence(4) }))).toEqual(new Set());
        // one answer less than the page sees: the oldest was given up
        expect(givenUpTriages(state({ triages, runs: [queuedRun('r')], agent: presence(3) }))).toEqual(new Set(['t1']));
        expect(givenUpTriages(state({ triages, agent: presence(1) }))).toEqual(new Set(['t1', 't2']));
        // no presence (an older server): none
        expect(givenUpTriages(state({ triages }))).toEqual(new Set());
    });
});

describe('the AI in the header and the composer', () => {
    test('nothing while every role is connected; else which is missing and how much waits', () => {
        expect(aiPresence(undefined)).toEqual({ kind: 'connected' });
        expect(aiPresence({ connected: { answer: 1, run: 2 }, waiting: 3 })).toEqual({ kind: 'connected' });
        expect(aiPresence({ connected: { answer: 0, run: 0 }, waiting: 2 })).toEqual({ kind: 'missing', role: 'all', waiting: 2 });
        expect(aiPresence({ connected: { answer: 1, run: 0 }, waiting: 0 })).toEqual({ kind: 'missing', role: 'run', waiting: 0 });
        expect(aiPresence({ connected: { answer: 0, run: 1 }, waiting: 1 })).toEqual({ kind: 'missing', role: 'answer', waiting: 1 });
    });

    test('a draft reaches the AI in Solo, with @AI, or as a reply to the AI or to a run', () => {
        const s = state({ requests: [message('mp', 'p', 0), message('ma', 'ai', 1, { replyTo: { kind: 'Message', request: 'mp' } })] });
        expect(willAddress(s, [], undefined)).toBe(false);
        expect(willAddress(s, ['p'], { kind: 'Message', request: 'mp' })).toBe(false);
        expect(willAddress(s, ['ai'], undefined)).toBe(true);
        expect(willAddress(s, [], { kind: 'Message', request: 'ma' })).toBe(true);
        expect(willAddress(s, [], { kind: 'Run' })).toBe(true);
        expect(willAddress(state({ session: { ...s.session, mode: 'Solo' } }), [], undefined)).toBe(true);
    });

    test("the agents' presence replaces the state's, and waits for a state before there is one", () => {
        const presence = { connected: { answer: 0, run: 1 }, waiting: 2 };
        expect(receive(INITIAL_SESSION, { type: 'agent.presence', agent: presence })).toBe(INITIAL_SESSION);
        const me = { session: 's', participant: { id: 'f', name: 'Fumi', role: 'facilitator' } } as unknown as Me;
        const held = adopt(INITIAL_SESSION, state(), me, true);
        expect(receive(held, { type: 'agent.presence', agent: presence }).state?.agent).toEqual(presence);
    });

    test('a triage or proposal event fetches the state again', () => {
        const me = { session: 's', participant: { id: 'f', name: 'Fumi', role: 'facilitator' } } as unknown as Me;
        const held = adopt(INITIAL_SESSION, state(), me, true);
        const event = { type: 'triage.decided', seq: 2, event: { type: 'TriageDecided', triageId: 't', kind: 'Consultation', decidedAt: at(1) } };
        expect(receive(held, event as never).refetch).toBe(true);
        const proposed = { type: 'proposal.approved', seq: 3, event: { type: 'ProposalApproved', proposalId: 'x' } };
        expect(receive(held, proposed as never).refetch).toBe(true);
    });
});

describe('change proposals', () => {
    test('in the stream where they were made; the open ones; an approval with an edit stands for the edit', () => {
        const edited = { what: 'w2', where: 'x2', how: 'h2' };
        const proposals = [
            proposal('a', 'Open'),
            proposal('b', 'Approved', { edited, approvedBy: 'f', approvedAt: at(3), run: 'r' }),
            proposal('c', 'Rejected'),
        ];
        const s = state({ proposals });
        expect(openProposals(s).map((p) => p.id)).toEqual(['a']);
        expect(proposalContent(proposals[1])).toEqual(edited);
        expect(proposalContent(proposals[0])).toEqual(proposals[0].content);
        const items = streamItems(s).map((i) => i.key);
        expect(items).toEqual(['message:mf', 'message:mp', 'proposal:a', 'proposal:b', 'proposal:c']);
    });
});

describe('a run that answered', () => {
    test('a request the run answered as a question is marked answered', () => {
        const m = message('mp', 'p', 0);
        const run = {
            id: 'r',
            session: 's',
            input: { requests: [{ request: 'mp', author: 'p', targets: [], body: m.body }] },
            queuedBy: 'f',
            queuedAt: at(1),
            state: 'Completed',
            baseRevision: 'v1',
            resultRevision: 'v1',
            changed: false,
            finishedAt: at(2),
            reply: { summary: 's', answer: 'It is so.', requests: [{ request: 'mp', status: 'Answered' }], questions: [], assumptions: [] },
        } as unknown as RunJson;
        const marks = messageMarks(changeUnits({ runs: [run], revisions: [] }));
        expect(marks.get('mp')?.state).toBe('answered');
    });
});
