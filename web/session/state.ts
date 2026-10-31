// The session as the page holds it (ADR 0026, S4's WebSocket): the state the server sends on connect
// (`session.state`, with the outbox position `seq` it includes) and the events after it. Events that arrive before a
// state are kept until it comes; an event is applied only when its `seq` is past the state's, and applying one twice
// changes nothing. An event that does not carry everything the state holds (a queued run's input, a finished run's
// report, a revision's files) asks for the state to be fetched again.
import type { EventMessage, Me, SessionServerMessage, SessionStateBody } from '@domaintrail/collaboration/protocol';

type RequestJson = SessionStateBody['requests'][number];
type RunJson = SessionStateBody['runs'][number];
type RevisionJson = SessionStateBody['revisions'][number];
type SessionJson = SessionStateBody['session'];

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

/** The page received a message of the session; presence messages leave the model as it is. */
export function receive(model: SessionModel, message: SessionServerMessage): SessionModel {
    if (message.type === 'session.state') return adopt(model, message.state, message.me, true);
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
                target: e.target,
                body: e.body,
                sentAt: e.sentAt,
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
        case 'RunCompleted':
            // the report is not in the event
            return { state: at, refetch: state.runs.find((r) => r.id === e.runId)?.state !== 'Completed' };
        case 'RunNeedsClarification':
            return {
                state: runs(
                    (r) =>
                        r.state === 'Running'
                            ? { ...r, state: 'NeedsClarification', question: e.question, resultRevision: e.resultRevision, finishedAt: e.finishedAt }
                            : r,
                    e.runId,
                ),
                refetch: false,
            };
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
        case 'RevisionConfirmed':
            return {
                state: {
                    ...at,
                    revisions: replaceById(state.revisions, e.revisionId, (r: RevisionJson) =>
                        r.state === 'Recorded' ? { ...r, state: 'Confirmed', confirmedBy: e.confirmedBy, confirmedAt: e.confirmedAt } : r,
                    ),
                },
                refetch: false,
            };
    }
}

/** The revision a request composed now is seen in: the session's latest. */
export function latestRevision(state: SessionStateBody): RevisionJson | undefined {
    let latest: RevisionJson | undefined;
    for (const r of state.revisions) if (!latest || r.takenAt >= latest.takenAt) latest = r;
    return latest;
}
