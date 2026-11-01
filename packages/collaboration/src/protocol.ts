// The messages of a collaboration session (ADR 0026) between the server and its two kinds of clients: the page
// (REST under `/api/session/`, and the WebSocket next to the Live View's `type: 'update'`) and the agent subscriber
// (the agent API on its own loopback listener: REST and an SSE stream). Types only, shared by presentation, the page
// (S5) and the subscriber (S6); what goes over the wire is JSON, so a `Date` arrives as an ISO string (`Json<T>`).
import type { FileComparison, FileStatus, LineDiff } from './domain/compare.js';
import type { PreviousRunChanges } from './domain/previous-runs.js';
import type { Collaboration } from './generated/index.js';
import type { Classification } from './application/classifier.js';

export type { Classification };

/** A branded string or number of the generated code as plain JSON: the brand is a promise checked on the server. */
type Unbranded<T> = T extends string & { readonly __domain: string } ? string : T extends number & { readonly __domain: string } ? number : T;

/** A value as JSON carries it: dates become ISO strings, branded values plain strings and numbers. */
export type Json<T> = T extends Date ? string : T extends string | number | boolean | null | undefined ? Unbranded<T> : { readonly [K in keyof T]: Json<T[K]> };

export type Role = 'facilitator' | 'participant';

/** A participant as other participants see them: no e-mail. */
export interface PublicParticipant {
    readonly id: Collaboration.ParticipantId;
    readonly name: string;
    readonly role: Role;
    readonly avatarUrl?: string;
}

/** `GET /api/session/me`: who the page is signed in as. */
export interface Me {
    readonly session: Collaboration.SessionId;
    readonly participant: PublicParticipant;
    readonly identity: { readonly provider: 'dev' | 'access'; readonly displayName: string };
}

/** `GET /api/session/state` and the WebSocket's `session.state`: everything the session holds. */
export interface SessionStateBody {
    readonly session: Json<Collaboration.Session>;
    readonly requests: Json<readonly Collaboration.Request[]>;
    readonly runs: Json<readonly Collaboration.AgentRun[]>;
    readonly revisions: Json<readonly Collaboration.Revision[]>;
    /** The marks still placed (votes and reactions), in the order they were placed: a page that joins late sees them. */
    readonly marks: Json<readonly Collaboration.PlacedMark[]>;
    /** The emoji the add-reaction popover offers first (`session.quickReactions`), in the form reactions are kept. */
    readonly quickReactions: readonly string[];
    /** The outbox position the state includes: event messages with a `seq` up to it are already in it. */
    readonly seq: number;
    /**
     * The participant that the identity holding the facilitator's role joined as (`dev:…`, `access:…`), once someone
     * claimed the role: that person acts as the facilitator now, so a page lists them once, as the facilitator.
     */
    readonly facilitatorHolder?: string;
}

/**
 * Where a participant is looking: a `.dt` view (`viewKey` of the page's navigation) or a storming at a level, in a
 * timeline's view or the integrated canvas. `layoutKey` is the laid-out graph's ID and signature: cursors are drawn
 * only between equal locations.
 */
export type ViewLocation =
    | { readonly kind: 'dt'; readonly viewKey: string; readonly layoutKey: string }
    | { readonly kind: 'dtes'; readonly stormingId: string; readonly level: string; readonly timelineId?: string; readonly layoutKey: string };

/** A cursor in tldraw world coordinates. */
export interface Cursor {
    readonly x: number;
    readonly y: number;
}

/** One page's presence: ephemeral, never stored. `connection` tells two pages of one participant apart. */
export interface Presence {
    readonly connection: string;
    readonly participant: PublicParticipant;
    readonly location: ViewLocation;
    readonly cursor?: Cursor;
    readonly selectedTarget?: Json<Collaboration.ModelTarget>;
}

/** What the page sends over the WebSocket (validated by the server; anything else is ignored). */
export type ClientMessage =
    | {
          readonly type: 'presence.update';
          readonly location: ViewLocation;
          readonly cursor?: Cursor;
          readonly selectedTarget?: Json<Collaboration.ModelTarget>;
      }
    | { readonly type: 'presence.leave' };

/** The message type of each persistent event of the model. */
export const EVENT_MESSAGE_TYPES = {
    SessionStarted: 'session.started',
    ParticipantJoined: 'session.participant_joined',
    SessionClosed: 'session.closed',
    RequestSent: 'request.sent',
    RequestDismissed: 'request.dismissed',
    RunQueued: 'run.queued',
    RunStarted: 'run.started',
    RunCompleted: 'run.completed',
    RunNeedsClarification: 'run.needs_clarification',
    RunDeclined: 'run.declined',
    RunFailed: 'run.failed',
    RunCancelled: 'run.cancelled',
    RevisionRecorded: 'revision.recorded',
    RevisionRestored: 'revision.restored',
    RevisionConfirmed: 'revision.confirmed',
    MarkPlaced: 'mark.placed',
    MarkRemoved: 'mark.removed',
} as const satisfies Record<Collaboration.PersistentEvent['type'], string>;

type EventType = Collaboration.PersistentEvent['type'];

/** A persistent event of the session as a message: `seq` is its outbox position (the SSE event ID of the agent). */
export type EventMessage = {
    [K in EventType]: {
        readonly type: (typeof EVENT_MESSAGE_TYPES)[K];
        readonly seq: number;
        readonly event: Json<Extract<Collaboration.PersistentEvent, { type: K }>>;
    };
}[EventType];

/** What the server sends over the WebSocket in a session, besides the Live View's `type: 'update'`. */
export type SessionServerMessage =
    | EventMessage
    | { readonly type: 'session.state'; readonly state: SessionStateBody; readonly me: Me }
    | { readonly type: 'presence.snapshot'; readonly peers: readonly Presence[] }
    | { readonly type: 'presence.update'; readonly presence: Presence }
    | { readonly type: 'presence.leave'; readonly connection: string }
    // the facilitator's only (ADR 0026, amendment): how the chat's messages read, when a classifier is configured
    | { readonly type: 'session.classifications'; readonly classifications: Readonly<Record<string, Classification>> }
    | { readonly type: 'session.classification'; readonly request: string; readonly classification: Classification };

/** The message type of a session message (`session.*`, `request.*`, `run.*`, `revision.*`, `mark.*`, `presence.*`). */
export type SessionMessageType = SessionServerMessage['type'];

/** An error of the session APIs: `{ "error": { "type": …, … } }` with an HTTP status. */
export interface ErrorBody {
    readonly error: { readonly type: string; readonly message?: string; readonly [detail: string]: unknown };
}

// ---- Browser REST bodies ----

/** `POST /api/session/join` (dev). */
export interface JoinBody {
    readonly name: string;
}

/** `POST /api/session/facilitator/claim`. */
export interface ClaimBody {
    readonly code: string;
}

/**
 * `POST /api/session/requests`: 0 to 20 targets, each once, none of them the whole workspace (no target: the whole
 * workspace); `#name[n]` in the body mentions target n (`@name[n]`, as bodies were written before, too), `@name[pN]`
 * the N-th of `mentions`: 0 to 20 participants of the session, each once (`MentionedNotAParticipant`,
 * `TooManyMentions`, `DuplicateMention` 400 otherwise). The former body with one `target` is still taken. `replyTo`: the
 * run of the session the message replies to — completed, failed, declined or cancelled (`RunNotFound` 404,
 * `RunOfAnotherSession` 404, `RunNotReplyable` 409 otherwise).
 */
export interface SendRequestBody {
    readonly targets: readonly Json<Collaboration.TargetSnapshot>[];
    readonly body: string;
    readonly replyTo?: string;
    readonly mentions?: readonly string[];
}

/**
 * `POST /api/session/marks` (any participant): sets one of my marks — a vote (♡) on a question's option or an
 * assumption's choice, a reaction on a message or an AI turn — placed or taken off (`placed`). `sign` is
 * `{ "kind": "Vote" }` or `{ "kind": "Reaction", "emoji": "👍" }`: any one emoji (one grapheme, at most
 * `MAX_EMOJI_BYTES` bytes), kept and sent back in one form (NFC, fully qualified: ❤ and ❤️ are the same reaction,
 * `domain/emoji.ts`). Placing a vote moves my vote of the same single-choice question or assumption.
 * The facilitator does not vote (`FacilitatorDoesNotVote`); a vote that closed is refused (`MarkTargetClosed`); an
 * emoji new to a target that has `MAX_REACTION_EMOJI` different ones is refused (`ReactionLimitReached`, 409).
 * → 200 `MarkSetBody`; the change reaches every page as `mark.placed` / `mark.removed`.
 */
export interface SetMarkBody {
    readonly target: Json<Collaboration.MarkTarget>;
    readonly sign: Json<Collaboration.MarkSign>;
    readonly placed: boolean;
}

/** `POST /api/session/marks` → 200: the mark placed (none if it was there already, or taken off) and the marks removed. */
export interface MarkSetBody {
    readonly placed?: Json<Collaboration.PlacedMark>;
    readonly removed: Json<readonly Collaboration.RemovedMark[]>;
}

/**
 * The facilitator's answer to the questions of a run that needs clarification: for each question answered (by its
 * `id`), the options chosen (by `id`; at most one for a single-choice question) and/or own words (`text`). Limits:
 * `REPLY_LIMITS` (`domain/reply.ts`).
 */
export interface AnswerBody {
    readonly answers: readonly { readonly question: string; readonly options: readonly string[]; readonly text?: string }[];
}

/**
 * `POST /api/session/runs`: the requests to bundle, in order, and the facilitator's note; with `answerTo` (a run of the
 * session that needs clarification) and `answer`, the answer to its questions, frozen into the new run's input; with
 * `pick`, the alternative picked of a completed run's assumption (its number in the reply, the alternative's key),
 * frozen into the input with the assumption's text and the alternative — the requests are then that run's requests.
 */
export interface QueueRunBody {
    readonly requests: readonly string[];
    readonly note?: string;
    readonly answerTo?: string;
    readonly answer?: AnswerBody;
    readonly pick?: PickBody;
}

/** The alternative picked of a completed run's assumption (`QueueRunBody.pick`). */
export interface PickBody {
    readonly pickOf: string;
    readonly assumption: number;
    readonly alternative: string;
}

/**
 * `POST /api/session/revisions/:id/restore` (the facilitator). `recordExternalChanges`: the workspace's changes since
 * the session's last revision are recorded first as a revision (Manual), then the restore goes on; without it they
 * make the restore refuse (`ExternalChangesSinceSnapshot`).
 */
export interface RestoreBody {
    readonly recordExternalChanges?: boolean;
}

/** `POST /api/session/revisions/:id/restore` → 200. */
export interface RestoredBody {
    readonly restored: Json<Collaboration.RecordedRevision>;
    readonly preRestore: Json<Collaboration.RecordedRevision>;
    readonly manual?: Json<Collaboration.RecordedRevision>;
}

/**
 * `POST /api/session/revisions/:id/restore` → 500 `ManualRecoveryNeeded`: the write started and did not finish; the
 * workspace before it is the revision `preRestore`.
 */
export interface ManualRecoveryNeededBody {
    readonly error: { readonly type: 'ManualRecoveryNeeded'; readonly preRestore: string; readonly cause: string; readonly message: string };
}

/** A file of a comparison: its status by path and DSL, and the line diff of its texts unless it is unchanged. */
export interface ComparedFileBody extends Json<FileComparison> {
    /** Absent for an unchanged file, and for the files after the comparison's diffs reached their limit (`diffsOmitted`). */
    readonly diff?: LineDiff;
}

/** `GET /api/session/revisions/:before/compare/:after` (any participant): two revisions side by side. */
export interface ComparisonBody {
    readonly before: Json<Collaboration.Revision>;
    readonly after: Json<Collaboration.Revision>;
    /** Every source of either revision, by path. */
    readonly files: readonly ComparedFileBody[];
    readonly counts: Readonly<Record<Collaboration.SourceLanguage, Readonly<Record<FileStatus, number>>>>;
    readonly diffsOmitted: boolean;
}

// ---- Agent API (loopback listener, `Authorization: Bearer <agent.json token>`) ----

/**
 * The SSE stream `GET /agent/events`: `id:` is the outbox position (resume with `Last-Event-ID`), `event:` one of these
 * types, `data:` the `EventMessage` as JSON. `run.cancel_requested` is the `RunCancelled` event (stop the agent if it
 * is that run's).
 */
export const AGENT_EVENT_TYPES = {
    RunQueued: 'run.queued',
    RunStarted: 'run.started',
    RunCompleted: 'run.completed',
    RunNeedsClarification: 'run.needs_clarification',
    RunDeclined: 'run.declined',
    RunFailed: 'run.failed',
    RunCancelled: 'run.cancel_requested',
    SessionClosed: 'session.closed',
} as const satisfies Partial<Record<EventType, string>>;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[keyof typeof AGENT_EVENT_TYPES];

/** `GET /agent/session`: the session the agent works for, and the tools the facilitator allows it. */
export interface AgentSessionBody {
    readonly session: Collaboration.SessionId;
    readonly state: 'Open' | 'Closed';
    readonly allowedTools: readonly string[];
    readonly leaseMs: number;
}

/** `GET /agent/participants`: who is in the session, by ID and display name (for the prompt's request authors; no e-mail). */
export interface AgentParticipantsBody {
    readonly participants: readonly { readonly id: string; readonly name: string }[];
}

/** `POST /agent/runs/claim`. */
export interface AgentClaimBody {
    /** Who claims (shown to the facilitator): e.g. `claude@host`. */
    readonly owner: string;
}

/** The lease of a claimed run: its token goes with every later call about the run. */
export interface AgentLease {
    readonly token: string;
    readonly expiresAt: string;
}

/** `POST /agent/runs/claim` → 200. */
export interface AgentClaimed {
    readonly run: Json<Collaboration.QueuedAgentRun>;
    readonly lease: AgentLease;
}

/** `POST /agent/runs/:id/{start,heartbeat,release}`. */
export interface AgentLeaseBody {
    readonly token: string;
}

/**
 * A run the started run continues (ADR 0026, "replies to runs"): a run its messages reply to, the run its answer
 * answers, or the run it picked an alternative of, with what it changed from its base to its result revision — a unified diff, or the files only past
 * `session.agent.maxPreviousRunDiff` characters for all of them.
 */
export interface AgentPreviousRun {
    readonly run: Json<Collaboration.AgentRun>;
    readonly changes: PreviousRunChanges;
}

/** `POST /agent/runs/:id/start` → 200: the running run, its base revision, and the runs it continues, in its input's order. */
export interface AgentStartedBody {
    readonly run: Json<Collaboration.RunningAgentRun>;
    readonly baseRevision: Json<Collaboration.Revision>;
    readonly previousRuns: readonly AgentPreviousRun[];
}

/**
 * The agent's reply as the subscriber sends it (`ReplyData` of `domain/reply.ts`, requests by ID): what the AI says,
 * validated against the shape and `REPLY_LIMITS` on both sides. Never a fact.
 */
export interface AgentReplyBody {
    readonly outcome: 'done' | 'clarification' | 'declined';
    readonly title?: string;
    readonly summary: string;
    readonly requests: readonly { readonly request: string; readonly status: 'done' | 'partial' | 'skipped' | 'question'; readonly note?: string }[];
    readonly questions?: readonly {
        readonly id: string;
        readonly text: string;
        readonly requests?: readonly string[];
        readonly options: readonly { readonly id: string; readonly label: string; readonly detail?: string }[];
        readonly multiple: boolean;
    }[];
    readonly assumptions?: readonly {
        readonly text: string;
        readonly requests?: readonly string[];
        readonly alternatives?: readonly { readonly id: string; readonly label: string }[];
    }[];
}

/**
 * `POST /agent/runs/:id/finish`: the agent's facts; the server compares the diagnostics and decides the rest. `reply`
 * (outcome `done`) is kept with a completed run, never used to decide it.
 */
export interface AgentFinishBody extends AgentLeaseBody {
    readonly exitCode: number;
    readonly formatted: boolean;
    readonly checked: boolean;
    readonly reply?: AgentReplyBody;
}

/** `POST /agent/runs/:id/clarification`: the question as plain text, and the structured reply (outcome `clarification`) when there is one. */
export interface AgentClarificationBody extends AgentLeaseBody {
    readonly question: string;
    readonly reply?: AgentReplyBody;
}

/** `POST /agent/runs/:id/decline`: the agent will not do the requests; the reply's summary is why (outcome `declined`). */
export interface AgentDeclineBody extends AgentLeaseBody {
    readonly reply: AgentReplyBody;
}

/** `POST /agent/runs/:id/fail`. */
export interface AgentFailBody extends AgentLeaseBody {
    readonly reason: 'AgentError' | 'Interrupted';
}
