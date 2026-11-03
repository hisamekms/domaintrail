// Replies to runs (ADR 0026, amendment "replies to runs"): a message may name an ended run of its session (completed,
// failed, declined, cancelled — not one queued, running or waiting for an answer); a run of replies freezes which runs
// they reply to, and the agent is given each of them (and the run an answer answers) with what it changed, bounded.
// Replies to messages (amendment "replies to messages"): a message may name any message of its session; a run freezes
// the original's author and body.
// The rules and the use cases over node:sqlite and a real workspace, the migration of a database written before
// replies, the prompt, and the session server's route and agent API.
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
    knownRequestId,
    openSessionBlobs,
    openSessionDatabase,
    toAgentReply,
} from '@domaintrail/collaboration';
import type { AgentPreviousRun } from '@domaintrail/collaboration/protocol';
import { type SessionServer, startSessionServer, createModelValidator } from '@domaintrail/dt';
import { DEFAULT_AGENT_TOOLS } from '@domaintrail/agent';
import { createWorkspaceSnapshot } from '@domaintrail/workspace';
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

const SALES = `context Sales {
  id OrderId: UUID

  aggregate Order {
    id: OrderId

    state Draft
    state Confirmed

    create command place(id: OrderId)
      -> Draft

    command confirm()
      Draft -> Confirmed
  }
}
`;
const WITH_CANCEL = SALES.replace('    command confirm()', '    command cancel()\n      Draft -> Draft\n\n    command confirm()');

async function workspace(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'domaintrail-replies-'));
    dirs.push(root);
    for (const [file, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), text);
    }
    return root;
}

const facilitator = value(C.makeParticipantId('facilitator'));
const ann = value(C.makeParticipantId('ann'));
const name = value(C.makeDisplayName('Ada'));
const text = (t: string): C.Text => value(C.makeText(t));
const facts = { exitCode: 0, formatted: 'Ran', checked: 'Ran' } as const;

interface Fixture {
    readonly root: string;
    readonly use: CollaborationUseCases;
    readonly deps: CollaborationDeps;
    readonly id: C.SessionId;
    /** Sends Ann's message, replying to a run (its ID) or to what `replyTo` names. */
    send(body: string, replyTo?: C.AgentRunId | C.ReplyTarget): Promise<C.SentRequest>;
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
    value(await use.joinSession({ session: session.id, participant: ann, name }));
    return {
        root,
        use,
        deps,
        id: session.id,
        send: async (body, to) => {
            const replyTo: C.ReplyTarget | undefined = typeof to === 'string' ? { kind: 'Run', run: to } : to;
            return value(await use.sendRequest({ session: session.id, actor: actor(ann), targets: [], body: text(body), ...(replyTo && { replyTo }) }));
        },
    };
}

type Ending = 'completed' | 'changed' | 'clarification' | 'declined' | 'failed' | 'cancelled' | 'running' | 'queued';

/** Queues the requests as a run (with an answer, when given) and takes it to `how`. */
async function runTo(
    f: Fixture,
    requests: readonly C.RequestId[],
    how: Ending,
    answer?: { answerTo: C.AgentRunId; answer: { answers: { question: string; options: string[] }[] } },
): Promise<C.AgentRunId> {
    const queued = value(await f.use.queueRun({ session: f.id, requests: [...requests], actor: actor(facilitator), ...(answer && { answer }) }));
    if (how === 'queued') return queued.id;
    if (how === 'cancelled') {
        value(await f.use.cancelRun({ run: queued.id, actor: actor(facilitator) }));
        return queued.id;
    }
    const { lease } = value(await f.use.claimNextRun({ session: f.id, owner: 'agent', leaseMs: 30_000 }));
    value(await f.use.startRun({ run: queued.id, token: lease.token }));
    const token = lease.token;
    const lines = requests.map((request) => ({ request, status: 'done' as const }));
    switch (how) {
        case 'running':
            break;
        case 'changed':
            await writeFile(path.join(f.root, 'sales/sales.dt'), WITH_CANCEL);
            value(
                await f.use.finishRun({
                    run: queued.id,
                    token,
                    facts,
                    reply: toAgentReply({ outcome: 'done', summary: 'Added cancel.', requests: lines, questions: [], assumptions: [] }),
                }),
            );
            break;
        case 'completed':
            value(await f.use.finishRun({ run: queued.id, token, facts }));
            break;
        case 'clarification': {
            const reply = toAgentReply({
                outcome: 'clarification',
                summary: 'Which?',
                requests: requests.map((request) => ({ request, status: 'question' })),
                questions: [{ id: 'q1', text: 'Which state?', requests: [], options: [{ id: 'draft', label: 'Draft' }], multiple: false }],
                assumptions: [],
            });
            value(await f.use.askClarification({ run: queued.id, token, question: text('Which state?'), reply }));
            break;
        }
        case 'declined':
            value(
                await f.use.declineRun({
                    run: queued.id,
                    token,
                    reply: toAgentReply({ outcome: 'declined', summary: 'Not about the model.', requests: [], questions: [], assumptions: [] }),
                }),
            );
            break;
        case 'failed':
            value(await f.use.failRun({ run: queued.id, token, reason: 'AgentError' }));
            break;
    }
    return queued.id;
}

/** The actor of a participant of these tests: `facilitator` holds the facilitator's role. */
const actor = (participant: C.ParticipantId): Actor => ({
    kind: 'participant',
    participant,
    role: participant === 'facilitator' ? 'Facilitator' : 'Participant',
});

describe('replying to a run', () => {
    test('a message replies to an ended run of its session: completed, failed, declined or cancelled', async () => {
        const f = await fixture();
        for (const how of ['completed', 'failed', 'declined', 'cancelled'] as const) {
            const run = await runTo(f, [(await f.send(`for ${how}`)).id], how);
            const reply = await f.send('Thanks', run);
            expect(reply.replyTo).toEqual({ kind: 'Run', run });
            const event = (await f.deps.uow.transaction((s) => s.outbox.readAfter(0, 1000, f.id))).at(-1)?.event;
            expect(event).toMatchObject({ type: 'RequestSent', requestId: reply.id, replyTo: { kind: 'Run', run } });
        }
        // a message that replies to nothing has no replyTo, in the request and its event
        const plain = await f.send('Hello');
        expect('replyTo' in plain && plain.replyTo !== undefined).toBe(false);
        expect((await f.deps.uow.transaction((s) => s.outbox.readAfter(0, 1000, f.id))).at(-1)?.event).not.toHaveProperty('replyTo');
    });

    test('not to a run that is queued, running or waits for an answer, nor one that is not of the session', async () => {
        const f = await fixture();
        const reply = (to: C.AgentRunId) =>
            f.use.sendRequest({ session: f.id, actor: actor(ann), targets: [], body: text('And?'), replyTo: { kind: 'Run', run: to } });
        const asked = await runTo(f, [(await f.send('a')).id], 'clarification');
        expect(error(await reply(asked))).toEqual({ type: 'RunNotReplyable', run: asked });
        const queued = await runTo(f, [(await f.send('b')).id], 'queued');
        expect(error(await reply(queued))).toEqual({ type: 'RunNotReplyable', run: queued });
        const { lease } = value(await f.use.claimNextRun({ session: f.id, owner: 'agent', leaseMs: 30_000 }));
        value(await f.use.startRun({ run: queued, token: lease.token }));
        expect(error(await reply(queued))).toEqual({ type: 'RunNotReplyable', run: queued });
        const unknown = knownAgentRunId('00000000-0000-4000-8000-0000000000ff');
        expect(error(await reply(unknown))).toEqual({ type: 'RunNotFound', run: unknown });

        // a run of another session (a session started later in the same workspace)
        const other = value(await f.use.startSession({ facilitator, name })).session;
        const elsewhere = value(await f.use.sendRequest({ session: other.id, actor: actor(facilitator), targets: [], body: text('x') }));
        const theirs = value(await f.use.queueRun({ session: other.id, requests: [elsewhere.id], actor: actor(facilitator) }));
        value(await f.use.cancelRun({ run: theirs.id, actor: actor(facilitator) }));
        expect(error(await reply(theirs.id))).toEqual({ type: 'RunOfAnotherSession', run: theirs.id });
        // nothing was sent
        expect(value(await f.use.sessionState({ session: f.id })).requests.filter((r) => r.replyTo !== undefined)).toEqual([]);
    });

    test("a run of replies freezes the runs they reply to; it is given each, in the input's order, with what it changed", async () => {
        const f = await fixture();
        const asked = await f.send('Add a cancel command.');
        const x = await runTo(f, [asked.id], 'changed');
        const y = await runTo(f, [(await f.send('Rename nothing.')).id], 'completed');
        const r1 = await f.send('Only drafts, please.', x);
        const r2 = await f.send('Also confirmed ones?', x);
        const r3 = await f.send('Thanks', y);
        const replies = await runTo(f, [r1.id, r2.id, r3.id], 'running');
        const run = value(await f.use.sessionState({ session: f.id })).runs.find((r) => r.id === replies);
        const toRun = (run: C.AgentRunId): C.FrozenReplyTarget => ({ kind: 'Run', run });
        expect(run?.input.requests.map((r) => r.replyTo)).toEqual([toRun(x), toRun(x), toRun(y)]);

        const previous = value(await f.use.previousRuns({ run: replies, maxDiff: 20 * 1024 }));
        expect(previous.map((p) => p.run.id)).toEqual([x, y]);
        const [px, py] = previous;
        expect(px.run.input.requests.map((r): string => r.body)).toEqual(['Add a cancel command.']);
        expect(px.changes.kind).toBe('diff');
        if (px.changes.kind !== 'diff') throw new Error('expected a diff');
        expect(px.changes.files).toEqual([{ path: 'sales/sales.dt', status: 'changed' }]);
        expect(px.changes.diff).toContain('--- a/sales/sales.dt\n+++ b/sales/sales.dt\n@@');
        expect(px.changes.diff).toContain('+    command cancel()');
        expect(py.changes).toEqual({ kind: 'diff', files: [], diff: '' });

        // past the budget: the files only, with the lines counted
        const small = value(await f.use.previousRuns({ run: replies, maxDiff: 10 }));
        expect(small[0].changes).toEqual({ kind: 'files', files: [{ path: 'sales/sales.dt', status: 'changed' }], added: 3, removed: 0, diffOmitted: true });
        // the run itself must exist
        const unknown = knownAgentRunId('00000000-0000-4000-8000-0000000000fe');
        expect(error(await f.use.previousRuns({ run: unknown, maxDiff: 1 }))).toEqual({ type: 'NotFound', aggregate: 'AgentRun', id: unknown });
    });

    test('the run an answer answers is a previous run too; a run that recorded no result is "unrecorded"', async () => {
        const f = await fixture();
        const m = await f.send('Add a state.');
        const asked = await runTo(f, [m.id], 'clarification');
        const answered = await runTo(f, [m.id], 'running', { answerTo: asked, answer: { answers: [{ question: 'q1', options: ['draft'] }] } });
        const previous = value(await f.use.previousRuns({ run: answered, maxDiff: 20 * 1024 }));
        expect(previous.map((p) => [p.run.id, p.run.state, p.changes.kind])).toEqual([[asked, 'NeedsClarification', 'diff']]);

        const f2 = await fixture();
        const cancelled = await runTo(f2, [(await f2.send('x')).id], 'cancelled');
        const reply = await runTo(f2, [(await f2.send('Why cancelled?', cancelled)).id], 'queued');
        expect(value(await f2.use.previousRuns({ run: reply, maxDiff: 100 })).map((p) => p.changes)).toEqual([{ kind: 'unrecorded' }]);
    });
});

describe('replying to a message', () => {
    test('a message replies to any message of its session, its own too; not to one unknown or of another session', async () => {
        const f = await fixture();
        const bob = value(C.makeParticipantId('bob'));
        value(await f.use.joinSession({ session: f.id, participant: bob, name }));
        const original = value(await f.use.sendRequest({ session: f.id, actor: actor(bob), targets: [], body: text('Orders need a state.') }));
        const to: C.ReplyTarget = { kind: 'Message', request: original.id };
        const reply = await f.send('Same here.', to);
        expect(reply.replyTo).toEqual(to);
        const event = (await f.deps.uow.transaction((s) => s.outbox.readAfter(0, 1000, f.id))).at(-1)?.event;
        expect(event).toMatchObject({ type: 'RequestSent', requestId: reply.id, replyTo: to });
        // one's own, and a reply to a reply
        expect((await f.send('And I mean it.', { kind: 'Message', request: reply.id })).replyTo).toEqual({ kind: 'Message', request: reply.id });

        const send = (request: C.RequestId) =>
            f.use.sendRequest({ session: f.id, actor: actor(ann), targets: [], body: text('?'), replyTo: { kind: 'Message', request } });
        const unknown = knownRequestId('00000000-0000-4000-8000-0000000000ff');
        expect(error(await send(unknown))).toEqual({ type: 'RequestNotFound', request: unknown });
        const other = value(await f.use.startSession({ facilitator, name })).session;
        const elsewhere = value(await f.use.sendRequest({ session: other.id, actor: actor(facilitator), targets: [], body: text('x') }));
        expect(error(await send(elsewhere.id))).toEqual({ type: 'RequestOfAnotherSession', request: elsewhere.id });
    });

    test("a run freezes the original's author and body; it continues no run", async () => {
        const f = await fixture();
        const original = await f.send('Add a cancel command.');
        const reply = await f.send('Only for drafts.', { kind: 'Message', request: original.id });
        const run = await runTo(f, [reply.id], 'running');
        const queued = value(await f.use.sessionState({ session: f.id })).runs.find((r) => r.id === run);
        expect(queued?.input.requests[0].replyTo).toEqual({ kind: 'Message', request: original.id, author: ann, body: text('Add a cancel command.') });
        expect(value(await f.use.previousRuns({ run, maxDiff: 1024 }))).toEqual([]);
    });
});

// ---- the prompt ----

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

describe('the requests route and the agent API with replies', () => {
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
        const root = await workspace({ 'shop.dt': DT });
        server = await startSessionServer({
            root,
            debounceMs: 30,
            session: {
                port: 0,
                host: '127.0.0.1',
                identity: 'dev',
                agent: {
                    port: 0,
                    allowedTools: [...DEFAULT_AGENT_TOOLS],
                    run: { warm: true, restartAfter: 20, idleTimeout: 30 },
                    maxPreviousRunDiff: 20 * 1024,
                },
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

    /** Claims and starts the next run: the start's answer. */
    const start = async (run: string): Promise<{ token: string; started: { previousRuns: AgentPreviousRun[] } }> => {
        const { lease } = (await (await agent('runs/claim', { owner: 'test' })).json()) as { lease: { token: string } };
        const res = await agent(`runs/${run}/start`, { token: lease.token });
        expect(res.status).toBe(200);
        return { token: lease.token, started: (await res.json()) as { previousRuns: AgentPreviousRun[] } };
    };

    test('anyone replies to an ended run; the run must be of the session and replyable; the run of replies is given the replied run', async () => {
        const request = ((await (await api(bob, 'requests', { targets: [], body: 'Add cancel.' })).json()) as { request: { id: string } }).request.id;
        const run = ((await (await api(ada, 'runs', { requests: [request] })).json()) as { run: { id: string } }).run.id;
        const { token, started } = await start(run);
        expect(started.previousRuns).toEqual([]);

        const bad = async (body: unknown): Promise<[number, string]> => {
            const res = await api(bob, 'requests', body);
            const e = ((await res.json()) as { error: { type: string; field?: string } }).error;
            return [res.status, e.field ?? e.type];
        };
        const toRun = { kind: 'Run', run };
        // running: not yet
        expect(await bad({ targets: [], body: 'And?', replyTo: toRun })).toEqual([409, 'RunNotReplyable']);
        expect((await agent(`runs/${run}/finish`, { token, exitCode: 0, formatted: true, checked: true })).status).toBe(200);

        expect(await bad({ targets: [], body: 'And?', replyTo: 'nope' })).toEqual([400, 'replyTo']);
        // a run's ID alone, as the body was before replies to messages, is no longer taken
        expect(await bad({ targets: [], body: 'And?', replyTo: run })).toEqual([400, 'replyTo']);
        expect(await bad({ targets: [], body: 'And?', replyTo: { kind: 'Turn', run } })).toEqual([400, 'replyTo']);
        expect(await bad({ targets: [], body: 'And?', replyTo: { kind: 'Run', run: 'nope' } })).toEqual([400, 'replyTo.run']);
        expect(await bad({ targets: [], body: 'And?', replyTo: { kind: 'Run', run, request } })).toEqual([400, 'replyTo.request']);
        expect(await bad({ targets: [], body: 'And?', replyTo: { kind: 'Run', run: crypto.randomUUID() } })).toEqual([404, 'RunNotFound']);
        const sent = await api(bob, 'requests', { targets: [], body: 'Only drafts.', replyTo: toRun });
        expect(sent.status).toBe(201);
        const reply = ((await sent.json()) as { request: { id: string; replyTo: unknown } }).request;
        expect(reply.replyTo).toEqual(toRun);
        // the facilitator's own reply, queued at once, is a run like any other
        const ownSent = (await (await api(ada, 'requests', { targets: [], body: 'And confirmed ones.', replyTo: toRun })).json()) as {
            request: { id: string; replyTo: unknown };
        };
        const own = {
            request: ownSent.request,
            run: (
                (await (await api(ada, 'runs', { requests: [ownSent.request.id] })).json()) as {
                    run: { id: string; input: { requests: { replyTo?: unknown }[] } };
                }
            ).run,
        };
        expect(own.request.replyTo).toEqual(toRun);
        expect(own.run.input.requests.map((r) => r.replyTo)).toEqual([toRun]);
        const next = await start(own.run.id);
        expect(next.started.previousRuns.map((p) => [p.run.id, p.run.state, p.changes.kind])).toEqual([[run, 'Completed', 'diff']]);
        expect((await agent(`runs/${own.run.id}/finish`, { token: next.token, exitCode: 0, formatted: true, checked: true })).status).toBe(200);

        // the reply Bob sent, applied later with another: one run, given the replied run once
        const both = ((await (await api(ada, 'runs', { requests: [reply.id, own.request.id] })).json()) as { run: { id: string } }).run.id;
        const last = await start(both);
        expect(last.started.previousRuns.map((p) => p.run.id)).toEqual([run]);
        const state = (await (await api(bob, 'state')).json()) as { requests: { id: string; replyTo?: unknown }[] };
        expect(state.requests.find((r) => r.id === reply.id)?.replyTo).toEqual(toRun);
        // runs are serial: end it for the next test
        expect((await agent(`runs/${both}/finish`, { token: last.token, exitCode: 0, formatted: true, checked: true })).status).toBe(200);
    });

    test("anyone replies to a message of the session; the run of the reply carries the original's author and body", async () => {
        const original = ((await (await api(bob, 'requests', { targets: [], body: 'Orders need a state.' })).json()) as { request: { id: string } }).request.id;
        const bad = async (body: unknown): Promise<[number, string]> => {
            const res = await api(ada, 'requests', body);
            const e = ((await res.json()) as { error: { type: string; field?: string } }).error;
            return [res.status, e.field ?? e.type];
        };
        expect(await bad({ targets: [], body: 'x', replyTo: { kind: 'Message', request: 'nope' } })).toEqual([400, 'replyTo.request']);
        expect(await bad({ targets: [], body: 'x', replyTo: { kind: 'Message', request: original, run: original } })).toEqual([400, 'replyTo.run']);
        expect(await bad({ targets: [], body: 'x', replyTo: { kind: 'Message', request: crypto.randomUUID() } })).toEqual([404, 'RequestNotFound']);
        const toMessage = { kind: 'Message', request: original };
        const sentMessage = (await (await api(ada, 'requests', { targets: [], body: 'Draft and confirmed.', replyTo: toMessage })).json()) as {
            request: { id: string; replyTo: unknown };
        };
        const sent = {
            request: sentMessage.request,
            run: (
                (await (await api(ada, 'runs', { requests: [sentMessage.request.id] })).json()) as {
                    run: { id: string; input: { requests: { replyTo?: unknown }[] } };
                }
            ).run,
        };
        expect(sent.request.replyTo).toEqual(toMessage);
        const bobId = ((await (await api(bob, 'me')).json()) as { participant: { id: string } }).participant.id;
        expect(sent.run.input.requests.map((r) => r.replyTo)).toEqual([{ ...toMessage, author: bobId, body: 'Orders need a state.' }]);
        // the agent gets the input as stored, and no previous run
        const { token, started } = await start(sent.run.id);
        expect(started.previousRuns).toEqual([]);
        expect((await agent(`runs/${sent.run.id}/finish`, { token, exitCode: 0, formatted: true, checked: true })).status).toBe(200);
        const state = (await (await api(bob, 'state')).json()) as { requests: { id: string; replyTo?: unknown }[] };
        expect(state.requests.find((r) => r.id === sent.request.id)?.replyTo).toEqual(toMessage);
    });

    test('only the facilitator picks an alternative; the pick is checked, frozen, and gives the agent the run picked from', async () => {
        const request = ((await (await api(bob, 'requests', { targets: [], body: 'Add a total.' })).json()) as { request: { id: string } }).request.id;
        const run = ((await (await api(ada, 'runs', { requests: [request] })).json()) as { run: { id: string } }).run.id;
        const { token } = await start(run);
        const reply = {
            outcome: 'done',
            summary: 'Added a total.',
            requests: [{ request, status: 'done' }],
            assumptions: [{ text: 'The total includes tax', requests: [request], alternatives: [{ id: 'net', label: 'Without tax' }] }],
        };
        expect((await agent(`runs/${run}/finish`, { token, exitCode: 0, formatted: true, checked: true, reply })).status).toBe(200);

        const pick = (assumption: unknown, alternative: unknown, requests: string[] = [request]) => ({
            requests,
            note: 'Redo it without tax.',
            pick: { pickOf: run, assumption, alternative },
        });
        const refused = async (who: string, body: unknown): Promise<[number, string]> => {
            const res = await api(who, 'runs', body);
            const e = ((await res.json()) as { error: { type: string; field?: string } }).error;
            return [res.status, e.field ?? e.type];
        };
        expect(await refused(bob, pick(0, 'net'))).toEqual([403, 'FacilitatorOnly']);
        expect(await refused(ada, pick(-1, 'net'))).toEqual([400, 'pick.assumption']);
        expect(await refused(ada, pick(0, 'not a key'))).toEqual([400, 'pick.alternative']);
        expect(await refused(ada, { ...pick(0, 'net'), pick: { pickOf: run, assumption: 0, alternative: 'net', extra: 1 } })).toEqual([400, 'pick.extra']);
        expect(await refused(ada, { ...pick(0, 'net'), pick: { pickOf: crypto.randomUUID(), assumption: 0, alternative: 'net' } })).toEqual([
            404,
            'RunNotFound',
        ]);
        expect(await refused(ada, pick(0, 'gross'))).toEqual([400, 'AlternativeNotFound']);
        const other = ((await (await api(bob, 'requests', { targets: [], body: 'And a subtotal.' })).json()) as { request: { id: string } }).request.id;
        expect(await refused(ada, pick(0, 'net', [request, other]))).toEqual([400, 'PickMismatch']);

        const queued = await api(ada, 'runs', pick(0, 'net'));
        expect(queued.status).toBe(201);
        const picked = ((await queued.json()) as { run: { id: string; input: { note: string; pick: unknown } } }).run;
        expect(picked.input).toMatchObject({
            note: 'Redo it without tax.',
            pick: { pickOf: run, assumption: 0, text: 'The total includes tax', alternative: { id: 'net', label: 'Without tax' } },
        });
        // a run that is not completed has nothing to pick
        expect(await refused(ada, { ...pick(0, 'net'), pick: { pickOf: picked.id, assumption: 0, alternative: 'net' } })).toEqual([409, 'RunNotPickable']);
        const next = await start(picked.id);
        expect(next.started.previousRuns.map((p) => [p.run.id, p.run.state])).toEqual([[run, 'Completed']]);
        expect((await agent(`runs/${picked.id}/finish`, { token: next.token, exitCode: 0, formatted: true, checked: true })).status).toBe(200);
    });

    test('only the facilitator approves an assumption; it is checked, recorded once, sent to no agent, and excludes a pick of it', async () => {
        const request = ((await (await api(bob, 'requests', { targets: [], body: 'Add a discount.' })).json()) as { request: { id: string } }).request.id;
        const run = ((await (await api(ada, 'runs', { requests: [request] })).json()) as { run: { id: string } }).run.id;
        const refused = async (who: string, body: unknown, p = 'approvals'): Promise<[number, string]> => {
            const res = await api(who, p, body);
            const e = ((await res.json()) as { error: { type: string; field?: string } }).error;
            return [res.status, e.field ?? e.type];
        };
        // queued: not completed
        expect(await refused(ada, { run, assumption: 0 })).toEqual([409, 'RunNotApprovable']);
        const { token } = await start(run);
        const reply = {
            outcome: 'done',
            summary: 'Added a discount.',
            requests: [{ request, status: 'done' }],
            assumptions: [{ text: 'The discount is a rate', requests: [request], alternatives: [{ id: 'amount', label: 'A fixed amount' }] }],
        };
        expect((await agent(`runs/${run}/finish`, { token, exitCode: 0, formatted: true, checked: true, reply })).status).toBe(200);

        expect(await refused(bob, { run, assumption: 0 })).toEqual([403, 'FacilitatorOnly']);
        expect(await refused(ada, { run: 'nope', assumption: 0 })).toEqual([400, 'run']);
        expect(await refused(ada, { run, assumption: -1 })).toEqual([400, 'assumption']);
        expect(await refused(ada, { run, assumption: 0, extra: 1 })).toEqual([400, 'extra']);
        expect(await refused(ada, { run: crypto.randomUUID(), assumption: 0 })).toEqual([404, 'RunNotFound']);
        expect(await refused(ada, { run, assumption: 1 })).toEqual([400, 'AssumptionNotFound']);

        const runsBefore = ((await (await api(ada, 'state')).json()) as { runs: unknown[] }).runs.length;
        const res = await api(ada, 'approvals', { run, assumption: 0 });
        expect(res.status).toBe(201);
        const { approval } = (await res.json()) as { approval: { id: string; state: string; assumption: unknown } };
        expect(approval).toMatchObject({ state: 'Approved', assumption: { run, assumption: 0 } });
        const state = (await (await api(bob, 'state')).json()) as { runs: unknown[]; approvals: { id: string }[] };
        expect(state.approvals.map((a) => a.id)).toEqual([approval.id]);
        expect(state.runs).toHaveLength(runsBefore);
        // decided: not approved again, not sent again with an alternative, its votes closed
        expect(await refused(ada, { run, assumption: 0 })).toEqual([409, 'AssumptionClosed']);
        expect(await refused(ada, { requests: [request], pick: { pickOf: run, assumption: 0, alternative: 'amount' } }, 'runs')).toEqual([
            409,
            'AssumptionClosed',
        ]);
        expect(await refused(bob, { target: { kind: 'AssumptionChoice', run, assumption: 0 }, sign: { kind: 'Vote' }, placed: true }, 'marks')).toEqual([
            409,
            'MarkTargetClosed',
        ]);
    });
});

// ---- the page's derivations ----
