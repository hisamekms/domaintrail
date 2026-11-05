// The extractor role of the agent (ADR 0031, section 3): a third role beside the runner and the answerer, read-only and
// with no tools. It follows the extraction entry point of the agent API (`/agent/extractions/events`), takes the jobs
// handed to it — the server hands out one extraction per session at a time — and returns each one's reply: the
// operations the talk calls for, with what the turn cost (tokens, cache, dollars) for the server to record. It runs
// beside the answers and the runs, never waiting for them nor they for it.
//
// A job withdrawn by the server is stopped and not answered; one past its own timeout is stopped and reported as
// failed. The reply is AI output: its shape is checked here (`readExtractorReply`) before it is sent, and read again by
// the server. A server with no knowledge store answers the stream 404: the extractor then ends (`off`) and nothing else
// does. Functions over the ports only; the log has job IDs and counts, never a message's text or an item's.
import { readExtractorReply, type ExtractionJobBody, type ExtractionResultBody } from '@domaintrail/knowledge';
import { buildExtractionPrompt } from './extract-prompt.js';
import { AgentApiError, type AnswerTurnResult, type Clock, type ExtractAgent, type ExtractionApi } from './ports.js';

export interface ExtractorDeps {
    readonly api: ExtractionApi;
    readonly agent: ExtractAgent;
    readonly clock: Clock;
    /** A random string per job (the prompt's block delimiter). */
    readonly nonce: () => string;
    readonly log: (line: string) => void;
    /** Milliseconds now (default `Date.now`): the jobs' durations. */
    readonly now?: () => number;
}

export interface ExtractorOptions {
    /** The most a job may take here (`agent.extract.timeout`); the job's own `timeoutMs` bounds it too. */
    readonly timeoutMs?: number;
    readonly reconnect?: { readonly minMs: number; readonly maxMs: number; readonly giveUpMs: number };
}

/** Why an extractor ended: the session closed, it was stopped, the server is gone, or it has no knowledge store. */
export type ExtractorEnd = 'closed' | 'stopped' | 'lost' | 'off';

export interface Extractor {
    readonly done: Promise<ExtractorEnd>;
    /** Stops: the job in hand is stopped (not answered). */
    stop(): Promise<ExtractorEnd>;
}

const DEFAULT_RECONNECT = { minMs: 500, maxMs: 5_000, giveUpMs: 60_000 };
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The structured output, else the text as JSON. */
function outputOf(result: AnswerTurnResult): unknown {
    if (result.structured !== undefined) return result.structured;
    try {
        return JSON.parse(result.text.trim());
    } catch {
        return undefined;
    }
}

export function startExtractor(deps: ExtractorDeps, options: ExtractorOptions = {}): Extractor {
    const { api, clock, log } = deps;
    const now = deps.now ?? Date.now;
    const reconnect = options.reconnect ?? DEFAULT_RECONNECT;
    const stopping = new AbortController();
    let end: ExtractorEnd | undefined;
    let resolveDone: (end: ExtractorEnd) => void = () => {};
    const done = new Promise<ExtractorEnd>((resolve) => (resolveDone = resolve));
    const queue: ExtractionJobBody[] = [];
    let current: { readonly job: string; readonly withdrawn: AbortController } | undefined;
    let wakeWorker: () => void = () => {};

    const finish = (why: ExtractorEnd): void => {
        if (end) return;
        end = why;
        stopping.abort();
        wakeWorker();
    };

    /** A job's result as the server takes it (`ExtractionResultBody`). */
    const resultOf = async (job: ExtractionJobBody, signal: AbortSignal): Promise<ExtractionResultBody> => {
        const started = now();
        const elapsed = (): number => Math.max(0, Math.round(now() - started));
        const result = await deps.agent.extract({ prompt: buildExtractionPrompt(job, deps.nonce()), signal });
        const meta = { ...(result.model && { model: result.model }), ...(result.usage && { usage: result.usage }), durationMs: elapsed() };
        if (result.error !== undefined) return { error: result.error, ...meta };
        const reply = outputOf(result);
        const read = readExtractorReply(reply);
        if (!read.ok) return { error: `invalid output (${read.error.path})`, ...meta };
        return { reply, ...meta };
    };

    const handle = async (job: ExtractionJobBody): Promise<void> => {
        const withdrawn = new AbortController();
        current = { job: job.job, withdrawn };
        const limit = Math.max(1, Math.min(job.timeoutMs, options.timeoutMs ?? Number.POSITIVE_INFINITY));
        const timeout = AbortSignal.timeout(limit);
        const signal = AbortSignal.any([withdrawn.signal, stopping.signal, timeout]);
        log(`extraction job ${job.job}: extraction ${job.number} (${job.messages.filter((m) => m.isNew).length} new messages, ${job.items.length} items)`);
        try {
            let result: ExtractionResultBody;
            try {
                result = await resultOf(job, signal);
            } catch (e) {
                result = { error: errorText(e), durationMs: 0 };
            }
            if (withdrawn.signal.aborted || stopping.signal.aborted) return log(`extraction job ${job.job}: stopped`);
            if (timeout.aborted) result = { error: 'timed out', durationMs: limit, ...(result.usage && { usage: result.usage }) };
            const sent = await api.extractionResult(job.job, result).catch((e: unknown) => {
                log(`extraction job ${job.job}: the result could not be sent (${errorText(e)})`);
                return undefined;
            });
            if (!sent) return;
            if (sent.ok) return log(`extraction job ${job.job}: ${result.error === undefined ? 'extracted' : 'failed'}`);
            if (sent.status === 401) finish('lost');
            log(`extraction job ${job.job}: result refused (${sent.status} ${sent.type})`);
        } finally {
            current = undefined;
        }
    };

    const work = async (): Promise<void> => {
        while (!end) {
            const job = queue.shift();
            if (!job) {
                await new Promise<void>((resolve) => (wakeWorker = resolve));
                wakeWorker = () => {};
                continue;
            }
            await handle(job);
        }
    };

    const follow = async (): Promise<void> => {
        let delay = reconnect.minMs;
        let failingSince = Date.now();
        while (!end) {
            try {
                for await (const item of api.extractionEvents(stopping.signal)) {
                    switch (item.kind) {
                        case 'open':
                            delay = reconnect.minMs;
                            failingSince = Number.POSITIVE_INFINITY;
                            // the jobs of a stream that broke are handed out again: none of them is ours any more
                            queue.length = 0;
                            current?.withdrawn.abort();
                            break;
                        case 'job':
                            queue.push(item.job);
                            wakeWorker();
                            break;
                        case 'withdrawn': {
                            const at = queue.findIndex((j) => j.job === item.job);
                            if (at >= 0) queue.splice(at, 1);
                            if (current?.job === item.job) current.withdrawn.abort();
                            break;
                        }
                        case 'closed':
                            finish('closed');
                            break;
                    }
                    if (end) break;
                }
            } catch (e) {
                if (end) break;
                if (e instanceof AgentApiError && e.status === 404) {
                    log('extractor: the session keeps no knowledge; not extracting');
                    finish('off');
                    break;
                }
                if (e instanceof AgentApiError && e.status === 401) {
                    log(`the session server refused the extraction stream (${e.status} ${e.type})`);
                    finish('lost');
                    break;
                }
                log(`the extraction stream broke (${errorText(e)}); reconnecting`);
            }
            if (end) break;
            failingSince = Math.min(failingSince, Date.now());
            if (Date.now() - failingSince > reconnect.giveUpMs) {
                log('the session server is unreachable');
                finish('lost');
                break;
            }
            await clock.sleep(delay, stopping.signal);
            delay = Math.min(delay * 2, reconnect.maxMs);
        }
    };

    const fail = (what: string) => (e: unknown) => {
        log(`${what} failed: ${errorText(e)}`);
        finish('lost');
    };
    const worker = work().catch(fail('the extractor'));
    const stream = follow().catch(fail('the extraction stream'));
    void Promise.all([worker, stream])
        .then(() => deps.agent.close?.())
        .catch((e: unknown) => log(`the extractor's agent could not be closed: ${errorText(e)}`))
        .then(() => resolveDone(end ?? 'stopped'));

    return {
        done,
        async stop() {
            finish('stopped');
            return done;
        },
    };
}
