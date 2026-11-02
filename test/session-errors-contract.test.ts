/**
 * Baseline of ADR 0027 (plan T0): the HTTP answers of the session routes when a request is refused — the status and the
 * whole error body — and the status of every error type. Moving the rules of the work from the routes into
 * Collaboration (T12) must keep each answer as it is; the other tasks change none. The ids in the bodies are replaced
 * with `<uuid>`. A deliberate change updates the snapshots with `bun test -u` and says why in its commit.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { type SessionServer, startSessionServer, statusOf } from '@domaintrail/dt';
import { DEFAULT_AGENT_TOOLS } from '@domaintrail/agent';

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

const MODEL = path.join(import.meta.dir, '..', 'contexts', 'collaboration', 'model');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const json = { 'content-type': 'application/json' };

/** The error types the routes answer with themselves (not declared in Collaboration's model). */
const ROUTE_ERRORS = [
    'InvalidInput',
    'UnknownRevision',
    'Unauthenticated',
    'Forbidden',
    'FacilitatorOnly',
    'FacilitatorDoesNotVote',
    'NotYourRequest',
    'NotAParticipant',
    'InvalidTarget',
    'InvalidAnswer',
    'NoRequests',
    'NotFound',
    'LinkInvalid',
    'BlobMissing',
    'ManualRecoveryNeeded',
    'NothingToUndo',
    'RunInProgress',
    'SubscriberOutdated',
];

describe('the status of each error type', () => {
    test('every error of the collaboration model and of the routes', async () => {
        const declared: string[] = [];
        for (const file of (await readdir(MODEL)).filter((f) => f.endsWith('.dt')).sort()) {
            for (const m of (await readFile(path.join(MODEL, file), 'utf8')).matchAll(/^\s*error\s+(\w+)/gm)) declared.push(m[1]);
        }
        expect(declared.length).toBeGreaterThan(0);
        const types = [...new Set([...declared, ...ROUTE_ERRORS])].sort();
        expect(Object.fromEntries(types.map((t) => [t, statusOf(t)]))).toMatchSnapshot();
    });
});

describe('refused requests of a session in dev mode', () => {
    let root: string;
    let server: SessionServer;
    let ada: string;
    let bob: string;

    const call = async (cookie: string | undefined, p: string, body?: unknown, method?: string): Promise<[number, unknown]> => {
        const res = await fetch(`${server.url}api/session/${p}`, {
            method: method ?? (body === undefined ? 'GET' : 'POST'),
            headers: { ...(cookie && { cookie }), ...(body !== undefined && json) },
            ...(body !== undefined && { body: JSON.stringify(body) }),
        });
        return [res.status, JSON.parse((await res.text()).replaceAll(UUID, '<uuid>'))];
    };

    beforeAll(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'domaintrail-baseline-session-'));
        await writeFile(path.join(root, 'shop.dt'), DT);
        server = await startSessionServer({
            root,
            debounceMs: 30,
            session: {
                port: 0,
                host: '127.0.0.1',
                identity: 'dev',
                agent: { port: 0, allowedTools: [...DEFAULT_AGENT_TOOLS], maxPreviousRunDiff: 20 * 1024 },
                maxParticipants: 50,
                quickReactions: ['👍'],
                classifier: { enabled: false, provider: 'cloudflare-clef', model: 'clef-flash', apiTokenEnv: 'CLOUDFLARE_API_TOKEN', threshold: 0.5 },
            },
        });
        await server.ready;
        const join = async (name: string): Promise<string> => {
            const res = await fetch(`${server.url}api/session/join`, { method: 'POST', headers: json, body: JSON.stringify({ name }) });
            expect(res.status).toBe(201);
            return (res.headers.get('set-cookie') ?? '').split(';')[0];
        };
        ada = await join('Ada');
        bob = await join('Bob');
        expect((await fetch(server.facilitatorLink, { headers: { cookie: ada }, redirect: 'manual' })).status).toBe(303);
    });
    afterAll(async () => {
        await server?.stop();
        await rm(root, { recursive: true, force: true });
    });

    test('status and body of each refusal', async () => {
        const state = (await (await fetch(`${server.url}api/session/state`, { headers: { cookie: bob } })).json()) as SessionStateBody;
        const revision = state.revisions[0].id;
        const post = (cookie: string, p: string, body: unknown): Promise<Response> =>
            fetch(`${server.url}api/session/${p}`, { method: 'POST', headers: { cookie, ...json }, body: JSON.stringify(body) });
        const sent = await post(bob, 'requests', { targets: [], body: 'Add a cancel command.' });
        expect(sent.status).toBe(201);
        const request = ((await sent.json()) as { request: { id: string } }).request.id;
        const queued = await post(ada, 'runs', { requests: [request] });
        expect(queued.status).toBe(201);
        const run = ((await queued.json()) as { run: { id: string } }).run.id;
        const unknown = crypto.randomUUID();

        const answers: Record<string, [number, unknown]> = {
            // no identity
            'GET state, signed out': await call(undefined, 'state'),
            'POST requests, signed out': await call(undefined, 'requests', { targets: [], body: 'x' }),
            // the facilitator's routes, by a participant
            'POST runs, participant': await call(bob, 'runs', { requests: [request] }),
            'POST runs/:id/cancel, participant': await call(bob, `runs/${run}/cancel`, {}),
            'POST revisions, participant': await call(bob, 'revisions', {}),
            'POST revisions/:id/restore, participant': await call(bob, `revisions/${revision}/restore`, {}),
            'POST facilitator/link, participant': await call(bob, 'facilitator/link', {}),
            'POST close, participant': await call(bob, 'close', {}),
            // rules the handlers hold
            'POST requests apply, participant': await call(bob, 'requests', { targets: [], body: 'Do it now.', apply: true }),
            'POST marks Vote, facilitator': await call(ada, 'marks', { target: { kind: 'Message', request }, sign: { kind: 'Vote' }, placed: true }),
            // what the use cases refuse
            'POST marks Vote on a message, participant': await call(bob, 'marks', {
                target: { kind: 'Message', request },
                sign: { kind: 'Vote' },
                placed: true,
            }),
            'POST marks on an unknown message': await call(bob, 'marks', {
                target: { kind: 'Message', request: unknown },
                sign: { kind: 'Reaction', emoji: '👍' },
                placed: true,
            }),
            'POST requests replyTo an unknown run': await call(bob, 'requests', { targets: [], body: 'x', replyTo: { kind: 'Run', run: unknown } }),
            'POST requests replyTo a queued run': await call(bob, 'requests', { targets: [], body: 'x', replyTo: { kind: 'Run', run } }),
            'POST requests replyTo an unknown message': await call(bob, 'requests', { targets: [], body: 'x', replyTo: { kind: 'Message', request: unknown } }),
            'POST requests mentioning a stranger': await call(bob, 'requests', { targets: [], body: 'x', mentions: [unknown] }),
            'POST runs of an unknown request': await call(ada, 'runs', { requests: [unknown] }),
            'POST runs/:id/cancel of a cancelled run': await (async (): Promise<[number, unknown]> => {
                expect((await post(ada, `runs/${run}/cancel`, {})).status).toBe(200);
                return call(ada, `runs/${run}/cancel`, {});
            })(),
            'POST runs/:id/cancel of an unknown run': await call(ada, `runs/${unknown}/cancel`, {}),
            'POST revisions/:id/restore of an unknown revision': await call(ada, `revisions/${unknown}/restore`, {}),
            // the routes themselves
            'GET an unknown API': await call(bob, 'nope'),
            'DELETE runs': await call(bob, 'runs', undefined, 'DELETE'),
            'POST requests with an unknown field': await call(bob, 'requests', { targets: [], body: 'x', extra: 1 }),
        };
        expect(answers).toMatchSnapshot();
    });
});
