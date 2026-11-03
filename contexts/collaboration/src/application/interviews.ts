// The use cases of the `/` commands' interviews (the plan's "`/` commands: ways of working with the AI", round 5): start
// one (anyone), the interviewer's question or brief (the answerer role, through the agent API), confirm the brief (the
// facilitator, as is or with its why edited; the approval of a participant's brief: dt writes the journey file, and a
// run is queued only to create a new storming's block) or reject it,
// stop one (its starter or the facilitator), and the interview jobs that wait for the interviewer. The starter's messages are heard by the interview in `sendMessage` (`hearIn`), without triage.
// As the other use cases: the aggregates loaded and saved in one transaction with their events, the commands deciding.
import { Collaboration, err, ok, type Result } from '../generated/index.js';
import { requestCommands } from '../domain/commands.js';
import { knownInterviewId, knownRequestId } from '../domain/ids.js';
import { awaitedMessage, interviewCommands, interviewMessages, isRunning, runningInterview, withEditedText } from '../domain/interviews.js';
import { applyBrief, type JourneyActError } from '../domain/journey.js';
import { sessionCommands } from '../domain/commands.js';
import { journeyKeyOf, updateJourneys, type JourneyWriteError } from './journeys.js';
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

/** A brief's text edited so that its why cannot be read back (a line without a known head, no purpose). */
export interface InvalidBriefText {
    readonly type: 'InvalidBriefText';
    readonly path: string;
    readonly message: string;
}

type QueueError = FreezeError | Collaboration.FacilitatorOnly | Collaboration.DuplicateRequest | Collaboration.InputMismatch;

export interface InterviewUseCases {
    /**
     * Starts an interview (`/es`, `/model`): the starter's opening message (the command's name), sent without triage, and
     * the interview waiting for the interviewer's first question. Anyone; one running interview per session
     * (`InterviewAlreadyRunning`).
     */
    startInterview(input: {
        readonly session: SessionId;
        readonly actor: Actor;
        readonly command: Collaboration.InterviewCommand;
        readonly body: Collaboration.Text;
        readonly language: Collaboration.UiLanguage;
        readonly focus?: Collaboration.ModelTarget;
        /** Where the starter was looking: kept on the opening message. */
        readonly viewedAt?: Collaboration.ViewedAt;
    }): Promise<
        Result<InterviewStarted, SendMessageError | Collaboration.InterviewAlreadyRunning | Collaboration.SessionNotFound | Collaboration.SessionAlreadyClosed>
    >;
    /**
     * The interviewer's next question: a message of the AI replying to the message it answers. Its choices (none, or two
     * to six; `multiple` when several make one answer) are kept on the interview until its starter answers.
     */
    askInInterview(input: {
        readonly interview: InterviewId;
        readonly answered: Collaboration.RequestId;
        readonly question: Collaboration.Text;
        readonly choices?: readonly Collaboration.AnswerChoice[];
        readonly multiple?: boolean;
    }): Promise<
        Result<
            { readonly question: Collaboration.SentRequest; readonly interview: Collaboration.AskingInterview },
            NotFound | NotAllowed | Collaboration.InterviewMovedOn | Collaboration.SessionNotFound | Collaboration.SessionAlreadyClosed
        >
    >;
    /** The interviewer's brief: the interview waits for the facilitator to confirm it (or edit, or reject it). */
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
     * The facilitator confirms the brief, as is or with its why edited (its text, read back by its heads) — for an
     * interview a participant started, that is the approval: dt writes the journey into the journey file (a storming's
     * ES journey, created or revised; a modeling journey, continued or new) and makes it the session's current journey.
     * Only a new storming queues a run (on the message the brief answered), to create its `storming` block with its
     * short description.
     */
    confirmInterview(input: {
        readonly interview: InterviewId;
        readonly actor: Actor;
        readonly text?: Collaboration.BriefText;
    }): Promise<
        Result<
            { readonly interview: Collaboration.ConfirmedInterview; readonly run?: Collaboration.QueuedAgentRun; readonly journey: string },
            | NotFound
            | NotAllowed
            | Collaboration.SessionNotFound
            | Collaboration.SessionAlreadyClosed
            | QueueError
            | InvalidBriefText
            | JourneyActError
            | JourneyWriteError
        >
    >;
    /** The facilitator rejects the brief (却下), with an optional note to its starter: the interview ends. */
    rejectInterview(input: {
        readonly interview: InterviewId;
        readonly actor: Actor;
        readonly note?: Collaboration.Text;
    }): Promise<
        Result<
            Collaboration.RejectedInterview,
            NotFound | NotAllowed | Collaboration.FacilitatorOnly | Collaboration.SessionNotFound | Collaboration.SessionAlreadyClosed
        >
    >;
    /** Its starter or the facilitator stops it (中止), asking or with its brief waiting. */
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
        async startInterview({ session, actor, command, body, language, focus, viewedAt }) {
            return uow.transaction(async (stores) => {
                if (runningInterview(stores.interviews.listBySession(session))) return err({ type: 'InterviewAlreadyRunning' });
                const sent = await sendIn(stores, { clock, ids }, { session, actor, targets: [], body, ...(viewedAt && { viewedAt }) });
                if (!sent.ok) return sent;
                const active = await storeVerifications(stores).makeActiveSession(session);
                if (!active.ok) return active;
                const at = clock.now();
                const started = interviewCommands.start({
                    id: knownInterviewId(ids.newId()),
                    session: active.value,
                    command,
                    startedBy: actor.participant,
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

        async askInInterview({ interview, answered, question, choices = [], multiple = false }) {
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
                const asked = interviewCommands.ask(i, {
                    answered,
                    question: { question: id, choices, multiple: choices.length > 0 && multiple },
                    askedAt: at,
                });
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
            // the brief as confirmed, checked first (nothing written while the interview could not be confirmed)
            type Checked = { readonly i: Collaboration.BriefedInterview; readonly brief: Collaboration.InterviewBrief; readonly edited: boolean };
            const checked = await uow.transaction(
                async (
                    stores,
                ): Promise<
                    Result<
                        Checked,
                        | NotFound
                        | NotAllowed
                        | Collaboration.FacilitatorOnly
                        | Collaboration.SessionNotFound
                        | Collaboration.SessionAlreadyClosed
                        | InvalidBriefText
                    >
                > => {
                    const found = load(stores, interview);
                    if (!found.ok) return found;
                    const i = found.value;
                    if (i.state !== 'Briefed') return err(notAllowed('confirm', i.state));
                    if (actor.role !== 'Facilitator') return err({ type: 'FacilitatorOnly' as const });
                    const active = await storeVerifications(stores).makeActiveSession(i.session);
                    if (!active.ok) return active;
                    const edited = text !== undefined && text !== i.brief.text;
                    if (!edited) return ok({ i, brief: i.brief, edited });
                    const read = withEditedText(i.brief, text);
                    if (!read.ok) return err({ type: 'InvalidBriefText' as const, ...read.error });
                    return ok({ i, brief: read.value, edited });
                },
            );
            if (!checked.ok) return checked;
            const { i, brief, edited } = checked.value;
            // dt writes the journey itself: no AI run for the brief
            const written = await updateJourneys<string, JourneyActError>(deps.journeys, (file) => {
                const applied = applyBrief(file, i.command, brief);
                return applied.ok ? ok({ file: applied.value.file, value: applied.value.key }) : applied;
            });
            if (!written.ok) return written;
            const journey = written.value.value;
            return uow.transaction(async (stores) => {
                const found = load(stores, interview);
                if (!found.ok) return found;
                const now = found.value;
                if (now.state !== 'Briefed') return err(notAllowed('confirm', now.state));
                const active = await storeVerifications(stores).makeActiveSession(now.session);
                if (!active.ok) return active;
                const at = clock.now();
                // a new storming still needs a run to create its block (its `///`: the short description only)
                let run: Collaboration.QueuedAgentRun | undefined;
                if (now.command === 'Es' && brief.isNew) {
                    const queued = await queueRequests(stores, ids, {
                        session: active.value,
                        requests: [now.answered],
                        extra: { brief: { interview: now.id, command: now.command, brief } },
                        queuedBy: actor.participant,
                        queuedByRole: actor.role,
                        at,
                    });
                    if (!queued.ok) return queued;
                    run = queued.value;
                }
                const confirmed = interviewCommands.confirm(now, {
                    confirmedBy: actor.participant,
                    confirmedByRole: actor.role,
                    confirmedBrief: brief,
                    edited,
                    run: run?.id,
                    confirmedAt: at,
                });
                if (!confirmed.ok) return confirmed;
                stores.interviews.save(confirmed.value.Confirmed.aggregate);
                publish(stores, now.session, confirmed.value.Confirmed.events, at);
                // the journey just written is the one the session works on now
                const session = stores.sessions.load(now.session);
                const key = journeyKeyOf(journey);
                if (session?.state === 'Open' && key && session.currentJourney !== key) {
                    const chosen = sessionCommands.chooseJourney(session, { journey: key, chosenByRole: actor.role, chosenAt: at });
                    if (chosen.ok) {
                        stores.sessions.save(chosen.value.Open.aggregate);
                        publish(stores, now.session, chosen.value.Open.events, at);
                    }
                }
                return ok({ interview: confirmed.value.Confirmed.aggregate, ...(run && { run }), journey });
            });
        },

        async rejectInterview({ interview, actor, note }) {
            return uow.transaction(async (stores) => {
                const found = load(stores, interview);
                if (!found.ok) return found;
                const i = found.value;
                if (i.state !== 'Briefed') return err(notAllowed('reject', i.state));
                const active = await storeVerifications(stores).makeActiveSession(i.session);
                if (!active.ok) return active;
                const at = clock.now();
                const rejected = interviewCommands.reject(i, { rejectedBy: actor.participant, rejectedByRole: actor.role, note, rejectedAt: at });
                if (!rejected.ok) return rejected;
                stores.interviews.save(rejected.value.Rejected.aggregate);
                publish(stores, i.session, rejected.value.Rejected.events, at);
                return ok(rejected.value.Rejected.aggregate);
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
                const stopped = interviewCommands.stop(i, { stoppedBy: actor.participant, stoppedByRole: actor.role, stoppedAt: at });
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
