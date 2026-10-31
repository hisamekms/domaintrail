// The agent API of a session (ADR 0026, S4): a listener of its own, bound to 127.0.0.1 only, never routed through the
// public listener, and requiring the bearer token of `.domaintrail/session/agent.json` on every request. Browsers are
// refused (any `Origin`). The subscriber (S6) follows an SSE stream of the outbox (`id:` = outbox position, resumed
// with `Last-Event-ID`), reads the participants' display names (for the prompt), claims the next run with a lease,
// starts it, heartbeats, and ends it (finish with its facts only, ask for clarification, fail) or releases it. The
// server computes the rest (S3's use cases).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { OutboxEntry } from '@domaintrail/collaboration/application/ports';
import type { CollaborationUseCases } from '@domaintrail/collaboration/application/use-cases';
import { Collaboration } from '@domaintrail/collaboration/generated/index';
import { AGENT_EVENT_TYPES, type AgentParticipantsBody, type AgentSessionBody } from '@domaintrail/collaboration/protocol';
import { isLoopbackHost } from '../http/access.js';
import { BodyError, readJson, sendError, sendJson } from '../http/json.js';
import { body, text, uuid, MAX_NOTE } from './input.js';
import { eventMessage } from './relay.js';
import { statusOf } from './routes.js';

/** Largest body of an agent request. */
const MAX_AGENT_BODY = 16 * 1024;
/** How many events a stream reads from the outbox at a time (it waits for the socket to drain before the next). */
const STREAM_PAGE = 100;
/** A comment on every stream this often, so that proxies and the subscriber see it is alive. */
const KEEPALIVE_MS = 15_000;

export interface AgentApiDeps {
    readonly session: Collaboration.SessionId;
    readonly collaboration: CollaborationUseCases;
    /** The bearer token every request must carry. */
    readonly token: string;
    readonly allowedTools: readonly string[];
    /** How long a claim or a heartbeat holds the lease. */
    readonly leaseMs: number;
    /** Most SSE streams open at once. */
    readonly maxStreams: number;
    /** Sends what the outbox got to the pages (and wakes the streams); called after every change. */
    readonly pump: () => Promise<void>;
}

export interface AgentApi {
    /** The listener, not yet listening: the caller binds it to 127.0.0.1. */
    readonly server: Server;
    /** New events are in the outbox: every stream reads on from its cursor. */
    wake(): void;
    /** Ends every stream (the server stops). */
    close(): void;
}

/** The SSE event name of an outbox event for the agent, if the agent is told about it. */
const agentEventType = (entry: OutboxEntry): string | undefined => (AGENT_EVENT_TYPES as Partial<Record<string, string>>)[entry.event.type];

const sameSecret = (given: string, expected: string): boolean => {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
};

/** A lease token or an owner: a short single-line string. */
const isToken = (v: unknown): v is string => typeof v === 'string' && /^[\x21-\x7e]{1,200}$/.test(v);

interface Stream {
    cursor: number;
    readonly res: ServerResponse;
    running: boolean;
    again: boolean;
    closed: boolean;
}

export function createAgentApi(deps: AgentApiDeps): AgentApi {
    const { session, collaboration: use } = deps;
    const streams = new Set<Stream>();

    const endStream = (stream: Stream): void => {
        if (stream.closed) return;
        stream.closed = true;
        streams.delete(stream);
        stream.res.end();
    };

    /** Writes, then waits for the socket to drain when its buffer is full: the outbox is the queue, not memory. */
    const write = (stream: Stream, chunk: string): Promise<void> | undefined => {
        if (stream.closed) return undefined;
        if (stream.res.write(chunk)) return undefined;
        return new Promise((resolve) => {
            const done = (): void => {
                stream.res.off('drain', done);
                stream.res.off('close', done);
                resolve();
            };
            stream.res.on('drain', done);
            stream.res.on('close', done);
        });
    };

    /** Sends the stream everything after its cursor; one reader per stream, woken again if events came meanwhile. */
    const drain = async (stream: Stream): Promise<void> => {
        if (stream.running) {
            stream.again = true;
            return;
        }
        stream.running = true;
        try {
            do {
                stream.again = false;
                for (;;) {
                    const entries = await use.eventsAfter({ session, cursor: stream.cursor, limit: STREAM_PAGE });
                    for (const entry of entries) {
                        if (stream.closed) return;
                        stream.cursor = entry.seq;
                        const type = agentEventType(entry);
                        if (!type) continue;
                        await write(stream, `id: ${entry.seq}\nevent: ${type}\ndata: ${JSON.stringify(eventMessage(entry))}\n\n`);
                        if (entry.event.type === 'SessionClosed') return endStream(stream);
                    }
                    if (entries.length < STREAM_PAGE) break;
                }
            } while (stream.again && !stream.closed);
        } finally {
            stream.running = false;
        }
    };

    const keepalive = setInterval(() => {
        for (const stream of streams) void write(stream, ': keepalive\n\n');
    }, KEEPALIVE_MS);
    keepalive.unref();

    const events = (req: IncomingMessage, url: URL, res: ServerResponse): void => {
        const resumeFrom = req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
        if (typeof resumeFrom !== 'string' || !/^\d{1,15}$/.test(resumeFrom))
            return sendError(res, 400, 'InvalidInput', 'Last-Event-ID must be an outbox position.', { field: 'Last-Event-ID' });
        if (streams.size >= deps.maxStreams) return sendError(res, 429, 'TooManyStreams', `At most ${deps.maxStreams} streams at once.`);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
        res.write(': stream\n\n');
        const stream: Stream = { cursor: Number(resumeFrom), res, running: false, again: false, closed: false };
        streams.add(stream);
        res.on('close', () => {
            stream.closed = true;
            streams.delete(stream);
        });
        void drain(stream).catch((e: unknown) => {
            console.error(`Agent stream failed: ${e instanceof Error ? e.message : String(e)}`);
            endStream(stream);
        });
    };

    /** Reads the body as an object with only `keys`; a `token` among them must be a lease token. */
    const input = async (req: IncomingMessage, res: ServerResponse, keys: readonly string[]): Promise<Record<string, unknown> | undefined> => {
        let raw: unknown;
        try {
            raw = await readJson(req, MAX_AGENT_BODY);
        } catch (e) {
            if (!(e instanceof BodyError)) throw e;
            sendError(res, e.status, e.type, e.message);
            return undefined;
        }
        const b = body(raw, keys);
        if (!b.ok) {
            sendError(res, 400, 'InvalidInput', b.error.message, { field: b.error.field });
            return undefined;
        }
        if (keys.includes('token') && !isToken(b.value.token)) {
            sendError(res, 400, 'InvalidInput', 'Expected the lease token.', { field: 'token' });
            return undefined;
        }
        return b.value;
    };

    const answer = async <T>(
        res: ServerResponse,
        result: { ok: true; value: T } | { ok: false; error: { readonly type: string } },
        body: (v: T) => unknown,
    ): Promise<void> => {
        if (!result.ok) return sendError(res, statusOf(result.error.type), result.error.type, undefined, result.error);
        await deps.pump();
        sendJson(res, 200, body(result.value));
    };

    const runRoute = async (req: IncomingMessage, res: ServerResponse, rawId: string, action: string): Promise<void> => {
        const id = uuid(rawId, 'id');
        if (!id.ok) return sendError(res, 400, 'InvalidInput', id.error.message, { field: 'id' });
        const run = Collaboration.makeAgentRunId(id.value);
        switch (action) {
            case 'start': {
                const b = await input(req, res, ['token']);
                if (!b) return;
                return answer(res, await use.startRun({ run, token: String(b.token) }), (v) => ({ run: v.run, baseRevision: v.base }));
            }
            case 'heartbeat': {
                const b = await input(req, res, ['token']);
                if (!b) return;
                const r = await use.heartbeat({ run, token: String(b.token), leaseMs: deps.leaseMs });
                if (!r.ok) return sendError(res, statusOf(r.error.type), r.error.type, undefined, { run: r.error.run });
                return sendJson(res, 200, { lease: { token: r.value.token, expiresAt: r.value.expiresAt.toISOString() } });
            }
            case 'finish': {
                const b = await input(req, res, ['token', 'exitCode', 'formatted', 'checked']);
                if (!b) return;
                const { exitCode, formatted, checked } = b;
                if (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < -1024 || exitCode > 1024)
                    return sendError(res, 400, 'InvalidInput', 'Expected the exit code.', { field: 'exitCode' });
                if (typeof formatted !== 'boolean') return sendError(res, 400, 'InvalidInput', 'Expected true or false.', { field: 'formatted' });
                if (typeof checked !== 'boolean') return sendError(res, 400, 'InvalidInput', 'Expected true or false.', { field: 'checked' });
                return answer(res, await use.finishRun({ run, token: String(b.token), facts: { exitCode, formatted, checked } }), (v) => v);
            }
            case 'clarification': {
                const b = await input(req, res, ['token', 'question']);
                if (!b) return;
                const question = text(b.question, 'question', MAX_NOTE);
                if (!question.ok) return sendError(res, 400, 'InvalidInput', question.error.message, { field: 'question' });
                return answer(res, await use.askClarification({ run, token: String(b.token), question: question.value }), (v) => v);
            }
            case 'fail': {
                const b = await input(req, res, ['token', 'reason']);
                if (!b) return;
                if (b.reason !== 'AgentError' && b.reason !== 'Interrupted')
                    return sendError(res, 400, 'InvalidInput', "Expected 'AgentError' or 'Interrupted'.", { field: 'reason' });
                return answer(res, await use.failRun({ run, token: String(b.token), reason: b.reason }), (v) => v);
            }
            case 'release': {
                const b = await input(req, res, ['token']);
                if (!b) return;
                return answer(res, await use.releaseRun({ run, token: String(b.token) }), (r) => ({ run: r }));
            }
            default:
                return sendError(res, 404, 'NotFound', 'No such agent API.');
        }
    };

    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        // loopback only, never a browser: the Host names this machine and there is no Origin
        let hostname: string | undefined;
        try {
            hostname = req.headers.host ? new URL(`http://${req.headers.host}`).hostname : undefined;
        } catch {
            hostname = undefined;
        }
        if (!hostname || !isLoopbackHost(hostname) || req.headers.origin !== undefined)
            return sendError(res, 403, 'Forbidden', 'The agent API is for local processes only.');
        const auth = req.headers.authorization ?? '';
        const given = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
        if (!given || !sameSecret(given, deps.token)) {
            res.setHeader('www-authenticate', 'Bearer realm="dt-session-agent"');
            return sendError(res, 401, 'Unauthenticated', 'The agent credential (.domaintrail/session/agent.json) is required.');
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        if (path === '/agent/session' && req.method === 'GET') {
            const state = await use.sessionState({ session });
            if (!state.ok) return sendError(res, 404, 'NotFound', 'The session is gone.');
            const answer: AgentSessionBody = { session, state: state.value.session.state, allowedTools: deps.allowedTools, leaseMs: deps.leaseMs };
            return sendJson(res, 200, answer);
        }
        if (path === '/agent/participants' && req.method === 'GET') {
            const state = await use.sessionState({ session });
            if (!state.ok) return sendError(res, 404, 'NotFound', 'The session is gone.');
            const answer: AgentParticipantsBody = { participants: state.value.session.participants.map((p) => ({ id: p.id, name: p.name })) };
            return sendJson(res, 200, answer);
        }
        if (path === '/agent/events' && req.method === 'GET') return events(req, url, res);
        if (path === '/agent/runs/claim' && req.method === 'POST') {
            const b = await input(req, res, ['owner']);
            if (!b) return;
            if (!isToken(b.owner)) return sendError(res, 400, 'InvalidInput', 'Expected who claims (a short name without spaces).', { field: 'owner' });
            const claimed = await use.claimNextRun({ session, owner: b.owner, leaseMs: deps.leaseMs });
            return answer(res, claimed, (v) => ({ run: v.run, lease: { token: v.lease.token, expiresAt: v.lease.expiresAt.toISOString() } }));
        }
        const run = /^\/agent\/runs\/([^/]+)\/([a-z]+)$/.exec(path);
        if (run) {
            if (req.method !== 'POST') return sendError(res, 405, 'MethodNotAllowed', 'Use POST.');
            return runRoute(req, res, run[1], run[2]);
        }
        sendError(res, 404, 'NotFound', 'No such agent API.');
    };

    const server = createServer((req, res) => {
        handle(req, res).catch((e: unknown) => {
            console.error(`Agent request failed: ${e instanceof Error ? e.message : String(e)}`);
            if (!res.headersSent) sendError(res, 500, 'InternalError');
            else res.end();
        });
    });
    // upgrades (WebSocket) are not part of the agent API
    server.on('upgrade', (_req, socket) => void socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'));

    return {
        server,
        wake() {
            for (const stream of streams) {
                void drain(stream).catch((e: unknown) => {
                    console.error(`Agent stream failed: ${e instanceof Error ? e.message : String(e)}`);
                    endStream(stream);
                });
            }
        },
        close() {
            clearInterval(keepalive);
            for (const stream of streams) endStream(stream);
        },
    };
}
