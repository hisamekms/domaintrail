// The messages of a collaboration session (ADR 0026) between the server and its two kinds of clients: the page
// (REST under `/api/session/`, and the WebSocket next to the Live View's `type: 'update'`) and the agent subscriber
// (the agent API on its own loopback listener: REST and an SSE stream). Types only, shared by the app (apps/dt), the page
// (S5) and the subscriber (S6); what goes over the wire is JSON, so a `Date` arrives as an ISO string (`Json<T>`).
import type { ElementChange, ElementChanges } from './domain/changes.js';
import type { FileComparison, FileStatus, LineDiff } from './domain/compare.js';
import type { PreviousRunChanges } from './domain/previous-runs.js';
import type { RevertChanges, RevertFile } from './domain/revert.js';
import type { Collaboration } from './generated/index.js';
import type { RunActivity, RunActivityPhase } from './domain/activity.js';
import type { TemplateContext } from './domain/templates.js';
import type { JourneyAct, JourneyFile, JourneyProblem, JourneySummary } from './domain/journey.js';
import type { JourneyWhere } from './domain/guide.js';

export type { RunActivity, RunActivityPhase, RevertChanges, RevertFile, TemplateContext };

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
    readonly identity: { readonly provider: 'dev' | 'access' | 'link'; readonly displayName: string };
}

/** A pending join request of the `link` identity mode, as the facilitator's page gets it. */
export interface JoinRequestBody {
    readonly id: string;
    readonly name: string;
    readonly requestedAt: string;
    readonly expiresAt: string;
    /** Its name is another pending request's or a participant's (the same, NFKC, case and spaces folded). */
    readonly duplicate?: boolean;
}

/** The `link` identity mode's invite as the facilitator sees it: when the live one expires (the link itself is shown once, when made). */
export interface InviteStateBody {
    readonly expiresAt: string;
}

/** `POST /api/session/invite`: a new invite link (the previous one stops working). */
export interface InviteBody {
    readonly link: string;
    readonly expiresAt: string;
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
     * before them): the facilitator gets each one's record (`Json<Triage>`: its steps, who decided), a participant only
     * its outcome (`TriageOutcomeBody`, plan decision 8).
     */
    readonly triages?: readonly TriageBody[];
    /** The change proposals, in the order they were made (absent from a server before them). */
    readonly proposals?: Json<readonly Collaboration.ChangeProposal[]>;
    /** The interviews of the `/` commands, in the order they were started (absent from a server before them). */
    readonly interviews?: Json<readonly Collaboration.Interview[]>;
    /** The candidate and answer commands of the `/` list, in the order they were started (absent from a server before them). */
    readonly slashCommands?: Json<readonly Collaboration.SlashCommand[]>;
    /**
     * The records of what people did (a goal changed, marks, a journey done or archived, the current journey chosen, a
     * request and its outcome, an interview stopped, a brief rejected) and of the journey file changed outside dt, in
     * the order they were written (absent from a server before them).
     */
    readonly records?: Json<readonly Collaboration.SessionRecord[]>;
    /** The team's message templates (`templates` in domaintrail.jsonc), shown after the built-in ones (absent: none). */
    readonly templates?: readonly MessageTemplateBody[];
    /** Whether an agent is connected, per role, and how many triages, answers and runs wait for one. */
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
 * A triage as a participant sees it (plan decision 8): how the message was addressed, whether it is decided, as what,
 * and where it went — not the stages, their reasons and models, nor which stage decided.
 */
export interface TriageOutcomeBody {
    readonly id: string;
    readonly session: string;
    readonly request: string;
    readonly addressedBy: Collaboration.AddressedBy;
    readonly addressedByParticipant: string;
    readonly openedAt: string;
    readonly state: 'Pending' | 'Decided';
    readonly kind?: Collaboration.TriageVerdict;
    readonly decidedAt?: string;
    readonly outcome?: Json<Collaboration.TriageOutcome>;
}

/** A triage on the wire: the record (the facilitator's) or the outcome only (a participant's). */
export type TriageBody = Json<Collaboration.Triage> | TriageOutcomeBody;

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

/**
 * The part of the page a canvas shows, in page coordinates (`x`, `y` its top-left corner, `w`, `h` its size): another
 * page following this one fits it to its own canvas, whatever their sizes.
 */
export interface CameraBounds {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

/**
 * One page's presence: ephemeral, never stored. `connection` tells two pages of one participant apart. `camera`: what
 * its canvas shows while its location has one (absent from a page before it).
 */
export interface Presence {
    readonly connection: string;
    readonly participant: PublicParticipant;
    readonly location: ViewLocation;
    readonly cursor?: Cursor;
    readonly camera?: CameraBounds;
    readonly selectedTarget?: Json<Collaboration.ModelTarget>;
}

/** What the page sends over the WebSocket (validated by the server; anything else is ignored). */
export type ClientMessage =
    | {
          readonly type: 'presence.update';
          readonly location: ViewLocation;
          readonly cursor?: Cursor;
          readonly camera?: CameraBounds;
          readonly selectedTarget?: Json<Collaboration.ModelTarget>;
      }
    | { readonly type: 'presence.leave' };

/** The message type of each persistent event of the model. */
export const EVENT_MESSAGE_TYPES = {
    SessionStarted: 'session.started',
    ParticipantJoined: 'session.participant_joined',
    SessionClosed: 'session.closed',
    SessionCollaborated: 'session.collaborated',
    JourneyChosen: 'session.journey_chosen',
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
    RunEdited: 'run.edited',
    RunEditConflicted: 'run.edit_conflicted',
    RunHotspotNamed: 'run.hotspot_named',
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
    InterviewStarted: 'interview.started',
    InterviewAnswered: 'interview.answered',
    InterviewQuestionAsked: 'interview.question_asked',
    InterviewBriefed: 'interview.briefed',
    InterviewConfirmed: 'interview.confirmed',
    InterviewStopped: 'interview.stopped',
    InterviewRejected: 'interview.rejected',
    SlashCommandStarted: 'command.started',
    CandidatesListed: 'command.candidates_listed',
    SlashCommandAnswered: 'command.answered',
    CandidatesApplied: 'command.candidates_applied',
    SlashCommandStopped: 'command.stopped',
    RecordWritten: 'record.written',
    RecordRevised: 'record.revised',
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

/** A participant's act on the journeys, waiting for the facilitator: an act on the file, or the current journey chosen. */
export type JourneyRequestAct = JourneyAct | { readonly kind: 'choose'; readonly journey: string | null };

/** A participant's request about the journeys (the plan's "The current journey"): who, what, when. In memory only. */
export interface JourneyRequestBody {
    readonly id: string;
    readonly by: string;
    readonly byName: string;
    readonly act: JourneyRequestAct;
    readonly at: string;
}

/**
 * The journey file as the pages get it (`journey`): its valid journeys (null: no file), what is wrong with it
 * (`dt check`'s J001 by path; the page says so and dt writes nothing over it), and the participants' requests waiting.
 */
export interface JourneyBody {
    readonly file: JourneyFile | null;
    readonly problems: readonly JourneyProblem[];
    readonly requests: readonly JourneyRequestBody[];
}

/** `POST /api/session/journey/acts`: an act on the journey file (a participant's becomes a request). */
export interface JourneyActBody {
    readonly act: JourneyAct;
}

/** `POST /api/session/journey/current`: the session's current journey (null: the default). A participant's becomes a request. */
export interface ChooseJourneyBody {
    readonly journey: string | null;
}

/** What `…/journey/acts` and `…/journey/current` answer: done, or requested of the facilitator. */
export interface JourneyActedBody {
    readonly done: boolean;
    readonly request?: JourneyRequestBody;
}

/** What the server sends over the WebSocket in a session, besides the Live View's `type: 'update'`. */
export type SessionServerMessage =
    | EventMessage
    | { readonly type: 'session.state'; readonly state: SessionStateBody; readonly me: Me }
    | { readonly type: 'presence.snapshot'; readonly peers: readonly Presence[] }
    | { readonly type: 'presence.update'; readonly presence: Presence }
    | { readonly type: 'presence.leave'; readonly connection: string }
    // a participant's page gets the triages' events without what only the facilitator sees (`ParticipantTriageMessage`)
    | ParticipantTriageMessage
    // the agents connected per role and the work waiting for one (ADR 0030): on connect, then on each change
    | { readonly type: 'agent.presence'; readonly agent: AgentPresence }
    // the journey file and the requests about it: on connect, then on each change (a write of dt, git or another tool)
    | { readonly type: 'journey'; readonly journey: JourneyBody }
    // what the running runs are doing (ADR 0026, amendment): transient, never an event; every activity held on connect,
    // then each change. A page shows a run's only while the run is `Running`
    | { readonly type: 'session.activities'; readonly activities: Readonly<Record<string, RunActivity>> }
    | { readonly type: 'run.activity'; readonly run: string; readonly activity: RunActivity }
    // the `link` identity mode, to the facilitator's pages only: the pending join requests and the live invite; on
    // connect, then on each change
    // (`inviteUsedUp`: the live invite took as many requests as it may)
    | {
          readonly type: 'join.requests';
          readonly requests: readonly JoinRequestBody[];
          readonly invite: InviteStateBody | null;
          readonly inviteUsedUp?: boolean;
      };

/**
 * The triages' events as a participant's page gets them (plan decision 8): `triage.step_recorded` is not sent at all;
 * `triage.decided` comes without the stage that decided, `triage.overridden` without the step (only the new kind). The
 * facilitator's pages get the events as they are (`EventMessage`).
 */
export type ParticipantTriageMessage =
    | {
          readonly type: 'triage.decided';
          readonly seq: number;
          readonly event: { readonly type: 'TriageDecided'; readonly triageId: string; readonly kind: Collaboration.TriageVerdict; readonly decidedAt: string };
      }
    | {
          readonly type: 'triage.overridden';
          readonly seq: number;
          readonly event: { readonly type: 'TriageOverridden'; readonly triageId: string; readonly kind: Collaboration.TriageVerdict };
      };

/** The agents connected to a session, per role, and the work waiting for one (ADR 0030; the chat header's AI status). */
export interface AgentPresence {
    readonly connected: { readonly answer: number; readonly run: number };
    /** Triages waiting for stage 3, answers and proposals to write, runs queued (the given-up ones left out). */
    readonly waiting: number;
    /**
     * The answers and proposals given up after failing twice (absent: none): each waits for an answerer to connect (a
     * new answer stream tries it again) or for the facilitator's `POST /api/session/requests/:id/retry-answer`.
     */
    readonly givenUp?: readonly AgentGivenUpAnswer[];
}

/** An answer (to a 相談), a proposal (for a 依頼) or an interview's turn of the AI that was given up: the message it is for. */
export interface AgentGivenUpAnswer {
    readonly request: string;
    readonly kind: 'answer' | 'propose' | 'interview' | 'command';
}

/** The message type of a session message (`session.*`, `request.*`, `run.*`, `revision.*`, `mark.*`, `assumption.*`, `triage.*`, `proposal.*`, `interview.*`, `agent.*`, `presence.*`). */
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
 * `POST /api/session/requests` (any participant): a message. It is addressed to the AI when the session is Solo, when it
 * mentions the AI (`@AI[pN]`, the AI's ID `ai` among `mentions`), or when it replies to a run or to a message of the AI;
 * its triage is then opened (→ 201 `SentBody` with `triage`). Otherwise it is talk between people: nothing is sent to any
 * model. The former `apply` is gone (`InvalidInput`): the facilitator's 「AI に送る」 is `POST
 * /api/session/requests/address`. 0 to 20 targets, each once, none of them the whole workspace (no target: the whole
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
    /**
     * Where the sender was looking (`readViewedAt`): kept on the message, its names the workspace does not have dropped
     * (`resolveViewedAt`), and given to the AI with it.
     */
    readonly viewedAt?: Json<Collaboration.ViewedAt>;
}

/** `POST /api/session/requests` → 201: the message, and its triage when it is addressed to the AI (as the sender's role sees it). */
export interface SentBody {
    readonly request: Json<Collaboration.SentRequest>;
    readonly triage?: TriageBody;
}

/**
 * `POST /api/session/requests/address` (the facilitator's 「AI に送る」, one message or several; ADR 0030): each message
 * not addressed yet gets a triage addressed by the facilitator; one judged "neither" is addressed again as 相談 (plan Q6).
 * `POST /api/session/requests/:id/address` is the same for one message (an empty body). Refused with `FacilitatorOnly`
 * (403), `RequestNotFound` / `RequestOfAnotherSession` (404), `RequestNotAddressable` (409: the AI's own message, a
 * revert) and `RequestAlreadyAddressed` (409). → 201 `AddressedBody`.
 */
export interface AddressBody {
    readonly requests: readonly string[];
}

/**
 * `POST /api/session/requests/:id/retry-answer` (the facilitator; an empty body): the AI's answer or proposal for the
 * message, given up after failing twice (`AgentPresence.givenUp`), is handed out again (another round of attempts).
 * Refused with `FacilitatorOnly` (403) and `AnswerNotGivenUp` (409: nothing of the message is given up). → 200 `{}`.
 */
export type RetryAnswerBody = Record<string, never>;

/** `POST /api/session/requests/address` → 201: the triages opened (or addressed again), in the order of the messages. */
export interface AddressedBody {
    readonly triages: readonly Json<Collaboration.Triage>[];
}

/**
 * A change proposal as the answerer sends it (`ProposalData` of `domain/proposals.ts`, read by `readProposal`): its
 * targets as element references (`@{Sales.Order}`, `@{es:Returns/ReturnRequested}`), how in a line or two, and two or
 * three options when the AI is unsure (one `recommended`).
 */
export interface ProposalBody {
    readonly targets: readonly string[];
    readonly how: string;
    readonly options?: readonly { readonly label: string; readonly targets: readonly string[]; readonly how?: string; readonly recommended?: boolean }[];
}

/**
 * `POST /api/session/proposals/approve` (the facilitator): open proposals of the session, each with the option chosen
 * (`option`, its index; the recommended one when not given, and none for a proposal without options) and as is or
 * with its how edited (`how`, at most `PROPOSAL_LIMITS.editedHow`); approved together, one run (`note`: the
 * facilitator's note on it). A proposal without the option given → 400 `NoSuchOption`.
 */
export interface ApproveProposalsBody {
    readonly proposals: readonly { readonly proposal: string; readonly option?: number; readonly how?: string }[];
    readonly note?: string;
}

/** `POST /api/session/proposals/approve` → 201: the run queued, and the proposals approved with it. */
export interface ProposalsApprovedBody {
    readonly run: Json<Collaboration.QueuedAgentRun>;
    readonly proposals: readonly Json<Collaboration.ApprovedChangeProposal>[];
}

/**
 * `POST /api/session/proposals/:id/reject` (the facilitator): an optional note to the requester. → 200 `{ proposal }`.
 * `POST /api/session/proposals/:id/withdraw` (its requester, an empty body) → 200 `{ proposal }` (`NotTheRequester` 403).
 */
export interface RejectProposalBody {
    readonly note?: string;
}

/**
 * `POST /api/session/interviews` (any participant): starts the `/es:start` or `/model:start`
 * interview (`command`: its stable ID; the former `es` and `model` are read too). `body` is the opening message the starter sends with it (the command's name in the UI
 * language, `ja` or `en`, which the interviewer follows unless the person writes in another); `focus` the element
 * selected then (a storming for `/es`, an element of a context for `/model`). → 201 `{ interview, request }`;
 * `InterviewAlreadyRunning` (409) while one runs. A participant who starts one answers it; its brief waits for the
 * facilitator.
 */
export interface StartInterviewBody {
    readonly command: 'es:start' | 'model:start' | 'es' | 'model';
    readonly body: string;
    readonly language: 'ja' | 'en';
    readonly focus?: Json<Collaboration.ModelTarget>;
    /** Where the starter was looking, kept on the opening message (as `SendRequestBody.viewedAt`). */
    readonly viewedAt?: Json<Collaboration.ViewedAt>;
}

/**
 * `POST /api/session/interviews/:id/confirm` (the facilitator; for an interview a participant started, the approval):
 * the brief confirmed, as is or with its text edited (`text`); a run is queued that writes it. → 201
 * `{ interview, run }`. `POST /api/session/interviews/:id/stop` (its starter or the facilitator, an empty body) → 200
 * `{ interview }` (`NotTheInterviewer` 403 for anyone else).
 */
export interface ConfirmInterviewBody {
    readonly text?: string;
}

/**
 * `POST /api/session/interviews/:id/reject` (the facilitator): the brief rejected, with an optional note to its
 * starter; the interview ends. → 200 `{ interview }`.
 */
export interface RejectInterviewBody {
    readonly note?: string;
}

/**
 * `POST /api/session/commands` (any participant): starts a candidate or answer command of the `/` list (`command`: its stable ID,
 * `es:exceptions`, `hint`, …). `body` is the opening message (the command's name in the UI language); `viewedAt` and
 * `focus` say what it is about (the storming in view). → 201 `{ command, request }`; `CommandAlreadyRunning` (409)
 * while one of the same kind runs.
 */
export interface StartCommandBody {
    readonly command: string;
    readonly body: string;
    readonly language: 'ja' | 'en';
    readonly focus?: Json<Collaboration.ModelTarget>;
    readonly viewedAt?: Json<Collaboration.ViewedAt>;
}

/**
 * `POST /api/session/commands/:id/apply` (the facilitator, whoever started it: applying is the approval): the
 * candidates checked (their numbers in the list) become one run. → 201 `{ command, run }`.
 * `POST /api/session/commands/:id/stop` (its starter or the facilitator, an empty body) → 200 `{ command }`
 * (`NotTheStarter` 403 for anyone else).
 */
export interface ApplyCandidatesBody {
    readonly chosen: readonly number[];
}

/**
 * A team's message template (`templates` in domaintrail.jsonc, `domain/templates.ts`): its ID, its name and text — one
 * text for every language, or one per language (`ja`, `en`) — and where it is offered (`when`; absent: everywhere).
 */
export interface MessageTemplateBody {
    readonly id: string;
    readonly name: string | { readonly ja?: string; readonly en?: string };
    readonly text: string | { readonly ja?: string; readonly en?: string };
    readonly when?: readonly TemplateContext[];
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
    RunEdited: 'run.edited',
    RunEditConflicted: 'run.edit_conflicted',
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
    /** The session so far (`sessionSoFar`), whole: for a fresh process (absent from a server before it). */
    readonly sessionSoFar?: AgentSessionSoFar;
    /** The session so far after the entry `since` of the start's body: for a warm process that saw it up to there. */
    readonly sessionSoFarSince?: AgentSessionSoFar;
    /** The journeys when the run starts (the current one, where it stands, the others): what the work is for and how far it goes. */
    readonly journeys?: AgentJourneysBody;
    /**
     * The people's edits of the stickies since the previous run started (ADR 0033), oldest first: who, when, what (old →
     * new). Absent when there were none, and from a server before them.
     */
    readonly peopleEdits?: readonly AgentPeopleEdit[];
}

/** A person's edit of a sticky as a starting run is told of it. */
export interface AgentPeopleEdit {
    readonly by: string;
    readonly at: string;
    readonly edit: Json<Collaboration.StickyEdit>;
}

/**
 * `POST /agent/runs/:id/start`: the lease token, and `since`, the last entry of the session so far the runner's warm
 * process was given (its previous run's `sessionSoFar.last`), for `sessionSoFarSince`.
 */
export interface AgentStartBody extends AgentLeaseBody {
    readonly since?: number;
}

/** The session so far as an agent gets it: the text, the number of its last entry, and the entry it starts after. */
export interface AgentSessionSoFar {
    readonly text: string;
    readonly last: number;
    readonly since?: number;
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

/**
 * Why a runner fails its run without a report: the agent could not run or changed other files (`AgentError`), the
 * runner was stopped (`Interrupted`), or the run was refused because the deny list that keeps what git ignores from the
 * agent would be too long (`ReadScopeTooLarge`: ignore whole directories rather than the files in them).
 */
export const AGENT_FAIL_REASONS = ['AgentError', 'Interrupted', 'ReadScopeTooLarge'] as const satisfies readonly Collaboration.FailureReason[];
export type AgentFailReason = (typeof AGENT_FAIL_REASONS)[number];

/** `POST /agent/runs/:id/fail`. */
export interface AgentFailBody extends AgentLeaseBody {
    readonly reason: AgentFailReason;
}

// ---- Agent API: the answerer role (ADR 0030, decision 6) ----

/** The two roles of an agent: the read-only answerer (triage, answers, proposals) and the runner (runs). */
export const AGENT_ROLES = ['answer', 'run'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/**
 * The SSE stream `GET /agent/answers/events` (the answerer role; no claim, no lease, no workspace lock; no `id:`, nothing
 * to resume: the jobs waiting are handed again to whoever connects): `event:` one of these, `data:` an
 * `AgentAnswerJobBody` (`answer.job`), `{ job }` (`answer.job_withdrawn`: it timed out, or is no longer needed), `{}`
 * (`revision.restored`: the files a warm answerer remembers were replaced), or `{}` (`session.closed`, then the stream
 * ends). Each job is handed to one connected answerer that has none in hand; one not answered within its timeout, or
 * whose answerer disconnects, is handed to another or waits. A connected stream counts as one answerer in
 * `AgentPresence`.
 */
export const AGENT_ANSWER_EVENT_TYPES = {
    job: 'answer.job',
    withdrawn: 'answer.job_withdrawn',
    restored: 'revision.restored',
    closed: 'session.closed',
} as const;

export type AgentAnswerEventType = (typeof AGENT_ANSWER_EVENT_TYPES)[keyof typeof AGENT_ANSWER_EVENT_TYPES];

/** The kinds of answer jobs about a triage: stage 3 of the triage, an answer to a 相談, a proposal for a participant's 依頼. */
export type AgentAnswerJobKind = 'triage' | 'answer' | 'propose';

/** Any job of the answer stream: a job about a triage, or the interviewer's next turn of an interview. */
export type AgentAnswerStreamJob = AgentAnswerJobBody | AgentInterviewJobBody | AgentCommandJobBody;

/**
 * A command job (the `/` list's candidate and answer commands, `/es:exceptions`, `/es:recap`): the answerer lists the
 * command's candidates or answers it, for the starter's opening message (`request`, with the view it was sent from).
 */
export interface AgentCommandJobBody {
    readonly job: string;
    readonly kind: 'command';
    readonly command: Json<Collaboration.SlashCommand>;
    /** The command's stable ID (`es:exceptions`). */
    readonly name: string;
    /** What the answerer returns: candidates, an answer, or the next steps (`/guide`, an answer written from them). */
    readonly type: 'candidates' | 'answer' | 'next';
    /** The starter's opening message. */
    readonly request: Json<Collaboration.Request>;
    /** The starter's display name. */
    readonly author: string;
    readonly timeoutMs: number;
    /** The UI language the command started in: the output follows it, or the person's own language. */
    readonly language: 'ja' | 'en';
    /** The session so far, whole. */
    readonly sessionSoFar?: AgentSessionSoFar;
    readonly readRevision?: string;
    /** The journeys (the current one first among them): what the work is for and how far it goes. */
    readonly journeys?: AgentJourneysBody;
}

/**
 * An interview job (the `/` commands, `/es` and `/model`): the interviewer's next turn — a question, or the brief —
 * answering the starter's latest message (`request`). `transcript` is the interview so far (its opening, the starter's
 * answers and the AI's questions, the message to answer last); `focus` the element selected when it started.
 */
export interface AgentInterviewJobBody {
    readonly job: string;
    readonly kind: 'interview';
    readonly interview: Json<Collaboration.Interview>;
    /** The starter's message to answer. */
    readonly request: Json<Collaboration.Request>;
    /** The starter's display name. */
    readonly author: string;
    readonly timeoutMs: number;
    /** The command's stable ID. */
    readonly command: 'es:start' | 'model:start';
    /** The UI language the interview started in: the questions and the brief follow it, or the person's own language. */
    readonly language: 'ja' | 'en';
    readonly transcript: readonly { readonly from: 'ai' | 'person'; readonly text: string }[];
    /** The session so far, whole. */
    readonly sessionSoFar?: AgentSessionSoFar;
    readonly readRevision?: string;
    /** The journeys (the current one first among them): what the work is for and how far it goes. */
    readonly journeys?: AgentJourneysBody;
}

/**
 * The journeys as the answerer is given them (the journey file, read when the job is handed out): the session's
 * current journey (its key; the default when none is chosen) and every journey but the archived.
 */
export interface AgentJourneysBody {
    readonly current?: string;
    readonly journeys: readonly JourneySummary[];
    /** Where the current journey stands (its 📍 step, the chip's rule; `journeyWhere` of `domain/guide.ts`); absent: not known. */
    readonly where?: JourneyWhere;
}

/** An answer job about a triage as the answerer gets it. */
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
    /** An answer or propose job: the session so far (`sessionSoFar`), whole (for a fresh process). */
    readonly sessionSoFar?: AgentSessionSoFar;
    /**
     * An answer or propose job handed to a stream that answered one before: the session so far after the last entry that
     * job was given (for a warm process that took it).
     */
    readonly sessionSoFarSince?: AgentSessionSoFar;
    /** The latest revision when the job was handed out: what an answer reads (recorded with it). */
    readonly readRevision?: string;
    /** An answer or propose job: the runs the message replies to, with what they changed. */
    readonly previousRuns?: readonly AgentPreviousRun[];
    /** The journeys (the current one first among them): what the work is for and how far it goes. */
    readonly journeys?: AgentJourneysBody;
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

/**
 * `POST /agent/answers/:job` for an interview job: the next question (its choices, two to six, cleaned again by the
 * server; `multiple` when several make one answer), or the brief (`readInterviewerReply`).
 */
export type AgentInterviewResultBody = (
    | { readonly kind: 'question'; readonly question: string; readonly choices?: readonly string[]; readonly multiple?: boolean }
    | { readonly kind: 'brief'; readonly brief: BriefBody }
) & {
    readonly model?: string;
    readonly durationMs: number;
};

/** `POST /agent/answers/:job` for a command job: its candidates, its answer, or its next steps (`readCommandReply`). */
export type AgentCommandResultBody = (
    | { readonly kind: 'candidates'; readonly candidates: readonly CandidateBody[] }
    | { readonly kind: 'answer'; readonly answer: string }
    | ({ readonly kind: 'next' } & NextAnswerBody)
) & {
    readonly model?: string;
    readonly durationMs: number;
};

/** `/guide`'s answer as the answerer writes it (`NextAnswerData` of `domain/slash-commands.ts`): the status and the steps. */
export interface NextAnswerBody {
    readonly status: string;
    readonly steps: readonly { readonly text: string; readonly reason: string; readonly command?: string }[];
}

/** A candidate as the answerer writes it (`CandidateData` of `domain/slash-commands.ts`). */
export interface CandidateBody {
    readonly label: string;
    readonly targets: readonly string[];
    readonly how: string;
    readonly reason?: string;
}

/** A brief as the interviewer writes it (`BriefData` of `domain/interviews.ts`). */
export interface BriefBody {
    /** `/es:start`: the storming's ID; `/model:start`: the ID of the journey it continues (a new one's is derived). */
    readonly name?: string;
    readonly label?: string;
    readonly isNew: boolean;
    /** A new storming's short description (`///`). */
    readonly description?: string;
    /** The journey (`JourneyBriefData` of `domain/interviews.ts`): its why, and how far. */
    readonly journey: {
        readonly purpose: string;
        readonly scope?: string;
        readonly constraints?: string;
        readonly participants: readonly string[];
        readonly use?: 'align' | 'modeling';
        readonly level?: 'BigPicture' | 'DesignLevel';
        readonly name?: string;
        readonly pattern?: string;
        readonly goal?: string;
        readonly stormings?: readonly string[];
        readonly context?: string;
    };
}

/** `POST /agent/answers/:job` for any job that failed (the process crashed, timed out, gave no valid output). */
export interface AgentAnswerFailedBody {
    readonly error: string;
    readonly durationMs: number;
}
