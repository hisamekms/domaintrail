// The session as the page holds it (ADR 0026, S4's WebSocket): the state the server sends on connect
// (`session.state`, with the outbox position `seq` it includes) and the events after it. Events that arrive before a
// state are kept until it comes; an event is applied only when its `seq` is past the state's, and applying one twice
// changes nothing. An event that does not carry everything the state holds (a queued run's input, a finished run's
// report or the agent's reply, a revision's files) asks for the state to be fetched again.
import type { EventMessage, Me, SessionServerMessage, SessionStateBody } from '@domaintrail/collaboration/protocol';

type RequestJson = SessionStateBody['requests'][number];
type RunJson = SessionStateBody['runs'][number];
type RevisionJson = SessionStateBody['revisions'][number];
type SessionJson = SessionStateBody['session'];
type MarkJson = SessionStateBody['marks'][number];
type ApprovalJson = SessionStateBody['approvals'][number];

export interface SessionModel {
    readonly state: SessionStateBody | undefined;
    /** Who the page is signed in as (from `session.state`, or `/api/session/me` after the role changed). */
    readonly me: Me | undefined;
    /** Events received while waiting for a state (before the first one, or after the socket closed). */
    readonly buffer: readonly EventMessage[];
    readonly awaitingState: boolean;
    /** An event was only partly applied: the state should be fetched again (`GET /api/session/state`). */
    readonly refetch: boolean;
}

export const INITIAL_SESSION: SessionModel = { state: undefined, me: undefined, buffer: [], awaitingState: true, refetch: false };

const isEvent = (m: SessionServerMessage): m is EventMessage => 'seq' in m && 'event' in m;

/**
 * The page received a message of the session; presence messages leave the model as it is. The agents' presence
 * (`agent.presence`) replaces the state's `agent`; before a state, the next one carries it.
 */
export function receive(model: SessionModel, message: SessionServerMessage): SessionModel {
    if (message.type === 'session.state') return adopt(model, message.state, message.me, true);
    if (message.type === 'agent.presence') return model.state ? { ...model, state: { ...model.state, agent: message.agent } } : model;
    if (!isEvent(message)) return model;
    if (model.awaitingState || !model.state) return { ...model, buffer: [...model.buffer, message] };
    const applied = applyEvent(model.state, message);
    return applied.state === model.state && !applied.refetch ? model : { ...model, state: applied.state, refetch: model.refetch || applied.refetch };
}

/**
 * Takes a state: the one the socket sends on connect (`replace`: always taken, then the events buffered past it), or
 * one fetched again (taken only when it is not older than the one held).
 */
export function adopt(model: SessionModel, state: SessionStateBody, me: Me | undefined, replace: boolean): SessionModel {
    if (!replace && model.state && state.seq < model.state.seq) return model;
    let next = state;
    let refetch = false;
    for (const event of model.buffer) {
        const applied = applyEvent(next, event);
        next = applied.state;
        refetch ||= applied.refetch;
    }
    return { state: next, me: me ?? model.me, buffer: [], awaitingState: false, refetch };
}

/** The socket closed: events from now on wait for the state the next connection sends. */
export const disconnected = (model: SessionModel): SessionModel => ({ ...model, awaitingState: true, buffer: [] });

/** The state was fetched again (or the fetch is under way). */
export const refetched = (model: SessionModel): SessionModel => (model.refetch ? { ...model, refetch: false } : model);

const replaceById = <T extends { readonly id: string }>(items: readonly T[], id: string, f: (item: T) => T): T[] => items.map((i) => (i.id === id ? f(i) : i));

/**
 * Applies one event to a state. Idempotent: an event at or before the state's `seq`, or one whose change is already
 * there, leaves it as it is. `refetch` tells that the event did not carry everything the state holds.
 */
export function applyEvent(state: SessionStateBody, message: EventMessage): { state: SessionStateBody; refetch: boolean } {
    if (message.seq <= state.seq) return { state, refetch: false };
    const at = { ...state, seq: message.seq };
    const runs = (f: (run: RunJson) => RunJson, id: string): SessionStateBody => ({ ...at, runs: replaceById(state.runs, id, f) });
    const session = (s: SessionJson): SessionStateBody => ({ ...at, session: s });
    const e = message.event;
    switch (e.type) {
        case 'SessionStarted':
            return { state: at, refetch: false };
        case 'ParticipantJoined': {
            const s = state.session;
            if (s.participants.some((p) => p.id === e.participant)) return { state: at, refetch: false };
            const joined = { id: e.participant, name: e.name, role: 'Participant' as const, joinedAt: e.joinedAt };
            const [first, ...rest] = s.participants;
            return { state: session({ ...s, participants: [first, ...rest, joined] }), refetch: false };
        }
        case 'SessionClosed':
            return { state: state.session.state === 'Closed' ? at : session({ ...state.session, state: 'Closed', closedAt: e.closedAt }), refetch: false };
        case 'RequestSent': {
            if (state.requests.some((r) => r.id === e.requestId)) return { state: at, refetch: false };
            const request: RequestJson = {
                id: e.requestId,
                session: e.session,
                author: e.author,
                targets: e.targets,
                body: e.body,
                sentAt: e.sentAt,
                ...(e.replyTo !== undefined && { replyTo: e.replyTo }),
                mentions: e.mentions,
                ...(e.journeyNote !== undefined && { journeyNote: e.journeyNote }),
                state: 'Sent',
            };
            return { state: { ...at, requests: [...state.requests, request] }, refetch: false };
        }
        case 'RequestDismissed':
            return {
                state: {
                    ...at,
                    requests: replaceById(state.requests, e.requestId, (r) =>
                        r.state === 'Sent' ? { ...r, state: 'Dismissed', dismissedBy: e.dismissedBy, dismissedAt: e.dismissedAt } : r,
                    ),
                },
                refetch: false,
            };
        case 'RunQueued':
            // the run's frozen input and note are not in the event
            return { state: at, refetch: !state.runs.some((r) => r.id === e.runId) };
        case 'RunStarted':
            return {
                state: runs((r) => (r.state === 'Queued' ? { ...r, state: 'Running', baseRevision: e.baseRevision, startedAt: e.startedAt } : r), e.runId),
                refetch: false,
            };
        case 'RunReverted': {
            // a queued revert the server reverted (or found nothing left to revert)
            const run = state.runs.find((r) => r.id === e.runId);
            if (run?.state !== 'Queued') return { state: at, refetch: run === undefined };
            const reverted: RunJson = {
                id: run.id,
                session: run.session,
                input: run.input,
                queuedBy: run.queuedBy,
                queuedAt: run.queuedAt,
                state: 'Reverted',
                baseRevision: e.baseRevision,
                resultRevision: e.resultRevision,
                changed: e.changed,
                finishedAt: e.finishedAt,
            };
            return { state: runs(() => reverted, e.runId), refetch: false };
        }
        case 'RevertLeftToAgent':
            // still queued, now for the agent, with why
            return {
                state: runs((r) => (r.state === 'Queued' ? { ...r, revertObstacle: e.obstacle } : r), e.runId),
                refetch: !state.runs.some((r) => r.id === e.runId),
            };
        case 'RunCompleted':
            // the report is not in the event
            return { state: at, refetch: state.runs.find((r) => r.id === e.runId)?.state !== 'Completed' };
        case 'RunNeedsClarification': {
            const run = state.runs.find((r) => r.id === e.runId);
            return {
                state: runs(
                    (r) =>
                        r.state === 'Running'
                            ? { ...r, state: 'NeedsClarification', question: e.question, resultRevision: e.resultRevision, finishedAt: e.finishedAt }
                            : r,
                    e.runId,
                ),
                // the agent's structured reply is not in the event
                refetch: run?.state === 'Running' || run === undefined,
            };
        }
        case 'RunDeclined':
            // the agent's reply (its reason) is not in the event
            return { state: at, refetch: state.runs.find((r) => r.id === e.runId)?.state !== 'Declined' };
        case 'RunFailed': {
            const run = state.runs.find((r) => r.id === e.runId);
            if (run?.state !== 'Running') return { state: at, refetch: run === undefined };
            // the report of a run that did not meet the rule is not in the event
            const failed: RunJson = { ...run, state: 'Failed', reason: e.reason, finishedAt: e.finishedAt };
            return { state: runs(() => failed, e.runId), refetch: e.reason === 'RuleNotMet' };
        }
        case 'RunCancelled':
            return {
                state: runs((r) => {
                    if (r.state === 'Queued') return { ...r, state: 'Cancelled', cancelledBy: e.cancelledBy, cancelledAt: e.cancelledAt };
                    if (r.state === 'Running')
                        return {
                            id: r.id,
                            session: r.session,
                            input: r.input,
                            queuedBy: r.queuedBy,
                            queuedAt: r.queuedAt,
                            state: 'Cancelled',
                            baseRevision: r.baseRevision,
                            cancelledBy: e.cancelledBy,
                            cancelledAt: e.cancelledAt,
                        };
                    return r;
                }, e.runId),
                refetch: false,
            };
        case 'RevisionRecorded':
        case 'RevisionRestored':
            // the revision's files are not in the event
            return { state: at, refetch: !state.revisions.some((r) => r.id === e.revisionId) };
        case 'MarkPlaced': {
            // a state from before marks were sent has none
            const marks = state.marks ?? [];
            if (marks.some((m) => m.id === e.markId)) return { state: at, refetch: false };
            const mark: MarkJson = {
                id: e.markId,
                session: e.session,
                participant: e.participant,
                target: e.target,
                sign: e.sign,
                placedAt: e.placedAt,
                state: 'Placed',
            };
            return { state: { ...at, marks: [...marks, mark] }, refetch: false };
        }
        case 'MarkRemoved':
            return { state: { ...at, marks: (state.marks ?? []).filter((m) => m.id !== e.markId) }, refetch: false };
        case 'AssumptionApproved': {
            // a state from before approvals were sent has none
            const approvals = state.approvals ?? [];
            if (approvals.some((a) => a.id === e.approvalId)) return { state: at, refetch: false };
            const approval: ApprovalJson = {
                id: e.approvalId,
                session: e.session,
                assumption: e.assumption,
                approvedBy: e.approvedBy,
                approvedAt: e.approvedAt,
                state: 'Approved',
            };
            return { state: { ...at, approvals: [...approvals, approval] }, refetch: false };
        }
        case 'SessionCollaborated':
            return { state: session({ ...state.session, mode: 'Collab' }), refetch: false };
        case 'JourneyChosen': {
            const { currentJourney: _was, ...rest } = state.session;
            return { state: session(e.journey === undefined ? rest : { ...rest, currentJourney: e.journey }), refetch: false };
        }
        // the triages and proposals (ADR 0030): the state is fetched again to hold them (a participant's page gets the
        // triages' events without their records, and an event does not carry the triage or the proposal whole)
        case 'TriageOpened':
        case 'TriageStepRecorded':
        case 'TriageDecided':
        case 'TriageOverridden':
        case 'TriageReaddressed':
        case 'TriageConcluded':
        case 'ChangeProposed':
        case 'ProposalApproved':
        case 'ProposalRejected':
        case 'ProposalWithdrawn':
        // the interviews of the `/` commands: the state holds them whole
        case 'InterviewStarted':
        case 'InterviewAnswered':
        case 'InterviewQuestionAsked':
        case 'InterviewBriefed':
        case 'InterviewConfirmed':
        case 'InterviewStopped':
        case 'InterviewRejected':
        // the candidate and answer commands of the `/` list: the state holds them whole
        case 'SlashCommandStarted':
        case 'CandidatesListed':
        case 'SlashCommandAnswered':
        case 'CandidatesApplied':
        case 'SlashCommandStopped':
            return { state: at, refetch: true };
    }
}

/** The revision a request composed now is seen in: the session's latest. */
export function latestRevision(state: SessionStateBody): RevisionJson | undefined {
    let latest: RevisionJson | undefined;
    for (const r of state.revisions) if (!latest || r.takenAt >= latest.takenAt) latest = r;
    return latest;
}
