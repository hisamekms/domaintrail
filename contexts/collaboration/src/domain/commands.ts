// The commands of the collaboration aggregates, checked against the generated contracts (ADR 0026). Each is a pure
// decision made with the runtime's `decide`: IDs, times, snapshots and the verified types (ActiveSession,
// PendingRequest, ReplyableRun, MentionableParticipant, RestorableRevision, RevertableRun) are parameters that the application makes. The requirements are checked with the
// generated `check…Requires`, so their expressions are the DSL's; what is written here is which error each returns and
// what each outcome sets. Who may act is a rule of the work (ADR 0027): the commands reserved to the facilitator take
// the role of who acts as a parameter, from the use case's `Actor`. A command takes its parameters as one object
// (ADR 0028), which it passes on as it is to its check of requirements.
import { Collaboration, decide, err, ok } from '../generated/index.js';
import { holdsHashOfFiles } from './snapshot.js';
import { succeeded } from './validation.js';

export const sessionCommands: Collaboration.SessionCommands = {
    // the facilitator is the first participant
    start: decide<Collaboration.StartSessionDecision>(Collaboration.SessionShape, ({ id, facilitator, name, startedAt }) =>
        ok({
            Open: {
                set: { id, facilitator, participants: [{ id: facilitator, name, role: 'Facilitator', joinedAt: startedAt }], startedAt },
                events: { SessionStarted: { type: 'SessionStarted', sessionId: id, facilitator, name, startedAt } },
            },
        }),
    ),

    join: decide<Collaboration.JoinSessionDecision>(Collaboration.SessionShape, {
        Open: (session, params) => {
            const { participant, name, joinedAt } = params;
            if (Collaboration.checkJoinSessionRequires(session, params) === 'newcomer') return err({ type: 'AlreadyJoined', participant });
            return ok({
                Open: {
                    set: { participants: [...session.participants, { id: participant, name, role: 'Participant', joinedAt }] },
                    events: { ParticipantJoined: { type: 'ParticipantJoined', sessionId: session.id, participant, name, joinedAt } },
                },
            });
        },
    }),

    close: decide<Collaboration.CloseSessionDecision>(Collaboration.SessionShape, {
        Open: (session, params) => {
            if (Collaboration.checkCloseSessionRequires(session, params) === 'facilitatorCloses') return err({ type: 'FacilitatorOnly' });
            const { closedAt } = params;
            return ok({ Closed: { set: { closedAt }, events: { SessionClosed: { type: 'SessionClosed', sessionId: session.id, closedAt } } } });
        },
    }),
};

export const requestCommands: Collaboration.RequestCommands = {
    send: decide<Collaboration.SendRequestDecision>(Collaboration.RequestShape, (params) => {
        switch (Collaboration.checkSendRequestRequires(params)) {
            case 'atMostTwentyTargets':
                return err({ type: 'TooManyTargets' });
            case 'distinctTargets':
                return err({ type: 'DuplicateTarget' });
            case 'noWorkspaceTarget':
                return err({ type: 'WorkspaceTarget' });
            case 'atMostTwentyMentions':
                return err({ type: 'TooManyMentions' });
            case 'distinctMentions':
                return err({ type: 'DuplicateMention' });
        }
        const { id, session, author, targets, body, sentAt, replyTo, mentions } = params;
        return ok({
            Sent: {
                // a reply names the run it answers; whether it runs is the facilitator's to decide, as for any message
                set: { id, session, author, targets, body, sentAt, replyTo, mentions, reverts: undefined },
                events: { RequestSent: { type: 'RequestSent', requestId: id, session, author, targets, body, sentAt, ...(replyTo && { replyTo }), mentions } },
            },
        });
    }),

    // a revert of a run's changes: about the workspace as a whole (no target, no mention), the facilitator's
    requestRevert: decide<Collaboration.RequestRevertRequestDecision>(Collaboration.RequestShape, (params) => {
        if (Collaboration.checkRequestRevertRequestRequires(params) === 'facilitatorReverts') return err({ type: 'FacilitatorOnly' });
        const { id, session, author, body, sentAt } = params;
        // the run without its evidence: the aggregate stores the base type
        const reverts: Collaboration.AgentRunId = params.reverts;
        return ok({
            Sent: {
                set: { id, session, author, targets: [], body, sentAt, replyTo: undefined, mentions: [], reverts },
                events: { RequestSent: { type: 'RequestSent', requestId: id, session, author, targets: [], body, sentAt, mentions: [], reverts } },
            },
        });
    }),
};

export const agentRunCommands: Collaboration.AgentRunCommands = {
    queue: decide<Collaboration.QueueAgentRunDecision>(Collaboration.AgentRunShape, (params) => {
        switch (Collaboration.checkQueueAgentRunRequires(params)) {
            case 'facilitatorQueues':
                return err({ type: 'FacilitatorOnly' });
            case 'distinctRequests':
                return err({ type: 'DuplicateRequest' });
            case 'inputCoversRequests':
                return err({ type: 'InputMismatch' });
        }
        const { id, session, requests, input, queuedBy, queuedAt } = params;
        return ok({
            Queued: {
                set: { id, session, input, queuedBy, queuedAt, revertObstacle: undefined },
                events: { RunQueued: { type: 'RunQueued', runId: id, session, requests, queuedBy, queuedAt } },
            },
        });
    }),

    // a queued revert whose turn came, reverted mechanically by the server (no agent); unchanged when nothing was left
    revert: decide<Collaboration.RevertAgentRunDecision>(Collaboration.AgentRunShape, {
        Queued: (run, params) => {
            switch (Collaboration.checkRevertAgentRunRequires(run, params)) {
                case 'inputReverts':
                    return err({ type: 'InputMismatch' });
                case 'changedMatchesResult':
                    return err({ type: 'ChangedMismatch' });
            }
            const { baseRevision, resultRevision, changed, finishedAt } = params;
            return ok({
                Reverted: {
                    set: { baseRevision, resultRevision, changed, finishedAt },
                    events: { RunReverted: { type: 'RunReverted', runId: run.id, baseRevision, resultRevision, changed, finishedAt } },
                },
            });
        },
    }),

    // a queued revert the server could not revert mechanically: it stays queued, for the agent, with why
    leaveToAgent: decide<Collaboration.LeaveToAgentAgentRunDecision>(Collaboration.AgentRunShape, {
        Queued: (run, params) => {
            if (Collaboration.checkLeaveToAgentAgentRunRequires(run, params) === 'inputReverts') return err({ type: 'InputMismatch' });
            const { obstacle } = params;
            return ok({
                Queued: {
                    set: { revertObstacle: obstacle },
                    events: { RevertLeftToAgent: { type: 'RevertLeftToAgent', runId: run.id, obstacle } },
                },
            });
        },
    }),

    start: decide<Collaboration.StartAgentRunDecision>(Collaboration.AgentRunShape, {
        Queued: (run, { baseRevision, startedAt }) =>
            ok({ Running: { set: { baseRevision, startedAt }, events: { RunStarted: { type: 'RunStarted', runId: run.id, baseRevision, startedAt } } } }),
    }),

    // Completed when the report meets the run success rule, Failed (RuleNotMet) with the report otherwise
    finish: decide<Collaboration.FinishAgentRunDecision>(Collaboration.AgentRunShape, {
        Running: (run, params) => {
            switch (Collaboration.checkFinishAgentRunRequires(run, params)) {
                case 'changedMatchesResult':
                    return err({ type: 'ChangedMismatch' });
                case 'replyAsksNothing':
                case 'replyAboutInput':
                    return err({ type: 'InvalidReply' });
            }
            const { report, resultRevision, changed, reply, finishedAt } = params;
            if (succeeded(report)) {
                return ok({
                    Completed: {
                        // the reply is kept with a completed run only: a failure is the facts'
                        set: { report, resultRevision, changed, reply, finishedAt },
                        events: { RunCompleted: { type: 'RunCompleted', runId: run.id, resultRevision, changed, finishedAt } },
                    },
                });
            }
            return ok({
                Failed: {
                    set: { reason: 'RuleNotMet', report, resultRevision, finishedAt },
                    events: { RunFailed: { type: 'RunFailed', runId: run.id, reason: 'RuleNotMet', finishedAt } },
                },
            });
        },
    }),

    askClarification: decide<Collaboration.AskClarificationAgentRunDecision>(Collaboration.AgentRunShape, {
        Running: (run, params) => {
            if (Collaboration.checkAskClarificationAgentRunRequires(run, params) !== undefined) return err({ type: 'InvalidReply' });
            const { question, reply, resultRevision, finishedAt } = params;
            return ok({
                NeedsClarification: {
                    set: { question, reply, resultRevision, finishedAt },
                    events: { RunNeedsClarification: { type: 'RunNeedsClarification', runId: run.id, question, resultRevision, finishedAt } },
                },
            });
        },
    }),

    decline: decide<Collaboration.DeclineAgentRunDecision>(Collaboration.AgentRunShape, {
        Running: (run, params) => {
            if (Collaboration.checkDeclineAgentRunRequires(run, params) !== undefined) return err({ type: 'InvalidReply' });
            const { reply, resultRevision, finishedAt } = params;
            return ok({
                Declined: {
                    set: { reply, resultRevision, finishedAt },
                    events: { RunDeclined: { type: 'RunDeclined', runId: run.id, resultRevision, finishedAt } },
                },
            });
        },
    }),

    // a failure without a report: the run success rule is finish's
    fail: decide<Collaboration.FailAgentRunDecision>(Collaboration.AgentRunShape, {
        Running: (run, params) => {
            if (Collaboration.checkFailAgentRunRequires(run, params) === 'abnormal') return err({ type: 'ReportRequired' });
            const { reason, finishedAt } = params;
            return ok({
                Failed: {
                    set: { reason, report: undefined, resultRevision: undefined, finishedAt },
                    events: { RunFailed: { type: 'RunFailed', runId: run.id, reason, finishedAt } },
                },
            });
        },
    }),

    // a running run keeps its base revision; a queued one has none
    cancel: decide<Collaboration.CancelAgentRunDecision>(Collaboration.AgentRunShape, {
        Queued: (run, params) => {
            if (Collaboration.checkCancelAgentRunRequires(run, params) === 'facilitatorCancels') return err({ type: 'FacilitatorOnly' });
            const { cancelledBy, cancelledAt } = params;
            return ok({
                Cancelled: {
                    set: { baseRevision: undefined, cancelledBy, cancelledAt },
                    events: { RunCancelled: { type: 'RunCancelled', runId: run.id, cancelledBy, cancelledAt } },
                },
            });
        },
        Running: (run, params) => {
            if (Collaboration.checkCancelAgentRunRequires(run, params) === 'facilitatorCancels') return err({ type: 'FacilitatorOnly' });
            const { cancelledBy, cancelledAt } = params;
            return ok({
                Cancelled: {
                    set: { baseRevision: run.baseRevision, cancelledBy, cancelledAt },
                    events: { RunCancelled: { type: 'RunCancelled', runId: run.id, cancelledBy, cancelledAt } },
                },
            });
        },
    }),
};

/** The declared requirement `hashMatchesFiles` of take and restore. */
const hashMatchesFiles = (contentHash: Collaboration.ContentHash, files: readonly Collaboration.SnapshotFile[]): boolean =>
    holdsHashOfFiles({ contentHash, files });

export const revisionCommands: Collaboration.RevisionCommands = {
    take: decide<Collaboration.TakeRevisionDecision>(Collaboration.RevisionShape, (params) => {
        const check = Collaboration.checkTakeRevisionRequiresWith({ hashMatchesFiles: (p) => hashMatchesFiles(p.contentHash, p.files) });
        switch (check(params)) {
            case 'notRestored':
                return err({ type: 'RestoreNeedsCheck' });
            case 'hashMatchesFiles':
                return err({ type: 'ContentHashMismatch' });
        }
        const { id, session, origin, contentHash, files, validation, takenAt } = params;
        return ok({
            Recorded: {
                set: { id, session, origin, contentHash, files, validation, takenAt },
                events: { RevisionRecorded: { type: 'RevisionRecorded', revisionId: id, session, origin, contentHash, validation, takenAt } },
            },
        });
    }),

    restore: decide<Collaboration.RestoreRevisionDecision>(Collaboration.RevisionShape, (params) => {
        const check = Collaboration.checkRestoreRevisionRequiresWith({ hashMatchesFiles: (p) => hashMatchesFiles(p.contentHash, p.files) });
        switch (check(params)) {
            case 'facilitatorRestores':
                return err({ type: 'FacilitatorOnly' });
            case 'hashMatchesFiles':
                return err({ type: 'ContentHashMismatch' });
        }
        const { id, session, restoredFrom, preRestore, contentHash, files, validation, takenAt } = params;
        return ok({
            Recorded: {
                set: { id, session, origin: { kind: 'Restored', restoredFrom, preRestore }, contentHash, files, validation, takenAt },
                events: {
                    RevisionRestored: { type: 'RevisionRestored', revisionId: id, session, restoredFrom, preRestore, contentHash, validation, takenAt },
                },
            },
        });
    }),
};

/** The declared invariants of the aggregates, as the contract tests and the stores check them. */
export const declaredChecks = {
    Revision: { hashOfFiles: (revision: Collaboration.RevisionCommon): boolean => holdsHashOfFiles(revision) },
} as const;
