// The extraction entry point of the agent API (ADR 0031, section 3): the extractor role's jobs, handed out over an SSE
// stream of their own (`GET /agent/extractions/events`) and their results taken back (`POST /agent/extractions/:job`),
// beside the answers' and the runs' entry points, behind the same token. No claim, no lease: an extraction changes
// nothing in the session and never waits for a run or an answer.
//
// The session's extraction (Knowledge's use case, wired in `wiring/knowledge.ts`) asks for one extraction at a time
// (`extract`): it is handed to a connected extractor that has none in hand, and the promise resolves with its result,
// or as `unavailable` when no extractor is connected (or the one it was handed to went away: the scheduler asks again
// when one connects). A job not answered within its timeout is withdrawn and resolves as failed. What is handed out is
// held here in memory. The result is AI output: only its envelope is read here (`ExtractionResultBody`); the reply is
// read by the use case.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { EXTRACTION_EVENT_TYPES, type ExtractionInput, type ExtractionResultBody, type Extractor, readUsage } from '@domaintrail/knowledge';
import { sendError } from '../http/json.js';

/** How long past its timeout a job's extractor has to report that it failed, before the job is withdrawn. */
const GRACE_MS = 5_000;
/** A comment on every stream this often, so that the extractor sees it is alive. */
const KEEPALIVE_MS = 15_000;

export interface ExtractionDispatcherDeps {
    /** The most milliseconds an extraction may take (`agent.extract.timeout`), told to the extractor. */
    readonly timeoutMs: number;
    /** Most extraction streams at once. */
    readonly maxStreams: number;
    /** The agent API's credential: a result that contains it is refused. */
    readonly token?: string;
    /** An extractor connected: what waited for one may go now. */
    readonly onConnected?: () => void;
    readonly log: (line: string) => void;
}

export interface ExtractionDispatcher extends Extractor {
    /** `GET /agent/extractions/events`: a connected extractor. */
    events(req: IncomingMessage, res: ServerResponse): void;
    /** `POST /agent/extractions/:job`: a job's result (the body read as JSON); answers the request. */
    result(res: ServerResponse, job: string, raw: unknown): void;
    /** How many extractors are connected. */
    connected(): number;
    /** Ends every stream (`sessionClosed`: told first), and resolves what is handed out as `unavailable`. */
    close(sessionClosed: boolean): void;
}

interface ExtractionStream {
    readonly res: ServerResponse;
    job?: string;
    closed: boolean;
}

interface Handed {
    readonly id: string;
    readonly stream: ExtractionStream;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly resolve: (answer: Awaited<ReturnType<Extractor['extract']>>) => void;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const durationOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, 86_400_000) : 0);
const shortText = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** A result's envelope, read: the reply as given (read by the use case), the error, the model, the duration, the usage. */
export function readExtractionResult(raw: Record<string, unknown>): ExtractionResultBody {
    const error = shortText(raw.error, 500);
    const model = shortText(raw.model, 200);
    const usage = readUsage(raw.usage);
    return {
        ...(error === undefined ? { reply: raw.reply } : { error }),
        ...(model && { model }),
        durationMs: durationOf(raw.durationMs),
        ...(usage && { usage }),
    };
}

export function createExtractionDispatcher(deps: ExtractionDispatcherDeps): ExtractionDispatcher {
    const { log } = deps;
    const streams = new Set<ExtractionStream>();
    const handed = new Map<string, Handed>();

    const send = (stream: ExtractionStream, event: string, data: unknown): void => {
        if (!stream.closed) stream.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const keepalive = setInterval(() => {
        for (const stream of streams) if (!stream.closed) stream.res.write(': keepalive\n\n');
    }, KEEPALIVE_MS);
    keepalive.unref();

    /** A hand-out ends with `answer`: its stream is free again. */
    const settle = (h: Handed, answer: Awaited<ReturnType<Extractor['extract']>>): void => {
        if (!handed.delete(h.id)) return;
        clearTimeout(h.timer);
        if (h.stream.job === h.id) h.stream.job = undefined;
        h.resolve(answer);
    };

    return {
        extract(input: ExtractionInput) {
            const stream = [...streams].find((s) => !s.closed && s.job === undefined);
            if (!stream) return Promise.resolve({ kind: 'unavailable' });
            const id = randomUUID();
            return new Promise((resolve) => {
                const timer = setTimeout(() => {
                    const h = handed.get(id);
                    if (!h) return;
                    send(h.stream, EXTRACTION_EVENT_TYPES.withdrawn, { job: id });
                    log(`extraction job ${id} timed out`);
                    settle(h, { kind: 'done', result: { error: 'timed out', durationMs: deps.timeoutMs } });
                }, deps.timeoutMs + GRACE_MS);
                timer.unref();
                handed.set(id, { id, stream, timer, resolve });
                stream.job = id;
                send(stream, EXTRACTION_EVENT_TYPES.job, { ...input, job: id, timeoutMs: deps.timeoutMs });
            });
        },

        events(_req, res) {
            if (streams.size >= deps.maxStreams) return sendError(res, 429, 'TooManyStreams', `At most ${deps.maxStreams} streams at once.`);
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-store',
                connection: 'keep-alive',
                'x-content-type-options': 'nosniff',
            });
            res.write(': extractions\n\n');
            const stream: ExtractionStream = { res, closed: false };
            streams.add(stream);
            res.on('close', () => {
                stream.closed = true;
                streams.delete(stream);
                // its job is not the job's fault: asked again once an extractor connects
                for (const h of handed.values()) if (h.stream === stream) settle(h, { kind: 'unavailable' });
            });
            deps.onConnected?.();
        },

        result(res, job, raw) {
            const h = handed.get(job);
            if (!h) return sendError(res, 409, 'ExtractionJobNotHeld', 'The job is not handed to anyone now: it timed out, or was answered.');
            if (!isObject(raw)) return sendError(res, 400, 'InvalidInput', 'Expected a JSON object.', { field: 'body' });
            // the agent's credential in a reply would be written into the knowledge: refused, and told
            if (deps.token && JSON.stringify(raw).includes(deps.token)) {
                log(`extraction job ${job}: refused, its result contains the agent credential`);
                settle(h, { kind: 'done', result: { error: 'refused: the output contained a credential', durationMs: durationOf(raw.durationMs) } });
                return sendError(res, 400, 'CredentialInOutput', 'The result contains the agent credential.');
            }
            settle(h, { kind: 'done', result: readExtractionResult(raw) });
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('{}');
        },

        connected: () => [...streams].filter((s) => !s.closed).length,

        close(sessionClosed) {
            clearInterval(keepalive);
            for (const h of handed.values()) settle(h, { kind: 'unavailable' });
            for (const stream of streams) {
                if (sessionClosed) send(stream, EXTRACTION_EVENT_TYPES.closed, {});
                stream.closed = true;
                streams.delete(stream);
                stream.res.end();
            }
        },
    };
}
