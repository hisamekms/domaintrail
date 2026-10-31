// The use cases of a collaboration session (ADR 0026): the application around the pure commands. Each turns its input
// into domain values (IDs and times from the ports, verified types from their factories), loads the aggregates in one
// transaction, rejects a state the command does not accept, calls the command, and on success saves the aggregate and
// appends its events to the outbox in the same transaction. Workspace snapshots are read and stored as blobs before
// the transaction that records them. Who may call which use case (facilitator, participant, the agent's credential)
// is decided by the caller (S4); the use cases take the participant as a fact.
import { Collaboration, eventList, err, ok, type Result } from '../generated/index.js';
import { agentRunCommands, requestCommands, revisionCommands, sessionCommands } from '../domain/commands.js';
import { nonEmpty, workspacePath } from '../domain/snapshot.js';
import { targetStatus, type TargetStatus } from '../domain/targets.js';
import { diagnosticsDiff, runReport, type DiagnosticsDiff, type RunFacts } from '../domain/validation.js';
import type { CollaborationDeps, Lease, StoredRun, Stores } from './ports.js';
import { analysisOf, capture, sourcesOf, type BlobMissing, type Captured } from './snapshots.js';
import { restorableRevision, storeVerifications } from './verifications.js';

type SessionId = Collaboration.SessionId;
type AgentRunId = Collaboration.AgentRunId;
type RevisionId = Collaboration.RevisionId;
type ParticipantId = Collaboration.ParticipantId;

// ---- Errors of the application (as opposed to those the domain decides) ----

export interface NotFound {
    readonly type: 'NotFound';
    readonly aggregate: 'Session' | 'Request' | 'AgentRun' | 'Revision';
    readonly id: string;
}

/** The aggregate is in a state the command does not accept: the contracts make this the caller's check. */
export interface NotAllowed {
    readonly type: 'NotAllowed';
    readonly command: string;
    readonly state: string;
}

export interface NotAParticipant {
    readonly type: 'NotAParticipant';
    readonly participant: ParticipantId;
}

/** A request's target breaks an invariant of `TargetSnapshot` or `SourceRange`. */
export interface InvalidTarget {
    readonly type: 'InvalidTarget';
    readonly violated: readonly string[];
}

export interface NoRequests {
    readonly type: 'NoRequests';
}

export interface NothingQueued {
    readonly type: 'NothingQueued';
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
}

/** Everything a session holds, for a page that shows it. */
export interface SessionState {
    readonly session: Collaboration.Session;
    readonly requests: readonly Collaboration.Request[];
    readonly runs: readonly Collaboration.AgentRun[];
    readonly revisions: readonly Collaboration.Revision[];
}

/** Whether each request's target still resolves in the workspace as it is now. */
export interface TargetStatuses {
    /** The content hash of the workspace the targets were resolved in. */
    readonly contentHash: Collaboration.ContentHash;
    readonly statuses: ReadonlyMap<Collaboration.RequestId, TargetStatus>;
}

export type RestoreError =
    | NotFound
    | RunInProgress
    | BlobMissing
    | Collaboration.RevisionNotFound
    | Collaboration.RevisionOfAnotherSession
    | Collaboration.SymlinkInWorkspace
    | Collaboration.PathOutsideRoot
    | Collaboration.ExternalChangesSinceSnapshot;

export interface CollaborationUseCases {
    /** Opens a session with its facilitator, and records the workspace as its first revision (SessionStart). */
    startSession(input: {
        readonly facilitator: ParticipantId;
        readonly name: Collaboration.DisplayName;
    }): Promise<Result<{ readonly session: Collaboration.OpenSession; readonly revision: Collaboration.RecordedRevision }, Collaboration.PathOutsideRoot>>;
    /** Admits a participant; one who already joined is not admitted again (`joined: false`). */
    joinSession(input: {
        readonly session: SessionId;
        readonly participant: ParticipantId;
        readonly name: Collaboration.DisplayName;
    }): Promise<
        Result<{ readonly session: Collaboration.OpenSession; readonly joined: boolean }, Collaboration.SessionNotFound | Collaboration.SessionAlreadyClosed>
    >;
    closeSession(input: { readonly session: SessionId }): Promise<Result<Collaboration.ClosedSession, NotFound | NotAllowed>>;
    sendRequest(input: {
        readonly session: SessionId;
        readonly author: ParticipantId;
        readonly target: Collaboration.TargetSnapshot;
        readonly body: Collaboration.Text;
    }): Promise<Result<Collaboration.SentRequest, Collaboration.SessionNotFound | Collaboration.SessionAlreadyClosed | NotAParticipant | InvalidTarget>>;
    dismissRequest(input: {
        readonly request: Collaboration.RequestId;
        readonly by: ParticipantId;
    }): Promise<Result<Collaboration.DismissedRequest, NotFound | NotAllowed>>;
    /** Bundles sent requests of the session into a queued run, freezing their content as its input. */
    queueRun(input: {
        readonly session: SessionId;
        readonly requests: readonly Collaboration.RequestId[];
        readonly note?: Collaboration.Text;
        readonly queuedBy: ParticipantId;
    }): Promise<
        Result<
            Collaboration.QueuedAgentRun,
            | Collaboration.SessionNotFound
            | Collaboration.SessionAlreadyClosed
            | Collaboration.RequestNotFound
            | Collaboration.RequestOfAnotherSession
            | Collaboration.RequestAlreadyDismissed
            | Collaboration.DuplicateRequest
            | Collaboration.InputMismatch
            | NoRequests
        >
    >;
    /** Claims the next queued run of the session for `leaseMs`, unless a run of the session is running or claimed. */
    claimNextRun(input: {
        readonly session: SessionId;
        readonly owner: string;
        readonly leaseMs: number;
    }): Promise<Result<Claimed, NothingQueued | RunInProgress>>;
    /** Extends a live lease by `leaseMs` from now. */
    heartbeat(input: { readonly run: AgentRunId; readonly token: string; readonly leaseMs: number }): Promise<Result<Lease, LeaseLost>>;
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
     * Failed. Calling it again with the same lease returns the same run.
     */
    finishRun(input: {
        readonly run: AgentRunId;
        readonly token: string;
        readonly facts: RunFacts;
    }): Promise<Result<Finished, NotFound | LeaseLost | NotAllowed | BlobMissing | Collaboration.PathOutsideRoot>>;
    askClarification(input: {
        readonly run: AgentRunId;
        readonly token: string;
        readonly question: Collaboration.Text;
    }): Promise<Result<Ended<Collaboration.NeedsClarificationAgentRun>, NotFound | LeaseLost | NotAllowed | Collaboration.PathOutsideRoot>>;
    /** Ends a running run without a report (the agent's abnormal end). */
    failRun(input: {
        readonly run: AgentRunId;
        readonly token: string;
        readonly reason: Exclude<Collaboration.FailureReason, 'RuleNotMet'>;
    }): Promise<Result<Ended<Collaboration.FailedAgentRun>, NotFound | LeaseLost | NotAllowed>>;
    cancelRun(input: { readonly run: AgentRunId; readonly by: ParticipantId }): Promise<Result<Collaboration.CancelledAgentRun, NotFound | NotAllowed>>;
    /**
     * The recovery policy, at startup and periodically: a running run whose lease expired fails (LeaseExpired), a
     * queued run whose claim expired goes back to the queue. A run is never executed twice.
     */
    expireLeases(): Promise<{ readonly failed: readonly Collaboration.FailedAgentRun[]; readonly released: readonly AgentRunId[] }>;
    /** Records the workspace as it is now (Manual): to keep external changes before a restore, for instance. */
    takeRevision(input: {
        readonly session: SessionId;
        readonly by: ParticipantId;
    }): Promise<Result<Collaboration.RecordedRevision, NotFound | Collaboration.PathOutsideRoot>>;
    confirmRevision(input: {
        readonly revision: RevisionId;
        readonly by: ParticipantId;
    }): Promise<Result<Collaboration.ConfirmedRevision, NotFound | NotAllowed>>;
    /**
     * Writes a past revision back: refused while a run is running, or when the workspace has a symbolic link, a path
     * outside the root, or changes since the session's last revision. The workspace before is recorded first
     * (PreRestore), then the restored sources (Restored).
     */
    restoreRevision(input: { readonly session: SessionId; readonly revision: RevisionId }): Promise<Result<Restored, RestoreError>>;
    sessionState(input: { readonly session: SessionId }): Promise<Result<SessionState, NotFound>>;
    /** Validates the workspace now and tells, for each request of the session, whether its target still resolves. */
    targetStatuses(input: { readonly session: SessionId }): Promise<Result<TargetStatuses, NotFound | Collaboration.PathOutsideRoot>>;
}

/** The success value of a command that cannot fail. */
function decided<T>(r: Result<T, never>): T {
    if (!r.ok) throw new Error('A command without errors returned one');
    return r.value;
}

const notFound = (aggregate: NotFound['aggregate'], id: string): NotFound => ({ type: 'NotFound', aggregate, id });
const notAllowed = (command: string, state: string): NotAllowed => ({ type: 'NotAllowed', command, state });

/** The ended states of a run under its lease. */
type EndedRun = Collaboration.CompletedAgentRun | Collaboration.FailedAgentRun | Collaboration.NeedsClarificationAgentRun;

export function createCollaboration(deps: CollaborationDeps): CollaborationUseCases {
    const { uow, clock, ids } = deps;
    const makeRestorable = restorableRevision(uow, deps.workspace);

    /** Appends a command's events to the outbox of its session. */
    const publish = (stores: Stores, session: SessionId, events: object, at: Date): void => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every event of the collaboration model is persistent: `events` is a command's events object
        stores.outbox.append(session, eventList(events) as readonly Collaboration.PersistentEvent[], at);
    };

    /** Records a captured snapshot as a new revision (take). */
    const record = (stores: Stores, session: SessionId, origin: Collaboration.RevisionOrigin, captured: Captured, at: Date): Collaboration.RecordedRevision => {
        const taken = revisionCommands.take(
            Collaboration.makeRevisionId(ids.newId()),
            session,
            origin,
            captured.contentHash,
            captured.files,
            captured.validation,
            at,
        );
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
        return r.state === 'Completed' || r.state === 'Failed' || r.state === 'NeedsClarification' ? r : undefined;
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

    const useCases: CollaborationUseCases = {
        async startSession({ facilitator, name }) {
            const captured = await capture(deps);
            if (!captured.ok) return captured;
            return uow.transaction((stores) => {
                const at = clock.now();
                const id = Collaboration.makeSessionId(ids.newId());
                const { Open } = decided(sessionCommands.start(id, facilitator, name, at));
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
                const joined = sessionCommands.join(open, participant, name, at);
                if (!joined.ok) return ok({ session: open, joined: false });
                stores.sessions.save(joined.value.Open.aggregate);
                publish(stores, session, joined.value.Open.events, at);
                return ok({ session: joined.value.Open.aggregate, joined: true });
            });
        },

        async closeSession({ session }) {
            return uow.transaction((stores) => {
                const found = stores.sessions.load(session);
                if (!found) return err(notFound('Session', session));
                if (found.state !== 'Open') return err(notAllowed('close', found.state));
                const at = clock.now();
                const { Closed } = decided(sessionCommands.close(found, at));
                stores.sessions.save(Closed.aggregate);
                publish(stores, session, Closed.events, at);
                return ok(Closed.aggregate);
            });
        },

        async sendRequest({ session, author, target, body }) {
            const violated = [...Collaboration.checkTargetSnapshot(target), ...(target.range ? Collaboration.checkSourceRange(target.range) : [])];
            if (violated.length) return err({ type: 'InvalidTarget', violated });
            return uow.transaction(async (stores) => {
                const active = await storeVerifications(stores).makeActiveSession(session);
                if (!active.ok) return active;
                if (!stores.sessions.load(session)?.participants.some((p) => p.id === author)) return err({ type: 'NotAParticipant', participant: author });
                const at = clock.now();
                const { Sent } = decided(requestCommands.send(Collaboration.makeRequestId(ids.newId()), active.value, author, target, body, at));
                stores.requests.save(Sent.aggregate);
                publish(stores, session, Sent.events, at);
                return ok(Sent.aggregate);
            });
        },

        async dismissRequest({ request, by }) {
            return uow.transaction((stores) => {
                const found = stores.requests.load(request);
                if (!found) return err(notFound('Request', request));
                if (found.state !== 'Sent') return err(notAllowed('dismiss', found.state));
                const at = clock.now();
                const { Dismissed } = decided(requestCommands.dismiss(found, by, at));
                stores.requests.save(Dismissed.aggregate);
                publish(stores, found.session, Dismissed.events, at);
                return ok(Dismissed.aggregate);
            });
        },

        async queueRun({ session, requests, note, queuedBy }) {
            return uow.transaction(async (stores) => {
                const verify = storeVerifications(stores);
                const active = await verify.makeActiveSession(session);
                if (!active.ok) return active;
                const pending: Collaboration.PendingRequest[] = [];
                const frozen: Collaboration.FrozenRequest[] = [];
                for (const id of requests) {
                    const p = await verify.makePendingRequest(id, session);
                    if (!p.ok) return p;
                    pending.push(p.value);
                    const r = stores.requests.load(id);
                    // the input is frozen once per request; a request bundled twice is the command's DuplicateRequest
                    if (r && !frozen.some((f) => f.request === id)) frozen.push({ request: id, author: r.author, target: r.target, body: r.body });
                }
                const bundled = nonEmpty(pending);
                const input = nonEmpty(frozen);
                if (!bundled || !input) return err({ type: 'NoRequests' });
                const at = clock.now();
                const queued = agentRunCommands.queue(
                    Collaboration.makeAgentRunId(ids.newId()),
                    active.value,
                    bundled,
                    note === undefined ? { requests: input } : { requests: input, note },
                    queuedBy,
                    at,
                );
                if (!queued.ok) return queued;
                stores.runs.enqueue(queued.value.Queued.aggregate);
                publish(stores, session, queued.value.Queued.events, at);
                return ok(queued.value.Queued.aggregate);
            });
        },

        async claimNextRun({ session, owner, leaseMs }) {
            return uow.transaction((stores) => {
                const now = clock.now();
                const active = stores.runs.active(session, now);
                if (active) return err({ type: 'RunInProgress', run: active.run.id });
                const lease: Lease = { owner, token: ids.newId(), expiresAt: new Date(now.getTime() + leaseMs) };
                const id = stores.runs.claimNext(session, lease, now);
                if (id === undefined) return err({ type: 'NothingQueued' });
                const run = stores.runs.load(id)?.run;
                if (run?.state !== 'Queued') throw new Error(`The claimed run ${id} is not queued`);
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
                const { Running } = decided(agentRunCommands.start(queued.value, base.id, at));
                stores.runs.save(Running.aggregate);
                publish(stores, Running.aggregate.session, Running.events, at);
                return ok({ run: Running.aggregate, base });
            });
        },

        async finishRun({ run, token, facts }) {
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
                if (replay.state === 'NeedsClarification') return err(notAllowed('finish', replay.state));
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
                const result = resultOf(stores, r.value, captured.value, at);
                const finished = agentRunCommands.finish(r.value, runReport(facts, diff), result.revision.id, result.changed, at);
                // `changed` is decided from the revisions above
                if (!finished.ok) throw new Error(`Finishing run ${run} failed: ${finished.error.type}`);
                const outcome = finished.value.Completed ?? finished.value.Failed;
                stores.runs.save(outcome.aggregate);
                stores.runs.endLease(run, token);
                publish(stores, r.value.session, outcome.events, at);
                return ok({ run: outcome.aggregate, replayed: false, diff });
            });
        },

        async askClarification({ run, token, question }) {
            const before = await uow.transaction((stores): Result<EndedRun | undefined, NotFound | LeaseLost | NotAllowed> => {
                const replay = replayOf(stores, run, token);
                if (replay) return ok(replay);
                const r = running(stores, run, token, clock.now());
                return r.ok ? ok(undefined) : r;
            });
            if (!before.ok) return before;
            if (before.value) {
                if (before.value.state !== 'NeedsClarification') return err(notAllowed('askClarification', before.value.state));
                return ok({ run: before.value, replayed: true });
            }
            const captured = await capture(deps);
            if (!captured.ok) return captured;
            return uow.transaction((stores) => {
                const r = running(stores, run, token, clock.now());
                if (!r.ok) return r;
                const at = clock.now();
                const result = resultOf(stores, r.value, captured.value, at);
                const { NeedsClarification } = decided(agentRunCommands.askClarification(r.value, question, result.revision.id, at));
                stores.runs.save(NeedsClarification.aggregate);
                stores.runs.endLease(run, token);
                publish(stores, r.value.session, NeedsClarification.events, at);
                return ok({ run: NeedsClarification.aggregate, replayed: false });
            });
        },

        async failRun({ run, token, reason }) {
            return uow.transaction((stores) => {
                const replay = replayOf(stores, run, token);
                if (replay) return replay.state === 'Failed' ? ok({ run: replay, replayed: true }) : err(notAllowed('fail', replay.state));
                const r = running(stores, run, token, clock.now());
                if (!r.ok) return r;
                const at = clock.now();
                const failed = agentRunCommands.fail(r.value, reason, at);
                if (!failed.ok) throw new Error(`Failing run ${run} failed: ${failed.error.type}`);
                stores.runs.save(failed.value.Failed.aggregate);
                stores.runs.endLease(run, token);
                publish(stores, r.value.session, failed.value.Failed.events, at);
                return ok({ run: failed.value.Failed.aggregate, replayed: false });
            });
        },

        async cancelRun({ run, by }) {
            return uow.transaction((stores) => {
                const stored = stores.runs.load(run);
                if (!stored) return err(notFound('AgentRun', run));
                const r = stored.run;
                if (r.state !== 'Queued' && r.state !== 'Running') return err(notAllowed('cancel', r.state));
                const at = clock.now();
                const { Cancelled } = decided(agentRunCommands.cancel(r, by, at));
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
                        const f = agentRunCommands.fail(run, 'LeaseExpired', now);
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

        async takeRevision({ session, by }) {
            const exists = await uow.transaction((stores) => stores.sessions.load(session) !== undefined);
            if (!exists) return err(notFound('Session', session));
            const captured = await capture(deps);
            if (!captured.ok) return captured;
            return uow.transaction((stores) => ok(record(stores, session, { kind: 'Manual', takenBy: by }, captured.value, clock.now())));
        },

        async confirmRevision({ revision, by }) {
            return uow.transaction((stores) => {
                const found = stores.revisions.load(revision);
                if (!found) return err(notFound('Revision', revision));
                if (found.state !== 'Recorded') return err(notAllowed('confirm', found.state));
                const at = clock.now();
                const { Confirmed } = decided(revisionCommands.confirm(found, by, at));
                stores.revisions.save(Confirmed.aggregate);
                publish(stores, found.session, Confirmed.events, at);
                return ok(Confirmed.aggregate);
            });
        },

        async restoreRevision({ session, revision }) {
            const busy = await uow.transaction((stores) => {
                if (!stores.sessions.load(session)) return err(notFound('Session', session));
                const active = stores.runs.active(session, clock.now());
                return active ? err<RunInProgress>({ type: 'RunInProgress', run: active.run.id }) : ok(undefined);
            });
            if (!busy.ok) return busy;
            const restorable = await makeRestorable(revision, session);
            if (!restorable.ok) return restorable;
            const target = await uow.transaction((stores) => stores.revisions.load(revision));
            if (!target) return err(notFound('Revision', revision));
            const sources = await sourcesOf(deps, target);
            if (!sources.ok) return sources;

            // the workspace before, kept first: what the write expects to replace
            const before = await capture(deps);
            if (!before.ok) return before;
            const preRestore = await uow.transaction((stores) =>
                record(stores, session, { kind: 'PreRestore', restoring: revision }, before.value, clock.now()),
            );

            const written = await deps.workspace.write(sources.value, before.value.files);
            if (!written.ok) {
                const e = written.error;
                if (e.type === 'ExternalChangesSinceSnapshot') {
                    const paths: Collaboration.WorkspacePath[] = [];
                    for (const raw of e.paths) {
                        const p = workspacePath(raw);
                        if (!p.ok) return p;
                        paths.push(p.value);
                    }
                    const changed = nonEmpty(paths);
                    if (!changed) throw new Error('The workspace adapter refused a write for external changes without naming a path');
                    return err({ type: 'ExternalChangesSinceSnapshot', paths: changed });
                }
                if (e.type === 'SymlinkInWorkspace') {
                    const p = workspacePath(e.path);
                    return p.ok ? err({ type: 'SymlinkInWorkspace', path: p.value }) : p;
                }
                return err({ type: 'PathOutsideRoot', path: e.path });
            }

            const after = await capture(deps);
            if (!after.ok) return after;
            return uow.transaction((stores) => {
                const at = clock.now();
                const id = Collaboration.makeRevisionId(ids.newId());
                const restored = revisionCommands.restore(
                    id,
                    session,
                    restorable.value,
                    preRestore.id,
                    after.value.contentHash,
                    after.value.files,
                    after.value.validation,
                    at,
                );
                if (!restored.ok) throw new Error(`Recording the restore failed: ${restored.error.type}`);
                stores.revisions.save(restored.value.Recorded.aggregate);
                publish(stores, session, restored.value.Recorded.events, at);
                return ok({ restored: restored.value.Recorded.aggregate, preRestore });
            });
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
                statuses: new Map(requests.map((r) => [r.id, targetStatus(r.target.target, scope)])),
            });
        },
    };
    return useCases;
}
