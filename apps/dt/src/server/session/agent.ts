// The agent API of a session (ADR 0026, S4): a listener of its own, bound to 127.0.0.1 only, never routed through the
// public listener, and requiring its bearer token on every request but the pairing (ADR 0030, M5): the token is held in
// memory only, handed to the agent in process, or exchanged once for a one-time pairing code (`POST /agent/pair`, the
// code printed by `dt collab agent-link`) by a standalone `dt agent`. Browsers are refused (any `Origin`). The
// subscriber (S6) follows an SSE stream of the outbox (`id:` = outbox position, resumed with `Last-Event-ID`), reads the
// participants' display names (for the prompt), claims the next run with a lease, starts it (and gets the runs it
// continues, with what they changed, and the runs it reverts), heartbeats, and ends it (finish with its facts and the
// agent's reply, ask for clarification, decline, fail) or releases it. The server computes the rest (S3's use cases);
// the reply is validated and kept, never a fact. While a run runs, its holder also reports what it is doing (an
// activity, ADR 0026, amendment): held in memory and sent to the pages, never stored. Since ADR 0030 (decision 6) these
// are the runner role's; the answerer role has an entry point of its own beside them, behind the same token
// (`/agent/answers/events`, `POST /agent/answers/:job`: `answers.ts`), and the extractor role of ADR 0031 one more
// (`/agent/extractions/events`, `POST /agent/extractions/:job`: `extractions.ts`), answered 404 when the session keeps
// no knowledge. Each stream open is an agent of its role connected (the page's AI status counts the runs' and the
// answers').
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
    Collaboration,
    type CollaborationUseCases,
    isActivityPhase,
    knownAgentRunId,
    type OutboxEntry,
    readActivity,
    readToolOutcome,
    type RunActivity,
} from '@domaintrail/collaboration';
import {
    AGENT_EVENT_TYPES,
    AGENT_FAIL_REASONS,
    type AgentJourneysBody,
    type AgentParticipantsBody,
    type AgentSessionBody,
    type AgentSessionSoFar,
} from '@domaintrail/collaboration/protocol';
import { isLoopbackHost } from '../http/access.js';
import { BodyError, readJson, sendError, sendJson } from '../http/json.js';
import { type AnswerDispatcher, createAnswerDispatcher } from './answers.js';
import type { ExtractionDispatcher } from './extractions.js';
import { agentReply, body, text, uuid, MAX_NOTE } from './input.js';
import { eventMessage } from './relay.js';
import { statusOf } from './routes.js';

/** Largest body of an agent request (a reply at its limits, in any script, fits). */
const MAX_AGENT_BODY = 256 * 1024;
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
    /** The most characters of diff a started run is given of the runs it continues, together (`agent.run.maxPreviousRunDiff`). */
    readonly maxPreviousRunDiff: number;
    /** Most SSE streams open at once. */
    readonly maxStreams: number;
    /** Sends what the outbox got to the pages (and wakes the streams); called after every change. */
    readonly pump: () => Promise<void>;
    /** What a running run is doing now, reported by its lease's holder: kept as its latest and sent to the pages. */
    readonly activity: (run: Collaboration.AgentRunId, activity: RunActivity) => void;
    /** Lets the server take a revert at the head of the queue (a claim found one it has not tried yet). */
    readonly reverts?: () => void;
    /** The most milliseconds an answer job may take (`agent.answer.timeout`). */
    readonly answerTimeoutMs: number;
    /** The agents connected changed (a stream of either role opened or closed). */
    readonly onPresence?: () => void;
    readonly log?: (line: string) => void;
    /** Uses a one-time pairing code: whether it was valid (`POST /agent/pair` then answers the token). Absent: no pairing. */
    readonly pair?: (code: string) => Promise<boolean>;
    /** The journeys as the answerer and a starting run are given them (absent: none given). */
    readonly journeys?: () => Promise<AgentJourneysBody | undefined>;
    /**
     * A run just ended with its result: the people's edits it dropped are written again (ADR 0033), behind the
     * watcher's hold, before the agent is answered (so that it claims the next run after them). Absent: none.
     */
    readonly afterRun?: (run: Collaboration.AgentRunId) => Promise<void>;
    /** The extractor role's entry point (absent: the session keeps no knowledge, and the entry point answers 404). */
    readonly extractions?: ExtractionDispatcher;
    /**
     * The light model's small jobs that are not knowledge's — a hotspot's name (ADR 0033) — on a stream of their own
     * (`/agent/helpers/events`, `POST /agent/helpers/:job`), served whatever the knowledge config, so that a running
     * extraction never holds them up. Absent: answered 404.
     */
    readonly helpers?: ExtractionDispatcher;
}

export interface AgentApi {
    /** The listener, not yet listening: the caller binds it to 127.0.0.1. */
    readonly server: Server;
    /** New events are in the outbox: every stream reads on from its cursor. */
    wake(): void;
    /** Ends every stream (the server stops). */
    close(): void;
    /** The answerer role's entry point: its jobs handed out, its streams. */
    readonly answers: AnswerDispatcher;
    /** How many agents of each role are connected: answer streams, and run streams (`/agent/events`). */
    connected(): { readonly answer: number; readonly run: number };
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
    const answers = createAnswerDispatcher({
        session,
        collaboration: use,
        timeoutMs: deps.answerTimeoutMs,
        maxPreviousRunDiff: deps.maxPreviousRunDiff,
        maxStreams: deps.maxStreams,
        pump: deps.pump,
        ...(deps.onPresence && { onPresence: deps.onPresence }),
        token: deps.token,
        ...(deps.journeys && { journeys: deps.journeys }),
        log: deps.log ?? (() => {}),
    });

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
        deps.onPresence?.();
        res.on('close', () => {
            stream.closed = true;
            streams.delete(stream);
            deps.onPresence?.();
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

    /** A run that ended now (not a replay): what people edited meanwhile is compared with its result first. */
    const ended = async <T extends { readonly replayed: boolean }>(
        run: Collaboration.AgentRunId,
        result: { ok: true; value: T } | { ok: false; error: { readonly type: string } },
    ): Promise<typeof result> => {
        if (result.ok && !result.value.replayed && deps.afterRun) {
            await deps.pump();
            await deps
                .afterRun(run)
                .catch((e: unknown) => deps.log?.(`run ${run}: re-applying people's edits failed: ${e instanceof Error ? e.message : String(e)}`));
        }
        return result;
    };

    /** Whether a reply of the agent carries the agent's own credential (it would reach the pages). */
    const leaks = (v: unknown): boolean => v !== undefined && JSON.stringify(v).includes(deps.token);
    const refuseLeak = (res: ServerResponse, run: Collaboration.AgentRunId): void => {
        deps.log?.(`run ${run}: refused a reply that contains the agent credential`);
        sendError(res, 400, 'CredentialInOutput', 'The reply contains the agent credential.');
    };

    const runRoute = async (req: IncomingMessage, res: ServerResponse, rawId: string, action: string): Promise<void> => {
        const id = uuid(rawId, 'id');
        if (!id.ok) return sendError(res, 400, 'InvalidInput', id.error.message, { field: 'id' });
        const run = knownAgentRunId(id.value);
        switch (action) {
            case 'start': {
                const b = await input(req, res, ['token', 'since']);
                if (!b) return;
                if (b.since !== undefined && !(typeof b.since === 'number' && Number.isInteger(b.since) && b.since >= 0))
                    return sendError(res, 400, 'InvalidInput', 'Expected the last entry of the session so far seen.', { field: 'since' });
                const since = b.since;
                const started = await use.startRun({ run, token: String(b.token) });
                if (!started.ok) return answer(res, started, (v) => v);
                // the runs it continues (replies, an answer) and what they changed, measured now (ADR 0026, "replies to runs")
                const previous = await use.previousRuns({ run, maxDiff: deps.maxPreviousRunDiff });
                const previousRuns = previous.ok ? previous.value : [];
                // the runs it reverts and what they changed, file by file (ADR 0026, amendment "revert a run")
                const reverted = await use.revertedRuns({ run });
                const revert = reverted.ok ? reverted.value : [];
                // the session so far (ADR 0030, round 3): whole, and since what the runner's warm process saw
                const soFar = async (from?: number): Promise<AgentSessionSoFar | undefined> => {
                    const s = await use.sessionSoFar({ session, ...(from !== undefined && { since: from }) });
                    return s.ok ? { text: s.value.text, last: s.value.last, ...(from !== undefined && { since: from }) } : undefined;
                };
                const sessionSoFar = await soFar();
                const sessionSoFarSince = typeof since === 'number' ? await soFar(since) : undefined;
                // the journeys as they are now, as the answerer gets them: the run keeps within the current one
                const journeys = await deps.journeys?.().catch(() => undefined);
                // the people's edits since the previous run started (ADR 0033): the agent keeps their wording
                const peopleEdits = await use.peopleEditsSince({ run });
                return answer(res, started, (v) => ({
                    run: v.run,
                    baseRevision: v.base,
                    previousRuns,
                    ...(revert.length > 0 && { revert }),
                    ...(sessionSoFar && { sessionSoFar }),
                    ...(sessionSoFarSince && { sessionSoFarSince }),
                    ...(journeys && { journeys }),
                    ...(peopleEdits.length > 0 && { peopleEdits: peopleEdits.map((e) => ({ by: e.by, at: e.at.toISOString(), edit: e.edit })) }),
                }));
            }
            case 'heartbeat': {
                const b = await input(req, res, ['token']);
                if (!b) return;
                const r = await use.heartbeat({ run, token: String(b.token), leaseMs: deps.leaseMs });
                if (!r.ok) return sendError(res, statusOf(r.error.type), r.error.type, undefined, { run: r.error.run });
                return sendJson(res, 200, { lease: { token: r.value.token, expiresAt: r.value.expiresAt.toISOString() } });
            }
            case 'activity': {
                const b = await input(req, res, ['token', 'phase', 'subject']);
                if (!b) return;
                const activity = readActivity(b.phase, b.subject);
                if (!activity) {
                    const phase = isActivityPhase(b.phase);
                    return sendError(
                        res,
                        400,
                        'InvalidInput',
                        phase ? 'Expected a short subject on one line.' : 'Expected reading, editing, checking or finishing.',
                        {
                            field: phase ? 'subject' : 'phase',
                        },
                    );
                }
                // only from the lease's holder, while the run runs; the lease is not extended (the heartbeat does that)
                const held = await use.heldRunningRun({ run, token: String(b.token) });
                if (!held.ok) return sendError(res, statusOf(held.error.type), held.error.type, undefined, held.error);
                deps.activity(run, activity);
                return sendJson(res, 200, {});
            }
            case 'finish': {
                const b = await input(req, res, ['token', 'exitCode', 'formatted', 'checked', 'reply']);
                if (!b) return;
                if (leaks(b.reply)) return refuseLeak(res, run);
                const { exitCode, formatted, checked } = b;
                if (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < -1024 || exitCode > 1024)
                    return sendError(res, 400, 'InvalidInput', 'Expected the exit code.', { field: 'exitCode' });
                // ran, failed or skipped (ADR 0030); a boolean from a subscriber before skipping existed (true: ran)
                const fmt = readToolOutcome(formatted);
                const check = readToolOutcome(checked);
                if (!fmt) return sendError(res, 400, 'InvalidInput', "Expected 'ran', 'failed' or 'skipped'.", { field: 'formatted' });
                if (!check) return sendError(res, 400, 'InvalidInput', "Expected 'ran', 'failed' or 'skipped'.", { field: 'checked' });
                const reply = b.reply === undefined ? undefined : agentReply(b.reply, 'done');
                if (reply && !reply.ok) return sendError(res, 400, 'InvalidInput', reply.error.message, { field: reply.error.field });
                return answer(
                    res,
                    await ended(
                        run,
                        await use.finishRun({
                            run,
                            token: String(b.token),
                            facts: { exitCode, formatted: fmt, checked: check },
                            ...(reply && { reply: reply.value }),
                        }),
                    ),
                    (v) => v,
                );
            }
            case 'clarification': {
                const b = await input(req, res, ['token', 'question', 'reply']);
                if (!b) return;
                if (leaks(b.question) || leaks(b.reply)) return refuseLeak(res, run);
                const question = text(b.question, 'question', MAX_NOTE);
                if (!question.ok) return sendError(res, 400, 'InvalidInput', question.error.message, { field: 'question' });
                const reply = b.reply === undefined ? undefined : agentReply(b.reply, 'clarification');
                if (reply && !reply.ok) return sendError(res, 400, 'InvalidInput', reply.error.message, { field: reply.error.field });
                return answer(
                    res,
                    await ended(
                        run,
                        await use.askClarification({ run, token: String(b.token), question: question.value, ...(reply && { reply: reply.value }) }),
                    ),
                    (v) => v,
                );
            }
            case 'decline': {
                const b = await input(req, res, ['token', 'reply']);
                if (!b) return;
                if (leaks(b.reply)) return refuseLeak(res, run);
                const reply = agentReply(b.reply, 'declined');
                if (!reply.ok) return sendError(res, 400, 'InvalidInput', reply.error.message, { field: reply.error.field });
                return answer(res, await ended(run, await use.declineRun({ run, token: String(b.token), reply: reply.value })), (v) => v);
            }
            case 'fail': {
                const b = await input(req, res, ['token', 'reason']);
                if (!b) return;
                const reason = AGENT_FAIL_REASONS.find((r) => r === b.reason);
                if (!reason)
                    return sendError(res, 400, 'InvalidInput', `Expected one of ${AGENT_FAIL_REASONS.map((r) => `'${r}'`).join(', ')}.`, { field: 'reason' });
                return answer(res, await use.failRun({ run, token: String(b.token), reason }), (v) => v);
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
        // the pairing: a one-time code (single use, short-lived, an agent code: never a facilitator link) for the token
        if (new URL(req.url ?? '/', 'http://localhost').pathname === '/agent/pair' && req.method === 'POST' && deps.pair) {
            const b = await input(req, res, ['code']);
            if (!b) return;
            const code = typeof b.code === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(b.code) ? b.code : undefined;
            if (!code || !(await deps.pair(code)))
                return sendError(res, 401, 'PairingInvalid', 'The pairing code is unknown, used or expired: print another with `dt collab agent-link`.');
            return sendJson(res, 200, { session, token: deps.token });
        }
        const auth = req.headers.authorization ?? '';
        const given = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
        if (!given || !sameSecret(given, deps.token)) {
            res.setHeader('www-authenticate', 'Bearer realm="dt-session-agent"');
            return sendError(res, 401, 'Unauthenticated', 'The agent credential is required (pair with `dt agent --code`).');
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
        if (path === '/agent/answers/events' && req.method === 'GET') return answers.events(req, res);
        if (path === '/agent/extractions/events' && req.method === 'GET') {
            if (!deps.extractions) return sendError(res, 404, 'KnowledgeOff', 'The session keeps no knowledge.');
            return deps.extractions.events(req, res);
        }
        if (path === '/agent/helpers/events' && req.method === 'GET') {
            if (!deps.helpers) return sendError(res, 404, 'NotFound', 'No helper jobs here.');
            return deps.helpers.events(req, res);
        }
        const helper = /^\/agent\/helpers\/([^/]+)$/.exec(path);
        if (helper && helper[1] !== 'events') {
            if (!deps.helpers) return sendError(res, 404, 'NotFound', 'No helper jobs here.');
            if (req.method !== 'POST') return sendError(res, 405, 'MethodNotAllowed', 'Use POST.');
            const id = uuid(helper[1], 'job');
            if (!id.ok) return sendError(res, 400, 'InvalidInput', id.error.message, { field: 'job' });
            let raw: unknown;
            try {
                raw = await readJson(req, MAX_AGENT_BODY);
            } catch (e) {
                if (!(e instanceof BodyError)) throw e;
                return sendError(res, e.status, e.type, e.message);
            }
            return deps.helpers.result(res, id.value, raw);
        }
        const extraction = /^\/agent\/extractions\/([^/]+)$/.exec(path);
        if (extraction && extraction[1] !== 'events') {
            if (!deps.extractions) return sendError(res, 404, 'KnowledgeOff', 'The session keeps no knowledge.');
            if (req.method !== 'POST') return sendError(res, 405, 'MethodNotAllowed', 'Use POST.');
            const id = uuid(extraction[1], 'job');
            if (!id.ok) return sendError(res, 400, 'InvalidInput', id.error.message, { field: 'job' });
            let raw: unknown;
            try {
                raw = await readJson(req, MAX_AGENT_BODY);
            } catch (e) {
                if (!(e instanceof BodyError)) throw e;
                return sendError(res, e.status, e.type, e.message);
            }
            return deps.extractions.result(res, id.value, raw);
        }
        const job = /^\/agent\/answers\/([^/]+)$/.exec(path);
        if (job && job[1] !== 'events') {
            if (req.method !== 'POST') return sendError(res, 405, 'MethodNotAllowed', 'Use POST.');
            const id = uuid(job[1], 'job');
            if (!id.ok) return sendError(res, 400, 'InvalidInput', id.error.message, { field: 'job' });
            let raw: unknown;
            try {
                raw = await readJson(req, MAX_AGENT_BODY);
            } catch (e) {
                if (!(e instanceof BodyError)) throw e;
                return sendError(res, e.status, e.type, e.message);
            }
            return answers.result(res, id.value, raw);
        }
        if (path === '/agent/runs/claim' && req.method === 'POST') {
            const b = await input(req, res, ['owner', 'capabilities']);
            if (!b) return;
            if (!isToken(b.owner)) return sendError(res, 400, 'InvalidInput', 'Expected who claims (a short name without spaces).', { field: 'owner' });
            // what the subscriber can run (`AGENT_CAPABILITIES`): an older one names none, and is given no revert
            const capabilities = b.capabilities ?? [];
            if (!Array.isArray(capabilities) || capabilities.length > 20 || !capabilities.every(isToken))
                return sendError(res, 400, 'InvalidInput', 'Expected the names of what the subscriber can run.', { field: 'capabilities' });
            const claimed = await use.claimNextRun({ session, owner: b.owner, leaseMs: deps.leaseMs, capabilities });
            // a revert at the head is the server's to try first: nudge it (it is normally on it already)
            if (!claimed.ok && claimed.error.type === 'RunInProgress') deps.reverts?.();
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
            answers.close(false);
        },
        answers,
        connected: () => ({ answer: answers.connected(), run: [...streams].filter((s) => !s.closed).length }),
    };
}
