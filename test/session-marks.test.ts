// Votes and reactions (ADR 0026, appendix "Votes and reactions"): one mechanism, "who marked what with which sign", with
// rules per kind of target; a reaction is any one emoji. The pure rules (domain/marks.ts), the use case over node:sqlite
// and the real workspace, the migrations of a database written before marks and before emoji, and the session server's
// route and WebSocket broadcast.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
    type Actor,
    Collaboration as C,
    type CollaborationDeps,
    type CollaborationUseCases,
    createCollaboration,
    createUnitOfWork,
    knownAgentRunId,
    makeEmoji,
    MAX_REACTION_EMOJI,
    openSessionBlobs,
    openSessionDatabase,
    signKey,
    toAgentReply,
    VOTE,
} from '@domaintrail/collaboration';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { DEFAULT_AGENT_TOOLS } from '@domaintrail/agent';
import { createWorkspaceSnapshot } from '@domaintrail/workspace';
import { type SessionServer, startSessionServer, createModelValidator } from '@domaintrail/dt';
import { sourceSelection } from '@domaintrail/analysis';

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

/** The actor of a participant of these tests: `facilitator` holds the facilitator's role. */
const actor = (participant: C.ParticipantId): Actor => ({
    kind: 'participant',
    participant,
    role: participant === 'facilitator' ? 'Facilitator' : 'Participant',
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
        uow: createUnitOfWork(await openSessionDatabase(root)),
        workspace: createWorkspaceSnapshot(root, sourceSelection()),
        blobs: await openSessionBlobs(root),
        validator: createModelValidator(),
        clock: { now: () => new Date('2026-11-01T09:00:00Z') },
        ids: { newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` },
    };
    const use = createCollaboration(deps);
    const { session } = value(await use.startSession({ facilitator, name }));
    for (const p of [ann, bob]) value(await use.joinSession({ session: session.id, participant: p, name }));
    const message = value(await use.sendRequest({ session: session.id, actor: actor(ann), targets: [], body: text('Add cancel.') })).id;
    return { use, deps, id: session.id, message };
}

/** Runs the message to an end: a clarification asking q1 (single) and q2 (multiple), or a completion with an assumption. */
async function ended(f: Fixture, how: 'clarification' | 'completed'): Promise<C.AgentRunId> {
    const queued = value(await f.use.queueRun({ session: f.id, requests: [f.message], actor: actor(facilitator) }));
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
            f.use.setMark({ session: f.id, actor: actor(participant), target, sign: VOTE, placed });

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
        value(await f.use.setMark({ session: f.id, actor: actor(ann), target, sign: VOTE, placed: true }));
        value(
            await f.use.queueRun({
                session: f.id,
                requests: [f.message],
                actor: actor(facilitator),
                answer: { answerTo: run, answer: { answers: [{ question: 'q1', options: ['a'] }] } },
            }),
        );
        expect(error(await f.use.setMark({ session: f.id, actor: actor(bob), target, sign: VOTE, placed: true }))).toEqual({ type: 'MarkTargetClosed' });
        expect(error(await f.use.setMark({ session: f.id, actor: actor(ann), target, sign: VOTE, placed: false }))).toEqual({ type: 'MarkTargetClosed' });
        expect(value(await f.use.sessionState({ session: f.id })).marks).toHaveLength(1);
    });

    test("an assumption's group: keep or an alternative, one per participant, closed by the re-run", async () => {
        const f = await fixture();
        const run = await ended(f, 'completed');
        const keep: C.MarkTarget = { kind: 'AssumptionChoice', run, assumption: value(C.makeTally(0)) };
        const all: C.MarkTarget = { ...keep, alternative: key('all') };
        value(await f.use.setMark({ session: f.id, actor: actor(ann), target: keep, sign: VOTE, placed: true }));
        expect(value(await f.use.setMark({ session: f.id, actor: actor(ann), target: all, sign: VOTE, placed: true })).removed).toHaveLength(1);
        value(await f.use.queueRun({ session: f.id, requests: [f.message], actor: actor(facilitator), note: text('前提「Only drafts.」は採らず…') }));
        expect(error(await f.use.setMark({ session: f.id, actor: actor(bob), target: keep, sign: VOTE, placed: true }))).toEqual({ type: 'MarkTargetClosed' });
    });

    test('refused: the facilitator voting, a sign that does not fit, a target not in the session, a stranger, a closed session', async () => {
        const f = await fixture();
        const run = await ended(f, 'clarification');
        const target: C.MarkTarget = { kind: 'QuestionOption', run, question: key('q1'), option: key('a') };
        const set = (participant: C.ParticipantId, t: C.MarkTarget, sign: C.MarkSign) =>
            f.use.setMark({ session: f.id, actor: actor(participant), target: t, sign, placed: true });
        expect(error(await set(facilitator, target, VOTE))).toEqual({ type: 'FacilitatorDoesNotVote' });
        expect(error(await set(ann, target, react('👍')))).toEqual({ type: 'MarkNotForTarget' });
        expect(error(await set(ann, { kind: 'Message', request: f.message }, VOTE))).toEqual({ type: 'MarkNotForTarget' });
        expect(error(await set(ann, { ...target, option: key('zz') }, VOTE))).toEqual({ type: 'MarkTargetNotFound' });
        expect(error(await set(ann, { kind: 'Turn', run: knownAgentRunId('00000000-0000-4000-8000-0000000000ff') }, react('❤️')))).toEqual({
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
        value(await f.use.closeSession({ session: f.id, actor: actor(facilitator) }));
        expect(error(await set(ann, { kind: 'Message', request: f.message }, react('❤️')))).toEqual({ type: 'SessionAlreadyClosed' });
    });

    test(`a message holds at most ${MAX_REACTION_EMOJI} different emoji: the next new one is refused, one already there is not`, async () => {
        const f = await fixture();
        const message: C.MarkTarget = { kind: 'Message', request: f.message };
        const set = (participant: C.ParticipantId, emoji: string) =>
            f.use.setMark({ session: f.id, actor: actor(participant), target: message, sign: react(emoji), placed: true });
        for (const [i, e] of TWENTY.entries()) value(await set(i % 2 === 0 ? ann : bob, e));
        expect(error(await set(ann, '🙃'))).toEqual({ type: 'ReactionLimitReached', limit: value(C.makeTally(MAX_REACTION_EMOJI)) });
        // joining an emoji there is fine; taking one off makes room
        value(await set(ann, '😁'));
        value(await f.use.setMark({ session: f.id, actor: actor(ann), target: message, sign: react('😀'), placed: false }));
        value(await set(ann, '🙃'));
        // another target has its own room
        value(
            await f.use.setMark({
                session: f.id,
                actor: actor(ann),
                target: { kind: 'Turn', run: await ended(f, 'completed') },
                sign: react('🙃'),
                placed: true,
            }),
        );
    });
});

// ---- persistence ----

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
                agent: { port: 0, allowedTools: [...DEFAULT_AGENT_TOOLS], run: { warm: true, restartAfter: 20 }, maxPreviousRunDiff: 20 * 1024 },
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
