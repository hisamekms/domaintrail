// The use cases of a collaboration session (ADR 0026): the application around the pure commands. Each turns its input
// into domain values (IDs and times from the ports, verified types from their factories), loads the aggregates in one
// transaction, rejects a state the command does not accept, calls the command, and on success saves the aggregate and
// appends its events to the outbox in the same transaction. Workspace snapshots are read and stored as blobs before
// the transaction that records them. Each use case a person calls takes the `Actor` this application built from the
// authenticated identity (ADR 0027): the participant and the role reach the commands as parameters, and the commands'
// `requires` decide who may do what. The agent's use cases take the token of the lease it claimed.
import { Collaboration, err, ok, type Result } from '../generated/index.js';
import { agentRunCommands, requestCommands, revisionCommands, sessionCommands } from '../domain/commands.js';
import { approvalCommands, approvalOf } from '../domain/approvals.js';
import { exclusiveGroup, markChange, markCommands, markKey, MAX_REACTION_EMOJI, reactionRoom } from '../domain/marks.js';
import { elementChanges, type ElementChanges } from '../domain/changes.js';
import { compareFiles, lineDiff, MAX_DIFF_BYTES, statusCounts, type FileComparison, type FileStatus, type LineDiff } from '../domain/compare.js';
import { resolveAnswer, resolvePick, type AnswerData, type PickData } from '../domain/reply.js';
import { boundChanges, previousRunIds, type ComparedChange, type PreviousRunChanges } from '../domain/previous-runs.js';
import { nonEmpty, workspacePath } from '../domain/snapshot.js';
import { awaitsServer, isRevert, reverseChanges, revertableChanges, revertChanges, revertedRunId, type RevertChanges } from '../domain/revert.js';
import { targetStatus, type TargetStatus } from '../domain/targets.js';
import { diagnosticsDiff, runReport, tally, type DiagnosticsDiff, type RunFacts } from '../domain/validation.js';
import type { Actor } from './actor.js';
import type { CollaborationDeps, Lease, OutboxEntry, RestoreOperation, StoredRun, Stores, ValidationResult, WorkspaceScan, WriteRefusal } from './ports.js';
import { analysisOf, capture, sourcesOf, type BlobMissing, type Captured } from './snapshots.js';
import { publish, queueRequests, type NoRequests } from './queueing.js';
import { createConversation, invalidTargets, overrideAnsweredTriages, sendIn, type ConversationUseCases } from './conversation.js';
import { notAllowed, notFound, type InvalidTarget, type NotAllowed, type NotAParticipant, type NotFound } from './errors.js';
import { restorableRevision, storeVerifications } from './verifications.js';
import { knownAgentRunId, knownAssumptionApprovalId, knownMarkId, knownRequestId, knownRevisionId, knownSessionId } from '../domain/ids.js';

type SessionId = Collaboration.SessionId;
type AgentRunId = Collaboration.AgentRunId;
type RevisionId = Collaboration.RevisionId;
type ParticipantId = Collaboration.ParticipantId;

// ---- Errors of the application (as opposed to those the domain decides) ----

export type { InvalidTarget, NotAllowed, NotAParticipant, NotFound, NoRequests };

export interface NothingQueued {
    readonly type: 'NothingQueued';
}

/** The facilitator's answer does not fit the questions of the run it answers (`field`: where in the answer). */
export interface InvalidAnswer {
    readonly type: 'InvalidAnswer';
    readonly field: string;
    readonly message: string;
}

/** The run answered is not one that waits for an answer to structured questions (not NeedsClarification, or its reply asked none). */
export interface NothingToAnswer {
    readonly type: 'NothingToAnswer';
    readonly run: AgentRunId;
}

/** Another run of the session is running or claimed: runs are serial. */
export interface RunInProgress {
    readonly type: 'RunInProgress';
    readonly run: AgentRunId;
}

/** The lease given is not the run's live lease (expired, released, ended, or another claim's). */
export interface LeaseLost {
    readonly type: 'LeaseLost';
    readonly run: AgentRunId;
}

/**
 * A restore failed after it started writing the workspace: the sources may be partly written. Nothing was recorded as
 * restored; the workspace as it was before is the pre-restore revision, to be restored (or looked at) by a person.
 */
export interface ManualRecoveryNeeded {
    readonly type: 'ManualRecoveryNeeded';
    readonly preRestore: RevisionId;
    /** What failed: `WriteFailed`, `WriteRefused` (a refusal after part of the write), `ReadBackFailed`, `ContentDiffers`, `RecordFailed`. */
    readonly cause: string;
    readonly message: string;
}

/**
 * The next queued run needs what the claiming subscriber did not say it can do (`capabilities` of the claim): a revert
 * needs `revert`. The run stays queued for a subscriber that can; this one is told to update.
 */
export interface SubscriberOutdated {
    readonly type: 'SubscriberOutdated';
    readonly run: AgentRunId;
    readonly needs: string;
    readonly message: string;
}

/** What a subscriber says it can run, when it claims: `revert`, a run that reverts another run's changes. */
export const REVERT_CAPABILITY = 'revert';

/**
 * The owner of the server's own lease on a queued revert, while it tries it mechanically (`revertNext`): shown where a
 * lease's owner is, never an agent's name.
 */
export const SERVER_REVERT_OWNER = 'dt-server';

export type { BlobMissing };

// ---- Results ----

/** A run as its lease's holder sees it after a claim. */
export interface Claimed {
    readonly run: Collaboration.QueuedAgentRun;
    readonly lease: Lease;
}

/** A run that ended under its lease. `replayed`: the same call was already made with this lease; nothing changed. */
export interface Ended<R extends Collaboration.AgentRun> {
    readonly run: R;
    readonly replayed: boolean;
}

/** What `finish` decided, with the diagnostics the run added and resolved (absent on a replay). */
export interface Finished extends Ended<Collaboration.CompletedAgentRun | Collaboration.FailedAgentRun> {
    readonly diff: DiagnosticsDiff | undefined;
}

export interface Restored {
    readonly restored: Collaboration.RecordedRevision;
    readonly preRestore: Collaboration.RecordedRevision;
    /** The external changes recorded first (Manual), when the restore was asked to keep them. */
    readonly manual?: Collaboration.RecordedRevision;
}

/** A file of a comparison: its status and, unless it is unchanged, the line diff of its two texts. */
export interface ComparedFile extends FileComparison {
    /** Absent for an unchanged file, and once the comparison's diffs reached `MAX_COMPARISON_DIFF` characters. */
    readonly diff?: LineDiff;
}

/** Two revisions of a session side by side. */
export interface Comparison {
    readonly before: Collaboration.Revision;
    readonly after: Collaboration.Revision;
    readonly files: readonly ComparedFile[];
    readonly counts: Record<Collaboration.SourceLanguage, Record<FileStatus, number>>;
    /** Some diffs were left out: the comparison's diffs reached `MAX_COMPARISON_DIFF` characters. */
    readonly diffsOmitted: boolean;
}

/** The most characters of unified diff text a comparison carries; the files after it get no diff. */
export const MAX_COMPARISON_DIFF = 512 * 1024;
/** How many pairs of revisions `modelChanges` keeps the changes of, and how many revisions it keeps the analysis of. */
const CHANGES_KEPT = 256;
const ANALYSES_KEPT = 8;

/** The least budget a file's diff is started with: below it, the rest of the comparison's diffs are omitted. */
const MIN_DIFF_ROOM = 2 * 1024;

/** A run that a run continues (its messages reply to it, its answer answers it, or it picked one of its alternatives), with what it changed. */
export interface PreviousRun {
    readonly run: Collaboration.AgentRun;
    readonly changes: PreviousRunChanges;
}

/** Everything a session holds, for a page that shows it. */
export interface SessionState {
    readonly session: Collaboration.Session;
    readonly requests: readonly Collaboration.Request[];
    readonly runs: readonly Collaboration.AgentRun[];
    readonly revisions: readonly Collaboration.Revision[];
    /** The marks still placed (votes and reactions), in the order they were placed. */
    readonly marks: readonly Collaboration.PlacedMark[];
    /** The assumptions the facilitator approved, in the order they were approved. */
    readonly approvals: readonly Collaboration.AssumptionApproval[];
    /** The triages of the messages addressed to the AI, in the order they were opened. */
    readonly triages: readonly Collaboration.Triage[];
    /** The change proposals, in the order they were made. */
    readonly proposals: readonly Collaboration.ChangeProposal[];
}

/** What setting a mark changed: the mark placed (none when it was there already or taken off) and the marks removed. */
export interface MarkSet {
    readonly placed: Collaboration.PlacedMark | undefined;
    /** The mark taken off, or the votes of its exclusive group that it moved from. */
    readonly removed: readonly Collaboration.RemovedMark[];
}

/** Whether each target of each request still resolves in the workspace as it is now (in the request's order of targets). */
export interface TargetStatuses {
    /** The content hash of the workspace the targets were resolved in. */
    readonly contentHash: Collaboration.ContentHash;
    readonly statuses: ReadonlyMap<Collaboration.RequestId, readonly TargetStatus[]>;
}

/** Why a revert was left to the AI rather than done mechanically (the model's `RevertObstacle`). */
export type RevertObstacle = Collaboration.RevertObstacle;

/** A revert asked: its request, and its run queued like any other (`revertNext` takes it when its turn comes). */
export interface RevertRequested {
    readonly request: Collaboration.SentRequest;
    readonly run: Collaboration.QueuedAgentRun;
}

export type RequestRevertError =
    | Collaboration.FacilitatorOnly
    | Collaboration.SessionNotFound
    | Collaboration.SessionAlreadyClosed
    | Collaboration.RunNotFound
    | Collaboration.RunOfAnotherSession
    | Collaboration.RunNotRevertable;

/**
 * What the server did with the revert at the head of the queue: reverted mechanically (`changed`: false when none of
 * the run's changes was left: nothing to revert, nothing written), or left queued for the agent, with why.
 */
export type RevertOutcome =
    | { readonly kind: 'reverted'; readonly run: Collaboration.RevertedAgentRun }
    | { readonly kind: 'leftToAgent'; readonly run: Collaboration.QueuedAgentRun; readonly obstacle: RevertObstacle };

/**
 * Why the server did not take the head of the queue: it is not a revert it has to try (`NothingQueued`: none queued,
 * not a revert, or one already left to the agent), a run is running or claimed (`RunInProgress`), or the write was
 * refused (the workspace changed meanwhile, …: nothing written, the revert stays queued and is tried again), or the
 * revert was cancelled while it was tried (`LeaseLost`: nothing written).
 */
export type RevertNextError =
    | NothingQueued
    | RunInProgress
    | LeaseLost
    | Collaboration.PathOutsideRoot
    | Collaboration.ExternalChangesSinceSnapshot
    | Collaboration.SymlinkInWorkspace;

/** A run that a run reverts, with what it changed file by file (for the agent asked to revert it). */
export interface RevertedRun {
    readonly run: Collaboration.AgentRun;
    readonly changes: RevertChanges;
}

export type RestoreError =
    | NotFound
    | Collaboration.FacilitatorOnly
    | RunInProgress
    | BlobMissing
    | Collaboration.RevisionNotFound
    | Collaboration.RevisionOfAnotherSession
    | Collaboration.SymlinkInWorkspace
    | Collaboration.PathOutsideRoot
    | Collaboration.ExternalChangesSinceSnapshot
    | ManualRecoveryNeeded;

export interface CollaborationUseCases extends ConversationUseCases {
    /**
     * Opens a session with its facilitator, in `mode` (Collab when not given), and records the workspace as its first
     * revision (SessionStart). `openSession` applies the rules between the modes (decision 13) on top of it.
     */
    startSession(input: {
        readonly facilitator: ParticipantId;
        readonly name: Collaboration.DisplayName;
        readonly mode?: Collaboration.SessionMode;
    }): Promise<Result<{ readonly session: Collaboration.OpenSession; readonly revision: Collaboration.RecordedRevision }, Collaboration.PathOutsideRoot>>;
    /** Admits a participant; one who already joined is not admitted again (`joined: false`). No one else joins a Solo session. */
    joinSession(input: {
        readonly session: SessionId;
        readonly participant: ParticipantId;
        readonly name: Collaboration.DisplayName;
    }): Promise<
        Result<
            { readonly session: Collaboration.OpenSession; readonly joined: boolean },
            Collaboration.SessionNotFound | Collaboration.SessionAlreadyClosed | Collaboration.SoloSession
        >
    >;
    /** Closes the session: the facilitator's. */
    closeSession(input: {
        readonly session: SessionId;
        readonly actor: Actor;
    }): Promise<Result<Collaboration.ClosedSession, NotFound | NotAllowed | Collaboration.FacilitatorOnly>>;
    /**
     * Sends a request of the actor, a participant of the session, without addressing it to the AI: the path of today's
     * page (its `apply` queues it at once). `sendMessage` is the one that addresses (M4 moves the routes to it).
     */
    sendRequest(input: {
        readonly session: SessionId;
        readonly actor: Actor;
        /** What the request is about: none for the whole workspace. */
        readonly targets: readonly Collaboration.TargetSnapshot[];
        readonly body: Collaboration.Text;
        /**
         * What it replies to: a run of the session, ended (completed, failed, declined or cancelled), not waiting for an
         * answer; or a message of the session (one's own too).
         */
        readonly replyTo?: Collaboration.ReplyTarget;
        /** The participants of the session the body mentions (`@name[pN]` names the N-th), each once, at most 20. */
        readonly mentions?: readonly ParticipantId[];
    }): Promise<
        Result<
            Collaboration.SentRequest,
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
            | Collaboration.WorkspaceTarget
        >
    >;
    /**
     * Places or takes off a participant's mark (a vote or a reaction; `placed`: whether it should be there). Placing
     * a vote moves the participant's vote of the same exclusive group; setting a mark to what it is changes nothing.
     * Refused when the target is not the session's, or is a vote that closed (`domain/marks.ts`), when the sign does
     * not fit the target, for a vote of the facilitator, and for an emoji new to a target that has
     * `MAX_REACTION_EMOJI` different emoji already.
     */
    setMark(input: {
        readonly session: SessionId;
        readonly actor: Actor;
        readonly target: Collaboration.MarkTarget;
        readonly sign: Collaboration.MarkSign;
        readonly placed: boolean;
    }): Promise<
        Result<
            MarkSet,
            | Collaboration.SessionNotFound
            | Collaboration.SessionAlreadyClosed
            | NotAParticipant
            | Collaboration.MarkTargetNotFound
            | Collaboration.MarkTargetClosed
            | Collaboration.MarkNotForTarget
            | Collaboration.FacilitatorDoesNotVote
            | Collaboration.ReactionLimitReached
        >
    >;
    /** Bundles sent requests of the session into a queued run, freezing their content as its input: the facilitator's. */
    queueRun(input: {
        readonly session: SessionId;
        readonly requests: readonly Collaboration.RequestId[];
        readonly note?: Collaboration.Text;
        /** The answer to the questions of a run of the session that needs clarification, frozen into the input. */
        readonly answer?: { readonly answerTo: AgentRunId; readonly answer: AnswerData };
        /**
         * The alternative picked of an assumption of a completed run of the session, frozen into the input: the requests
         * are that run's requests, queued again (`domain/reply.ts` `resolvePick`).
         */
        readonly pick?: PickData;
        readonly actor: Actor;
    }): Promise<
        Result<
            Collaboration.QueuedAgentRun,
            | Collaboration.FacilitatorOnly
            | Collaboration.SessionNotFound
            | Collaboration.SessionAlreadyClosed
            | Collaboration.RequestNotFound
            | Collaboration.RequestOfAnotherSession
            | Collaboration.RequestAlreadyDismissed
            | Collaboration.DuplicateRequest
            | Collaboration.InputMismatch
            | NoRequests
            | NotFound
            | NothingToAnswer
            | InvalidAnswer
            | Collaboration.RunNotFound
            | Collaboration.RunOfAnotherSession
            | Collaboration.RunNotPickable
            | Collaboration.AlternativeNotFound
            | Collaboration.PickMismatch
            | Collaboration.AssumptionClosed
        >
    >;
    /**
     * Approves an assumption of a completed run of the session: it stands as the AI made it. The facilitator's; sends
     * nothing to the agent. Refused when the assumption was decided already (approved, or a later run took over the
     * run's requests, a pick among them).
     */
    approveAssumption(input: {
        readonly session: SessionId;
        readonly actor: Actor;
        readonly assumption: Collaboration.AssumptionRef;
    }): Promise<
        Result<
            Collaboration.AssumptionApproval,
            | Collaboration.FacilitatorOnly
            | Collaboration.SessionNotFound
            | Collaboration.SessionAlreadyClosed
            | Collaboration.RunNotFound
            | Collaboration.RunOfAnotherSession
            | Collaboration.RunNotApprovable
            | Collaboration.AssumptionNotFound
            | Collaboration.AssumptionClosed
        >
    >;
    /**
     * Claims the next queued run of the session for `leaseMs`, unless a run of the session is running or claimed. A run
     * that needs a capability the subscriber did not name (`capabilities`: a revert needs `revert`) is left queued:
     * `SubscriberOutdated`.
     */
    claimNextRun(input: {
        readonly session: SessionId;
        readonly owner: string;
        readonly leaseMs: number;
        readonly capabilities?: readonly string[];
    }): Promise<Result<Claimed, NothingQueued | RunInProgress | SubscriberOutdated>>;
    /** Extends a live lease by `leaseMs` from now. */
    heartbeat(input: { readonly run: AgentRunId; readonly token: string; readonly leaseMs: number }): Promise<Result<Lease, LeaseLost>>;
    /**
     * The running run held under the live lease `token`, read without changing anything (not even the lease): what the
     * agent reports of a run's activity is taken only from its lease's holder, while the run is running.
     */
    heldRunningRun(input: {
        readonly run: AgentRunId;
        readonly token: string;
    }): Promise<Result<Collaboration.RunningAgentRun, NotFound | LeaseLost | NotAllowed>>;
    /** Gives a claimed run back to the queue before it started. */
    releaseRun(input: { readonly run: AgentRunId; readonly token: string }): Promise<Result<Collaboration.QueuedAgentRun, NotFound | LeaseLost | NotAllowed>>;
    /** Starts a claimed run: the workspace now is its base revision (RunBase). */
    startRun(input: {
        readonly run: AgentRunId;
        readonly token: string;
    }): Promise<
        Result<
            { readonly run: Collaboration.RunningAgentRun; readonly base: Collaboration.RecordedRevision },
            NotFound | LeaseLost | NotAllowed | Collaboration.PathOutsideRoot
        >
    >;
    /**
     * Ends a running run with the agent's facts: the workspace now is its result revision (the base itself when
     * nothing changed), the diagnostics are compared with the base's, and the run success rule decides Completed or
     * Failed. The agent's reply is kept with a completed run, never used to decide. Calling it again with the same lease
     * returns the same run.
     */
    finishRun(input: {
        readonly run: AgentRunId;
        readonly token: string;
        readonly facts: RunFacts;
        readonly reply?: Collaboration.AgentReply;
    }): Promise<Result<Finished, NotFound | LeaseLost | NotAllowed | BlobMissing | Collaboration.PathOutsideRoot | Collaboration.InvalidReply>>;
    /** Ends a running run with the agent's question (plain text, and its structured reply when there is one). */
    askClarification(input: {
        readonly run: AgentRunId;
        readonly token: string;
        readonly question: Collaboration.Text;
        readonly reply?: Collaboration.AgentReply;
    }): Promise<
        Result<Ended<Collaboration.NeedsClarificationAgentRun>, NotFound | LeaseLost | NotAllowed | Collaboration.PathOutsideRoot | Collaboration.InvalidReply>
    >;
    /** Ends a running run that the agent declined (its reply says why); the workspace now is its result revision. */
    declineRun(input: {
        readonly run: AgentRunId;
        readonly token: string;
        readonly reply: Collaboration.AgentReply;
    }): Promise<Result<Ended<Collaboration.DeclinedAgentRun>, NotFound | LeaseLost | NotAllowed | Collaboration.PathOutsideRoot | Collaboration.InvalidReply>>;
    /** Ends a running run without a report (the agent's abnormal end). */
    failRun(input: {
        readonly run: AgentRunId;
        readonly token: string;
        readonly reason: Exclude<Collaboration.FailureReason, 'RuleNotMet'>;
    }): Promise<Result<Ended<Collaboration.FailedAgentRun>, NotFound | LeaseLost | NotAllowed>>;
    /** Cancels a queued or running run: the facilitator's. */
    cancelRun(input: {
        readonly run: AgentRunId;
        readonly actor: Actor;
    }): Promise<Result<Collaboration.CancelledAgentRun, NotFound | NotAllowed | Collaboration.FacilitatorOnly>>;
    /**
     * The recovery policy, at startup and periodically: a running run whose lease expired fails (LeaseExpired), a
     * queued run whose claim expired goes back to the queue. A run is never executed twice.
     */
    expireLeases(): Promise<{ readonly failed: readonly Collaboration.FailedAgentRun[]; readonly released: readonly AgentRunId[] }>;
    /**
     * Asks to revert the changes of a run of the session (one that changed files, not reverted yet nor being reverted):
     * the facilitator's. The facilitator's message `body` (what is reverted, for everyone) is sent as a revert request,
     * and queued as a run of its own behind the others, like any change (never refused for a run in progress). When its
     * turn comes, the server tries it mechanically first (`revertNext`).
     */
    requestRevert(input: {
        readonly session: SessionId;
        readonly actor: Actor;
        readonly run: AgentRunId;
        readonly body: Collaboration.Text;
    }): Promise<Result<RevertRequested, RequestRevertError>>;
    /**
     * The server's turn at the head of the session's queue, when it is a revert it has not tried yet (no agent needed).
     * It claims the run with its own lease (`SERVER_REVERT_OWNER`, for `leaseMs`), so that no agent claims it meanwhile;
     * reverses the reverted run's changes — its base and result revisions, file by file — onto the workspace as it is
     * then (`domain/revert.ts`); when that merges and the result checks as a run's would (no `.dt` error the workspace
     * does not have, every `.dtes` parses; formatted), writes it and records the run `Reverted` (with its base and result
     * revisions; unchanged when none of the run's changes was left). Otherwise the run stays queued for the agent, with
     * why (`RevertLeftToAgent`). Writing and recording are one transaction that first checks the lease is still the
     * server's: a revert cancelled meanwhile writes nothing.
     */
    revertNext(input: { readonly session: SessionId; readonly leaseMs: number }): Promise<Result<RevertOutcome, RevertNextError>>;
    /**
     * The runs a run reverts (its revert requests), each with what it changed, file by file: a unified diff per file while
     * they fit `MAX_REVERT_DIFF` characters, else the file's line counts. Measured now, from the revisions (for the run's start).
     */
    revertedRuns(input: { readonly run: AgentRunId }): Promise<Result<readonly RevertedRun[], NotFound>>;
    /** Records the workspace as it is now (Manual): to keep external changes before a restore, for instance. The facilitator's. */
    takeRevision(input: {
        readonly session: SessionId;
        readonly actor: Actor;
    }): Promise<Result<Collaboration.RecordedRevision, NotFound | Collaboration.FacilitatorOnly | Collaboration.PathOutsideRoot>>;
    /**
     * Writes a past revision back: refused while a run is running or claimed, or when the workspace has a symbolic
     * link, a path outside the root, or changes since the session's last revision — unless `recordExternalChanges`,
     * which records them first (Manual) and goes on. The workspace before is recorded first (PreRestore), then written,
     * validated and recorded (Restored). A failure once the write started is `ManualRecoveryNeeded` with the
     * pre-restore revision; nothing is recorded as restored then. Every attempt is kept in the operation log. The
     * facilitator's: anyone else is refused before the workspace is read.
     */
    restoreRevision(input: {
        readonly session: SessionId;
        readonly revision: RevisionId;
        readonly actor: Actor;
        readonly recordExternalChanges?: boolean;
    }): Promise<Result<Restored, RestoreError>>;
    /** Two revisions of the session side by side: each file's status and line diff (bounded), and both validations. */
    compareRevisions(input: {
        readonly session: SessionId;
        readonly before: RevisionId;
        readonly after: RevisionId;
    }): Promise<Result<Comparison, NotFound | Collaboration.RevisionOfAnotherSession | BlobMissing>>;
    /**
     * What a unit of work changed in the model's words: the `.dt` and `.dtes` elements the analyses of two revisions
     * differ by. Kept per pair of revisions (they never change), so a page that asks again is answered at once.
     */
    modelChanges(input: {
        readonly session: SessionId;
        readonly before: RevisionId;
        readonly after: RevisionId;
    }): Promise<Result<ElementChanges, NotFound | Collaboration.RevisionOfAnotherSession | BlobMissing>>;
    /**
     * The runs a run continues — those its messages reply to, then the one its answer answers, then the one it picked an
     * alternative of, as its frozen input names them — each with what it changed from its base to its result revision:
     * a unified diff while the diffs of all of them fit `maxDiff` characters, else the files it changed. Measured now, from the revisions (for the run's start).
     */
    previousRuns(input: { readonly run: AgentRunId; readonly maxDiff: number }): Promise<Result<readonly PreviousRun[], NotFound>>;
    /** The restores attempted in the session, in order. */
    restoreOperations(input: { readonly session: SessionId }): Promise<readonly RestoreOperation[]>;
    sessionState(input: { readonly session: SessionId }): Promise<Result<SessionState, NotFound>>;
    /** Validates the workspace now and tells, for each request of the session, whether its target still resolves. */
    targetStatuses(input: { readonly session: SessionId }): Promise<Result<TargetStatuses, NotFound | Collaboration.PathOutsideRoot>>;
    /** The open session of the workspace, if any: `dt session start` resumes it rather than starting another. */
    currentSession(): Promise<Collaboration.OpenSession | undefined>;
    /** At most `limit` events of the session after the outbox position `cursor` (0: from the start), in order. */
    eventsAfter(input: { readonly session: SessionId; readonly cursor: number; readonly limit: number }): Promise<readonly OutboxEntry[]>;
}

/** A failure of a restore after it started writing, with its cause (see `ManualRecoveryNeeded`). */
class RestoreFailure extends Error {
    constructor(
        readonly failure: string,
        message: string,
    ) {
        super(message);
    }
}

/** A refusal of the workspace's writer as the model's error. */
function writeRefusal(e: WriteRefusal): Collaboration.ExternalChangesSinceSnapshot | Collaboration.SymlinkInWorkspace | Collaboration.PathOutsideRoot {
    if (e.type === 'ExternalChangesSinceSnapshot') {
        const paths: Collaboration.WorkspacePath[] = [];
        for (const raw of e.paths) {
            const p = workspacePath(raw);
            if (!p.ok) return p.error;
            paths.push(p.value);
        }
        const changed = nonEmpty(paths);
        if (!changed) throw new Error('The workspace adapter refused a write for external changes without naming a path');
        return { type: 'ExternalChangesSinceSnapshot', paths: changed };
    }
    if (e.type === 'SymlinkInWorkspace') {
        const p = workspacePath(e.path);
        return p.ok ? { type: 'SymlinkInWorkspace', path: p.value } : p.error;
    }
    return { type: 'PathOutsideRoot', path: e.path };
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** What the mechanical revert of a run does to the workspace: leave it to the agent (why), write sources, or nothing. */
type RevertPlan =
    | { readonly kind: 'agent'; readonly obstacle: RevertObstacle }
    | { readonly kind: 'write'; readonly sources: ReadonlyMap<string, string> }
    | { readonly kind: 'nothing' };

/** The paths of the workspace among `raw` (a path that is not one is left out: it never comes from a snapshot). */
function workspacePaths(raw: readonly string[]): Collaboration.WorkspacePath[] {
    return raw.flatMap((r) => {
        const p = workspacePath(r);
        return p.ok ? [p.value] : [];
    });
}

/**
 * The mechanical revert of the run whose sources were `base` before and `result` after it, onto the workspace `scan`
 * (captured as `current`): the reverse merge (`domain/revert.ts`), checked as a run is (no `.dt` error the workspace
 * does not have now, every `.dtes` parses) and formatted as `dt fmt` formats a run's edits. Reads only; writes nothing.
 */
async function revertPlan(
    deps: Pick<CollaborationDeps, 'blobs' | 'validator' | 'formatter'>,
    base: Collaboration.Revision,
    result: Collaboration.Revision,
    scan: WorkspaceScan,
    current: Captured,
): Promise<RevertPlan> {
    const before = await sourcesOf(deps, base);
    const after = await sourcesOf(deps, result);
    if (!before.ok || !after.ok) return { kind: 'agent', obstacle: { kind: 'Unreadable' } };
    const texts = (files: readonly { readonly path: string; readonly bytes: Uint8Array }[]): Map<string, string> =>
        new Map(files.map((f) => [f.path, decoder.decode(f.bytes)]));
    const now = texts(scan.files);
    const merge = reverseChanges(texts(before.value), texts(after.value), now);
    if (merge.kind === 'nothing') return { kind: 'nothing' };
    if (merge.kind === 'conflict') return { kind: 'agent', obstacle: { kind: 'Conflict', paths: workspacePaths(merge.paths) } };
    const sources = new Map(now);
    for (const path of merge.remove) sources.delete(path);
    for (const [path, text] of merge.write) sources.set(path, text);
    const analysis = await deps.validator.validate([...sources].map(([path, text]) => ({ path, text })));
    const diff = diagnosticsDiff(current.analysis.diagnostics, analysis.diagnostics);
    if (diff.newDtErrors.length > 0 || diff.unparsedDtes.length > 0)
        return { kind: 'agent', obstacle: { kind: 'Check', newDtErrors: tally(diff.newDtErrors.length), unparsedDtes: workspacePaths(diff.unparsedDtes) } };
    // formatted as `dt fmt` formats a run's edits: the sources it wrote that parse
    const broken = new Set(analysis.diagnostics.filter((d) => d.code === 'SYNTAX').map((d) => d.file));
    for (const [path, text] of merge.write) if (deps.formatter && !broken.has(path)) sources.set(path, deps.formatter.format(path, text));
    const same = sources.size === now.size && [...sources].every(([path, text]) => now.get(path) === text);
    return same ? { kind: 'nothing' } : { kind: 'write', sources };
}

/** The success value of a command that cannot fail. */
function decided<T>(r: Result<T, never>): T {
    if (!r.ok) throw new Error('A command without errors returned one');
    return r.value;
}

/** The ended states of a run under its lease. */
type EndedRun = Collaboration.CompletedAgentRun | Collaboration.FailedAgentRun | Collaboration.NeedsClarificationAgentRun | Collaboration.DeclinedAgentRun;

export function createCollaboration(deps: CollaborationDeps): CollaborationUseCases {
    const { uow, clock, ids } = deps;
    const makeRestorable = restorableRevision(uow, deps.workspace);

    /** Records a captured snapshot as a new revision (take). */
    const record = (stores: Stores, session: SessionId, origin: Collaboration.RevisionOrigin, captured: Captured, at: Date): Collaboration.RecordedRevision => {
        const taken = revisionCommands.take({
            id: knownRevisionId(ids.newId()),
            session,
            origin,
            contentHash: captured.contentHash,
            files: captured.files,
            validation: captured.validation,
            takenAt: at,
        });
        // the hash is computed from the files, and the origins taken here are never Restored
        if (!taken.ok) throw new Error(`Taking a revision failed: ${taken.error.type}`);
        stores.revisions.save(taken.value.Recorded.aggregate);
        publish(stores, session, taken.value.Recorded.events, at);
        return taken.value.Recorded.aggregate;
    };

    /** The run held under the live lease `token`, or why not. */
    const held = (stores: Stores, run: AgentRunId, token: string, now: Date): Result<StoredRun, NotFound | LeaseLost> => {
        const stored = stores.runs.load(run);
        if (!stored) return err(notFound('AgentRun', run));
        if (!stored.lease || stored.lease.token !== token || stored.lease.expiresAt <= now) return err({ type: 'LeaseLost', run });
        return ok(stored);
    };

    /** A previous call that ended the run with `token`, if there was one: its run. */
    const replayOf = (stores: Stores, run: AgentRunId, token: string): EndedRun | undefined => {
        const stored = stores.runs.load(run);
        if (stored?.completedWith !== token) return undefined;
        const r = stored.run;
        return r.state === 'Completed' || r.state === 'Failed' || r.state === 'NeedsClarification' || r.state === 'Declined' ? r : undefined;
    };

    /** The running run held with `token` (before or after a snapshot taken between transactions). */
    const running = (stores: Stores, run: AgentRunId, token: string, now: Date): Result<Collaboration.RunningAgentRun, NotFound | LeaseLost | NotAllowed> => {
        const stored = held(stores, run, token, now);
        if (!stored.ok) return stored;
        const r = stored.value.run;
        return r.state === 'Running' ? ok(r) : err(notAllowed('end', r.state));
    };

    /** The result revision of a run: the base itself when the workspace did not change, a new RunResult otherwise. */
    const resultOf = (
        stores: Stores,
        run: Collaboration.RunningAgentRun,
        captured: Captured,
        at: Date,
    ): { revision: Collaboration.Revision; changed: boolean } => {
        const base = stores.revisions.load(run.baseRevision);
        if (base && base.contentHash === captured.contentHash) return { revision: base, changed: false };
        return { revision: record(stores, run.session, { kind: 'RunResult', run: run.id }, captured, at), changed: true };
    };

    /**
     * Ends a running run without `dt fmt`/`dt check` (a question, a decline): the workspace now is its result revision
     * (the base itself when nothing changed). The same call again with the same lease returns the same run.
     */
    const endWithoutChecks = async <S extends 'NeedsClarification' | 'Declined', R extends Extract<EndedRun, { state: S }>>(
        run: AgentRunId,
        token: string,
        state: S,
        decide: (
            r: Collaboration.RunningAgentRun,
            resultRevision: RevisionId,
            at: Date,
        ) => Result<{ readonly aggregate: R; readonly events: object }, Collaboration.InvalidReply>,
    ): Promise<Result<Ended<R>, NotFound | LeaseLost | NotAllowed | Collaboration.PathOutsideRoot | Collaboration.InvalidReply>> => {
        const before = await uow.transaction((stores): Result<EndedRun | undefined, NotFound | LeaseLost | NotAllowed> => {
            const replay = replayOf(stores, run, token);
            if (replay) return ok(replay);
            const r = running(stores, run, token, clock.now());
            return r.ok ? ok(undefined) : r;
        });
        if (!before.ok) return before;
        if (before.value) {
            const replay = before.value;
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the replayed run is in the state this call ends runs in
            if (replay.state === state) return ok({ run: replay as R, replayed: true });
            return err(notAllowed(state === 'Declined' ? 'decline' : 'askClarification', replay.state));
        }
        const captured = await capture(deps);
        if (!captured.ok) return captured;
        return uow.transaction((stores) => {
            const r = running(stores, run, token, clock.now());
            if (!r.ok) return r;
            const at = clock.now();
            // decided before the result is recorded: a refused reply records nothing
            const check = decide(r.value, r.value.baseRevision, at);
            if (!check.ok) return check;
            const result = resultOf(stores, r.value, captured.value, at);
            const decided = decide(r.value, result.revision.id, at);
            if (!decided.ok) return decided;
            stores.runs.save(decided.value.aggregate);
            stores.runs.endLease(run, token);
            publish(stores, r.value.session, decided.value.events, at);
            return ok({ run: decided.value.aggregate, replayed: false });
        });
    };

    // the element changes per pair of revisions, and the analyses of the latest revisions read (a unit's result is the
    // next one's base): revisions never change, so neither expires; the oldest goes first
    const changesKept = new Map<string, Promise<Result<ElementChanges, BlobMissing>>>();
    const analysesKept = new Map<RevisionId, Promise<Result<ValidationResult, BlobMissing>>>();
    const kept = <K, V>(map: Map<K, V>, key: K, limit: number, make: () => V): V => {
        const found = map.get(key);
        if (found !== undefined) return found;
        const made = make();
        map.set(key, made);
        const oldest = map.keys().next();
        if (map.size > limit && !oldest.done) map.delete(oldest.value);
        return made;
    };
    const analysisKept = (r: Collaboration.Revision): Promise<Result<ValidationResult, BlobMissing>> =>
        kept(analysesKept, r.id, ANALYSES_KEPT, () => analysisOf(deps, r));

    const useCases: Omit<CollaborationUseCases, keyof ConversationUseCases> = {
        async startSession({ facilitator, name, mode = 'Collab' }) {
            const captured = await capture(deps);
            if (!captured.ok) return captured;
            return uow.transaction((stores) => {
                const at = clock.now();
                const id = knownSessionId(ids.newId());
                const { Open } = decided(sessionCommands.start({ id, facilitator, name, mode, startedAt: at }));
                stores.sessions.save(Open.aggregate);
                publish(stores, id, Open.events, at);
                const revision = record(stores, id, { kind: 'SessionStart', session: id }, captured.value, at);
                return ok({ session: Open.aggregate, revision });
            });
        },

        async joinSession({ session, participant, name }) {
            return uow.transaction(async (stores) => {
                const active = await storeVerifications(stores).makeActiveSession(session);
                if (!active.ok) return active;
                const open = stores.sessions.load(session);
                if (open?.state !== 'Open') throw new Error(`Session ${session} is no longer open`);
                const at = clock.now();
                const joined = sessionCommands.join(open, { participant, name, joinedAt: at });
                if (!joined.ok) return joined.error.type === 'SoloSession' ? err(joined.error) : ok({ session: open, joined: false });
                stores.sessions.save(joined.value.Open.aggregate);
                publish(stores, session, joined.value.Open.events, at);
                return ok({ session: joined.value.Open.aggregate, joined: true });
            });
        },

        async closeSession({ session, actor }) {
            return uow.transaction((stores) => {
                const found = stores.sessions.load(session);
                if (!found) return err(notFound('Session', session));
                if (found.state !== 'Open') return err(notAllowed('close', found.state));
                const at = clock.now();
                const closed = sessionCommands.close(found, { closedByRole: actor.role, closedAt: at });
                if (!closed.ok) return closed;
                const { Closed } = closed.value;
                stores.sessions.save(Closed.aggregate);
                publish(stores, session, Closed.events, at);
                return ok(Closed.aggregate);
            });
        },

        async sendRequest(input) {
            const invalid = invalidTargets(input.targets);
            if (invalid) return err(invalid);
            return uow.transaction((stores) => sendIn(stores, { clock, ids }, input));
        },

        async setMark({ session, actor, target, sign, placed }) {
            const { participant, role } = actor;
            return uow.transaction(async (stores) => {
                const verify = storeVerifications(stores);
                const active = await verify.makeActiveSession(session);
                if (!active.ok) return active;
                if (!stores.sessions.load(session)?.participants.some((p) => p.id === participant)) return err({ type: 'NotAParticipant', participant });
                const open = await verify.makeOpenMarkTarget(target, session);
                if (!open.ok) return open;
                const runs = stores.runs.listBySession(session);
                const change = markChange(stores.marks.placedBy(session, participant), target, sign, placed, (t) => exclusiveGroup(t, runs));
                const at = clock.now();
                let made: Collaboration.PlacedMark | undefined;
                const events: Collaboration.PersistentEvent[] = [];
                if (change.place) {
                    const key = markKey(target);
                    if (
                        !reactionRoom(
                            stores.marks.placedBySession(session).filter((m) => markKey(m.target) === key),
                            sign,
                        )
                    )
                        return err({ type: 'ReactionLimitReached', limit: tally(MAX_REACTION_EMOJI) });
                    // decided before anything is removed: a refused mark changes nothing
                    const decided = markCommands.place({
                        id: knownMarkId(ids.newId()),
                        session: active.value,
                        participant,
                        role,
                        target: open.value,
                        sign,
                        placedAt: at,
                    });
                    if (!decided.ok) return decided;
                    made = decided.value.Placed.aggregate;
                    events.push(decided.value.Placed.events.MarkPlaced);
                }
                const removed: Collaboration.RemovedMark[] = [];
                for (const mark of change.remove) {
                    // the votes moved from are in the same run's question or assumption: open as the target is
                    const off = await verify.makeOpenMarkTarget(mark.target, session);
                    if (!off.ok) return off;
                    const { Removed } = decided(markCommands.remove(mark, { open: off.value, removedAt: at }));
                    stores.marks.save(Removed.aggregate);
                    removed.push(Removed.aggregate);
                    events.unshift(Removed.events.MarkRemoved);
                }
                if (made) stores.marks.save(made);
                stores.outbox.append(session, events, at);
                return ok({ placed: made, removed });
            });
        },

        async queueRun({ session, requests, note, answer, pick, actor }) {
            return uow.transaction(async (stores) => {
                const verify = storeVerifications(stores);
                const active = await verify.makeActiveSession(session);
                if (!active.ok) return active;
                let answered: Collaboration.Answer | undefined;
                if (answer) {
                    const to = stores.runs.load(answer.answerTo)?.run;
                    if (!to || to.session !== session) return err(notFound('AgentRun', answer.answerTo));
                    if (to.state !== 'NeedsClarification' || !to.reply) return err({ type: 'NothingToAnswer', run: to.id });
                    const resolved = resolveAnswer(answer.answer, to.id, to.reply);
                    if (!resolved.ok) return err({ type: 'InvalidAnswer', field: resolved.error.path, message: resolved.error.message });
                    answered = resolved.value;
                }
                let picked: Collaboration.AlternativePick | undefined;
                if (pick) {
                    const of = stores.runs.load(pick.pickOf)?.run;
                    if (!of) return err({ type: 'RunNotFound', run: pick.pickOf });
                    if (of.session !== session) return err({ type: 'RunOfAnotherSession', run: pick.pickOf });
                    const resolved = resolvePick(pick, of, requests);
                    if (!resolved.ok) return resolved;
                    // one decision per assumption: an approved one is not sent again with an alternative
                    if (approvalOf(stores.approvals.listBySession(session), of.id, pick.assumption)) return err({ type: 'AssumptionClosed', run: of.id });
                    picked = resolved.value;
                }
                // the input is frozen once per request; a request bundled twice is the command's DuplicateRequest
                return queueRequests(stores, ids, {
                    session: active.value,
                    requests,
                    extra: { ...(note !== undefined && { note }), ...(answered && { answer: answered }), ...(picked && { pick: picked }) },
                    queuedBy: actor.participant,
                    queuedByRole: actor.role,
                    at: clock.now(),
                });
            });
        },

        async approveAssumption({ session, actor, assumption }) {
            return uow.transaction(async (stores) => {
                const verify = storeVerifications(stores);
                const active = await verify.makeActiveSession(session);
                if (!active.ok) return active;
                const decidable = await verify.makeDecidableAssumption(assumption, session);
                if (!decidable.ok) return decidable;
                const at = clock.now();
                const approved = approvalCommands.approve({
                    id: knownAssumptionApprovalId(ids.newId()),
                    session: active.value,
                    assumption: decidable.value,
                    approvedBy: actor.participant,
                    approvedByRole: actor.role,
                    approvedAt: at,
                });
                if (!approved.ok) return approved;
                stores.approvals.save(approved.value.Approved.aggregate);
                publish(stores, session, approved.value.Approved.events, at);
                return ok(approved.value.Approved.aggregate);
            });
        },

        async claimNextRun({ session, owner, leaseMs, capabilities = [] }) {
            return uow.transaction((stores) => {
                const now = clock.now();
                const active = stores.runs.active(session, now);
                if (active) return err({ type: 'RunInProgress', run: active.run.id });
                const lease: Lease = { owner, token: ids.newId(), expiresAt: new Date(now.getTime() + leaseMs) };
                const id = stores.runs.claimNext(session, lease, now);
                if (id === undefined) return err({ type: 'NothingQueued' });
                const run = stores.runs.load(id)?.run;
                if (run?.state !== 'Queued') throw new Error(`The claimed run ${id} is not queued`);
                // a revert the server has not tried is the server's (`revertNext`): an agent never gets it before the
                // mechanical try. Released in this same transaction, so nobody ever sees it claimed; the agent is told
                // a run is in progress (the server takes it now) and is woken by RunReverted or RevertLeftToAgent
                if (awaitsServer(run)) {
                    stores.runs.release(id, lease.token);
                    return err({ type: 'RunInProgress', run: id });
                }
                // a subscriber that cannot run a revert would run it as a plain request: it stays queued for one that can
                if (isRevert(run) && !capabilities.includes(REVERT_CAPABILITY)) {
                    stores.runs.release(id, lease.token);
                    return err({
                        type: 'SubscriberOutdated',
                        run: id,
                        needs: REVERT_CAPABILITY,
                        message: 'The next run reverts a run: this subscriber cannot run it. Update DomainTrail and restart `dt session subscribe`.',
                    });
                }
                return ok({ run, lease });
            });
        },

        async heartbeat({ run, token, leaseMs }) {
            return uow.transaction((stores) => {
                const now = clock.now();
                const stored = held(stores, run, token, now);
                if (!stored.ok || !stored.value.lease) return err({ type: 'LeaseLost', run });
                const expiresAt = new Date(now.getTime() + leaseMs);
                if (!stores.runs.extend(run, token, now, expiresAt)) return err({ type: 'LeaseLost', run });
                return ok({ ...stored.value.lease, expiresAt });
            });
        },

        async heldRunningRun({ run, token }) {
            return uow.transaction((stores) => {
                const stored = held(stores, run, token, clock.now());
                if (!stored.ok) return stored;
                const r = stored.value.run;
                return r.state === 'Running' ? ok(r) : err(notAllowed('report', r.state));
            });
        },

        async releaseRun({ run, token }) {
            return uow.transaction((stores) => {
                const stored = held(stores, run, token, clock.now());
                if (!stored.ok) return stored;
                const r = stored.value.run;
                if (r.state !== 'Queued') return err(notAllowed('release', r.state));
                if (!stores.runs.release(run, token)) return err({ type: 'LeaseLost', run });
                return ok(r);
            });
        },

        async startRun({ run, token }) {
            const check = (stores: Stores): Result<Collaboration.QueuedAgentRun, NotFound | LeaseLost | NotAllowed> => {
                const stored = held(stores, run, token, clock.now());
                if (!stored.ok) return stored;
                const r = stored.value.run;
                return r.state === 'Queued' ? ok(r) : err(notAllowed('start', r.state));
            };
            const before = await uow.transaction(check);
            if (!before.ok) return before;
            const captured = await capture(deps);
            if (!captured.ok) return captured;
            return uow.transaction((stores) => {
                const queued = check(stores);
                if (!queued.ok) return queued;
                const at = clock.now();
                const base = record(stores, queued.value.session, { kind: 'RunBase', run }, captured.value, at);
                const { Running } = decided(agentRunCommands.start(queued.value, { baseRevision: base.id, startedAt: at }));
                stores.runs.save(Running.aggregate);
                publish(stores, Running.aggregate.session, Running.events, at);
                return ok({ run: Running.aggregate, base });
            });
        },

        async finishRun({ run, token, facts, reply }) {
            const before = await uow.transaction(
                (stores): Result<{ replay: EndedRun | undefined; base: Collaboration.Revision | undefined }, NotFound | LeaseLost | NotAllowed> => {
                    const replay = replayOf(stores, run, token);
                    if (replay) return ok({ replay, base: undefined });
                    const r = running(stores, run, token, clock.now());
                    if (!r.ok) return r;
                    return ok({ replay: undefined, base: stores.revisions.load(r.value.baseRevision) });
                },
            );
            if (!before.ok) return before;
            const { replay, base } = before.value;
            if (replay) {
                if (replay.state === 'NeedsClarification' || replay.state === 'Declined') return err(notAllowed('finish', replay.state));
                return ok({ run: replay, replayed: true, diff: undefined });
            }
            if (!base) throw new Error(`The base revision of run ${run} is missing`);
            const baseAnalysis = await analysisOf(deps, base);
            if (!baseAnalysis.ok) return baseAnalysis;
            const captured = await capture(deps);
            if (!captured.ok) return captured;
            const diff = diagnosticsDiff(baseAnalysis.value.diagnostics, captured.value.analysis.diagnostics);
            return uow.transaction((stores) => {
                const r = running(stores, run, token, clock.now());
                if (!r.ok) return r;
                const at = clock.now();
                const report = runReport(facts, diff);
                // the reply is checked before the result is recorded: a refused reply records nothing
                const check = agentRunCommands.finish(r.value, { report, resultRevision: r.value.baseRevision, changed: false, reply, finishedAt: at });
                if (!check.ok && check.error.type === 'InvalidReply') return err(check.error);
                const result = resultOf(stores, r.value, captured.value, at);
                const finished = agentRunCommands.finish(r.value, {
                    report,
                    resultRevision: result.revision.id,
                    changed: result.changed,
                    reply,
                    finishedAt: at,
                });
                // `changed` is decided from the revisions above, and the reply was checked
                if (!finished.ok) throw new Error(`Finishing run ${run} failed: ${finished.error.type}`);
                const outcome = finished.value.Completed ?? finished.value.Failed;
                stores.runs.save(outcome.aggregate);
                stores.runs.endLease(run, token);
                publish(stores, r.value.session, outcome.events, at);
                // the messages the run answered instead of editing were questions after all (decision 18)
                if (outcome.aggregate.state === 'Completed') overrideAnsweredTriages(stores, outcome.aggregate, at);
                return ok({ run: outcome.aggregate, replayed: false, diff });
            });
        },

        async askClarification({ run, token, question, reply }) {
            return endWithoutChecks(run, token, 'NeedsClarification', (r, revision, at) => {
                const asked = agentRunCommands.askClarification(r, { question, reply, resultRevision: revision, finishedAt: at });
                return asked.ok ? ok(asked.value.NeedsClarification) : asked;
            });
        },

        async declineRun({ run, token, reply }) {
            return endWithoutChecks(run, token, 'Declined', (r, revision, at) => {
                const declined = agentRunCommands.decline(r, { reply, resultRevision: revision, finishedAt: at });
                return declined.ok ? ok(declined.value.Declined) : declined;
            });
        },

        async failRun({ run, token, reason }) {
            return uow.transaction((stores) => {
                const replay = replayOf(stores, run, token);
                if (replay) return replay.state === 'Failed' ? ok({ run: replay, replayed: true }) : err(notAllowed('fail', replay.state));
                const r = running(stores, run, token, clock.now());
                if (!r.ok) return r;
                const at = clock.now();
                const failed = agentRunCommands.fail(r.value, { reason, finishedAt: at });
                if (!failed.ok) throw new Error(`Failing run ${run} failed: ${failed.error.type}`);
                stores.runs.save(failed.value.Failed.aggregate);
                stores.runs.endLease(run, token);
                publish(stores, r.value.session, failed.value.Failed.events, at);
                return ok({ run: failed.value.Failed.aggregate, replayed: false });
            });
        },

        async cancelRun({ run, actor }) {
            return uow.transaction((stores) => {
                const stored = stores.runs.load(run);
                if (!stored) return err(notFound('AgentRun', run));
                const r = stored.run;
                if (r.state !== 'Queued' && r.state !== 'Running') return err(notAllowed('cancel', r.state));
                const at = clock.now();
                const cancelled = agentRunCommands.cancel(r, { cancelledBy: actor.participant, cancelledByRole: actor.role, cancelledAt: at });
                if (!cancelled.ok) return cancelled;
                const { Cancelled } = cancelled.value;
                stores.runs.save(Cancelled.aggregate);
                stores.runs.endLease(run, undefined);
                publish(stores, r.session, Cancelled.events, at);
                return ok(Cancelled.aggregate);
            });
        },

        async expireLeases() {
            return uow.transaction((stores) => {
                const now = clock.now();
                const failed: Collaboration.FailedAgentRun[] = [];
                const released: AgentRunId[] = [];
                for (const { run } of stores.runs.expired(now)) {
                    if (run.state === 'Running') {
                        const f = agentRunCommands.fail(run, { reason: 'LeaseExpired', finishedAt: now });
                        if (!f.ok) throw new Error(`Failing run ${run.id} failed: ${f.error.type}`);
                        stores.runs.save(f.value.Failed.aggregate);
                        publish(stores, run.session, f.value.Failed.events, now);
                        failed.push(f.value.Failed.aggregate);
                    } else {
                        released.push(run.id);
                    }
                    stores.runs.endLease(run.id, undefined);
                }
                return { failed, released };
            });
        },

        async requestRevert({ session, actor, run, body }) {
            // requestRevert and queue require the facilitator: asked first
            if (actor.role !== 'Facilitator') return err({ type: 'FacilitatorOnly' });
            return uow.transaction(async (stores): Promise<Result<RevertRequested, RequestRevertError>> => {
                const verify = storeVerifications(stores);
                const active = await verify.makeActiveSession(session);
                if (!active.ok) return active;
                // not reverted, nor a revert of it queued or under way: a second one is refused
                const revertable = await verify.makeRevertableRun(run, session);
                if (!revertable.ok) return revertable;
                const at = clock.now();
                const sent = requestCommands.requestRevert({
                    id: knownRequestId(ids.newId()),
                    session: active.value,
                    author: actor.participant,
                    authorRole: actor.role,
                    body,
                    sentAt: at,
                    reverts: revertable.value,
                });
                if (!sent.ok) return sent;
                const request = sent.value.Sent.aggregate;
                stores.requests.save(request);
                publish(stores, session, sent.value.Sent.events, at);
                const pending = await verify.makePendingRequest(request.id, session);
                if (!pending.ok) throw new Error(`The revert request ${request.id} just sent is not pending: ${pending.error.type}`);
                // queued behind the others like any change; the server tries it first when its turn comes (revertNext)
                const queued = agentRunCommands.queue({
                    id: knownAgentRunId(ids.newId()),
                    session: active.value,
                    requests: [pending.value],
                    input: { requests: [{ request: request.id, author: request.author, targets: [], body: request.body, reverts: run }] },
                    queuedBy: actor.participant,
                    queuedByRole: actor.role,
                    queuedAt: at,
                });
                if (!queued.ok) throw new Error(`Queueing the revert of run ${run} failed: ${queued.error.type}`);
                stores.runs.enqueue(queued.value.Queued.aggregate);
                publish(stores, session, queued.value.Queued.events, at);
                return ok({ request, run: queued.value.Queued.aggregate });
            });
        },

        async revertNext({ session, leaseMs }) {
            // The race with an agent's claim: the server claims the head with a lease of its own, in one transaction
            // that also checks it is a revert not tried yet (else released at once, unseen). While the server holds the
            // lease, the session has a live lease: an agent's claim answers RunInProgress, and a restore is refused, as
            // for an agent's run. And an agent's claim never takes an untried revert (claimNextRun releases it), so the
            // two never process the same run.
            const claimed = await uow.transaction(
                (
                    stores,
                ): Result<
                    { run: Collaboration.QueuedAgentRun; lease: Lease; base: Collaboration.Revision; result: Collaboration.Revision },
                    NothingQueued | RunInProgress
                > => {
                    const now = clock.now();
                    const active = stores.runs.active(session, now);
                    if (active) return err({ type: 'RunInProgress', run: active.run.id });
                    const lease: Lease = { owner: SERVER_REVERT_OWNER, token: ids.newId(), expiresAt: new Date(now.getTime() + leaseMs) };
                    const id = stores.runs.claimNext(session, lease, now);
                    if (id === undefined) return err({ type: 'NothingQueued' });
                    const run = stores.runs.load(id)?.run;
                    if (run?.state !== 'Queued') throw new Error(`The claimed run ${id} is not queued`);
                    if (!awaitsServer(run)) {
                        stores.runs.release(id, lease.token);
                        return err({ type: 'NothingQueued' });
                    }
                    const reverted = revertedRunId(run);
                    const target = reverted && stores.runs.load(reverted)?.run;
                    const changes = target && revertableChanges(target);
                    const base = changes && stores.revisions.load(knownRevisionId(changes.base));
                    const result = changes && stores.revisions.load(knownRevisionId(changes.result));
                    if (!base || !result) throw new Error(`The revisions of run ${reverted ?? '?'}, reverted by ${id}, are missing`);
                    return ok({ run, lease, base, result });
                },
            );
            if (!claimed.ok) return claimed;
            const { run, lease } = claimed.value;
            const id = run.id;
            try {
                // the workspace now, kept as the revert's base; the run's sources before and after it
                const scan = await deps.workspace.read();
                const current = await capture(deps, scan);
                if (!current.ok) {
                    await uow.transaction((stores) => stores.runs.release(id, lease.token));
                    return current;
                }
                const plan = await revertPlan(deps, claimed.value.base, claimed.value.result, scan, current.value);

                // written and recorded in one transaction, once it is sure the revert is still the server's: a revert
                // cancelled meanwhile (or whose lease expired) writes nothing
                return await uow.transaction(async (stores): Promise<Result<RevertOutcome, RevertNextError>> => {
                    const stored = stores.runs.load(id);
                    if (stored?.run.state !== 'Queued' || stored.lease?.token !== lease.token) return err({ type: 'LeaseLost', run: id });
                    const queued = stored.run;
                    if (plan.kind === 'agent') {
                        const left = agentRunCommands.leaveToAgent(queued, { obstacle: plan.obstacle });
                        if (!left.ok) throw new Error(`Leaving the revert ${id} to the agent failed: ${left.error.type}`);
                        stores.runs.save(left.value.Queued.aggregate);
                        stores.runs.release(id, lease.token);
                        publish(stores, session, left.value.Queued.events, clock.now());
                        return ok({ kind: 'leftToAgent', run: left.value.Queued.aggregate, obstacle: plan.obstacle });
                    }
                    let after = current.value;
                    if (plan.kind === 'write') {
                        const files = [...plan.sources].map(([path, text]) => ({ path, bytes: encoder.encode(text) }));
                        const wrote = await deps.workspace.write(files, scan.files);
                        if (!wrote.ok) {
                            stores.runs.release(id, lease.token);
                            return err(writeRefusal(wrote.error));
                        }
                        const read = await capture(deps);
                        if (!read.ok) throw new Error(`The workspace reverted by ${id} could not be read back: ${read.error.path}`);
                        after = read.value;
                    }
                    const at = clock.now();
                    const base = record(stores, session, { kind: 'RunBase', run: id }, current.value, at);
                    // nothing left to revert: nothing written, the result is the base
                    const result = plan.kind === 'write' ? record(stores, session, { kind: 'RunResult', run: id }, after, at) : base;
                    const reverted = agentRunCommands.revert(queued, {
                        baseRevision: base.id,
                        resultRevision: result.id,
                        changed: plan.kind === 'write',
                        finishedAt: at,
                    });
                    if (!reverted.ok) throw new Error(`Recording the revert ${id} failed: ${reverted.error.type}`);
                    stores.runs.save(reverted.value.Reverted.aggregate);
                    stores.runs.endLease(id, lease.token);
                    publish(stores, session, reverted.value.Reverted.events, at);
                    return ok({ kind: 'reverted', run: reverted.value.Reverted.aggregate });
                });
            } catch (e) {
                // anything else: the lease goes, the revert stays queued and untried (tried again later)
                await uow.transaction((stores) => stores.runs.release(id, lease.token));
                throw e;
            }
        },

        async revertedRuns({ run }) {
            const found = await uow.transaction((stores) => {
                const r = stores.runs.load(run)?.run;
                if (!r) return undefined;
                const ids = [...new Set(r.input.requests.flatMap((q) => (q.reverts ? [q.reverts] : [])))];
                // of the run's session only (checked when the revert was asked)
                return ids.flatMap((id) => {
                    const u = stores.runs.load(id)?.run;
                    return u && u.session === r.session ? [u] : [];
                });
            });
            if (!found) return err(notFound('AgentRun', run));
            const out: RevertedRun[] = [];
            for (const u of found) {
                const changes = revertableChanges(u);
                if (!changes) {
                    out.push({ run: u, changes: { files: [], diffsOmitted: false } });
                    continue;
                }
                const before = knownRevisionId(changes.base);
                const after = knownRevisionId(changes.result);
                const c = await useCases.compareRevisions({ session: u.session, before, after });
                if (c.ok) {
                    const files = c.value.files.flatMap((f) =>
                        f.status === 'unchanged' ? [] : [{ path: f.path, status: f.status, ...(f.diff && { diff: f.diff }) }],
                    );
                    out.push({ run: u, changes: revertChanges(files) });
                    continue;
                }
                // the bytes are gone: the files by hash, without their diff
                const revisions = await uow.transaction((stores) => ({ a: stores.revisions.load(before), b: stores.revisions.load(after) }));
                const files =
                    revisions.a && revisions.b
                        ? compareFiles(revisions.a.files, revisions.b.files).flatMap((f) =>
                              f.status === 'unchanged' ? [] : [{ path: f.path, status: f.status }],
                          )
                        : [];
                out.push({ run: u, changes: { files, diffsOmitted: files.length > 0 } });
            }
            return ok(out);
        },

        async takeRevision({ session, actor }) {
            const exists = await uow.transaction((stores) => stores.sessions.load(session) !== undefined);
            if (!exists) return err(notFound('Session', session));
            // `take` records every snapshot, the system's too (the session's start, a run's base and result, a restore's
            // before): who may take one by hand is this use case's to check
            if (actor.role !== 'Facilitator') return err({ type: 'FacilitatorOnly' });
            const captured = await capture(deps);
            if (!captured.ok) return captured;
            return uow.transaction((stores) => ok(record(stores, session, { kind: 'Manual', takenBy: actor.participant }, captured.value, clock.now())));
        },

        async restoreRevision({ session, revision, actor, recordExternalChanges }) {
            const { participant: by, identity } = actor;
            const exists = await uow.transaction((stores) => stores.sessions.load(session) !== undefined);
            if (!exists) return err(notFound('Session', session));
            const recorded: { manual?: Collaboration.RecordedRevision; preRestore?: Collaboration.RecordedRevision } = {};
            /** Keeps the attempt in the operation log. */
            const log = (outcome: Pick<RestoreOperation, 'result' | 'reason' | 'detail' | 'restored'>): Promise<void> =>
                uow.transaction((stores) =>
                    stores.operations.recordRestore({
                        id: ids.newId(),
                        session,
                        at: clock.now(),
                        by,
                        ...(identity && { identity: { provider: identity.provider, subject: identity.subject } }),
                        revision,
                        ...(recorded.manual && { manual: recorded.manual.id }),
                        ...(recorded.preRestore && { preRestore: recorded.preRestore.id }),
                        ...outcome,
                    }),
                );
            const refused = async <E extends { readonly type: string }>(e: E): Promise<Result<never, E>> => {
                await log({ result: 'Refused', reason: e.type });
                return err(e);
            };
            const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

            let writing = false;
            try {
                // the restore command requires the facilitator (facilitatorRestores): asked first, before the workspace is
                // read or a revision recorded on the way
                if (actor.role !== 'Facilitator') return refused<Collaboration.FacilitatorOnly>({ type: 'FacilitatorOnly' });
                const busy = await uow.transaction((stores) => stores.runs.active(session, clock.now()));
                if (busy) return refused<RunInProgress>({ type: 'RunInProgress', run: busy.run.id });
                let restorable = await makeRestorable(revision, session);
                if (!restorable.ok && restorable.error.type === 'ExternalChangesSinceSnapshot' && recordExternalChanges) {
                    // the two-step: the external changes become a revision of their own, then the restore goes on
                    const captured = await capture(deps);
                    if (!captured.ok) return refused(captured.error);
                    recorded.manual = await uow.transaction((stores) => record(stores, session, { kind: 'Manual', takenBy: by }, captured.value, clock.now()));
                    restorable = await makeRestorable(revision, session);
                }
                if (!restorable.ok) return refused(restorable.error);
                const target = await uow.transaction((stores) => stores.revisions.load(revision));
                if (!target) return refused(notFound('Revision', revision));
                const sources = await sourcesOf(deps, target);
                if (!sources.ok) return refused(sources.error);

                // the workspace before, kept first: what the write expects to replace
                const before = await capture(deps);
                if (!before.ok) return refused(before.error);
                const preRestore = await uow.transaction((stores) =>
                    record(stores, session, { kind: 'PreRestore', restoring: revision }, before.value, clock.now()),
                );
                recorded.preRestore = preRestore;

                writing = true;
                const written = await deps.workspace.write(sources.value, before.value.files);
                if (!written.ok) {
                    // a refusal is made before anything is written, unless the workspace changed under the write
                    const now = await deps.workspace.read();
                    const was = new Map<string, string>(before.value.files.map((f) => [f.path, f.hash]));
                    const untouched = now.files.length === was.size && now.files.every((f) => was.get(f.path) === f.hash);
                    if (!untouched) throw new RestoreFailure('WriteRefused', `The write was refused (${written.error.type}) after it changed the workspace`);
                    writing = false;
                    return refused(writeRefusal(written.error));
                }

                const after = await capture(deps).catch((e: unknown) => {
                    throw new RestoreFailure('ReadBackFailed', message(e));
                });
                if (!after.ok) throw new RestoreFailure('ReadBackFailed', `A source is outside the root: ${after.error.path}`);
                if (after.value.contentHash !== target.contentHash)
                    throw new RestoreFailure('ContentDiffers', 'The workspace after the write is not the revision restored');
                const restored = await uow
                    .transaction((stores) => {
                        const at = clock.now();
                        const made = revisionCommands.restore({
                            id: knownRevisionId(ids.newId()),
                            session,
                            restoredFrom: restorable.value,
                            preRestore: preRestore.id,
                            contentHash: after.value.contentHash,
                            files: after.value.files,
                            validation: after.value.validation,
                            restoredByRole: actor.role,
                            takenAt: at,
                        });
                        if (!made.ok) throw new Error(`Recording the restore failed: ${made.error.type}`);
                        stores.revisions.save(made.value.Recorded.aggregate);
                        publish(stores, session, made.value.Recorded.events, at);
                        return made.value.Recorded.aggregate;
                    })
                    .catch((e: unknown) => {
                        throw new RestoreFailure('RecordFailed', message(e));
                    });
                await log({ result: 'Restored', restored: restored.id });
                return ok({ restored, preRestore, ...(recorded.manual && { manual: recorded.manual }) });
            } catch (e) {
                const preRestore = recorded.preRestore;
                if (!writing || !preRestore) {
                    await log({ result: 'Failed', reason: 'Error', detail: message(e) });
                    throw e;
                }
                const cause = e instanceof RestoreFailure ? e.failure : 'WriteFailed';
                const failure: ManualRecoveryNeeded = { type: 'ManualRecoveryNeeded', preRestore: preRestore.id, cause, message: message(e) };
                await log({ result: 'Failed', reason: cause, detail: failure.message });
                return err(failure);
            }
        },

        async compareRevisions({ session, before, after }) {
            const found = await uow.transaction((stores) => ({ a: stores.revisions.load(before), b: stores.revisions.load(after) }));
            for (const [id, r] of [
                [before, found.a],
                [after, found.b],
            ] as const) {
                if (!r) return err(notFound('Revision', id));
                if (r.session !== session) return err({ type: 'RevisionOfAnotherSession', revision: id });
            }
            const { a, b } = found;
            if (!a || !b) throw new Error('Both revisions were found above');
            const decoder = new TextDecoder();
            const textOf = async (path: Collaboration.WorkspacePath, hash: Collaboration.ContentHash | undefined): Promise<Result<string, BlobMissing>> => {
                if (hash === undefined) return ok('');
                const bytes = await deps.blobs.get(hash);
                return bytes ? ok(decoder.decode(bytes)) : err({ type: 'BlobMissing', path, hash });
            };
            const sizes = new Map<string, number>([...a.files, ...b.files].map((f) => [f.hash, f.bytes]));
            const files: ComparedFile[] = [];
            let left = MAX_COMPARISON_DIFF;
            let diffsOmitted = false;
            for (const f of compareFiles(a.files, b.files)) {
                if (f.status === 'unchanged') {
                    files.push(f);
                    continue;
                }
                // too little left for a hunk: the files from here on get no diff
                if (left < MIN_DIFF_ROOM) {
                    diffsOmitted = true;
                    files.push(f);
                    continue;
                }
                // a side too large is never read nor decoded: changed, diff omitted
                const large = [f.before, f.after].some((h) => h !== undefined && (sizes.get(h) ?? 0) > MAX_DIFF_BYTES);
                if (large) {
                    files.push({ ...f, diff: { kind: 'tooLarge' } });
                    continue;
                }
                const was = await textOf(f.path, f.before);
                if (!was.ok) return was;
                const is = await textOf(f.path, f.after);
                if (!is.ok) return is;
                const diff = lineDiff(was.value, is.value, left);
                if (diff.kind === 'diff') left -= diff.unified.length + 1;
                files.push({ ...f, diff });
            }
            return ok({ before: a, after: b, files, counts: statusCounts(files), diffsOmitted });
        },

        async modelChanges({ session, before, after }) {
            const found = await uow.transaction((stores) => ({ a: stores.revisions.load(before), b: stores.revisions.load(after) }));
            for (const [id, r] of [
                [before, found.a],
                [after, found.b],
            ] as const) {
                if (!r) return err(notFound('Revision', id));
                if (r.session !== session) return err({ type: 'RevisionOfAnotherSession', revision: id });
            }
            const { a, b } = found;
            if (!a || !b) throw new Error('Both revisions were found above');
            const changes = await kept(changesKept, `${a.id}>${b.id}`, CHANGES_KEPT, async (): Promise<Result<ElementChanges, BlobMissing>> => {
                const was = await analysisKept(a);
                const is = await analysisKept(b);
                // a blob missing now may be put back later: not kept
                if (!was.ok) analysesKept.delete(a.id);
                if (!is.ok) analysesKept.delete(b.id);
                if (!was.ok) return was;
                if (!is.ok) return is;
                return ok(elementChanges(was.value, is.value));
            });
            // a blob missing now may be put back later: not kept
            if (!changes.ok) changesKept.delete(`${a.id}>${b.id}`);
            return changes;
        },

        async previousRuns({ run, maxDiff }) {
            const found = await uow.transaction((stores) => {
                const r = stores.runs.load(run)?.run;
                if (!r) return undefined;
                // the runs named by the frozen input, of the run's session only (checked when the reply was sent)
                return previousRunIds(r.input).flatMap((id) => {
                    const p = stores.runs.load(id)?.run;
                    return p && p.session === r.session ? [p] : [];
                });
            });
            if (!found) return err(notFound('AgentRun', run));
            const compared: (ComparedChange[] | undefined)[] = [];
            for (const p of found) {
                const base = 'baseRevision' in p ? p.baseRevision : undefined;
                const result = 'resultRevision' in p ? p.resultRevision : undefined;
                if (!base || !result) {
                    compared.push(undefined);
                    continue;
                }
                const c = await useCases.compareRevisions({ session: p.session, before: base, after: result });
                if (c.ok) {
                    compared.push(
                        c.value.files.flatMap((f) => (f.status === 'unchanged' ? [] : [{ path: f.path, status: f.status, ...(f.diff && { diff: f.diff }) }])),
                    );
                    continue;
                }
                // the bytes are gone (or the revisions): the files by hash, without their diff
                const revisions = await uow.transaction((stores) => ({ a: stores.revisions.load(base), b: stores.revisions.load(result) }));
                compared.push(
                    revisions.a && revisions.b
                        ? compareFiles(revisions.a.files, revisions.b.files).flatMap((f) =>
                              f.status === 'unchanged' ? [] : [{ path: f.path, status: f.status }],
                          )
                        : undefined,
                );
            }
            const changes = boundChanges(compared, maxDiff);
            return ok(found.map((p, i) => ({ run: p, changes: changes[i] })));
        },

        async restoreOperations({ session }) {
            return uow.transaction((stores) => stores.operations.restores(session));
        },

        async sessionState({ session }) {
            return uow.transaction((stores) => {
                const found = stores.sessions.load(session);
                if (!found) return err(notFound('Session', session));
                return ok({
                    session: found,
                    requests: stores.requests.listBySession(session),
                    runs: stores.runs.listBySession(session),
                    revisions: stores.revisions.listBySession(session),
                    marks: stores.marks.placedBySession(session),
                    approvals: stores.approvals.listBySession(session),
                    triages: stores.triages.listBySession(session),
                    proposals: stores.proposals.listBySession(session),
                });
            });
        },

        async targetStatuses({ session }) {
            const requests = await uow.transaction((stores) => (stores.sessions.load(session) ? stores.requests.listBySession(session) : undefined));
            if (!requests) return err(notFound('Session', session));
            const captured = await capture(deps);
            if (!captured.ok) return captured;
            const scope = captured.value.analysis;
            return ok({
                contentHash: captured.value.contentHash,
                statuses: new Map(requests.map((r) => [r.id, r.targets.map((t) => targetStatus(t.target, scope))])),
            });
        },

        async currentSession() {
            // one open session per workspace: the oldest one if a store ever holds more
            return uow.transaction((stores) => stores.sessions.listOpen()[0]);
        },

        async eventsAfter({ session, cursor, limit }) {
            return uow.transaction((stores) => stores.outbox.readAfter(cursor, limit, session));
        },
    };
    return { ...useCases, ...createConversation(deps, { startSession: useCases.startSession, modelChanges: useCases.modelChanges }) };
}
