// The commands of the collaboration aggregates, checked against the generated contracts (ADR 0026). Each is a pure
// decision made with the runtime's `decide`: IDs, times, snapshots and the verified types (ActiveSession,
// PendingRequest, RestorableRevision) are parameters that the application makes. The requirements are checked with the
// generated `check…Requires`, so their expressions are the DSL's; what is written here is which error each returns and
// what each outcome sets.
import { Collaboration, decide, err, ok } from '../generated/index.js';
import { holdsHashOfFiles } from './snapshot.js';
import { succeeded } from './validation.js';

export const sessionCommands: Collaboration.SessionCommands = {
    // the facilitator is the first participant
    start: decide<Collaboration.StartSessionDecision>(Collaboration.SessionShape, (id, facilitator, name, startedAt) =>
        ok({
            Open: {
                set: { id, facilitator, participants: [{ id: facilitator, name, role: 'Facilitator', joinedAt: startedAt }], startedAt },
                events: { SessionStarted: { type: 'SessionStarted', sessionId: id, facilitator, name, startedAt } },
            },
        }),
    ),

    join: decide<Collaboration.JoinSessionDecision>(Collaboration.SessionShape, {
        Open: (session, participant, name, joinedAt) => {
            if (Collaboration.checkJoinSessionRequires(session, participant, name, joinedAt) === 'newcomer') return err({ type: 'AlreadyJoined', participant });
            return ok({
                Open: {
                    set: { participants: [...session.participants, { id: participant, name, role: 'Participant', joinedAt }] },
                    events: { ParticipantJoined: { type: 'ParticipantJoined', sessionId: session.id, participant, name, joinedAt } },
                },
            });
        },
    }),

    close: decide<Collaboration.CloseSessionDecision>(Collaboration.SessionShape, {
        Open: (session, closedAt) =>
            ok({ Closed: { set: { closedAt }, events: { SessionClosed: { type: 'SessionClosed', sessionId: session.id, closedAt } } } }),
    }),
};

export const requestCommands: Collaboration.RequestCommands = {
    send: decide<Collaboration.SendRequestDecision>(Collaboration.RequestShape, (id, session, author, target, body, sentAt) =>
        ok({
            Sent: {
                set: { id, session, author, target, body, sentAt },
                events: { RequestSent: { type: 'RequestSent', requestId: id, session, author, target, body, sentAt } },
            },
        }),
    ),

    dismiss: decide<Collaboration.DismissRequestDecision>(Collaboration.RequestShape, {
        Sent: (request, dismissedBy, dismissedAt) =>
            ok({
                Dismissed: {
                    set: { dismissedBy, dismissedAt },
                    events: { RequestDismissed: { type: 'RequestDismissed', requestId: request.id, dismissedBy, dismissedAt } },
                },
            }),
    }),
};

export const agentRunCommands: Collaboration.AgentRunCommands = {
    queue: decide<Collaboration.QueueAgentRunDecision>(Collaboration.AgentRunShape, (id, session, requests, input, queuedBy, queuedAt) => {
        switch (Collaboration.checkQueueAgentRunRequires(id, session, requests, input, queuedBy, queuedAt)) {
            case 'distinctRequests':
                return err({ type: 'DuplicateRequest' });
            case 'inputCoversRequests':
                return err({ type: 'InputMismatch' });
        }
        return ok({
            Queued: {
                set: { id, session, input, queuedBy, queuedAt },
                events: { RunQueued: { type: 'RunQueued', runId: id, session, requests, queuedBy, queuedAt } },
            },
        });
    }),

    start: decide<Collaboration.StartAgentRunDecision>(Collaboration.AgentRunShape, {
        Queued: (run, baseRevision, startedAt) =>
            ok({ Running: { set: { baseRevision, startedAt }, events: { RunStarted: { type: 'RunStarted', runId: run.id, baseRevision, startedAt } } } }),
    }),

    // Completed when the report meets the run success rule, Failed (RuleNotMet) with the report otherwise
    finish: decide<Collaboration.FinishAgentRunDecision>(Collaboration.AgentRunShape, {
        Running: (run, report, resultRevision, changed, finishedAt) => {
            if (Collaboration.checkFinishAgentRunRequires(run, report, resultRevision, changed, finishedAt) === 'changedMatchesResult')
                return err({ type: 'ChangedMismatch' });
            if (succeeded(report)) {
                return ok({
                    Completed: {
                        set: { report, resultRevision, changed, finishedAt },
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
        Running: (run, question, resultRevision, finishedAt) =>
            ok({
                NeedsClarification: {
                    set: { question, resultRevision, finishedAt },
                    events: { RunNeedsClarification: { type: 'RunNeedsClarification', runId: run.id, question, resultRevision, finishedAt } },
                },
            }),
    }),

    // a failure without a report: the run success rule is finish's
    fail: decide<Collaboration.FailAgentRunDecision>(Collaboration.AgentRunShape, {
        Running: (run, reason, finishedAt) => {
            if (Collaboration.checkFailAgentRunRequires(run, reason, finishedAt) === 'abnormal') return err({ type: 'ReportRequired' });
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
        Queued: (run, cancelledBy, cancelledAt) =>
            ok({
                Cancelled: {
                    set: { baseRevision: undefined, cancelledBy, cancelledAt },
                    events: { RunCancelled: { type: 'RunCancelled', runId: run.id, cancelledBy, cancelledAt } },
                },
            }),
        Running: (run, cancelledBy, cancelledAt) =>
            ok({
                Cancelled: {
                    set: { baseRevision: run.baseRevision, cancelledBy, cancelledAt },
                    events: { RunCancelled: { type: 'RunCancelled', runId: run.id, cancelledBy, cancelledAt } },
                },
            }),
    }),
};

/** The declared requirement `hashMatchesFiles` of take and restore. */
const hashMatchesFiles = (contentHash: Collaboration.ContentHash, files: readonly Collaboration.SnapshotFile[]): boolean =>
    holdsHashOfFiles({ contentHash, files });

export const revisionCommands: Collaboration.RevisionCommands = {
    take: decide<Collaboration.TakeRevisionDecision>(Collaboration.RevisionShape, (id, session, origin, contentHash, files, validation, takenAt) => {
        const check = Collaboration.checkTakeRevisionRequiresWith({ hashMatchesFiles: (_i, _s, _o, hash, fs) => hashMatchesFiles(hash, fs) });
        switch (check(id, session, origin, contentHash, files, validation, takenAt)) {
            case 'notRestored':
                return err({ type: 'RestoreNeedsCheck' });
            case 'hashMatchesFiles':
                return err({ type: 'ContentHashMismatch' });
        }
        return ok({
            Recorded: {
                set: { id, session, origin, contentHash, files, validation, takenAt },
                events: { RevisionRecorded: { type: 'RevisionRecorded', revisionId: id, session, origin, contentHash, validation, takenAt } },
            },
        });
    }),

    restore: decide<Collaboration.RestoreRevisionDecision>(
        Collaboration.RevisionShape,
        (id, session, restoredFrom, preRestore, contentHash, files, validation, takenAt) => {
            const check = Collaboration.checkRestoreRevisionRequiresWith({ hashMatchesFiles: (_i, _s, _r, _p, hash, fs) => hashMatchesFiles(hash, fs) });
            if (check(id, session, restoredFrom, preRestore, contentHash, files, validation, takenAt) === 'hashMatchesFiles')
                return err({ type: 'ContentHashMismatch' });
            return ok({
                Recorded: {
                    set: { id, session, origin: { kind: 'Restored', restoredFrom, preRestore }, contentHash, files, validation, takenAt },
                    events: {
                        RevisionRestored: { type: 'RevisionRestored', revisionId: id, session, restoredFrom, preRestore, contentHash, validation, takenAt },
                    },
                },
            });
        },
    ),

    confirm: decide<Collaboration.ConfirmRevisionDecision>(Collaboration.RevisionShape, {
        Recorded: (revision, confirmedBy, confirmedAt) =>
            ok({
                Confirmed: {
                    set: { confirmedBy, confirmedAt },
                    events: { RevisionConfirmed: { type: 'RevisionConfirmed', revisionId: revision.id, confirmedBy, confirmedAt } },
                },
            }),
    }),
};

/** The declared invariants of the aggregates, as the contract tests and the stores check them. */
export const declaredChecks = {
    Revision: { hashOfFiles: (revision: Collaboration.Revision): boolean => holdsHashOfFiles(revision) },
} as const;
