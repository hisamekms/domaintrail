// The use cases of who talks to the AI (ADR 0030; the plan's "Who talks to the AI", "Triage" and "The session so far"):
// the session's mode (decision 13), messages addressed to the AI and their triage, the AI's answers, change proposals,
// and what the agents are given about the session. As the other use cases (`use-cases.ts`): domain values made here,
// the aggregates loaded and saved in one transaction with their events, the commands deciding.
//
// Who may act: a person through the `Actor` this application built (the facilitator's rescue 「AI に送る」, approving
// and rejecting proposals, withdrawing one's own); the server and the agent's answerer role through the use cases that
// take no actor (a stage's verdict, an override, an answer, a proposal) — the agent API (M4) authenticates them.
import { Collaboration, err, ok, type Result } from '../generated/index.js';
import { isAi } from '../domain/ai.js';
import { requestCommands, sessionCommands } from '../domain/commands.js';
import { knownChangeProposalId, knownRequestId, knownTriageId } from '../domain/ids.js';
import { sessionOpening } from '../domain/modes.js';
import { instructionOf, proposalCommands, recommendedOption } from '../domain/proposals.js';
import { REPLY_LIMITS } from '../domain/reply.js';
import { sessionSoFar, type SessionSoFar, type TimelineRecords } from '../domain/timeline.js';
import {
    addressing,
    answerJobOf,
    confidence,
    MECHANICAL_REASONS,
    mechanicalVerdict,
    milliseconds,
    triageCommands,
    triageRoute,
    type TriageRoute,
} from '../domain/triage.js';
import type { ElementChanges } from '../domain/changes.js';
import { notAllowed, notFound, type InvalidTarget, type NotAllowed, type NotAParticipant, type NotFound } from './errors.js';
import type { Actor } from './actor.js';
import type { CollaborationDeps, Stores } from './ports.js';
import { publish, queueRequests, type FreezeError, type NoRequests } from './queueing.js';
import { storeVerifications } from './verifications.js';
import { hearIn } from './interviews.js';

type SessionId = Collaboration.SessionId;
type TriageId = Collaboration.TriageId;

/** A stage's answer as the server or the agent gives it, before it is made a `TriageStep`. */
export interface TriageStepInput {
    readonly stage: Collaboration.TriageStage;
    readonly verdict: Collaboration.TriageVerdict;
    /** 0–1: Clef's probability, the model's confidence. */
    readonly confidence?: number;
    /** Why (the model's or the agent's words; stage 1's rule): cut to `MAX_TRIAGE_REASON` characters. */
    readonly reason?: string;
    readonly model?: string;
    readonly durationMs: number;
    /** Why the stage failed or timed out (its verdict is then unknown). */
    readonly error?: string;
}

/** The most characters of a step's reason and error kept. */
export const MAX_TRIAGE_REASON = 500;

/** A step's input that is not one (a confidence out of 0–1, an error with a verdict). */
export interface InvalidTriageInput {
    readonly type: 'InvalidTriageInput';
    readonly message: string;
}

/** The AI's answer is longer than `REPLY_LIMITS.answer` characters. */
export interface AnswerTooLong {
    readonly type: 'AnswerTooLong';
    readonly limit: number;
}

/** What a triage's progress led to: the triage now, where it goes, and the run or proposal made for it, if any. */
export interface TriageProgress {
    readonly triage: Collaboration.Triage;
    /** Where it goes once decided (`none` while pending). */
    readonly route: TriageRoute;
    /** The run queued for it (a 依頼 that goes straight to the queue). */
    readonly run?: Collaboration.QueuedAgentRun;
    /** The proposal written for it (an answerer's override that came with one). */
    readonly proposal?: Collaboration.OpenChangeProposal;
}

/** A message sent, and its triage when it is addressed to the AI, or the interview of its author that heard it. */
export interface MessageSent {
    readonly request: Collaboration.SentRequest;
    readonly triage?: Collaboration.Triage;
    readonly interview?: Collaboration.AskingInterview;
}

/** How a session was opened (decision 13): started anew, resumed, or a Solo session continued as a Collab one. */
export interface SessionOpened {
    readonly session: Collaboration.OpenSession;
    readonly opened: 'started' | 'resumed' | 'collaborated';
    /** The first revision of a session started now. */
    readonly revision?: Collaboration.RecordedRevision;
}

/** A job the answerer role waits for (`/agent/answers/events`, M4): the triage, and the message it is about. */
export interface AnswerJob {
    readonly kind: 'triage' | 'answer' | 'propose';
    readonly triage: Collaboration.Triage;
    readonly request: Collaboration.Request;
}

/** Approved proposals and the run they were queued as. */
export interface ProposalsApproved {
    readonly run: Collaboration.QueuedAgentRun;
    readonly proposals: readonly Collaboration.ApprovedChangeProposal[];
}

export type SendMessageError =
    | Collaboration.SessionNotFound
    | Collaboration.SessionAlreadyClosed
    | NotAParticipant
    | Collaboration.RunNotFound
    | Collaboration.RunOfAnotherSession
    | Collaboration.RunNotReplyable
    | Collaboration.RequestNotFound
    | Collaboration.RequestOfAnotherSession
    | Collaboration.MentionedNotAParticipant
    | Collaboration.TooManyMentions
    | Collaboration.DuplicateMention
    | InvalidTarget
    | Collaboration.TooManyTargets
    | Collaboration.DuplicateTarget
    | Collaboration.WorkspaceTarget;

type QueueError = FreezeError | Collaboration.FacilitatorOnly | Collaboration.DuplicateRequest | Collaboration.InputMismatch;

export interface ConversationUseCases {
    /**
     * Opens the workspace's session in `mode` (decision 13): starts one when none is open; resumes an open one of the same
     * mode; continues an open Solo session as a Collab one (`dt collab`: its person stays the facilitator, its history
     * stays); refuses a Solo session while a Collab one is open (`CollabSessionOpen`: resume it with `dt collab`, or end it).
     */
    openSession(input: {
        readonly mode: Collaboration.SessionMode;
        readonly facilitator: Collaboration.ParticipantId;
        readonly name: Collaboration.DisplayName;
    }): Promise<Result<SessionOpened, Collaboration.CollabSessionOpen | Collaboration.PathOutsideRoot>>;
    /**
     * Sends a message of the actor (as `sendRequest`), and opens its triage when it is addressed to the AI (`addressing`:
     * every message in Solo; a mention of the AI or a reply to the AI in Collab), with stage 1 (mechanical) recorded.
     * While an interview of the actor runs (`/es`, `/model`), their message goes to it instead, without triage.
     */
    sendMessage(input: {
        readonly session: SessionId;
        readonly actor: Actor;
        readonly targets: readonly Collaboration.TargetSnapshot[];
        readonly body: Collaboration.Text;
        readonly replyTo?: Collaboration.ReplyTarget;
        readonly mentions?: readonly Collaboration.ParticipantId[];
        /** Where the sender was looking (its names already checked against the workspace). */
        readonly viewedAt?: Collaboration.ViewedAt;
    }): Promise<Result<MessageSent, SendMessageError>>;
    /**
     * The facilitator's 「AI に送る」 (one message or several): each message, not addressed yet, gets a triage addressed by
     * the facilitator (stage 1 recorded); a message whose triage judged it "neither" is addressed again, skipping the
     * cascade as 相談 (plan Q6). Refused for anyone else, for the AI's own messages and reverts, and for a message whose
     * triage is pending or decided otherwise (`RequestAlreadyAddressed`).
     */
    addressMessages(input: {
        readonly session: SessionId;
        readonly actor: Actor;
        readonly requests: readonly Collaboration.RequestId[];
    }): Promise<
        Result<
            readonly Collaboration.Triage[],
            | Collaboration.FacilitatorOnly
            | Collaboration.SessionNotFound
            | Collaboration.SessionAlreadyClosed
            | Collaboration.RequestNotFound
            | Collaboration.RequestOfAnotherSession
            | Collaboration.RequestNotAddressable
            | Collaboration.RequestAlreadyAddressed
            | NoRequests
        >
    >;
    /**
     * Records a cascade stage's verdict (stage 2 by the server, stage 3 by the answerer role). Once decided, a 依頼 that
     * goes to the queue (the facilitator's, a Solo session's, one the facilitator addressed) is queued as a run in the same
     * transaction; the rest is told by `route` (an answer job, a propose job, nothing).
     */
    recordTriageStep(input: {
        readonly triage: TriageId;
        readonly step: TriageStepInput;
    }): Promise<
        Result<
            TriageProgress,
            | NotFound
            | NotAllowed
            | InvalidTriageInput
            | Collaboration.InvalidTriageStep
            | Collaboration.TriageStepOutOfOrder
            | Collaboration.SessionNotFound
            | Collaboration.SessionAlreadyClosed
            | QueueError
        >
    >;
    /**
     * An agent's correction of a decided triage (decision 18): the answerer turns a 相談 into a 依頼 (with its proposal,
     * when the requester is a participant; queued at once when it goes to the queue) or into "neither"; the runner turns
     * a 依頼 into a 相談 (its run answered instead of editing).
     */
    overrideTriage(input: {
        readonly triage: TriageId;
        readonly step: TriageStepInput;
        readonly proposal?: Collaboration.ProposalContent;
    }): Promise<
        Result<
            TriageProgress,
            | NotFound
            | NotAllowed
            | InvalidTriageInput
            | Collaboration.TriageNotOverridable
            | Collaboration.SessionNotFound
            | Collaboration.SessionAlreadyClosed
            | Collaboration.TriageNotFound
            | Collaboration.TriageOfAnotherSession
            | Collaboration.TriageNotProposable
            | QueueError
        >
    >;
    /**
     * The read-only answerer's answer to a 相談: written as a message of the AI replying to the addressed message, and the
     * triage concluded with it (and the revision the answerer read, when given). No revision is recorded.
     */
    answerMessage(input: {
        readonly triage: TriageId;
        readonly body: Collaboration.Text;
        readonly readRevision?: Collaboration.RevisionId;
    }): Promise<
        Result<
            { readonly answer: Collaboration.SentRequest; readonly triage: Collaboration.DecidedTriage },
            | NotFound
            | NotAllowed
            | AnswerTooLong
            | Collaboration.SessionNotFound
            | Collaboration.SessionAlreadyClosed
            | Collaboration.TriageAlreadyConcluded
            | Collaboration.TriageNotConcludable
        >
    >;
    /** The answerer's change proposal for a participant's 依頼 (a propose job): the proposal, and the triage concluded with it. */
    proposeChange(input: {
        readonly triage: TriageId;
        readonly content: Collaboration.ProposalContent;
    }): Promise<
        Result<
            { readonly proposal: Collaboration.OpenChangeProposal; readonly triage: Collaboration.DecidedTriage },
            | Collaboration.SessionNotFound
            | Collaboration.SessionAlreadyClosed
            | Collaboration.TriageNotFound
            | Collaboration.TriageOfAnotherSession
            | Collaboration.TriageNotProposable
        >
    >;
    /**
     * The facilitator approves open proposals of the session, each with one of its options when it has options (its
     * recommended one when none is given) and as is or with its how edited: together they are one run queued with the
     * proposals' messages and the approved instructions (plan Q2); one at a time, separate runs.
     */
    approveProposals(input: {
        readonly session: SessionId;
        readonly actor: Actor;
        readonly proposals: readonly {
            readonly proposal: Collaboration.ChangeProposalId;
            readonly option?: Collaboration.ProposalOptionIndex;
            readonly editedHow?: Collaboration.ProposalText;
        }[];
        readonly note?: Collaboration.Text;
    }): Promise<
        Result<
            ProposalsApproved,
            | NotFound
            | NotAllowed
            | NoRequests
            | Collaboration.FacilitatorOnly
            | Collaboration.NoSuchOption
            | Collaboration.SessionNotFound
            | Collaboration.SessionAlreadyClosed
            | QueueError
        >
    >;
    /** The facilitator rejects an open proposal, with an optional note to its requester. */
    rejectProposal(input: {
        readonly proposal: Collaboration.ChangeProposalId;
        readonly actor: Actor;
        readonly note?: Collaboration.Text;
    }): Promise<
        Result<
            Collaboration.RejectedChangeProposal,
            NotFound | NotAllowed | Collaboration.FacilitatorOnly | Collaboration.SessionNotFound | Collaboration.SessionAlreadyClosed
        >
    >;
    /** The requester withdraws their open proposal. */
    withdrawProposal(input: {
        readonly proposal: Collaboration.ChangeProposalId;
        readonly actor: Actor;
    }): Promise<
        Result<
            Collaboration.WithdrawnChangeProposal,
            NotFound | NotAllowed | Collaboration.NotTheRequester | Collaboration.SessionNotFound | Collaboration.SessionAlreadyClosed
        >
    >;
    /** The jobs the answerer role waits for in the session, in the order the triages were opened. */
    answerJobs(input: { readonly session: SessionId }): Promise<Result<readonly AnswerJob[], NotFound>>;
    /**
     * The session so far as an agent gets it (`domain/timeline.ts`): the newest entries in full, older ones a line each,
     * what is open now; `since` (a warm agent's last entry) gives only the entries after it. The elements the latest
     * changing turns changed are measured (`modelChanges`); older turns are told by their files.
     */
    sessionSoFar(input: {
        readonly session: SessionId;
        readonly since?: number;
        readonly full?: number;
        readonly lines?: number;
    }): Promise<Result<SessionSoFar, NotFound>>;
}

/** What this module needs of the other use cases. */
export interface ConversationNeeds {
    readonly startSession: (input: {
        readonly facilitator: Collaboration.ParticipantId;
        readonly name: Collaboration.DisplayName;
        readonly mode?: Collaboration.SessionMode;
    }) => Promise<Result<{ readonly session: Collaboration.OpenSession; readonly revision: Collaboration.RecordedRevision }, Collaboration.PathOutsideRoot>>;
    readonly modelChanges: (input: {
        readonly session: SessionId;
        readonly before: Collaboration.RevisionId;
        readonly after: Collaboration.RevisionId;
    }) => Promise<Result<ElementChanges, unknown>>;
}

/** How many of the latest turns that changed files the timeline tells by their elements (measured; older by files). */
const MEASURED_TURNS = 30;

/** A step's input as the model's `TriageStep`, or why it is not one. */
function stepOf(input: TriageStepInput, at: Date): Result<Collaboration.TriageStep, InvalidTriageInput> {
    const text = (s: string | undefined): Collaboration.Text | undefined => {
        const t = s?.trim().slice(0, MAX_TRIAGE_REASON);
        if (!t) return undefined;
        const made = Collaboration.makeText(t);
        return made.ok ? made.value : undefined;
    };
    const c = input.confidence === undefined ? undefined : confidence(input.confidence);
    if (input.confidence !== undefined && c === undefined) return err({ type: 'InvalidTriageInput', message: 'A confidence is a number from 0 to 1.' });
    const error = text(input.error);
    if (error && input.verdict !== 'Unknown') return err({ type: 'InvalidTriageInput', message: 'A stage that failed answers Unknown.' });
    const reason = text(input.reason);
    const model = input.model?.trim().slice(0, 200);
    const step: Collaboration.TriageStep = {
        stage: input.stage,
        verdict: input.verdict,
        ...(c !== undefined && { confidence: c }),
        ...(reason && { reason }),
        ...(model && { model }),
        durationMs: milliseconds(input.durationMs),
        ...(error && { error }),
        at,
    };
    return ok(step);
}

/** Stage 1 for a message: its step (no time to speak of; the rule as its reason). */
function mechanicalStep(body: string, at: Date): Collaboration.TriageStep {
    const v = mechanicalVerdict(body);
    const reason = v.verdict === 'NotForAi' ? Collaboration.makeText(MECHANICAL_REASONS[v.rule]) : undefined;
    return {
        stage: 'Mechanical',
        verdict: v.verdict,
        ...(reason?.ok && { reason: reason.value }),
        durationMs: milliseconds(0),
        at,
    };
}

export function createConversation(deps: CollaborationDeps, needs: ConversationNeeds): ConversationUseCases {
    const { uow, clock, ids } = deps;

    /** The route of a decided triage, from its session and message. */
    const routeOf = (stores: Stores, triage: Collaboration.Triage): TriageRoute => {
        if (triage.state === 'Pending') return 'none';
        const session = stores.sessions.load(triage.session);
        const request = stores.requests.load(triage.request);
        if (!session || !request) return 'none';
        return triageRoute(triage, { mode: session.mode, authorIsFacilitator: request.author === session.facilitator });
    };

    /** Opens a triage for an addressable message, with stage 1 recorded; saved and published. */
    const openTriage = (
        stores: Stores,
        args: {
            readonly session: Collaboration.ActiveSession;
            readonly request: Collaboration.AddressableRequest;
            readonly body: string;
            readonly addressedBy: Collaboration.AddressedBy;
            readonly by: Collaboration.ParticipantId;
            readonly at: Date;
        },
    ): Collaboration.Triage => {
        const { Pending } = decided(
            triageCommands.open({
                id: knownTriageId(ids.newId()),
                session: args.session,
                request: args.request,
                addressedBy: args.addressedBy,
                addressedByParticipant: args.by,
                openedAt: args.at,
            }),
        );
        publish(stores, args.session, Pending.events, args.at);
        const recorded = triageCommands.record(Pending.aggregate, { step: mechanicalStep(args.body, args.at), recordedAt: args.at });
        // stage 1 is first and answers only NotForAi or Unknown
        if (!recorded.ok) throw new Error(`Recording stage 1 failed: ${recorded.error.type}`);
        const outcome = recorded.value.Decided ?? recorded.value.Pending;
        stores.triages.save(outcome.aggregate);
        publish(stores, args.session, outcome.events, args.at);
        return outcome.aggregate;
    };

    /** A decided triage that goes to the queue: its run queued (by the facilitator) and the triage concluded with it. */
    const queueIfRouted = async (
        stores: Stores,
        triage: Collaboration.DecidedTriage,
        at: Date,
    ): Promise<
        Result<
            { triage: Collaboration.Triage; route: TriageRoute; run?: Collaboration.QueuedAgentRun },
            QueueError | Collaboration.SessionNotFound | Collaboration.SessionAlreadyClosed
        >
    > => {
        const route = routeOf(stores, triage);
        if (route !== 'queue' || triage.outcome !== undefined) return ok({ triage, route });
        const active = await storeVerifications(stores).makeActiveSession(triage.session);
        if (!active.ok) return active;
        const session = stores.sessions.load(triage.session);
        if (!session) throw new Error(`Session ${triage.session} is gone`);
        // the facilitator's own request, a Solo session's (its one person is the facilitator), or a message the
        // facilitator addressed (the sending is the approval, plan Q3)
        const run = await queueRequests(stores, ids, {
            session: active.value,
            requests: [triage.request],
            queuedBy: session.facilitator,
            queuedByRole: 'Facilitator',
            at,
        });
        if (!run.ok) return run;
        const concluded = triageCommands.conclude(triage, { to: { kind: 'Run', run: run.value.id }, concludedAt: at });
        if (!concluded.ok) throw new Error(`Concluding triage ${triage.id} failed: ${concluded.error.type}`);
        stores.triages.save(concluded.value.Decided.aggregate);
        publish(stores, triage.session, concluded.value.Decided.events, at);
        return ok({ triage: concluded.value.Decided.aggregate, route, run: run.value });
    };

    /** Writes a proposal for a triage that may have one, and concludes the triage with it. */
    const propose = async (
        stores: Stores,
        triage: Collaboration.DecidedTriage,
        content: Collaboration.ProposalContent,
        at: Date,
    ): Promise<
        Result<
            { proposal: Collaboration.OpenChangeProposal; triage: Collaboration.DecidedTriage },
            | Collaboration.SessionNotFound
            | Collaboration.SessionAlreadyClosed
            | Collaboration.TriageNotFound
            | Collaboration.TriageOfAnotherSession
            | Collaboration.TriageNotProposable
        >
    > => {
        const verify = storeVerifications(stores);
        const active = await verify.makeActiveSession(triage.session);
        if (!active.ok) return active;
        const proposable = await verify.makeProposableTriage(triage.id, triage.session);
        if (!proposable.ok) return proposable;
        const request = stores.requests.load(triage.request);
        if (!request) throw new Error(`The message of triage ${triage.id} is gone`);
        const { Open } = decided(
            proposalCommands.propose({
                id: knownChangeProposalId(ids.newId()),
                session: active.value,
                triage: proposable.value,
                request: request.id,
                requestedBy: request.author,
                content,
                proposedAt: at,
            }),
        );
        stores.proposals.save(Open.aggregate);
        publish(stores, triage.session, Open.events, at);
        const concluded = triageCommands.conclude(triage, { to: { kind: 'Proposal', proposal: Open.aggregate.id }, concludedAt: at });
        if (!concluded.ok) throw new Error(`Concluding triage ${triage.id} failed: ${concluded.error.type}`);
        stores.triages.save(concluded.value.Decided.aggregate);
        publish(stores, triage.session, concluded.value.Decided.events, at);
        return ok({ proposal: Open.aggregate, triage: concluded.value.Decided.aggregate });
    };

    const loadTriage = (stores: Stores, id: TriageId): Result<Collaboration.Triage, NotFound> => {
        const t = stores.triages.load(id);
        return t ? ok(t) : err(notFound('Triage', id));
    };

    return {
        async openSession({ mode, facilitator, name }) {
            const current = await uow.transaction((stores) => stores.sessions.listOpen()[0]);
            switch (sessionOpening(current, mode)) {
                case 'start': {
                    const started = await needs.startSession({ facilitator, name, mode });
                    if (!started.ok) return started;
                    return ok({ session: started.value.session, opened: 'started', revision: started.value.revision });
                }
                case 'refuse':
                    return err({ type: 'Collaboration.CollabSessionOpen' });
                case 'resume':
                    if (!current) throw new Error('A session to resume is open');
                    return ok({ session: current, opened: 'resumed' });
                case 'collaborate':
                    return uow.transaction((stores) => {
                        const open = current && stores.sessions.load(current.id);
                        if (open?.state !== 'Open') throw new Error('The Solo session to continue is no longer open');
                        const at = clock.now();
                        const collaborated = sessionCommands.collaborate(open, { collaboratedAt: at });
                        if (!collaborated.ok) throw new Error(`Continuing session ${open.id} as Collab failed: ${collaborated.error.type}`);
                        stores.sessions.save(collaborated.value.Open.aggregate);
                        publish(stores, open.id, collaborated.value.Open.events, at);
                        return ok({ session: collaborated.value.Open.aggregate, opened: 'collaborated' });
                    });
            }
        },

        async sendMessage(input) {
            const invalid = invalidTargets(input.targets);
            if (invalid) return err(invalid);
            return uow.transaction(async (stores): Promise<Result<MessageSent, SendMessageError>> => {
                const sent = await sendIn(stores, { clock, ids }, input);
                if (!sent.ok) return sent;
                const request = sent.value;
                const session = stores.sessions.load(input.session);
                if (session?.state !== 'Open') return ok({ request });
                // the starter of a running interview answers it: no triage (a reply would come out "neither")
                const interview = hearIn(stores, request, clock.now());
                if (interview) return ok({ request, interview });
                const to = request.replyTo;
                const replyTo =
                    to === undefined
                        ? undefined
                        : to.kind === 'Run'
                          ? ({ kind: 'Run' } as const)
                          : { kind: 'Message' as const, author: stores.requests.load(to.request)?.author ?? '' };
                const addressedBy = addressing({ mode: session.mode, mentions: request.mentions, ...(replyTo && { replyTo }) });
                if (!addressedBy) return ok({ request });
                const verify = storeVerifications(stores);
                const active = await verify.makeActiveSession(input.session);
                const addressable = await verify.makeAddressableRequest(request.id, input.session);
                if (!active.ok || !addressable.ok) throw new Error(`The message ${request.id} just sent cannot be addressed`);
                const triage = openTriage(stores, {
                    session: active.value,
                    request: addressable.value,
                    body: request.body,
                    addressedBy,
                    by: request.author,
                    at: clock.now(),
                });
                return ok({ request, triage });
            });
        },

        async addressMessages({ session, actor, requests }) {
            if (actor.role !== 'Facilitator') return err({ type: 'Collaboration.FacilitatorOnly' });
            if (requests.length === 0) return err({ type: 'NoRequests' });
            return uow.transaction(async (stores) => {
                const verify = storeVerifications(stores);
                const active = await verify.makeActiveSession(session);
                if (!active.ok) return active;
                const at = clock.now();
                const triages: Collaboration.Triage[] = [];
                for (const id of new Set(requests)) {
                    const existing = stores.triages.ofRequest(id);
                    if (existing?.state === 'Decided' && existing.session === session && existing.kind === 'NotForAi') {
                        // plan Q6: judged "neither", sent again: 相談, as the facilitator's
                        const again = triageCommands.readdress(existing, { by: actor.participant, byRole: actor.role, readdressedAt: at });
                        if (!again.ok) return again;
                        stores.triages.save(again.value.Decided.aggregate);
                        publish(stores, session, again.value.Decided.events, at);
                        triages.push(again.value.Decided.aggregate);
                        continue;
                    }
                    const addressable = await verify.makeAddressableRequest(id, session);
                    if (!addressable.ok) return addressable;
                    const request = stores.requests.load(id);
                    if (!request) throw new Error(`Message ${id} is gone`);
                    triages.push(
                        openTriage(stores, {
                            session: active.value,
                            request: addressable.value,
                            body: request.body,
                            addressedBy: 'Facilitator',
                            by: actor.participant,
                            at,
                        }),
                    );
                }
                return ok(triages);
            });
        },

        async recordTriageStep({ triage, step }) {
            return uow.transaction(async (stores) => {
                const found = loadTriage(stores, triage);
                if (!found.ok) return found;
                const t = found.value;
                if (t.state !== 'Pending') return err(notAllowed('record', t.state));
                const active = await storeVerifications(stores).makeActiveSession(t.session);
                if (!active.ok) return active;
                const at = clock.now();
                const made = stepOf(step, at);
                if (!made.ok) return made;
                const recorded = triageCommands.record(t, { step: made.value, recordedAt: at });
                if (!recorded.ok) return recorded;
                const outcome = recorded.value.Decided ?? recorded.value.Pending;
                stores.triages.save(outcome.aggregate);
                publish(stores, t.session, outcome.events, at);
                if (outcome.aggregate.state === 'Pending') return ok({ triage: outcome.aggregate, route: 'none' });
                return queueIfRouted(stores, outcome.aggregate, at);
            });
        },

        async overrideTriage({ triage, step, proposal }) {
            return uow.transaction(async (stores) => {
                const found = loadTriage(stores, triage);
                if (!found.ok) return found;
                const t = found.value;
                if (t.state !== 'Decided') return err(notAllowed('override', t.state));
                const active = await storeVerifications(stores).makeActiveSession(t.session);
                if (!active.ok) return active;
                const at = clock.now();
                const made = stepOf(step, at);
                if (!made.ok) return made;
                const overridden = triageCommands.override(t, { step: made.value, overriddenAt: at });
                if (!overridden.ok) return overridden;
                const now = overridden.value.Decided.aggregate;
                stores.triages.save(now);
                publish(stores, t.session, overridden.value.Decided.events, at);
                const progressed = await queueIfRouted(stores, now, at);
                if (!progressed.ok) return progressed;
                if (progressed.value.route !== 'propose' || !proposal || progressed.value.triage.state !== 'Decided') return progressed;
                const proposed = await propose(stores, progressed.value.triage, proposal, at);
                if (!proposed.ok) return proposed;
                return ok({ triage: proposed.value.triage, route: 'propose', proposal: proposed.value.proposal });
            });
        },

        async answerMessage({ triage, body, readRevision }) {
            if (body.length > REPLY_LIMITS.answer) return err({ type: 'AnswerTooLong', limit: REPLY_LIMITS.answer });
            return uow.transaction(async (stores) => {
                const found = loadTriage(stores, triage);
                if (!found.ok) return found;
                const t = found.value;
                if (t.state !== 'Decided') return err(notAllowed('answer', t.state));
                if (readRevision !== undefined && stores.revisions.load(readRevision)?.session !== t.session) return err(notFound('Revision', readRevision));
                const active = await storeVerifications(stores).makeActiveSession(t.session);
                if (!active.ok) return active;
                const at = clock.now();
                const id = knownRequestId(ids.newId());
                const to: Collaboration.TriageOutcome = { kind: 'Answer', answer: id, ...(readRevision && { readRevision }) };
                // concluded first: an answer to what is not an open 相談 writes nothing
                const concluded = triageCommands.conclude(t, { to, concludedAt: at });
                if (!concluded.ok) return concluded;
                const { Sent } = decided(requestCommands.answer({ id, session: active.value, answers: t.request, body, sentAt: at }));
                stores.requests.save(Sent.aggregate);
                publish(stores, t.session, Sent.events, at);
                stores.triages.save(concluded.value.Decided.aggregate);
                publish(stores, t.session, concluded.value.Decided.events, at);
                return ok({ answer: Sent.aggregate, triage: concluded.value.Decided.aggregate });
            });
        },

        async proposeChange({ triage, content }) {
            return uow.transaction(async (stores) => {
                const t = stores.triages.load(triage);
                if (!t) return err({ type: 'Collaboration.TriageNotFound', triage });
                if (t.state !== 'Decided') return err({ type: 'Collaboration.TriageNotProposable', triage });
                return propose(stores, t, content, clock.now());
            });
        },

        async approveProposals({ session, actor, proposals, note }) {
            // approve and queue require the facilitator: asked first
            if (actor.role !== 'Facilitator') return err({ type: 'Collaboration.FacilitatorOnly' });
            if (proposals.length === 0) return err({ type: 'NoRequests' });
            return uow.transaction(async (stores) => {
                const active = await storeVerifications(stores).makeActiveSession(session);
                if (!active.ok) return active;
                const open: {
                    proposal: Collaboration.OpenChangeProposal;
                    option: Collaboration.ProposalOptionIndex | undefined;
                    editedHow: Collaboration.ProposalText | undefined;
                    instruction: Collaboration.ProposalInstruction;
                }[] = [];
                for (const { proposal, option: given, editedHow } of proposals) {
                    const p = stores.proposals.load(proposal);
                    if (!p || p.session !== session) return err(notFound('ChangeProposal', proposal));
                    if (p.state !== 'Open') return err(notAllowed('approve', p.state));
                    if (open.some((o) => o.proposal.id === p.id)) continue;
                    // no option given of a proposal with options: the one the AI recommends
                    const option = given ?? recommendedOption(p.content);
                    const instruction = instructionOf(p.content, option, editedHow);
                    if (!instruction) return err({ type: 'Collaboration.NoSuchOption' });
                    open.push({ proposal: p, option, editedHow, instruction });
                }
                const [first, ...rest] = open.map(({ proposal, instruction }) => ({ proposal: proposal.id, request: proposal.request, instruction }));
                if (!first) return err({ type: 'NoRequests' });
                const at = clock.now();
                const run = await queueRequests(stores, ids, {
                    session: active.value,
                    requests: [...new Set(open.map((o) => o.proposal.request))],
                    extra: { proposals: { approved: [first, ...rest] }, ...(note !== undefined && { note }) },
                    queuedBy: actor.participant,
                    queuedByRole: actor.role,
                    at,
                });
                if (!run.ok) return run;
                const approved: Collaboration.ApprovedChangeProposal[] = [];
                for (const { proposal, option, editedHow } of open) {
                    const a = proposalCommands.approve(proposal, {
                        approvedBy: actor.participant,
                        approvedByRole: actor.role,
                        option,
                        editedHow,
                        run: run.value.id,
                        approvedAt: at,
                    });
                    if (!a.ok) return a;
                    stores.proposals.save(a.value.Approved.aggregate);
                    publish(stores, session, a.value.Approved.events, at);
                    approved.push(a.value.Approved.aggregate);
                }
                return ok({ run: run.value, proposals: approved });
            });
        },

        async rejectProposal({ proposal, actor, note }) {
            return uow.transaction(async (stores) => {
                const p = stores.proposals.load(proposal);
                if (!p) return err(notFound('ChangeProposal', proposal));
                if (p.state !== 'Open') return err(notAllowed('reject', p.state));
                const active = await storeVerifications(stores).makeActiveSession(p.session);
                if (!active.ok) return active;
                const at = clock.now();
                const rejected = proposalCommands.reject(p, { rejectedBy: actor.participant, rejectedByRole: actor.role, note, rejectedAt: at });
                if (!rejected.ok) return rejected;
                stores.proposals.save(rejected.value.Rejected.aggregate);
                publish(stores, p.session, rejected.value.Rejected.events, at);
                return ok(rejected.value.Rejected.aggregate);
            });
        },

        async withdrawProposal({ proposal, actor }) {
            return uow.transaction(async (stores) => {
                const p = stores.proposals.load(proposal);
                if (!p) return err(notFound('ChangeProposal', proposal));
                if (p.state !== 'Open') return err(notAllowed('withdraw', p.state));
                const active = await storeVerifications(stores).makeActiveSession(p.session);
                if (!active.ok) return active;
                const at = clock.now();
                const withdrawn = proposalCommands.withdraw(p, { withdrawnBy: actor.participant, withdrawnAt: at });
                if (!withdrawn.ok) return withdrawn;
                stores.proposals.save(withdrawn.value.Withdrawn.aggregate);
                publish(stores, p.session, withdrawn.value.Withdrawn.events, at);
                return ok(withdrawn.value.Withdrawn.aggregate);
            });
        },

        async answerJobs({ session }) {
            return uow.transaction((stores) => {
                const found = stores.sessions.load(session);
                if (!found) return err(notFound('Session', session));
                const jobs: AnswerJob[] = [];
                for (const triage of stores.triages.listBySession(session)) {
                    const request = stores.requests.load(triage.request);
                    if (!request) continue;
                    const kind = answerJobOf(triage, { mode: found.mode, authorIsFacilitator: request.author === found.facilitator });
                    if (kind) jobs.push({ kind, triage, request });
                }
                return ok(jobs);
            });
        },

        async sessionSoFar({ session, since, full, lines }) {
            const records = await uow.transaction((stores): TimelineRecords | undefined => {
                const found = stores.sessions.load(session);
                if (!found) return undefined;
                return {
                    session: found,
                    requests: stores.requests.listBySession(session),
                    runs: stores.runs.listBySession(session),
                    revisions: stores.revisions.listBySession(session),
                    approvals: stores.approvals.listBySession(session),
                    proposals: stores.proposals.listBySession(session),
                    triages: stores.triages.listBySession(session),
                    interviews: stores.interviews.listBySession(session),
                    slashCommands: stores.slashCommands.listBySession(session),
                    records: stores.records.listBySession(session),
                };
            });
            if (!records) return err(notFound('Session', session));
            // the elements the latest turns that changed files changed (kept per pair of revisions by modelChanges)
            const elementChanges = new Map<string, string[]>();
            const changing = records.runs
                .filter((r) => 'resultRevision' in r && r.resultRevision !== undefined && r.resultRevision !== r.baseRevision)
                .slice(-MEASURED_TURNS);
            for (const run of changing) {
                if (!('resultRevision' in run) || !run.resultRevision || !run.baseRevision) continue;
                const c = await needs.modelChanges({ session, before: run.baseRevision, after: run.resultRevision });
                if (!c.ok) continue;
                elementChanges.set(
                    run.id,
                    c.value.changes.map((e) => `${e.language === 'Dt' ? e.element : `${e.storming}.${e.local}`} (${e.change})`),
                );
            }
            return ok(
                sessionSoFar(
                    { ...records, elementChanges },
                    { ...(since !== undefined && { since }), ...(full !== undefined && { full }), ...(lines !== undefined && { lines }) },
                ),
            );
        },
    };
}

/** The invariants of `TargetSnapshot` and `SourceRange` the targets break, as an error; `undefined` when they hold them. */
export function invalidTargets(targets: readonly Collaboration.TargetSnapshot[]): InvalidTarget | undefined {
    const violated = targets.flatMap((target) => [
        ...Collaboration.checkTargetSnapshot(target),
        ...(target.range ? Collaboration.checkSourceRange(target.range) : []),
    ]);
    return violated.length ? { type: 'InvalidTarget', violated } : undefined;
}

/**
 * Sends a message of the actor inside the caller's transaction: the session is open, the actor a participant (never
 * the AI: it writes only through `answerMessage`), what it replies to and whom it mentions verified.
 */
export async function sendIn(
    stores: Stores,
    deps: Pick<CollaborationDeps, 'clock' | 'ids'>,
    input: Parameters<ConversationUseCases['sendMessage']>[0],
): Promise<Result<Collaboration.SentRequest, SendMessageError>> {
    const { session, actor, targets, body, replyTo, mentions = [], viewedAt } = input;
    const author = actor.participant;
    const verify = storeVerifications(stores);
    const active = await verify.makeActiveSession(session);
    if (!active.ok) return active;
    if (isAi(author) || !stores.sessions.load(session)?.participants.some((p) => p.id === author)) return err({ type: 'NotAParticipant', participant: author });
    let replyable: Collaboration.ReplyableTarget | undefined;
    if (replyTo !== undefined) {
        const r = await verify.makeReplyableTarget(replyTo, session);
        if (!r.ok) return r;
        replyable = r.value;
    }
    const mentioned: Collaboration.MentionableParticipant[] = [];
    for (const m of mentions) {
        const p = await verify.makeMentionableParticipant(m, session);
        if (!p.ok) return p;
        mentioned.push(p.value);
    }
    const at = deps.clock.now();
    const sent = requestCommands.send({
        id: knownRequestId(deps.ids.newId()),
        session: active.value,
        author,
        targets,
        body,
        sentAt: at,
        replyTo: replyable,
        mentions: mentioned,
        viewedAt,
    });
    if (!sent.ok) return sent;
    const { Sent } = sent.value;
    stores.requests.save(Sent.aggregate);
    publish(stores, session, Sent.events, at);
    return ok(Sent.aggregate);
}

/** Records the runner's correction of the triages of a run's messages it answered instead of editing (decision 18). */
export function overrideAnsweredTriages(stores: Stores, run: Collaboration.CompletedAgentRun, at: Date): void {
    if (!run.reply) return;
    for (const r of run.reply.requests) {
        if (r.status !== 'Answered') continue;
        const triage = stores.triages.ofRequest(r.request);
        if (triage?.state !== 'Decided' || triage.kind !== 'ChangeRequest') continue;
        const reason = Collaboration.makeText('実行役が問いとして答えた');
        const overridden = triageCommands.override(triage, {
            step: { stage: 'Runner', verdict: 'Consultation', ...(reason.ok && { reason: reason.value }), durationMs: milliseconds(0), at },
            overriddenAt: at,
        });
        if (!overridden.ok) continue;
        stores.triages.save(overridden.value.Decided.aggregate);
        publish(stores, run.session, overridden.value.Decided.events, at);
    }
}

/** The success value of a command that cannot fail. */
function decided<T>(r: Result<T, never>): T {
    if (!r.ok) throw new Error('A command without errors returned one');
    return r.value;
}
