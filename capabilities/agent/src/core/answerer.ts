// The answerer role of the agent (ADR 0030, decision 6; the plan's "Two roles"): follows the answers entry point of the
// agent API (`/agent/answers/events`), takes the jobs handed to it one at a time, and returns each one's result:
//
//   triage  → stage 3: the light model with no tools → { kind, confidence, reason } (or why it failed)
//   answer  → the read-only agent → an answer, or "a request after all" with a proposal, or "neither"
//   propose → the read-only agent → the change proposal for a participant's 依頼
//   interview → the read-only agent (the interviewer) → the next question of a `/es:start` or `/model:start`
//               interview, or its brief
//   command → the read-only agent → the candidates of a candidate command (`/es:exceptions`), or the answer of an
//             answer command (`/es:recap`)
//
// No claim, no lease, no revision, no `dt fmt` / `dt check`: an answer changes nothing to record, and the read-only
// guarantee is the agent's tools (its adapter), not this code. A job withdrawn by the server (it timed out there, or is
// no longer needed) is stopped and not answered; one past its own timeout is stopped and reported as failed. The
// session so far is given whole to a fresh process and since its previous job to a warm one, with the files changed
// since its previous job ended (`changedSinceYourLastAnswer`). A restored revision makes the agent forget. The output is
// validated here before it is sent (the server validates it again). Functions over the ports only; the log has job
// kinds and IDs, never a message's text or an answer.
import {
    briefData,
    candidateData,
    proposalData,
    readAnswererReply,
    readCommandReply,
    readInterviewerReply,
    readTriageAnswer,
    TRIAGE_KINDS,
} from '@domaintrail/collaboration';
import type { AgentAnswerStreamJob, AgentCommandJobBody, AgentInterviewJobBody } from '@domaintrail/collaboration/protocol';
import { buildAnswerPrompt, buildCommandPrompt, buildInterviewPrompt, buildProposePrompt, buildTriagePrompt } from './answer-prompt.js';
import { AgentApiError, type AgentApi, type AnswerAgent, type AnswerTurnResult, type Clock, type WorkspaceFiles } from './ports.js';
import { changedPaths } from './subscriber.js';
import type { Practice } from './prompt.js';

export interface AnswererDeps {
    readonly api: AgentApi;
    readonly agent: AnswerAgent;
    readonly workspace: Pick<WorkspaceFiles, 'scan'>;
    readonly clock: Clock;
    /** A random string per job (the prompt's block delimiter). */
    readonly nonce: () => string;
    /** Progress for the person running it: job kinds and IDs only. */
    readonly log: (line: string) => void;
    /** Milliseconds now (default `Date.now`): the jobs' durations. */
    readonly now?: () => number;
}

export interface AnswererOptions {
    /** The most a job may take here (`agent.answer.timeout`); the job's own `timeoutMs` (the server's) bounds it too. */
    readonly timeoutMs?: number;
    /** Reconnection delays of the stream: from `minMs`, doubling up to `maxMs`; ends when none opens for `giveUpMs`. */
    readonly reconnect?: { readonly minMs: number; readonly maxMs: number; readonly giveUpMs: number };
    /** The ways of working the answer and propose prompts give for the DSLs a message is about (the guide's); none without it. */
    readonly practice?: Practice;
}

/** Why an answerer ended. */
export type AnswererEnd = 'closed' | 'stopped' | 'lost';

export interface Answerer {
    readonly done: Promise<AnswererEnd>;
    /** Stops: the job in hand is stopped (not answered: the server hands it to another answerer). */
    stop(): Promise<AnswererEnd>;
}

const DEFAULT_RECONNECT = { minMs: 500, maxMs: 5_000, giveUpMs: 60_000 };
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The structured output, else the text as JSON. */
function outputOf(result: AnswerTurnResult): unknown {
    if (result.structured !== undefined) return result.structured;
    try {
        return JSON.parse(result.text.trim());
    } catch {
        return undefined;
    }
}

/** The wire kind of stage 3's verdict (`TRIAGE_KINDS`, read back). */
const wireKind = (verdict: string): string => Object.entries(TRIAGE_KINDS).find(([, v]) => v === verdict)?.[0] ?? 'unknown';

export function startAnswerer(deps: AnswererDeps, options: AnswererOptions = {}): Answerer {
    const { api, clock, log } = deps;
    const now = deps.now ?? Date.now;
    const reconnect = options.reconnect ?? DEFAULT_RECONNECT;
    const practice = options.practice && { practice: options.practice };
    const stopping = new AbortController();
    let end: AnswererEnd | undefined;
    let resolveDone: (end: AnswererEnd) => void = () => {};
    const done = new Promise<AnswererEnd>((resolve) => (resolveDone = resolve));
    const queue: AgentAnswerStreamJob[] = [];
    let current: { readonly job: string; readonly withdrawn: AbortController } | undefined;
    let wakeWorker: () => void = () => {};
    /** The workspace as the read-only agent's previous answer or proposal left it. */
    let lastScan: ReadonlyMap<string, string> | undefined;

    const finish = (why: AnswererEnd): void => {
        if (end) return;
        end = why;
        stopping.abort();
        wakeWorker();
    };

    /** An interview's turn: the interviewer's question or brief, as the server takes it (`AgentInterviewResultBody`). */
    const interviewResultOf = async (job: AgentInterviewJobBody, signal: AbortSignal, started: number): Promise<Record<string, unknown>> => {
        const elapsed = (): number => Math.max(0, Math.round(now() - started));
        const result = await deps.agent.interview({ prompt: buildInterviewPrompt(job, deps.nonce(), practice ?? {}), signal });
        const meta = { ...(result.model && { model: result.model }), durationMs: elapsed() };
        if (result.error !== undefined) return { error: result.error, ...meta };
        const read = readInterviewerReply(outputOf(result));
        if (!read.ok) return { error: `invalid output (${read.error.path})`, ...meta };
        const reply = read.value;
        return reply.kind === 'question' ? { kind: 'question', question: reply.question, ...meta } : { kind: 'brief', brief: briefData(reply.brief), ...meta };
    };

    /** A command's turn: its candidates or its answer, as the server takes it (`AgentCommandResultBody`). */
    const commandResultOf = async (job: AgentCommandJobBody, signal: AbortSignal, started: number): Promise<Record<string, unknown>> => {
        const elapsed = (): number => Math.max(0, Math.round(now() - started));
        const result = await deps.agent.command({ prompt: buildCommandPrompt(job, deps.nonce(), practice ?? {}), type: job.type, signal });
        const meta = { ...(result.model && { model: result.model }), durationMs: elapsed() };
        if (result.error !== undefined) return { error: result.error, ...meta };
        const read = readCommandReply(outputOf(result), job.type);
        if (!read.ok) return { error: `invalid output (${read.error.path})`, ...meta };
        const reply = read.value;
        // the candidates as read (clamped, malformed references dropped) go as the answerer sends them: the server reads them again
        return reply.kind === 'answer'
            ? { kind: 'answer', answer: reply.answer, ...meta }
            : { kind: 'candidates', candidates: reply.candidates.map(candidateData), ...meta };
    };

    /** The result of a job as the server takes it (`AgentTriageResultBody`, `AgentAnswerResultBody`, `AgentProposeResultBody`). */
    const resultOf = async (job: AgentAnswerStreamJob, signal: AbortSignal): Promise<Record<string, unknown>> => {
        const started = now();
        if (job.kind === 'interview') return interviewResultOf(job, signal, started);
        if (job.kind === 'command') return commandResultOf(job, signal, started);
        const elapsed = (): number => Math.max(0, Math.round(now() - started));
        const failed = (error: string, model?: string): Record<string, unknown> => ({ error, durationMs: elapsed(), ...(model && { model }) });
        if (job.kind === 'triage') {
            const result = await deps.agent.triage({ prompt: buildTriagePrompt(job, deps.nonce()), signal });
            if (result.error !== undefined) return failed(result.error, result.model);
            const read = readTriageAnswer(outputOf(result));
            if (!read.ok) return failed(`invalid output (${read.error.path})`, result.model);
            return {
                kind: wireKind(read.value.verdict),
                confidence: read.value.confidence,
                reason: read.value.reason,
                ...(result.model && { model: result.model }),
                durationMs: elapsed(),
            };
        }
        // what changed since this agent's previous answer or proposal (people, a run, a restore): for a warm process
        const before = await deps.workspace.scan();
        const changed = lastScan && changedPaths(lastScan, before);
        const nonce = deps.nonce();
        const build = job.kind === 'answer' ? buildAnswerPrompt : buildProposePrompt;
        const since = job.sessionSoFarSince ?? job.sessionSoFar;
        const result = await deps.agent.answer({
            prompt: build(job, nonce, { ...(job.sessionSoFar && { sessionSoFar: job.sessionSoFar.text }), ...practice }),
            ...(changed && {
                continuedPrompt: build(job, nonce, { ...practice, changedSinceYourLastAnswer: changed, ...(since && { sessionSoFar: since.text }) }),
            }),
            signal,
        });
        lastScan = await deps.workspace.scan().catch(() => undefined);
        if (result.error !== undefined) return failed(result.error, result.model);
        const read = readAnswererReply(outputOf(result));
        if (!read.ok) return failed(`invalid output (${read.error.path})`, result.model);
        const meta = { ...(result.model && { model: result.model }), durationMs: elapsed() };
        const reply = read.value;
        // a proposal as read (clamped, malformed references dropped) goes as the answerer sends one: the server reads it again
        if (job.kind === 'propose') {
            if (reply.kind !== 'proposal') return failed(`no proposal (${reply.kind})`, result.model);
            return { proposal: proposalData(reply.proposal), ...meta };
        }
        if (reply.kind === 'proposal') return { ...reply, proposal: proposalData(reply.proposal), ...meta };
        return { ...reply, ...(reply.kind === 'answer' && job.readRevision && { readRevision: job.readRevision }), ...meta };
    };

    const handle = async (job: AgentAnswerStreamJob): Promise<void> => {
        const withdrawn = new AbortController();
        current = { job: job.job, withdrawn };
        const limit = Math.max(1, Math.min(job.timeoutMs, options.timeoutMs ?? Number.POSITIVE_INFINITY));
        const timeout = AbortSignal.timeout(limit);
        const signal = AbortSignal.any([withdrawn.signal, stopping.signal, timeout]);
        const subject =
            job.kind === 'interview' ? `interview ${job.interview.id}` : job.kind === 'command' ? `command ${job.command.id}` : `triage ${job.triage.id}`;
        log(`answer job ${job.job}: ${job.kind} of ${subject}`);
        try {
            let result: Record<string, unknown>;
            try {
                result = await resultOf(job, signal);
            } catch (e) {
                result = { error: message(e), durationMs: 0 };
            }
            // withdrawn by the server, or this answerer stops: not answered (the server hands it out again or let it go)
            if (withdrawn.signal.aborted || stopping.signal.aborted) return log(`answer job ${job.job}: stopped`);
            if (timeout.aborted) result = { error: 'timed out', durationMs: limit };
            const sent = await api.answerResult(job.job, result).catch((e: unknown) => {
                log(`answer job ${job.job}: the result could not be sent (${message(e)})`);
                return undefined;
            });
            if (!sent) return;
            if (sent.ok) return log(`answer job ${job.job}: ${'error' in result ? 'failed' : 'answered'}`);
            if (sent.status === 401) finish('lost');
            log(`answer job ${job.job}: result refused (${sent.status} ${sent.type})`);
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
                for await (const item of api.answerEvents(stopping.signal)) {
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
                        case 'restored':
                            deps.agent.reset?.('a revision was restored');
                            break;
                        case 'closed':
                            finish('closed');
                            break;
                    }
                    if (end) break;
                }
            } catch (e) {
                if (end) break;
                if (e instanceof AgentApiError && (e.status === 401 || e.status === 404)) {
                    log(`the session server refused the answer stream (${e.status} ${e.type})`);
                    finish('lost');
                    break;
                }
                log(`the answer stream broke (${message(e)}); reconnecting`);
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
        log(`${what} failed: ${message(e)}`);
        finish('lost');
    };
    const worker = work().catch(fail('the answerer'));
    const stream = follow().catch(fail('the answer stream'));
    void Promise.all([worker, stream])
        .then(() => deps.agent.close?.())
        .catch((e: unknown) => log(`the answerer's agent could not be closed: ${message(e)}`))
        .then(() => resolveDone(end ?? 'stopped'));

    return {
        done,
        async stop() {
            finish('stopped');
            return done;
        },
    };
}
