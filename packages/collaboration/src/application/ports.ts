// The ports of the collaboration application (ADR 0025's rule: defined on the consumer's side, implemented
// structurally by the adapters). The stores are synchronous and used inside one transaction of a `UnitOfWork`; the
// workspace, the blobs and the validator are asynchronous and used between transactions, never inside one.
import type { Diagnostic } from '@domaintrail/modeling/core/diagnostics';
import type { DomainModel } from '@domaintrail/modeling/model/model';
import type { Storming } from '@domaintrail/modeling/storming/ir';
import type { Collaboration } from '../generated/index.js';
import type { Identity, IdentityKey } from './identity.js';

type SessionId = Collaboration.SessionId;
type AgentRunId = Collaboration.AgentRunId;

export interface Clock {
    now(): Date;
}

/** New IDs: a UUID each time. */
export interface IdGenerator {
    newId(): string;
}

/** Secrets: a new random token each time (at least 256 bits, URL-safe), for links, cookies and credentials. */
export interface SecretGenerator {
    newSecret(): string;
}

export interface SessionRepository {
    load(id: SessionId): Collaboration.Session | undefined;
    /** Inserts or replaces the session. */
    save(session: Collaboration.Session): void;
    /** The sessions still open, oldest first (a workspace has at most one; see `currentSession`). */
    listOpen(): Collaboration.OpenSession[];
}

export interface RequestRepository {
    load(id: Collaboration.RequestId): Collaboration.Request | undefined;
    /** Inserts or replaces the request. */
    save(request: Collaboration.Request): void;
    /** The requests of a session, in the order they were sent. */
    listBySession(session: SessionId): Collaboration.Request[];
}

/** A claim on a run: who holds it, its secret token, and until when. */
export interface Lease {
    readonly owner: string;
    readonly token: string;
    readonly expiresAt: Date;
}

/** A run as the queue keeps it: the aggregate, its lease while claimed, the token it was completed with. */
export interface StoredRun {
    readonly run: Collaboration.AgentRun;
    readonly lease: Lease | undefined;
    /** The lease token of the call that ended the run (finish, askClarification, fail): a repeated call is recognized. */
    readonly completedWith: string | undefined;
}

/**
 * The agent runs of the sessions, in queue order, with their leases. One run of a session at a time holds a live
 * lease or is running (`serial`); the store enforces it where it saves (a unique index), the claim checks it.
 */
export interface RunQueue {
    /** Adds a queued run at the end of its session's queue, with the requests it bundles. */
    enqueue(run: Collaboration.QueuedAgentRun): void;
    load(id: AgentRunId): StoredRun | undefined;
    /** Replaces a run's aggregate (its new state); the lease is kept. */
    save(run: Collaboration.AgentRun): void;
    /** The runs of a session, in queue order. */
    listBySession(session: SessionId): Collaboration.AgentRun[];
    /** The run of the session that is running or holds a live lease at `now`, if any. */
    active(session: SessionId, now: Date): StoredRun | undefined;
    /**
     * Claims the first queued run of the session without a live lease, when no run of the session is active: one
     * atomic update. `undefined` when there is none or another run is active.
     */
    claimNext(session: SessionId, lease: Lease, now: Date): AgentRunId | undefined;
    /** Extends the live lease held with `token` to `expiresAt`; false when it is lost (expired, released, ended, another token). */
    extend(id: AgentRunId, token: string, now: Date, expiresAt: Date): boolean;
    /** Ends the lease held with `token` of a queued run (it can be claimed again); false when it is not held. */
    release(id: AgentRunId, token: string): boolean;
    /** Ends a run's lease, recording the token it ended with (`undefined`: ended by the facilitator or the recovery). */
    endLease(id: AgentRunId, completedWith: string | undefined): void;
    /** The runs whose lease expired at `now` (running, or claimed while queued). */
    expired(now: Date): StoredRun[];
}

export interface RevisionStore {
    load(id: Collaboration.RevisionId): Collaboration.Revision | undefined;
    /** Inserts or replaces the revision. */
    save(revision: Collaboration.Revision): void;
    /** The revisions of a session, in the order they were taken. */
    listBySession(session: SessionId): Collaboration.Revision[];
    /** The revision of the session taken last. */
    latest(session: SessionId): Collaboration.Revision | undefined;
}

/** An event appended to the outbox, with its position: the cursor of a subscriber (SSE event ID). */
export interface OutboxEntry {
    readonly seq: number;
    readonly session: SessionId;
    readonly event: Collaboration.PersistentEvent;
    readonly recordedAt: Date;
}

/** The events of the commands, appended in the transaction that saves their aggregates. */
export interface EventOutbox {
    append(session: SessionId, events: readonly Collaboration.PersistentEvent[], recordedAt: Date): void;
    /** At most `limit` entries after `cursor` (0: from the start), in order; of one session when given. */
    readAfter(cursor: number, limit: number, session?: SessionId): OutboxEntry[];
}

/** A sign-in of the `dev` identity mode: the session cookie's hash and the identity it stands for. */
export interface SignIn {
    readonly session: SessionId;
    readonly identity: Identity;
}

/**
 * Who may act in a session, outside the model (technical, ADR 0026): the one-time facilitator links, the identity
 * bound to the facilitator, and the sign-ins of the `dev` mode. Secrets are kept only as their SHA-256.
 */
export interface AccessStore {
    addLink(codeHash: string, session: SessionId, expiresAt: Date): void;
    /** Marks a link used when it is unused and not expired at `now`: the session it is for; `undefined` otherwise. */
    useLink(codeHash: string, now: Date): SessionId | undefined;
    /** The identity that holds the facilitator role of the session, if one claimed it. */
    facilitator(session: SessionId): IdentityKey | undefined;
    setFacilitator(session: SessionId, identity: IdentityKey, at: Date): void;
    addSignIn(tokenHash: string, signIn: SignIn, at: Date): void;
    /** The sign-in of a cookie's hash, unless it was revoked. */
    signIn(tokenHash: string): SignIn | undefined;
    /** Revokes one sign-in; false when there was none (or it was revoked already). */
    revokeSignIn(tokenHash: string, at: Date): boolean;
    /** Revokes every sign-in of the session: the identities they stood for. */
    revokeSignIns(session: SessionId, at: Date): IdentityKey[];
}

/** The stores, as one transaction sees them. */
export interface Stores {
    readonly sessions: SessionRepository;
    readonly requests: RequestRepository;
    readonly runs: RunQueue;
    readonly revisions: RevisionStore;
    readonly outbox: EventOutbox;
    readonly access: AccessStore;
}

export interface UnitOfWork {
    /**
     * Runs `work` in one transaction: committed when it returns, rolled back when it throws. Transactions run one at a
     * time; `work` must not wait for anything but the stores (no workspace or blob I/O inside).
     */
    transaction<T>(work: (stores: Stores) => T | Promise<T>): Promise<T>;
}

/** The bytes of the files of snapshots, by content hash: storing the same content twice keeps one copy. */
export interface SnapshotBlobs {
    put(files: readonly { readonly hash: string; readonly bytes: Uint8Array }[]): Promise<void>;
    /** The bytes stored under `hash`; `undefined` when there are none (or they no longer have that hash). */
    get(hash: string): Promise<Uint8Array | undefined>;
}

/** A source of the workspace as read: its path relative to the root (`/`-separated), bytes and SHA-256 (hex). */
export interface ScannedFile {
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly hash: string;
}

/** The sources of the workspace (`sources` globs, `.dt` and `.dtes`), and the symbolic links among them, not read. */
export interface WorkspaceScan {
    readonly files: readonly ScannedFile[];
    readonly symlinks: readonly string[];
}

/** Why a write of a snapshot to the workspace was refused; nothing was written. */
export type WriteRefusal =
    | { readonly type: 'SymlinkInWorkspace'; readonly path: string }
    | { readonly type: 'PathOutsideRoot'; readonly path: string }
    | { readonly type: 'ExternalChangesSinceSnapshot'; readonly paths: readonly string[] };

/** The sources of the workspace on disk. Paths are plain strings here: the application makes them `WorkspacePath`s. */
export interface WorkspaceSnapshot {
    read(): Promise<WorkspaceScan>;
    /**
     * Makes the sources exactly `files`: writes each (a temporary file renamed into place) and removes the other
     * sources. Refused when a path is outside the root or goes through a symbolic link, or when the sources are no
     * longer `expected` (changed since that snapshot).
     */
    write(
        files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
        expected: readonly { readonly path: string; readonly hash: string }[],
    ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: WriteRefusal }>;
}

/** The analysis of a snapshot's sources. */
export interface ValidationResult {
    /** The diagnostics of the `.dt` and `.dtes` sources. */
    readonly diagnostics: readonly Diagnostic[];
    /** The Typed Model; absent when the `.dt` sources do not parse. */
    readonly model: DomainModel | undefined;
    /** The stormings of the `.dtes` files that parse. */
    readonly stormings: readonly Storming[];
    /** Whether every `.dtes` file parses. */
    readonly stormingsComplete: boolean;
}

/** Validates sources as `dt check` does (`analyze`). */
export interface ModelValidator {
    validate(sources: readonly { readonly path: string; readonly text: string }[]): Promise<ValidationResult>;
}

/** Everything the use cases need. */
export interface CollaborationDeps {
    readonly uow: UnitOfWork;
    readonly workspace: WorkspaceSnapshot;
    readonly blobs: SnapshotBlobs;
    readonly validator: ModelValidator;
    readonly clock: Clock;
    readonly ids: IdGenerator;
}
