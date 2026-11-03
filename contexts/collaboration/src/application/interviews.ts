// The use cases of the `/` commands' interviews (the plan's "`/` commands: ways of working with the AI", round 5): start
// one (the facilitator; in Solo, the person), the interviewer's question or brief (the answerer role, through the agent
// API), confirm the brief (as is or edited: a run is queued that writes it), stop one, and the interview jobs that wait
// for the interviewer. The starter's messages are heard by the interview in `sendMessage` (`hearIn`), without triage.
// As the other use cases: the aggregates loaded and saved in one transaction with their events, the commands deciding.
import { Collaboration, err, ok, type Result } from '../generated/index.js';
import { requestCommands } from '../domain/commands.js';
import { knownInterviewId, knownRequestId } from '../domain/ids.js';
import { awaitedMessage, interviewCommands, interviewMessages, isRunning, runningInterview } from '../domain/interviews.js';
import type { Actor } from './actor.js';
import { notAllowed, notFound, type NotAllowed, type NotFound } from './errors.js';
import type { CollaborationDeps, Stores } from './ports.js';
import { publish, queueRequests, type FreezeError } from './queueing.js';
import { sendIn, type SendMessageError } from './conversation.js';
import { storeVerifications } from './verifications.js';

type SessionId = Collaboration.SessionId;
type InterviewId = Collaboration.InterviewId;

/** An interview job (`/agent/answers/events`): the interview, the message to answer, and the interview's messages so far. */
export interface InterviewJob {
    readonly kind: 'interview';
    readonly interview: Collaboration.AskingInterview;
    /** The starter's message the interviewer answers (with a question or the brief). */
    readonly request: Collaboration.Request;
    /** The interview's messages up to it: its opening, the starter's answers and the AI's questions. */
    readonly transcript: readonly Collaboration.Request[];
}

/** An interview started: the interview, and its opening message. */
export interface InterviewStarted {
    readonly interview: Collaboration.AskingInterview;
    readonly request: Collaboration.SentRequest;
}

type QueueError = FreezeError | Collaboration.FacilitatorOnly | Collaboration.DuplicateRequest | Collaboration.InputMismatch;

export interface InterviewUseCases {
    /**
     * Starts an interview (`/es`, `/model`): the starter's opening message (the command's name), sent without triage, and
     * the interview waiting for the interviewer's first question. Only the facilitator (in Solo, the person); one running
     * interview per session (`InterviewAlreadyRunning`).
     */
    startInterview(input: {
        readonly session: SessionId;
        readonly actor: Actor;
        readonly command: Collaboration.InterviewCommand;
        readonly body: Collaboration.Text;
        readonly language: Collaboration.UiLanguage;
        readonly focus?: Collaboration.ModelTarget;
    }): Promise<
        Result<
            InterviewStarted,
            | SendMessageError
            | Collaboration.FacilitatorOnly
            | Collaboration.InterviewAlreadyRunning
            | Collaboration.SessionNotFound
            | Collaboration.SessionAlreadyClosed
        >
    >;
    /** The interviewer's next question: a message of the AI replying to the message it answers. */
    askInInterview(input: {
        readonly interview: InterviewId;
        readonly answered: Collaboration.RequestId;
        readonly question: Collaboration.Text;
    }): Promise<
        Result<
            { readonly question: Collaboration.SentRequest; readonly interview: Collaboration.AskingInterview },
            NotFound | NotAllowed | Collaboration.InterviewMovedOn | Collaboration.SessionNotFound | Collaboration.SessionAlreadyClosed
        >
    >;
    /** The interviewer's brief: the interview waits for its starter to confirm it, edit it or stop. */
    briefInterview(input: {
        readonly interview: InterviewId;
        readonly answered: Collaboration.RequestId;
        readonly brief: Collaboration.InterviewBrief;
    }): Promise<
        Result<
            Collaboration.BriefedInterview,
            NotFound | NotAllowed | Collaboration.InterviewMovedOn | Collaboration.SessionNotFound | Collaboration.SessionAlreadyClosed
        >
    >;
    /**
     * Its starter confirms the brief, as is or with its text edited: a run is queued (on the message the brief answered)
     * whose input carries the brief, to write it as the description of its storming or context.
     */
    confirmInterview(input: {
        readonly interview: InterviewId;
        readonly actor: Actor;
        readonly text?: Collaboration.BriefText;
    }): Promise<
        Result<
            { readonly interview: Collaboration.ConfirmedInterview; readonly run: Collaboration.QueuedAgentRun },
            NotFound | NotAllowed | Collaboration.NotTheInterviewer | Collaboration.SessionNotFound | Collaboration.SessionAlreadyClosed | QueueError
        >
    >;
    /** Its starter stops it (中止), asking or with its brief waiting. */
    stopInterview(input: {
        readonly interview: InterviewId;
        readonly actor: Actor;
    }): Promise<
        Result<
            Collaboration.StoppedInterview,
            NotFound | NotAllowed | Collaboration.NotTheInterviewer | Collaboration.SessionNotFound | Collaboration.SessionAlreadyClosed
        >
    >;
    /** The interview jobs the answerer role waits for in the session (at most one: one interview runs at a time). */
    interviewJobs(input: { readonly session: SessionId }): Promise<Result<readonly InterviewJob[], NotFound>>;
}

/**
 * The starter's message while their interview runs, inside the caller's transaction: heard by the interview (it waits
 * for the interviewer again; a brief waiting is dropped). Undefined when no interview of the author runs: the message
 * goes on to the triage.
 */
export function hearIn(stores: Stores, request: Collaboration.SentRequest, at: Date): Collaboration.AskingInterview | undefined {
    const running = runningInterview(stores.interviews.listBySession(request.session));
    if (!running || running.startedBy !== request.author) return undefined;
    const heard = decided(interviewCommands.hear(running, { message: request.id, heardAt: at }));
    stores.interviews.save(heard.Asking.aggregate);
    publish(stores, request.session, heard.Asking.events, at);
    return heard.Asking.aggregate;
}

export function createInterviews(deps: CollaborationDeps): InterviewUseCases {
    const { uow, clock, ids } = deps;

    const load = (stores: Stores, id: InterviewId): Result<Collaboration.Interview, NotFound> => {
        const i = stores.interviews.load(id);
        return i ? ok(i) : err(notFound('Interview', id));
    };

    return {
        async startInterview({ session, actor, command, body, language, focus }) {
            // only the facilitator: asked first, so that nothing is sent for a refused start
            if (actor.role !== 'Facilitator') return err({ type: 'FacilitatorOnly' });
            return uow.transaction(async (stores) => {
                if (runningInterview(stores.interviews.listBySession(session))) return err({ type: 'InterviewAlreadyRunning' });
                const sent = await sendIn(stores, { clock, ids }, { session, actor, targets: [], body });
                if (!sent.ok) return sent;
                const active = await storeVerifications(stores).makeActiveSession(session);
                if (!active.ok) return active;
                const at = clock.now();
                const started = interviewCommands.start({
                    id: knownInterviewId(ids.newId()),
                    session: active.value,
                    command,
                    startedBy: actor.participant,
                    startedByRole: actor.role,
                    opening: sent.value.id,
                    focus,
                    language,
                    startedAt: at,
                });
                if (!started.ok) return started;
                stores.interviews.save(started.value.Asking.aggregate);
                publish(stores, session, started.value.Asking.events, at);
                return ok({ interview: started.value.Asking.aggregate, request: sent.value });
            });
        },

        async askInInterview({ interview, answered, question }) {
            return uow.transaction(async (stores) => {
                const found = load(stores, interview);
                if (!found.ok) return found;
                const i = found.value;
                if (i.state !== 'Asking') return err(notAllowed('ask', i.state));
                const active = await storeVerifications(stores).makeActiveSession(i.session);
                if (!active.ok) return active;
                const at = clock.now();
                const id = knownRequestId(ids.newId());
                // the interview first: a question to a message it no longer waits for writes nothing
                const asked = interviewCommands.ask(i, { answered, question: id, askedAt: at });
                if (!asked.ok) return asked;
                const { Sent } = decided(requestCommands.answer({ id, session: active.value, answers: answered, body: question, sentAt: at }));
                stores.requests.save(Sent.aggregate);
                publish(stores, i.session, Sent.events, at);
                stores.interviews.save(asked.value.Asking.aggregate);
                publish(stores, i.session, asked.value.Asking.events, at);
                return ok({ question: Sent.aggregate, interview: asked.value.Asking.aggregate });
            });
        },

        async briefInterview({ interview, answered, brief }) {
            return uow.transaction(async (stores) => {
                const found = load(stores, interview);
                if (!found.ok) return found;
                const i = found.value;
                if (i.state !== 'Asking') return err(notAllowed('summarize', i.state));
                const active = await storeVerifications(stores).makeActiveSession(i.session);
                if (!active.ok) return active;
                const at = clock.now();
                const briefed = interviewCommands.summarize(i, { answered, summary: brief, briefedAt: at });
                if (!briefed.ok) return briefed;
                stores.interviews.save(briefed.value.Briefed.aggregate);
                publish(stores, i.session, briefed.value.Briefed.events, at);
                return ok(briefed.value.Briefed.aggregate);
            });
        },

        async confirmInterview({ interview, actor, text }) {
            return uow.transaction(async (stores) => {
                const found = load(stores, interview);
                if (!found.ok) return found;
                const i = found.value;
                if (i.state !== 'Briefed') return err(notAllowed('confirm', i.state));
                if (actor.participant !== i.startedBy) return err({ type: 'NotTheInterviewer' });
                const active = await storeVerifications(stores).makeActiveSession(i.session);
                if (!active.ok) return active;
                const at = clock.now();
                const edited = text !== undefined && text !== i.brief.text;
                const brief: Collaboration.InterviewBrief = edited ? { ...i.brief, text } : i.brief;
                const run = await queueRequests(stores, ids, {
                    session: active.value,
                    requests: [i.answered],
                    extra: { brief: { interview: i.id, command: i.command, brief } },
                    queuedBy: actor.participant,
                    queuedByRole: actor.role,
                    at,
                });
                if (!run.ok) return run;
                const confirmed = interviewCommands.confirm(i, {
                    confirmedBy: actor.participant,
                    confirmedBrief: brief,
                    edited,
                    run: run.value.id,
                    confirmedAt: at,
                });
                if (!confirmed.ok) return confirmed;
                stores.interviews.save(confirmed.value.Confirmed.aggregate);
                publish(stores, i.session, confirmed.value.Confirmed.events, at);
                return ok({ interview: confirmed.value.Confirmed.aggregate, run: run.value });
            });
        },

        async stopInterview({ interview, actor }) {
            return uow.transaction(async (stores) => {
                const found = load(stores, interview);
                if (!found.ok) return found;
                const i = found.value;
                if (!isRunning(i)) return err(notAllowed('stop', i.state));
                const active = await storeVerifications(stores).makeActiveSession(i.session);
                if (!active.ok) return active;
                const at = clock.now();
                const stopped = interviewCommands.stop(i, { stoppedBy: actor.participant, stoppedAt: at });
                if (!stopped.ok) return stopped;
                stores.interviews.save(stopped.value.Stopped.aggregate);
                publish(stores, i.session, stopped.value.Stopped.events, at);
                return ok(stopped.value.Stopped.aggregate);
            });
        },

        async interviewJobs({ session }) {
            return uow.transaction((stores) => {
                const found = stores.sessions.load(session);
                if (!found) return err(notFound('Session', session));
                if (found.state !== 'Open') return ok([]);
                const jobs: InterviewJob[] = [];
                const requests = stores.requests.listBySession(session);
                for (const interview of stores.interviews.listBySession(session)) {
                    const awaited = awaitedMessage(interview);
                    if (interview.state !== 'Asking' || !awaited) continue;
                    const request = requests.find((r) => r.id === awaited);
                    if (!request) continue;
                    const transcript = interviewMessages(interview, requests);
                    jobs.push({ kind: 'interview', interview, request, transcript: transcript.slice(0, transcript.findIndex((r) => r.id === awaited) + 1) });
                }
                return ok(jobs);
            });
        },
    };
}

/** The success value of a command that cannot fail. */
function decided<T>(r: Result<T, never>): T {
    if (!r.ok) throw new Error('A command without errors returned one');
    return r.value;
}
