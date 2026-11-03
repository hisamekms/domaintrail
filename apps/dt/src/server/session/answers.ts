// The answers entry point of the agent API (ADR 0030, decision 6; the plan's "Two roles"): the answerer role's jobs —
// stage 3 of a triage (`triage`), the answer to a 相談 (`answer`), the proposal for a participant's 依頼 (`propose`), the
// interviewer's next turn of a `/es:start` or `/model:start` interview (`interview`: a question, or the brief), a
// candidate or answer command of the `/` list (`command`: its candidates, or its answer) —
// handed out over an SSE stream of their own (`GET /agent/answers/events`), each to one connected answerer that has
// none in hand, and their results taken back (`POST /agent/answers/:job`). No claim, no lease, no workspace lock: the
// jobs never wait for the run queue nor hold it. What a job is waiting for is the collaboration's (`answerJobs`); what is
// handed out, to whom and until when, is held here in memory: a job not answered within its timeout is withdrawn (a
// triage's stage 3 is then recorded as failed, which makes it a 相談; an answer or a proposal is tried again, at most
// `MAX_ATTEMPTS` times, then given up until an answerer connects — each new stream gives the given-up jobs another
// round — or the facilitator retries it), and the jobs of an answerer that disconnects are handed to another one, or wait.
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
    commandId,
    type InterviewJob,
    plainBody,
    readInterviewerReply,
    readCommandReply,
    slashCommandName,
    slashCommandSpec,
    type SlashCommandJob,
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
import {
    AGENT_ANSWER_EVENT_TYPES,
    type AgentAnswerJobBody,
    type AgentAnswerStreamJob,
    type AgentCommandJobBody,
    type AgentInterviewJobBody,
    type AgentSessionSoFar,
} from '@domaintrail/collaboration/protocol';
import { sendError } from '../http/json.js';
import { body as objectBody } from './input.js';

/** How many times an answer or a proposal is handed out before it is given up (until an answerer connects, or a retry). */
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
    /** The number of connected answerers, or the jobs given up, changed. */
    readonly onPresence?: () => void;
    /** The agent API's credential: a result that contains it is refused (defense in depth: no agent should be able to read it). */
    readonly token?: string;
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
    /** The answers and proposals given up that are still to write, in the order of the jobs. */
    givenUp(): Promise<readonly GivenUpAnswer[]>;
    /** The facilitator's retry: the given-up jobs of the message, still to write, get another round; whether there was one. */
    retry(request: Collaboration.RequestId): Promise<boolean>;
    /** Ends every stream (the session closed: told first; the server stops). */
    close(sessionClosed: boolean): void;
    /** Resolves once the hand-outs under way have ended (tests). */
    settled(): Promise<void>;
}

/** Any job of the answerer: about a triage, an interview's next turn, or a `/` command. */
type Job = AnswerJob | InterviewJob | SlashCommandJob;

/** An answer, a proposal or an interview's turn given up after `MAX_ATTEMPTS` (the agents' presence lists them for the page). */
export interface GivenUpAnswer {
    readonly request: Collaboration.RequestId;
    readonly kind: Exclude<Job['kind'], 'triage'>;
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
    readonly kind: Job['kind'];
    /** The triage (a job about one) or the interview (an interview job): the log names it. */
    readonly subject: string;
    readonly triage?: Collaboration.TriageId;
    readonly interview?: Collaboration.InterviewId;
    readonly command?: Collaboration.SlashCommandId;
    readonly request: Collaboration.RequestId;
    readonly stream: AnswerStream;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly readRevision?: Collaboration.RevisionId;
    readonly soFarLast?: number;
    /** A result is being written: not withdrawn meanwhile. */
    settling: boolean;
}

// an interview's turn is one per message it answers: the starter writing again makes another one due
const keyOf = (job: Job): string =>
    job.kind === 'interview'
        ? `${job.interview.id}:${job.request.id}:interview`
        : job.kind === 'command'
          ? `${job.command.id}:command`
          : `${job.triage.id}:${job.kind}`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const durationOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, 86_400_000) : 0);
const shortText = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

export function createAnswerDispatcher(deps: AnswerDispatcherDeps): AnswerDispatcher {
    const { session, collaboration: use, log } = deps;
    const streams = new Set<AnswerStream>();
    const handed = new Map<string, Handed>();
    const handedKeys = new Set<string>();
    const attempts = new Map<string, number>();
    const givenUp = new Map<string, GivenUpAnswer>();
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
        if (n >= MAX_ATTEMPTS && h.kind !== 'triage') {
            givenUp.set(h.key, { request: h.request, kind: h.kind });
            log(`answer job ${h.kind} of ${h.subject} given up after ${n} attempts (${why}); a new answerer or a retry tries it again`);
            deps.onPresence?.();
        } else log(`answer job ${h.kind} of ${h.subject} failed (${why}); it will be handed out again`);
    };

    /** The given-up jobs `which` selects get another round of `MAX_ATTEMPTS` (handed out at the next kick); how many. */
    const another = (which: (g: GivenUpAnswer) => boolean, by: string): number => {
        let n = 0;
        for (const [key, g] of givenUp) {
            if (!which(g)) continue;
            givenUp.delete(key);
            attempts.delete(key);
            log(`answer job ${g.kind} of request ${g.request}: tried again (${by})`);
            n++;
        }
        if (n) deps.onPresence?.();
        return n;
    };

    /** Stage 3 that failed or timed out: recorded as unknown with why, which makes the triage a 相談. */
    const recordFailedTriage = async (h: Handed, error: string, durationMs: number, model?: string): Promise<void> => {
        if (!h.triage) return;
        const recorded = await use.recordTriageStep({
            triage: h.triage,
            step: { stage: 'Model', verdict: 'Unknown', error, durationMs, ...(model && { model }) },
        });
        if (!recorded.ok) log(`${h.subject}: stage 3's failure not recorded (${recorded.error.type})`);
        await deps.pump();
    };

    const timedOut = (id: string): void => {
        const h = handed.get(id);
        if (!h || h.settling) return;
        release(h);
        send(h.stream, AGENT_ANSWER_EVENT_TYPES.withdrawn, { job: h.id });
        log(`answer job ${h.kind} of ${h.subject} timed out`);
        const after = h.kind === 'triage' ? recordFailedTriage(h, 'timed out', deps.timeoutMs) : Promise.resolve(failedOnce(h, 'timed out'));
        void after.catch((e: unknown) => log(`answer job: ${e instanceof Error ? e.message : String(e)}`)).finally(() => dispatcher.kick());
    };

    /** An interview job's body: the interview, the message to answer, the transcript, the session so far. */
    const interviewBodyOf = async (
        job: InterviewJob,
        state: { readonly session: Collaboration.Session; readonly revisions: readonly Collaboration.Revision[] },
        id: string,
    ): Promise<{ body: AgentInterviewJobBody; readRevision?: Collaboration.RevisionId }> => {
        const names = new Map<string, string>(state.session.participants.map((p) => [p.id, p.name]));
        const full = await use.sessionSoFar({ session });
        const readRevision = state.revisions.at(-1)?.id;
        return {
            body: {
                job: id,
                kind: 'interview',
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the aggregates become their JSON when encoded
                interview: job.interview as unknown as AgentInterviewJobBody['interview'],
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above
                request: job.request as unknown as AgentInterviewJobBody['request'],
                author: names.get(job.interview.startedBy) ?? 'a participant',
                timeoutMs: deps.timeoutMs,
                command: commandId(job.interview.command),
                language: job.interview.language === 'En' ? 'en' : 'ja',
                transcript: job.transcript.map((r) => ({
                    from: isAi(r.author) ? 'ai' : 'person',
                    text: plainBody(r.body, { targets: r.targets.length, people: r.mentions.length }),
                })),
                ...(full.ok && { sessionSoFar: { text: full.value.text, last: full.value.last } }),
                ...(readRevision && { readRevision }),
            },
            ...(readRevision && { readRevision }),
        };
    };

    /** A command job's body: the command, its opening message (with its view), the session so far. */
    const commandBodyOf = async (
        job: SlashCommandJob,
        state: { readonly session: Collaboration.Session; readonly revisions: readonly Collaboration.Revision[] },
        id: string,
    ): Promise<{ body: AgentCommandJobBody; readRevision?: Collaboration.RevisionId }> => {
        const names = new Map<string, string>(state.session.participants.map((p) => [p.id, p.name]));
        const full = await use.sessionSoFar({ session });
        const readRevision = state.revisions.at(-1)?.id;
        return {
            body: {
                job: id,
                kind: 'command',
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the aggregates become their JSON when encoded
                command: job.command as unknown as AgentCommandJobBody['command'],
                name: slashCommandName(job.command.kind),
                type: slashCommandSpec(job.command.kind).reply,
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above
                request: job.request as unknown as AgentCommandJobBody['request'],
                author: names.get(job.command.startedBy) ?? 'a participant',
                timeoutMs: deps.timeoutMs,
                language: job.command.language === 'En' ? 'en' : 'ja',
                ...(full.ok && { sessionSoFar: { text: full.value.text, last: full.value.last } }),
                ...(readRevision && { readRevision }),
            },
            ...(readRevision && { readRevision }),
        };
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
            const jobs = await allJobs();
            if (!jobs) return;
            const due = jobs.filter((j) => !handedKeys.has(keyOf(j)) && !givenUp.has(keyOf(j)));
            if (!due.length) continue;
            const state = await use.sessionState({ session });
            if (!state.ok || state.value.session.state !== 'Open') return;
            for (const job of due) {
                const stream = idle.shift();
                if (!stream) break;
                if (stream.closed) continue;
                const id = randomUUID();
                const { body, soFarLast, readRevision }: { body: AgentAnswerStreamJob; soFarLast?: number; readRevision?: Collaboration.RevisionId } =
                    job.kind === 'interview'
                        ? await interviewBodyOf(job, state.value, id)
                        : job.kind === 'command'
                          ? await commandBodyOf(job, state.value, id)
                          : await bodyOf(job, state.value, stream, id);
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
                    ...(job.kind === 'interview'
                        ? { subject: `interview ${job.interview.id}`, interview: job.interview.id }
                        : job.kind === 'command'
                          ? { subject: `command ${job.command.id}`, command: job.command.id }
                          : { subject: `triage ${job.triage.id}`, triage: job.triage.id }),
                    request: job.request.id,
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

    /** Every job waiting: those about triages, then the interviews' turns, then the `/` commands. */
    const allJobs = async (): Promise<readonly Job[] | undefined> => {
        const [answers, interviews, commands] = await Promise.all([use.answerJobs({ session }), use.interviewJobs({ session }), use.commandJobs({ session })]);
        if (!answers.ok) return undefined;
        return [...answers.value, ...(interviews.ok ? interviews.value : []), ...(commands.ok ? commands.value : [])];
    };

    /** An interview job's result: the next question (a message of the AI) or the brief. */
    const takeInterview = async (
        h: Handed,
        raw: Record<string, unknown>,
        r: {
            readonly durationMs: number;
            readonly model?: string;
            readonly error?: string;
            readonly fail: (status: number, type: string, message?: string, detail?: object) => void;
            readonly done: (result: { ok: true } | { ok: false; error: { readonly type: string } }) => Promise<void>;
        },
    ): Promise<void> => {
        const interview = h.interview;
        if (!interview) return r.fail(500, 'NoInterview');
        if (r.error !== undefined) {
            failedOnce(h, r.error);
            return r.done({ ok: true });
        }
        const { model: _m, durationMs: _d, ...reply } = raw;
        const read = readInterviewerReply(reply);
        if (!read.ok) {
            failedOnce(h, `invalid output (${read.error.path})`);
            return r.fail(400, 'InvalidReply', read.error.message, { field: read.error.path });
        }
        if (read.value.kind === 'question') {
            const text = Collaboration.makeText(read.value.question);
            if (!text.ok) return r.fail(400, 'InvalidReply', 'Not a text.', { field: 'question' });
            return r.done(await use.askInInterview({ interview, answered: h.request, question: text.value }));
        }
        return r.done(await use.briefInterview({ interview, answered: h.request, brief: read.value.brief }));
    };

    /** A command job's result: its candidates, or its answer (a message of the AI). */
    const takeCommand = async (
        h: Handed,
        raw: Record<string, unknown>,
        r: {
            readonly error?: string;
            readonly fail: (status: number, type: string, message?: string, detail?: object) => void;
            readonly done: (result: { ok: true } | { ok: false; error: { readonly type: string } }) => Promise<void>;
        },
    ): Promise<void> => {
        const command = h.command;
        if (!command) return r.fail(500, 'NoCommand');
        if (r.error !== undefined) {
            failedOnce(h, r.error);
            return r.done({ ok: true });
        }
        const { model: _m, durationMs: _d, ...reply } = raw;
        // the use case refuses the kind of result the command does not take
        const read = readCommandReply(reply, reply.kind === 'answer' ? 'answer' : reply.kind === 'next' ? 'next' : 'candidates');
        if (!read.ok) {
            failedOnce(h, `invalid output (${read.error.path})`);
            return r.fail(400, 'InvalidReply', read.error.message, { field: read.error.path });
        }
        if (read.value.kind === 'candidates') return r.done(await use.listCandidates({ command, candidates: read.value.candidates }));
        const text = Collaboration.makeText(read.value.answer);
        if (!text.ok) return r.fail(400, 'InvalidReply', 'Not a text.', { field: 'answer' });
        return r.done(await use.answerCommand({ command, answer: text.value, ...(read.value.next && { next: read.value.next }) }));
    };

    /** A job's result as a step, a message, an override or a proposal; the HTTP answer. */
    const take = async (res: ServerResponse, h: Handed, raw: unknown): Promise<void> => {
        if (!isObject(raw)) return sendError(res, 400, 'InvalidInput', 'Expected a JSON object.', { field: 'body' });
        // the agent's credential in an answer or a proposal would be posted to the chat: refused, and told
        if (deps.token && JSON.stringify(raw).includes(deps.token)) {
            log(`answer job ${h.kind} of ${h.subject}: refused, its result contains the agent credential`);
            if (h.kind === 'triage') await recordFailedTriage(h, 'refused: the output contained a credential', durationOf(raw.durationMs));
            else failedOnce(h, 'refused: the output contained a credential');
            return sendError(res, 400, 'CredentialInOutput', 'The result contains the agent credential.');
        }
        const durationMs = durationOf(raw.durationMs);
        const model = shortText(raw.model, 200);
        const error = shortText(raw.error, 500);
        const fail = (status: number, type: string, message?: string, detail: object = {}): void => sendError(res, status, type, message, detail);
        const done = async (result: { ok: true } | { ok: false; error: { readonly type: string } }): Promise<void> => {
            if (!result.ok) {
                log(`answer job ${h.kind} of ${h.subject}: refused (${result.error.type})`);
                return fail(409, result.error.type, undefined, result.error);
            }
            await deps.pump();
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('{}');
        };
        if (h.kind === 'interview') return takeInterview(h, raw, { durationMs, model, error, fail, done });
        if (h.kind === 'command') return takeCommand(h, raw, { error, fail, done });
        const triage = h.triage;
        if (!triage) return fail(500, 'NoTriage');
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
                const recorded = await use.recordTriageStep({ triage, step });
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
                    const answered = await use.answerMessage({ triage, body: text.value, ...(readRevision && { readRevision }) });
                    if (answered.ok) h.stream.lastSoFar = h.soFarLast ?? h.stream.lastSoFar;
                    return done(answered.ok ? { ok: true } : answered);
                }
                // the override (decision 18): a request after all, with its proposal; or nothing for the AI to do
                const overridden = await use.overrideTriage({
                    triage,
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
                const proposed = await use.proposeChange({ triage, content: read.value });
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
            // a new answerer (another process, or one restarted after a fix) gets what was given up: another round
            another(() => true, 'an answerer connected');
            res.on('close', () => {
                stream.closed = true;
                streams.delete(stream);
                // its job goes to another answerer, or waits: it was not the job's fault
                for (const h of handed.values()) if (h.stream === stream && !h.settling) release(h);
                deps.onPresence?.();
                dispatcher.kick();
            });
            deps.onPresence?.();
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
            const jobs = await allJobs();
            return jobs ? jobs.filter((j) => !givenUp.has(keyOf(j))).length : 0;
        },

        async givenUp() {
            if (!givenUp.size) return [];
            const jobs = await allJobs();
            if (!jobs) return [];
            // a job no longer waited for (answered by hand, dismissed, an interview stopped) is forgotten
            const due = new Set(jobs.map(keyOf));
            for (const key of givenUp.keys()) if (!due.has(key)) givenUp.delete(key);
            return jobs.flatMap((j) => givenUp.get(keyOf(j)) ?? []);
        },

        async retry(request) {
            if (!(await dispatcher.givenUp()).some((g) => g.request === request)) return false;
            another((g) => g.request === request, 'the facilitator retried it');
            dispatcher.kick();
            return true;
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
