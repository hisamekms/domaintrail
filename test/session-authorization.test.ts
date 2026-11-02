/**
 * Who may do what in a session, over HTTP (ADR 0026, S4; ADR 0027, Authorization): the status and the whole error body
 * of every operation reserved to the facilitator, asked by a participant, by the facilitator and by no one, pinned so
 * that moving the rules of the work into the domain changes neither.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { type SessionServer, startSessionServer } from '@domaintrail/dt';
import { DEFAULT_AGENT_TOOLS } from '@domaintrail/agent';
import type { ResolvedSessionConfig } from '@domaintrail/dt';

const DT = `context Shop {
  id OrderId: UUID

  aggregate Order {
    id: OrderId

    state Open
    state Placed

    create command start(id: OrderId) -> Open

    command place()
      Open -> Placed
      emits OrderPlaced
  }

  event OrderPlaced {
    orderId: OrderId
  }
}
`;

const sessionConfig: ResolvedSessionConfig = {
    port: 0,
    host: '127.0.0.1',
    identity: 'dev',
    agent: { port: 0, allowedTools: [...DEFAULT_AGENT_TOOLS], run: { warm: true, restartAfter: 20 }, maxPreviousRunDiff: 20 * 1024 },
    maxParticipants: 50,
    quickReactions: ['👍'],
    classifier: { enabled: false, provider: 'cloudflare-clef', model: 'clef-flash', apiTokenEnv: 'CLOUDFLARE_API_TOKEN', threshold: 0.5 },
};

const json = { 'content-type': 'application/json' };
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

const FACILITATOR_ONLY = { error: { type: 'FacilitatorOnly', message: 'Only the facilitator may do this.' } };

describe('the operations reserved to the facilitator', () => {
    let root: string;
    let server: SessionServer;
    let ada: string;
    let bob: string;

    const api = (cookie: string | undefined, p: string, body?: unknown): Promise<Response> =>
        fetch(`${server.url}api/session/${p}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { ...(cookie && { cookie }), ...(body !== undefined && json) },
            ...(body !== undefined && { body: JSON.stringify(body) }),
        });
    const answer = async (res: Response): Promise<[number, unknown]> => [res.status, await res.json()];
    const state = async (): Promise<SessionStateBody> => (await (await api(bob, 'state')).json()) as SessionStateBody;
    const join = async (name: string): Promise<string> => {
        const res = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name }) });
        expect(res.status).toBe(201);
        return (res.headers.get('set-cookie') ?? '').split(';')[0];
    };
    const send = async (cookie: string, body: string): Promise<string> => {
        const res = await api(cookie, 'requests', { targets: [], body });
        expect(res.status).toBe(201);
        return ((await res.json()) as { request: { id: string } }).request.id;
    };

    beforeAll(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'domaintrail-session-authorization-'));
        await writeFile(path.join(root, 'shop.dt'), DT);
        server = await startSessionServer({ root, debounceMs: 30, session: sessionConfig });
        await server.ready;
        ada = await join('Ada');
        bob = await join('Bob');
        expect((await fetch(server.facilitatorLink, { headers: { cookie: ada }, redirect: 'manual' })).status).toBe(303);
    });
    afterAll(async () => {
        await server?.stop();
        await rm(root, { recursive: true, force: true });
    });

    test('a participant gets 403 FacilitatorOnly, before the input or what it names is looked at', async () => {
        const revision = (await state()).revisions[0].id;
        const request = await send(bob, 'Add a cancel command.');
        for (const [p, body] of [
            ['runs', { requests: [request] }],
            ['runs', { requests: 'not a list' }],
            ['runs', { requests: [UNKNOWN] }],
            [`runs/${UNKNOWN}/cancel`, {}],
            ['runs/not-a-uuid/cancel', {}],
            ['revisions', {}],
            ['revisions', { extra: 1 }],
            [`revisions/${revision}/confirm`, {}],
            [`revisions/${UNKNOWN}/confirm`, {}],
            [`revisions/${revision}/restore`, {}],
            [`revisions/${revision}/restore`, { recordExternalChanges: 'yes' }],
            ['facilitator/link', {}],
            ['close', {}],
            ['close', { extra: 1 }],
        ] as const) {
            expect([p, body, ...(await answer(await api(bob, p, body)))]).toEqual([p, body, 403, FACILITATOR_ONLY]);
        }
        // applying a message is the facilitator's: refused before the message is sent, after `apply` is read
        const before = (await state()).requests.length;
        expect(await answer(await api(bob, 'requests', { targets: [], body: 'Do it now.', apply: true }))).toEqual([
            403,
            { error: { type: 'FacilitatorOnly', message: 'Only the facilitator applies messages.' } },
        ]);
        expect(await answer(await api(bob, 'requests', { targets: [], body: 'Do it now.', apply: { note: 'x' } }))).toEqual([
            403,
            { error: { type: 'FacilitatorOnly', message: 'Only the facilitator applies messages.' } },
        ]);
        expect((await api(bob, 'requests', { targets: [], body: 'Do it now.', apply: 1 })).status).toBe(400);
        expect((await state()).requests.length).toBe(before);
    });

    test('the facilitator does not vote: 403 FacilitatorDoesNotVote; reacting is anyone’s', async () => {
        const target = { kind: 'QuestionOption', run: UNKNOWN, question: 'q', option: 'o' };
        expect(await answer(await api(ada, 'marks', { target, sign: { kind: 'Vote' }, placed: true }))).toEqual([
            403,
            { error: { type: 'FacilitatorDoesNotVote', message: "The facilitator's answer is the decision: the facilitator does not vote." } },
        ]);
        expect(await answer(await api(bob, 'marks', { target, sign: { kind: 'Vote' }, placed: true }))).toEqual([
            404,
            { error: { type: 'MarkTargetNotFound' } },
        ]);
        const request = await send(bob, 'Rename Order.');
        expect((await api(ada, 'marks', { target: { kind: 'Message', request }, sign: { kind: 'Reaction', emoji: '👍' }, placed: true })).status).toBe(200);
    });

    test('dismissing a message has no route: 404', async () => {
        const request = await send(bob, 'Something.');
        for (const cookie of [bob, ada]) {
            expect(await answer(await api(cookie, `requests/${request}/dismiss`, {}))).toEqual([
                404,
                { error: { type: 'NotFound', message: 'No such session API.' } },
            ]);
        }
    });

    test('the facilitator: what is unknown is 404, what the state refuses is 409, the rest succeeds', async () => {
        expect(await answer(await api(ada, `runs/${UNKNOWN}/cancel`, {}))).toEqual([404, { error: { type: 'NotFound', aggregate: 'AgentRun', id: UNKNOWN } }]);
        expect(await answer(await api(ada, `revisions/${UNKNOWN}/confirm`, {}))).toEqual([
            404,
            { error: { type: 'NotFound', aggregate: 'Revision', id: UNKNOWN } },
        ]);
        expect(await answer(await api(ada, 'runs', { requests: [UNKNOWN] }))).toEqual([404, { error: { type: 'RequestNotFound', request: UNKNOWN } }]);

        const request = await send(bob, 'Add a total.');
        const queued = await api(ada, 'runs', { requests: [request] });
        expect(queued.status).toBe(201);
        const run = ((await queued.json()) as { run: { id: string; state: string } }).run;
        expect(run.state).toBe('Queued');
        const cancelled = await api(ada, `runs/${run.id}/cancel`, {});
        expect([cancelled.status, ((await cancelled.json()) as { run: { state: string } }).run.state]).toEqual([200, 'Cancelled']);
        expect(await answer(await api(ada, `runs/${run.id}/cancel`, {}))).toEqual([
            409,
            { error: { type: 'NotAllowed', command: 'cancel', state: 'Cancelled' } },
        ]);

        const taken = await api(ada, 'revisions', {});
        expect(taken.status).toBe(201);
        const revision = ((await taken.json()) as { revision: { id: string; origin: { kind: string } } }).revision;
        expect(revision.origin.kind).toBe('Manual');
        const confirmed = await api(ada, `revisions/${revision.id}/confirm`, {});
        expect([confirmed.status, ((await confirmed.json()) as { revision: { state: string } }).revision.state]).toEqual([200, 'Confirmed']);
        expect(await answer(await api(ada, `revisions/${revision.id}/confirm`, {}))).toEqual([
            409,
            { error: { type: 'NotAllowed', command: 'confirm', state: 'Confirmed' } },
        ]);
        expect((await api(ada, `revisions/${revision.id}/restore`, {})).status).toBe(200);
        expect((await api(ada, 'facilitator/link', {})).status).toBe(201);
    });

    test('no one signed in: 401 Unauthenticated; the facilitator closes the session', async () => {
        for (const p of ['runs', `runs/${UNKNOWN}/cancel`, 'revisions', 'close', 'facilitator/link']) {
            expect([p, ...(await answer(await api(undefined, p, {})))]).toEqual([
                p,
                401,
                { error: { type: 'Unauthenticated', message: 'Sign in to the session first.' } },
            ]);
        }
        const closed = await api(ada, 'close', {});
        expect([closed.status, ((await closed.json()) as { session: { state: string } }).session.state]).toEqual([200, 'Closed']);
    });
});
