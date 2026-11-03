// The AI's side of the chat (ADR 0030): Solo, where an addressed message stands, the answers given up, the AI's
// presence, whether a draft reaches the AI, the proposals; and how the page's state takes the agents' presence.
import { describe, expect, test } from 'bun:test';
import type { Me, SessionStateBody } from '@domaintrail/collaboration/protocol';
import {
    aiPresence,
    aiSlot,
    givenUpRequests,
    isSolo,
    messageAi,
    openProposals,
    settleOutgoing,
    triagesByRequest,
    willAddress,
    type AiSlot,
    type Outgoing,
    type TriageJson,
} from './ai';
import { messageMarks } from './cards';
import { collabMenuItems } from './collab';
import { changeUnits } from './history';
import { adopt, INITIAL_SESSION, receive } from './state';
import { participantNames, placeAiSlots, streamItems } from './stream';
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
        content: { targets: [], how: 'how', options: [] },
        proposedAt: at(2),
        state,
        ...extra,
    }) as unknown as ProposalJson;
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
        expect(messageAi(decided('t', 'm', 'Consultation'), new Set(['m']))).toEqual({ kind: 'given-up' });
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

    test('given up: the messages the presence lists, each until it is tried again', () => {
        const presence = { connected: { answer: 1, run: 1 }, waiting: 0, givenUp: [{ request: 'mp', kind: 'answer' as const }] };
        expect(givenUpRequests(state({ agent: presence }))).toEqual(new Set(['mp']));
        expect(givenUpRequests(state({ agent: { connected: { answer: 1, run: 1 }, waiting: 0 } }))).toEqual(new Set());
        expect(givenUpRequests(state())).toEqual(new Set());
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
    test('in the stream where they were made; the open ones', () => {
        const proposals = [
            proposal('a', 'Open'),
            proposal('b', 'Approved', { editedHow: 'h2', approvedBy: 'f', approvedAt: at(3), run: 'r' }),
            proposal('c', 'Rejected'),
        ];
        const s = state({ proposals });
        expect(openProposals(s).map((p) => p.id)).toEqual(['a']);
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

describe("the AI's card under a message in Solo", () => {
    const none = new Set<string>();
    const mine = message('m', 'f', 0);

    test('pending from the sending (before the triage reaches the page), then the answer, the run, or nothing', () => {
        // sent from this page, its triage not here yet: pending at once
        expect(aiSlot(true, mine, undefined, none, true)).toEqual({ kind: 'pending' });
        // not sent from this page (a revert, a message from before the triages): no card
        expect(aiSlot(true, mine, undefined, none, false)).toBeUndefined();
        // the server's triage: pending while it is triaged or the answer is being written, after a reload too
        expect(aiSlot(true, mine, pending('t', 'm'), none, false)).toEqual({ kind: 'pending' });
        expect(aiSlot(true, mine, decided('t', 'm', 'Consultation'), none, false)).toEqual({ kind: 'pending' });
        expect(aiSlot(true, mine, decided('t', 'm', 'Consultation', { kind: 'Answer', answer: 'a' }), none, true)).toEqual({ kind: 'answer', answer: 'a' });
        expect(aiSlot(true, mine, decided('t', 'm', 'ChangeRequest', { kind: 'Run', run: 'r' }), none, false)).toEqual({ kind: 'run', run: 'r' });
        expect(aiSlot(true, mine, decided('t', 'm', 'NotForAi'), none, true)).toBeUndefined();
        expect(aiSlot(true, mine, decided('t', 'm', 'Consultation'), new Set(['m']), false)).toEqual({ kind: 'given-up' });
        // a proposal is a card of its own
        expect(aiSlot(true, mine, decided('t', 'm', 'ChangeRequest', { kind: 'Proposal', proposal: 'x' }), none, false)).toBeUndefined();
        // the AI's own messages have none
        expect(aiSlot(true, message('a', 'ai', 1), undefined, none, true)).toBeUndefined();
    });

    test("the AI's reply on the page before the triage naming it the answer: the answer at once, not pending", () => {
        expect(aiSlot(true, mine, decided('t', 'm', 'Consultation'), none, true, 'a')).toEqual({ kind: 'answer', answer: 'a' });
        expect(aiSlot(true, mine, undefined, none, true, 'a')).toEqual({ kind: 'answer', answer: 'a' });
        // what the triage says once it is there stands
        expect(aiSlot(true, mine, decided('t', 'm', 'ChangeRequest', { kind: 'Run', run: 'r' }), none, false, 'a')).toEqual({ kind: 'run', run: 'r' });
        expect(aiSlot(true, mine, decided('t', 'm', 'Consultation'), new Set(['m']), false, 'a')).toEqual({ kind: 'given-up' });
    });

    test('Collab is unchanged: no card, the message keeps its quiet "…"', () => {
        expect(aiSlot(false, mine, pending('t', 'm'), none, true)).toBeUndefined();
        expect(aiSlot(false, mine, undefined, none, true)).toBeUndefined();
        const items = streamItems(state());
        expect(placeAiSlots(items, new Map())).toEqual(items.map((item) => ({ kind: 'item', item })));
    });

    test("a message sent from this page: on its way until the server's is here, by the ID it answered or by its text", () => {
        const o = (local: string, body: string, extra: Partial<Outgoing> = {}): Outgoing => ({
            local,
            request: message(local, 'f', 5, { body }),
            known: new Set(['m0']),
            ...extra,
        });
        const requests = [message('m0', 'f', 0, { body: 'same' }), message('m1', 'f', 1, { body: 'same' }), message('m2', 'p', 2, { body: 'other' })];
        // before the server answered: the first new message of mine with the same text, each taken once
        const a = settleOutgoing([o('l1', 'same'), o('l2', 'same'), o('l3', 'other')], requests);
        expect([...a.sent]).toEqual([['m1', 'l1']]);
        expect(a.waiting.map((w) => w.local)).toEqual(['l2', 'l3']);
        // the server answered with its ID: that one, once it is on the page
        expect([...settleOutgoing([o('l1', 'x', { id: 'm2' })], requests).sent]).toEqual([['m2', 'l1']]);
        expect(settleOutgoing([o('l1', 'x', { id: 'm9' })], requests).waiting.length).toBe(1);
    });

    test('the answer or the run card goes right under its message, in the place of its card', () => {
        const run = {
            id: 'r',
            session: 's',
            input: { requests: [{ request: 'm2', author: 'f', targets: [], body: 'b' }] },
            queuedBy: 'f',
            queuedAt: at(5),
            state: 'Running',
            startedAt: at(6),
        };
        const s = state({
            session: { ...state().session, mode: 'Solo' },
            requests: [
                message('m1', 'f', 0),
                message('m2', 'f', 1),
                message('m3', 'f', 2),
                message('a1', 'ai', 3, { replyTo: { kind: 'Message', request: 'm1' } }),
            ],
            runs: [run],
        });
        const items = streamItems(s);
        const keys = (slots: ReadonlyMap<string, AiSlot>): string[] =>
            placeAiSlots(items, slots).map((e) =>
                e.kind === 'item' ? e.item.key : `ai:${e.request}=${e.content.kind === 'item' ? e.content.item.key : e.content.kind}`,
            );
        expect(items.map((i) => i.key)).toEqual(['message:m1', 'message:m2', 'message:m3', 'message:a1', 'card:r']);
        expect(
            keys(
                new Map<string, AiSlot>([
                    ['m1', { kind: 'answer', answer: 'a1' }],
                    ['m2', { kind: 'run', run: 'r' }],
                    ['m3', { kind: 'pending' }],
                ]),
            ),
        ).toEqual(['message:m1', 'ai:m1=message:a1', 'message:m2', 'ai:m2=card:r', 'message:m3', 'ai:m3=pending']);
        // decided, the answer not on the page yet: still pending; given up: said in the card
        expect(
            keys(
                new Map<string, AiSlot>([
                    ['m1', { kind: 'answer', answer: 'a9' }],
                    ['m3', { kind: 'given-up' }],
                ]),
            ),
        ).toEqual(['message:m1', 'ai:m1=pending', 'message:m2', 'message:m3', 'ai:m3=given-up', 'message:a1', 'card:r']);
        // a card already under an earlier message stays there: the later one has no card of its own
        expect(
            keys(
                new Map<string, AiSlot>([
                    ['m2', { kind: 'run', run: 'r' }],
                    ['m3', { kind: 'run', run: 'r' }],
                ]),
            ),
        ).toEqual(['message:m1', 'message:m2', 'ai:m2=card:r', 'message:m3', 'message:a1']);
    });
});
