// The messages of a collaboration session (ADR 0026) between the server and its two kinds of clients: the page
// (REST under `/api/session/`, and the WebSocket next to the Live View's `type: 'update'`) and the agent subscriber
// (the agent API on its own loopback listener: REST and an SSE stream). Types only, shared by the app (apps/dt), the page
// (S5) and the subscriber (S6); what goes over the wire is JSON, so a `Date` arrives as an ISO string (`Json<T>`).
import type { ElementChange, ElementChanges } from './domain/changes.js';
import type { FileComparison, FileStatus, LineDiff } from './domain/compare.js';
import type { PreviousRunChanges } from './domain/previous-runs.js';
import type { RevertChanges, RevertFile } from './domain/revert.js';
import type { Collaboration } from './generated/index.js';
import type { Classification } from './application/classifier.js';
import type { RunActivity, RunActivityPhase } from './domain/activity.js';

export type { Classification, RunActivity, RunActivityPhase, RevertChanges, RevertFile };

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
    /** The assumptions the facilitator approved, in the order they were approved. */
    readonly approvals: Json<readonly Collaboration.AssumptionApproval[]>;
    /**
     * The triages of the messages addressed to the AI, in the order they were opened (ADR 0030; absent from a server
     * before them). M4 sends each page the outcome and the facilitator the record.
     */
    readonly triages?: Json<readonly Collaboration.Triage[]>;
    /** The change proposals, in the order they were made (absent from a server before them). */
    readonly proposals?: Json<readonly Collaboration.ChangeProposal[]>;
    /** Whether an agent is connected, per role, and how many triages, answers and runs wait for one (M4). */
    readonly agent?: AgentPresence;
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

/** A cursor in page coordinates (the layout's space, whatever draws the canvas). */
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
    SessionCollaborated: 'session.collaborated',
    RequestSent: 'request.sent',
    RequestDismissed: 'request.dismissed',
    RunQueued: 'run.queued',
    RunStarted: 'run.started',
    RunCompleted: 'run.completed',
    RunNeedsClarification: 'run.needs_clarification',
    RunDeclined: 'run.declined',
    RunFailed: 'run.failed',
    RunCancelled: 'run.cancelled',
    RunReverted: 'run.reverted',
    RevertLeftToAgent: 'run.revert_left_to_agent',
    RevisionRecorded: 'revision.recorded',
    RevisionRestored: 'revision.restored',
    MarkPlaced: 'mark.placed',
    MarkRemoved: 'mark.removed',
    AssumptionApproved: 'assumption.approved',
    TriageOpened: 'triage.opened',
    TriageStepRecorded: 'triage.step_recorded',
    TriageDecided: 'triage.decided',
    TriageOverridden: 'triage.overridden',
    TriageReaddressed: 'triage.readdressed',
    TriageConcluded: 'triage.concluded',
    ChangeProposed: 'proposal.proposed',
    ProposalApproved: 'proposal.approved',
    ProposalRejected: 'proposal.rejected',
    ProposalWithdrawn: 'proposal.withdrawn',
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
    // the facilitator's only (ADR 0026, amendment): how the chat's messages read, when a classifier is configured.
    // Superseded by the triage (ADR 0030): kept for today's page until M4/M6 remove it
    | { readonly type: 'agent.presence'; readonly agent: AgentPresence }
    | { readonly type: 'session.classifications'; readonly classifications: Readonly<Record<string, Classification>> }
    | { readonly type: 'session.classification'; readonly request: string; readonly classification: Classification }
    // what the running runs are doing (ADR 0026, amendment): transient, never an event; every activity held on connect,
    // then each change. A page shows a run's only while the run is `Running`
    | { readonly type: 'session.activities'; readonly activities: Readonly<Record<string, RunActivity>> }
    | { readonly type: 'run.activity'; readonly run: string; readonly activity: RunActivity };

/** The agents connected to a session, per role, and the work waiting for one (ADR 0030; the chat header's AI status). */
export interface AgentPresence {
    readonly connected: { readonly answer: number; readonly run: number };
    /** Triages waiting for stage 3, answers and proposals to write, runs queued. */
    readonly waiting: number;
}

/** The message type of a session message (`session.*`, `request.*`, `run.*`, `revision.*`, `mark.*`, `assumption.*`, `triage.*`, `proposal.*`, `agent.*`, `presence.*`). */
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
 * `TooManyMentions`, `DuplicateMention` 400 otherwise). The former body with one `target` is still taken. `replyTo`:
 * what the message replies to — `{ kind: 'Run', run }`, a run of the session that is completed, failed, declined or
 * cancelled (`RunNotFound` 404, `RunOfAnotherSession` 404, `RunNotReplyable` 409 otherwise), or `{ kind: 'Message',
 * request }`, a message of the session, one's own too (`RequestNotFound` 404, `RequestOfAnotherSession` 404).
 */
export interface SendRequestBody {
    readonly targets: readonly Json<Collaboration.TargetSnapshot>[];
    readonly body: string;
    readonly replyTo?: Json<Collaboration.ReplyTarget>;
    readonly mentions?: readonly string[];
}

/** `POST /api/session/requests/:id/address` and `POST /api/session/requests/address` (the facilitator's 「AI に送る」, ADR 0030): the messages. */
export interface AddressBody {
    readonly requests: readonly string[];
}

/** A change proposal's text: what, where (elements as `#name`), how (`PROPOSAL_LIMITS` of `domain/proposals.ts`). */
export interface ProposalBody {
    readonly what: string;
    readonly where: string;
    readonly how: string;
}

/**
 * `POST /api/session/proposals/approve` (the facilitator): open proposals of the session, each as is or edited; approved
 * together, one run (`note`: the facilitator's note on it).
 */
export interface ApproveProposalsBody {
    readonly proposals: readonly { readonly proposal: string; readonly edited?: ProposalBody }[];
    readonly note?: string;
}

/** `POST /api/session/proposals/:id/reject` (the facilitator): an optional note to the requester. */
export interface RejectProposalBody {
    readonly note?: string;
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
 * `POST /api/session/approvals` (the facilitator): approves an assumption of a completed run of the session — `run`, and
 * `assumption`, its index in the run's reply. It stands as the AI made it; nothing is sent to the agent. Refused with
 * `RunNotFound` / `RunOfAnotherSession` (404), `RunNotApprovable` (409: the run is not completed, or its reply has no
 * assumptions), `AssumptionNotFound` (400), `AssumptionClosed` (409: approved already, an alternative of it picked, or a
 * later run took over the run's requests). → 201 `ApprovedBody`; every page gets `assumption.approved`.
 */
export interface ApproveBody {
    readonly run: string;
    readonly assumption: number;
}

/** `POST /api/session/approvals` → 201: the approval made. */
export interface ApprovedBody {
    readonly approval: Json<Collaboration.AssumptionApproval>;
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

/**
 * `POST /api/session/runs/:id/revert` (the facilitator): revert the changes of the run `:id` of the session (one that
 * changed files, not reverted yet nor being reverted). `body` is the message everyone sees in the chat, sent as the
 * revert request (「〈作業名〉の変更を打ち消す」). The revert is queued behind the other work like any change, never
 * refused for a run in progress; when it reaches the head of the queue, the server reverts it mechanically when the
 * run's changes reverse cleanly onto the workspace then and the result checks, else leaves it queued for the AI, with
 * why (`revertObstacle`). Refused with `FacilitatorOnly` (403), `RunNotFound` / `RunOfAnotherSession` (404),
 * `RunNotRevertable` (409: it changed no file, or it is reverted, or a revert of it is queued or under way).
 */
export interface RevertRunBody {
    readonly body: string;
}

/**
 * `POST /api/session/runs/:id/revert` → 201: the revert request, and its run as it is once the server had its turn:
 * `Reverted` when it was at the head and went through at once (`changed` false: nothing was left to revert), `Queued`
 * with `revertObstacle` when it was left to the AI, `Queued` without one while it waits its turn behind `ahead` runs
 * (the run in progress and the queued ones before it).
 */
export interface RevertRequestedBody {
    readonly request: Json<Collaboration.SentRequest>;
    readonly run: Json<Collaboration.AgentRun>;
    readonly ahead: number;
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

/**
 * `GET /api/session/revisions/:before/changes/:after` (any participant): what a unit of work changed in the model's
 * words — the `.dt` and `.dtes` elements added, changed and removed. `complete` is false when a side's sources did not
 * all parse (that DSL's changes are then left out).
 */
export type ModelChangesBody = ElementChanges;
export type { ElementChange };

// ---- Agent API (loopback listener, `Authorization: Bearer <token>`, held in memory; `POST /agent/pair` exchanges a one-time code for it) ----

/**
 * The SSE stream `GET /agent/events`: `id:` is the outbox position (resume with `Last-Event-ID`), `event:` one of these
 * types, `data:` the `EventMessage` as JSON. `run.cancel_requested` is the `RunCancelled` event (stop the agent if it
 * is that run's). A queued revert is first tried by the server: `run.reverted` when it went through (the queue moved
 * on), `run.revert_left_to_agent` when it is left to the agent — both mean a run may now be claimed.
 */
export const AGENT_EVENT_TYPES = {
    RunQueued: 'run.queued',
    RunReverted: 'run.reverted',
    RevertLeftToAgent: 'run.revert_left_to_agent',
    RunStarted: 'run.started',
    RunCompleted: 'run.completed',
    RunNeedsClarification: 'run.needs_clarification',
    RunDeclined: 'run.declined',
    RunFailed: 'run.failed',
    RunCancelled: 'run.cancel_requested',
    // a warm agent forgets its conversation: the files it remembers were replaced
    RevisionRestored: 'revision.restored',
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

/**
 * What a subscriber of this version can run, named when it claims: `revert`, a run whose request reverts another run
 * (it gets that run's changes when it starts, `AgentStartedBody.revert`). A subscriber that does not name it is never
 * given such a run: its claim is refused with `SubscriberOutdated` (409) and the run stays queued.
 */
export const AGENT_CAPABILITIES = ['revert'] as const;

/** `POST /agent/runs/claim`. */
export interface AgentClaimBody {
    /** Who claims (shown to the facilitator): e.g. `claude@host`. */
    readonly owner: string;
    /** What it can run (`AGENT_CAPABILITIES`); none when left out. */
    readonly capabilities?: readonly string[];
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

/**
 * A run the started run reverts (a revert request of its input names it), with what it changed from its base to its
 * result revision, file by file: each file's unified diff while they fit `MAX_REVERT_DIFF` characters, else its line counts.
 */
export interface AgentRevertedRun {
    readonly run: Json<Collaboration.AgentRun>;
    readonly changes: RevertChanges;
}

/**
 * `POST /agent/runs/:id/start` → 200: the running run, its base revision, the runs it continues, in its input's order,
 * and the runs it reverts (`revert`, for a revert: absent from a server before reverting runs).
 */
export interface AgentStartedBody {
    readonly run: Json<Collaboration.RunningAgentRun>;
    readonly baseRevision: Json<Collaboration.Revision>;
    readonly previousRuns: readonly AgentPreviousRun[];
    readonly revert?: readonly AgentRevertedRun[];
}

/**
 * The agent's reply as the subscriber sends it (`ReplyData` of `domain/reply.ts`, requests by ID): what the AI says,
 * validated against the shape and `REPLY_LIMITS` on both sides. Never a fact.
 */
export interface AgentReplyBody {
    readonly outcome: 'done' | 'clarification' | 'declined';
    readonly title?: string;
    readonly summary: string;
    readonly requests: readonly {
        readonly request: string;
        readonly status: 'done' | 'partial' | 'skipped' | 'question' | 'answered';
        readonly note?: string;
    }[];
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
    /** The answer, when the agent judged a request a question and changed nothing (its status `answered`). */
    readonly answer?: string;
}

/**
 * How `dt fmt` / `dt check` went after a run: ran, failed, or skipped because no file changed (ADR 0030). A boolean is
 * a subscriber before skipping existed (true: ran; false: failed): still taken.
 */
export type ToolOutcomeBody = 'ran' | 'failed' | 'skipped' | boolean;

/**
 * `POST /agent/runs/:id/finish`: the agent's facts; the server compares the diagnostics and decides the rest. `reply`
 * (outcome `done`) is kept with a completed run, never used to decide it.
 */
export interface AgentFinishBody extends AgentLeaseBody {
    readonly exitCode: number;
    readonly formatted: ToolOutcomeBody;
    readonly checked: ToolOutcomeBody;
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

/**
 * `POST /agent/runs/:id/activity` → 200 `{}`: what the running run is doing now (`RunActivity`), from its lease's holder.
 * Kept in memory as the run's latest and sent to the pages; it does not extend the lease. Refused with `LeaseLost` or
 * `NotAllowed` (409) unless the token is the live lease of a running run, `InvalidInput` (400) for a phase or a
 * subject that is not one.
 */
export interface AgentActivityBody extends AgentLeaseBody {
    readonly phase: RunActivityPhase;
    readonly subject?: string;
}

/** `POST /agent/runs/:id/fail`. */
export interface AgentFailBody extends AgentLeaseBody {
    readonly reason: 'AgentError' | 'Interrupted';
}

// ---- Agent API: the answerer role (ADR 0030, decision 6). Types only: the routes are M4's ----

/** The two roles of an agent: the read-only answerer (triage, answers, proposals) and the runner (runs). */
export const AGENT_ROLES = ['answer', 'run'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/**
 * The SSE stream `GET /agent/answers/events` (the answerer role; no claim, no lease, no workspace lock): `event:` one of
 * these, `data:` an `AgentAnswerJobBody` (`answer.job`), `{ job }` (`answer.job_withdrawn`: handed to another answerer or
 * no longer needed), or the `EventMessage` of `session.closed`. Each job is handed to one connected answerer; one not
 * answered within its timeout, or whose answerer disconnects, is handed to another or waits.
 */
export const AGENT_ANSWER_EVENT_TYPES = {
    job: 'answer.job',
    withdrawn: 'answer.job_withdrawn',
    closed: 'session.closed',
} as const;

export type AgentAnswerEventType = (typeof AGENT_ANSWER_EVENT_TYPES)[keyof typeof AGENT_ANSWER_EVENT_TYPES];

/** The kinds of answer jobs: stage 3 of the triage, an answer to a 相談, a proposal for a participant's 依頼. */
export type AgentAnswerJobKind = 'triage' | 'answer' | 'propose';

/** An answer job as the answerer gets it. */
export interface AgentAnswerJobBody {
    /** The job's ID: `POST /agent/answers/:job` returns its result. */
    readonly job: string;
    readonly kind: AgentAnswerJobKind;
    readonly triage: Json<Collaboration.Triage>;
    /** The addressed message. */
    readonly request: Json<Collaboration.Request>;
    /** Its author's display name. */
    readonly author: string;
    /** The most milliseconds the result may take (`agent.answer.timeout`). */
    readonly timeoutMs: number;
    /** A triage job: the chat before the message, one line each (`chatWindow` of `domain/timeline.ts`). */
    readonly chat?: readonly string[];
    /** A triage job: the open change proposals, so that 「それでお願いします」 reads as a 依頼. */
    readonly openProposals?: Json<readonly Collaboration.OpenChangeProposal[]>;
    /** An answer or propose job: the session so far (`sessionSoFar`), whole or since the answerer's last entry. */
    readonly sessionSoFar?: { readonly text: string; readonly last: number; readonly since?: number };
    /** An answer or propose job: the runs the message replies to, with what they changed. */
    readonly previousRuns?: readonly AgentPreviousRun[];
    /** An answer job: the files changed since the answerer's previous job ended (for a warm process). */
    readonly changedSinceYourLastAnswer?: readonly string[];
}

/** `POST /agent/answers/:job` for a triage job: stage 3's answer (`readTriageAnswer` of `domain/answers.ts`), or why it failed. */
export type AgentTriageResultBody =
    | {
          readonly kind: 'consultation' | 'change_request' | 'neither' | 'unknown';
          readonly confidence: number;
          readonly reason: string;
          readonly model?: string;
          readonly durationMs: number;
      }
    | { readonly error: string; readonly durationMs: number };

/**
 * `POST /agent/answers/:job` for an answer job: the answer (`readRevision`: the revision the answerer read, the latest
 * at its start), "this is a request" with a proposal (the override), or "neither" (`readAnswererReply`).
 */
export type AgentAnswerResultBody = (
    | { readonly kind: 'answer'; readonly answer: string; readonly readRevision?: string }
    | { readonly kind: 'proposal'; readonly proposal: ProposalBody; readonly reason?: string }
    | { readonly kind: 'neither'; readonly reason?: string }
) & { readonly model?: string; readonly durationMs: number };

/** `POST /agent/answers/:job` for a propose job: the proposal (`readProposeReply`). */
export interface AgentProposeResultBody {
    readonly proposal: ProposalBody;
    readonly durationMs: number;
}

/** `POST /agent/answers/:job` for any job that failed (the process crashed, timed out, gave no valid output). */
export interface AgentAnswerFailedBody {
    readonly error: string;
    readonly durationMs: number;
}
