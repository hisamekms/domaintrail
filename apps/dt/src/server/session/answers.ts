// The answers entry point of the agent API (ADR 0030, decision 6; the plan's "Two roles"): the answerer role's jobs —
// stage 3 of a triage (`triage`), the answer to a 相談 (`answer`), the proposal for a participant's 依頼 (`propose`) —
// handed out over an SSE stream of their own (`GET /agent/answers/events`), each to one connected answerer that has
// none in hand, and their results taken back (`POST /agent/answers/:job`). No claim, no lease, no workspace lock: the
// jobs never wait for the run queue nor hold it. What a job is waiting for is the collaboration's (`answerJobs`); what is
// handed out, to whom and until when, is held here in memory: a job not answered within its timeout is withdrawn (a
// triage's stage 3 is then recorded as failed, which makes it a 相談; an answer or a proposal is tried again, at most
// `MAX_ATTEMPTS` times), and the jobs of an answerer that disconnects are handed to another one, or wait.
//
// Each job carries what its prompt needs: the message, its author's name, and for stage 3 the chat around it and the
// open proposals; for an answer or a proposal the session so far — whole, and since the last entry the stream's previous
// such job was given (a warm answerer took that one) — the run the message replies to with its changes, and the latest
// revision (what the answer reads). The result is AI output: validated against its shape and limits before anything is
// written.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
    AI_NAME,
    type AnswerJob,
    chatWindow,
    Collaboration,
    type CollaborationUseCases,
    isAi,
    modelVerdict,
    readAnswererReply,
    readProposeReply,
    readTriageAnswer,
    type TriageStepInput,
} from '@domaintrail/collaboration';
import { AGENT_ANSWER_EVENT_TYPES, type AgentAnswerJobBody, type AgentSessionSoFar } from '@domaintrail/collaboration/protocol';
import { sendError } from '../http/json.js';
import { body as objectBody } from './input.js';

/** How many times an answer or a proposal is handed out before it is given up (until the server starts again). */
export const MAX_ATTEMPTS = 2;
/** How long past its timeout a job's answerer has to report that it failed, before the job is withdrawn. */
const GRACE_MS = 5_000;
/** A comment on every stream this often, so that the answerer sees it is alive. */
const KEEPALIVE_MS = 15_000;

export interface AnswerDispatcherDeps {
    readonly session: Collaboration.SessionId;
    readonly collaboration: CollaborationUseCases;
    /** The most milliseconds a job may take (`agent.answer.timeout`), told to the answerer. */
    readonly timeoutMs: number;
    /** The most characters of diff of the run a message replies to (`maxPreviousRunDiff`). */
    readonly maxPreviousRunDiff: number;
    /** Most answer streams at once. */
    readonly maxStreams: number;
    /** Sends what the outbox got to the pages; called after every result. */
    readonly pump: () => Promise<void>;
    /** The number of connected answerers changed. */
    readonly onConnections?: () => void;
    readonly log: (line: string) => void;
}

export interface AnswerDispatcher {
    /** `GET /agent/answers/events`: a connected answerer. */
    events(req: IncomingMessage, res: ServerResponse): void;
    /** `POST /agent/answers/:job`: a job's result (the body read as JSON); answers the request. */
    result(res: ServerResponse, job: string, raw: unknown): Promise<void>;
    /** Hands out what waits (after a change of the session, a stream opening, a result). */
    kick(): void;
    /** A revision was restored: the warm answerers forget what they read. */
    restored(): void;
    /** How many answerers are connected. */
    connected(): number;
    /** How many jobs wait (handed out or not), the given-up ones left out. */
    waiting(): Promise<number>;
    /** Ends every stream (the session closed: told first; the server stops). */
    close(sessionClosed: boolean): void;
    /** Resolves once the hand-outs under way have ended (tests). */
    settled(): Promise<void>;
}

interface AnswerStream {
    readonly id: number;
    readonly res: ServerResponse;
    /** The job in hand. */
    job?: string;
    /** The last entry of the session so far that the previous answer or proposal of this stream was given. */
    lastSoFar?: number;
    closed: boolean;
}

interface Handed {
    readonly id: string;
    readonly key: string;
    readonly kind: AnswerJob['kind'];
    readonly triage: Collaboration.TriageId;
    readonly stream: AnswerStream;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly readRevision?: Collaboration.RevisionId;
    readonly soFarLast?: number;
    /** A result is being written: not withdrawn meanwhile. */
    settling: boolean;
}

const keyOf = (job: { readonly kind: string; readonly triage: { readonly id: string } }): string => `${job.triage.id}:${job.kind}`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const durationOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, 86_400_000) : 0);
const shortText = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

export function createAnswerDispatcher(deps: AnswerDispatcherDeps): AnswerDispatcher {
    const { session, collaboration: use, log } = deps;
    const streams = new Set<AnswerStream>();
    const handed = new Map<string, Handed>();
    const handedKeys = new Set<string>();
    const attempts = new Map<string, number>();
    const givenUp = new Set<string>();
    let streamIds = 0;
    let running: Promise<void> | undefined;
    let again = false;

    const send = (stream: AnswerStream, event: string, data: unknown): void => {
        if (stream.closed) return;
        stream.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const endStream = (stream: AnswerStream): void => {
        if (stream.closed) return;
        stream.closed = true;
        streams.delete(stream);
        stream.res.end();
    };

    const keepalive = setInterval(() => {
        for (const stream of streams) if (!stream.closed) stream.res.write(': keepalive\n\n');
    }, KEEPALIVE_MS);
    keepalive.unref();

    /** A job's hand-out ends: its stream is free again (and its key may be handed again). */
    const release = (h: Handed): void => {
        clearTimeout(h.timer);
        handed.delete(h.id);
        handedKeys.delete(h.key);
        if (h.stream.job === h.id) h.stream.job = undefined;
    };

    /** An answer or a proposal that failed once more: given up after `MAX_ATTEMPTS`. */
    const failedOnce = (h: Handed, why: string): void => {
        const n = (attempts.get(h.key) ?? 0) + 1;
        attempts.set(h.key, n);
        if (n >= MAX_ATTEMPTS) {
            givenUp.add(h.key);
            log(`answer job ${h.kind} of triage ${h.triage} given up after ${n} attempts (${why})`);
        } else log(`answer job ${h.kind} of triage ${h.triage} failed (${why}); it will be handed out again`);
    };

    /** Stage 3 that failed or timed out: recorded as unknown with why, which makes the triage a 相談. */
    const recordFailedTriage = async (h: Handed, error: string, durationMs: number, model?: string): Promise<void> => {
        const recorded = await use.recordTriageStep({
            triage: h.triage,
            step: { stage: 'Model', verdict: 'Unknown', error, durationMs, ...(model && { model }) },
        });
        if (!recorded.ok) log(`triage ${h.triage}: stage 3's failure not recorded (${recorded.error.type})`);
        await deps.pump();
    };

    const timedOut = (id: string): void => {
        const h = handed.get(id);
        if (!h || h.settling) return;
        release(h);
        send(h.stream, AGENT_ANSWER_EVENT_TYPES.withdrawn, { job: h.id });
        log(`answer job ${h.kind} of triage ${h.triage} timed out`);
        const after = h.kind === 'triage' ? recordFailedTriage(h, 'timed out', deps.timeoutMs) : Promise.resolve(failedOnce(h, 'timed out'));
        void after.catch((e: unknown) => log(`answer job: ${e instanceof Error ? e.message : String(e)}`)).finally(() => dispatcher.kick());
    };

    /** The job's body for the answerer. */
    const bodyOf = async (
        job: AnswerJob,
        state: { readonly requests: readonly Collaboration.Request[]; readonly proposals: readonly Collaboration.ChangeProposal[] } & {
            readonly session: Collaboration.Session;
            readonly revisions: readonly Collaboration.Revision[];
        },
        stream: AnswerStream,
        id: string,
    ): Promise<{ body: AgentAnswerJobBody; soFarLast?: number; readRevision?: Collaboration.RevisionId }> => {
        const names = new Map<string, string>(state.session.participants.map((p) => [p.id, p.name]));
        const author = isAi(job.request.author) ? AI_NAME : (names.get(job.request.author) ?? 'a participant');
        const common = {
            job: id,
            kind: job.kind,
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the aggregates become their JSON when encoded
            triage: job.triage as unknown as AgentAnswerJobBody['triage'],
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above
            request: job.request as unknown as AgentAnswerJobBody['request'],
            author,
            timeoutMs: deps.timeoutMs,
        };
        if (job.kind === 'triage') {
            const open = state.proposals.filter((p) => p.state === 'Open');
            return {
                body: {
                    ...common,
                    chat: chatWindow(state, job.request.id),
                    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above
                    openProposals: open as unknown as NonNullable<AgentAnswerJobBody['openProposals']>,
                },
            };
        }
        const full = await use.sessionSoFar({ session });
        const since = stream.lastSoFar === undefined ? undefined : await use.sessionSoFar({ session, since: stream.lastSoFar });
        const replied = await use.repliedRuns({ request: job.request.id, maxDiff: deps.maxPreviousRunDiff });
        const readRevision = state.revisions.at(-1)?.id;
        const soFar = (s: { readonly text: string; readonly last: number }, from?: number): AgentSessionSoFar => ({
            text: s.text,
            last: s.last,
            ...(from !== undefined && { since: from }),
        });
        return {
            body: {
                ...common,
                ...(full.ok && { sessionSoFar: soFar(full.value) }),
                ...(since?.ok && stream.lastSoFar !== undefined && { sessionSoFarSince: soFar(since.value, stream.lastSoFar) }),
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the runs become their JSON when encoded
                ...(replied.ok && replied.value.length > 0 && { previousRuns: replied.value as unknown as NonNullable<AgentAnswerJobBody['previousRuns']> }),
                ...(readRevision && { readRevision }),
            },
            ...(full.ok && { soFarLast: full.value.last }),
            ...(readRevision && { readRevision }),
        };
    };

    const handOut = async (): Promise<void> => {
        do {
            again = false;
            const idle = [...streams].filter((s) => !s.closed && s.job === undefined);
            if (!idle.length) return;
            const jobs = await use.answerJobs({ session });
            if (!jobs.ok) return;
            const due = jobs.value.filter((j) => !handedKeys.has(keyOf(j)) && !givenUp.has(keyOf(j)));
            if (!due.length) continue;
            const state = await use.sessionState({ session });
            if (!state.ok || state.value.session.state !== 'Open') return;
            for (const job of due) {
                const stream = idle.shift();
                if (!stream) break;
                if (stream.closed) continue;
                const id = randomUUID();
                const { body, soFarLast, readRevision } = await bodyOf(job, state.value, stream, id);
                if (stream.closed) {
                    again = true;
                    continue;
                }
                const timer = setTimeout(() => timedOut(id), deps.timeoutMs + GRACE_MS);
                timer.unref();
                const h: Handed = {
                    id,
                    key: keyOf(job),
                    kind: job.kind,
                    triage: job.triage.id,
                    stream,
                    timer,
                    ...(readRevision && { readRevision }),
                    ...(soFarLast !== undefined && { soFarLast }),
                    settling: false,
                };
                handed.set(id, h);
                handedKeys.add(h.key);
                stream.job = id;
                send(stream, AGENT_ANSWER_EVENT_TYPES.job, body);
            }
        } while (again);
    };

    /** A job's result as a step, a message, an override or a proposal; the HTTP answer. */
    const take = async (res: ServerResponse, h: Handed, raw: unknown): Promise<void> => {
        if (!isObject(raw)) return sendError(res, 400, 'InvalidInput', 'Expected a JSON object.', { field: 'body' });
        const durationMs = durationOf(raw.durationMs);
        const model = shortText(raw.model, 200);
        const error = shortText(raw.error, 500);
        const fail = (status: number, type: string, message?: string, detail: object = {}): void => sendError(res, status, type, message, detail);
        const done = async (result: { ok: true } | { ok: false; error: { readonly type: string } }): Promise<void> => {
            if (!result.ok) {
                log(`answer job ${h.kind} of triage ${h.triage}: refused (${result.error.type})`);
                return fail(409, result.error.type, undefined, result.error);
            }
            await deps.pump();
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('{}');
        };
        switch (h.kind) {
            case 'triage': {
                if (error !== undefined) {
                    await recordFailedTriage(h, error, durationMs, model);
                    return done({ ok: true });
                }
                const keys = objectBody(raw, ['kind', 'confidence', 'reason', 'model', 'durationMs']);
                if (!keys.ok) return fail(400, 'InvalidInput', keys.error.message, { field: keys.error.field });
                const answer = readTriageAnswer({ kind: raw.kind, confidence: raw.confidence, reason: raw.reason });
                if (!answer.ok) {
                    await recordFailedTriage(h, `invalid output (${answer.error.path})`, durationMs, model);
                    return fail(400, 'InvalidReply', answer.error.message, { field: answer.error.path });
                }
                const step: TriageStepInput = {
                    stage: 'Model',
                    verdict: modelVerdict({ kind: answer.value.verdict, confidence: answer.value.confidence }),
                    confidence: answer.value.confidence,
                    reason: answer.value.reason,
                    ...(model && { model }),
                    durationMs,
                };
                const recorded = await use.recordTriageStep({ triage: h.triage, step });
                return done(recorded.ok ? { ok: true } : recorded);
            }
            case 'answer': {
                if (error !== undefined) {
                    failedOnce(h, error);
                    return done({ ok: true });
                }
                const { model: _m, durationMs: _d, readRevision: given, ...reply } = raw;
                const read = readAnswererReply(reply);
                if (!read.ok) {
                    failedOnce(h, `invalid output (${read.error.path})`);
                    return fail(400, 'InvalidReply', read.error.message, { field: read.error.path });
                }
                const r = read.value;
                if (r.kind === 'answer') {
                    const text = Collaboration.makeText(r.answer);
                    if (!text.ok) return fail(400, 'InvalidReply', 'Not a text.', { field: 'answer' });
                    const revision = typeof given === 'string' && given ? given : h.readRevision;
                    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked against the session's revisions by the use case
                    const readRevision = revision as Collaboration.RevisionId | undefined;
                    const answered = await use.answerMessage({ triage: h.triage, body: text.value, ...(readRevision && { readRevision }) });
                    if (answered.ok) h.stream.lastSoFar = h.soFarLast ?? h.stream.lastSoFar;
                    return done(answered.ok ? { ok: true } : answered);
                }
                // the override (decision 18): a request after all, with its proposal; or nothing for the AI to do
                const overridden = await use.overrideTriage({
                    triage: h.triage,
                    step: {
                        stage: 'Answerer',
                        verdict: r.kind === 'proposal' ? 'ChangeRequest' : 'NotForAi',
                        ...(r.reason !== undefined && { reason: r.reason }),
                        ...(model && { model }),
                        durationMs,
                    },
                    ...(r.kind === 'proposal' && { proposal: r.proposal }),
                });
                if (overridden.ok) h.stream.lastSoFar = h.soFarLast ?? h.stream.lastSoFar;
                return done(overridden.ok ? { ok: true } : overridden);
            }
            case 'propose': {
                if (error !== undefined) {
                    failedOnce(h, error);
                    return done({ ok: true });
                }
                const { model: _m, durationMs: _d, ...reply } = raw;
                const read = readProposeReply(reply);
                if (!read.ok) {
                    failedOnce(h, `invalid output (${read.error.path})`);
                    return fail(400, 'InvalidReply', read.error.message, { field: read.error.path });
                }
                const proposed = await use.proposeChange({ triage: h.triage, content: read.value });
                if (proposed.ok) h.stream.lastSoFar = h.soFarLast ?? h.stream.lastSoFar;
                return done(proposed.ok ? { ok: true } : proposed);
            }
        }
    };

    const dispatcher: AnswerDispatcher = {
        events(_req, res) {
            if (streams.size >= deps.maxStreams) return sendError(res, 429, 'TooManyStreams', `At most ${deps.maxStreams} streams at once.`);
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-store',
                connection: 'keep-alive',
                'x-content-type-options': 'nosniff',
            });
            res.write(': answers\n\n');
            const stream: AnswerStream = { id: ++streamIds, res, closed: false };
            streams.add(stream);
            res.on('close', () => {
                stream.closed = true;
                streams.delete(stream);
                // its job goes to another answerer, or waits: it was not the job's fault
                for (const h of handed.values()) if (h.stream === stream && !h.settling) release(h);
                deps.onConnections?.();
                dispatcher.kick();
            });
            deps.onConnections?.();
            dispatcher.kick();
        },

        async result(res, job, raw) {
            const h = handed.get(job);
            if (!h || h.settling) return sendError(res, 409, 'AnswerJobNotHeld', 'The job is not handed to anyone now: it timed out, or was answered.');
            h.settling = true;
            try {
                await take(res, h, raw);
            } finally {
                release(h);
                dispatcher.kick();
            }
        },

        kick() {
            if (running) {
                again = true;
                return;
            }
            running = handOut()
                .catch((e: unknown) => log(`handing out answer jobs failed: ${e instanceof Error ? e.message : String(e)}`))
                .finally(() => {
                    running = undefined;
                    if (again) dispatcher.kick();
                });
        },

        restored() {
            for (const stream of streams) send(stream, AGENT_ANSWER_EVENT_TYPES.restored, {});
        },

        connected: () => [...streams].filter((s) => !s.closed).length,

        async waiting() {
            const jobs = await use.answerJobs({ session });
            return jobs.ok ? jobs.value.filter((j) => !givenUp.has(keyOf(j))).length : 0;
        },

        close(sessionClosed) {
            clearInterval(keepalive);
            for (const h of handed.values()) release(h);
            for (const stream of streams) {
                if (sessionClosed) send(stream, AGENT_ANSWER_EVENT_TYPES.closed, {});
                endStream(stream);
            }
        },

        async settled() {
            while (running) await running;
        },
    };
    return dispatcher;
}
