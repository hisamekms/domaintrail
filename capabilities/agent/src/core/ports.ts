// The ports of the agent's roles (ADR 0026, S6; ADR 0030, decision 6; ADR 0031, section 3), defined here on their side:
// the session server's agent API (the runner's entry point, the answerer's and the extractor's), the agent that edits
// the workspace (the runner), the read-only agent that triages and answers (the answerer), the agent with no tools that
// extracts knowledge (the extractor), the DSL tools run after a run, the workspace's files, and time. The adapters are in
// `../adapters`, wired by the app (`startSubscriber`, `startAnswerer`, `startExtractor`).
import type {
    AgentAnswerStreamJob,
    AgentClaimed,
    AgentFailReason,
    AgentReplyBody,
    AgentFinishBody,
    AgentJourneysBody,
    AgentLease,
    AgentPreviousRun,
    AgentParticipantsBody,
    AgentRevertedRun,
    AgentSessionBody,
    AgentSessionSoFar,
    EventMessage,
    Json,
    RunActivity,
    AgentPeopleEdit,
} from '@domaintrail/collaboration/protocol';
import type { Collaboration, CommandReplyShape, ReplyData, ReplyOutcome } from '@domaintrail/collaboration';
import type { ExtractionJobBody, ExtractionResultBody } from '@domaintrail/knowledge';

/** An answer of the agent API other than 2xx: its HTTP status and the error's `type` (`LeaseLost`, `NothingQueued`, …). */
export interface ApiFailure {
    readonly ok: false;
    readonly status: number;
    readonly type: string;
}

/** The agent API answered a stream's request with an error (401: the credential is no longer the server's). */
export class AgentApiError extends Error {
    constructor(
        readonly status: number,
        readonly type: string,
    ) {
        super(`The agent API answered ${status} ${type}`);
    }
}

/**
 * A runner refuses a run because the deny list that keeps what git ignores from the agent would be too long: the run
 * fails as `ReadScopeTooLarge` (the page says why), never runs with part of the list.
 */
export class ReadScopeTooLarge extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ReadScopeTooLarge';
    }
}

/** What a call of the agent API answered; a transport failure (refused, reset, timed out) rejects instead. */
export type ApiResult<T> = { readonly ok: true; readonly value: T } | ApiFailure;

/** The SSE event names the subscriber acts on (`AGENT_EVENT_TYPES` of the protocol). */
export type StreamItem =
    /** The stream is open (first, and again after each reconnection): queued runs may have been missed meanwhile. */
    { readonly kind: 'open' } | { readonly kind: 'event'; readonly id: string; readonly type: string; readonly message: EventMessage };

/**
 * `POST /agent/runs/:id/start` → 200 (`AgentStartedBody`): `previousRuns` may be absent from an older server, `revert`
 * is there only for a revert.
 */
export interface Started {
    readonly run: Json<Collaboration.RunningAgentRun>;
    readonly baseRevision: Json<Collaboration.Revision>;
    readonly previousRuns?: readonly AgentPreviousRun[];
    readonly revert?: readonly AgentRevertedRun[];
    /** The session so far, whole (absent from an older server). */
    readonly sessionSoFar?: AgentSessionSoFar;
    /** The session so far after the `since` the start was given. */
    readonly sessionSoFarSince?: AgentSessionSoFar;
    /** The journeys when the run starts (absent: no journey file, or an older server). */
    readonly journeys?: AgentJourneysBody;
    /** The stickies people edited by hand since the previous run started (absent: none, or an older server). */
    readonly peopleEdits?: readonly AgentPeopleEdit[];
}

/** The agent API of the session server (loopback, bearer token). */
export interface AgentApi {
    session(): Promise<ApiResult<AgentSessionBody>>;
    participants(): Promise<ApiResult<AgentParticipantsBody>>;
    /**
     * The SSE stream of the outbox after `lastEventId` (from the start without one): `open` first, then the events, until
     * the server ends it or `signal` aborts. Rejects with `AgentApiError` when the server answers the request with an
     * error, with another error when the stream cannot be opened or breaks.
     */
    events(lastEventId: string | undefined, signal: AbortSignal): AsyncIterable<StreamItem>;
    /** Claims the next run; `capabilities`: what this subscriber can run (`AGENT_CAPABILITIES`), so that it is given no run it cannot. */
    claim(owner: string, capabilities: readonly string[]): Promise<ApiResult<AgentClaimed>>;
    /** `since`: the last entry of the session so far the runner's warm process was given (for `sessionSoFarSince`). */
    start(run: string, token: string, since?: number): Promise<ApiResult<Started>>;
    heartbeat(run: string, token: string): Promise<ApiResult<{ readonly lease: AgentLease }>>;
    /** What the running run is doing now (the server keeps the latest for the pages; the lease is not extended). */
    activity(run: string, token: string, activity: RunActivity): Promise<ApiResult<unknown>>;
    finish(run: string, token: string, facts: Omit<AgentFinishBody, 'token'>): Promise<ApiResult<unknown>>;
    clarification(run: string, token: string, question: string, reply?: AgentReplyBody): Promise<ApiResult<unknown>>;
    decline(run: string, token: string, reply: AgentReplyBody): Promise<ApiResult<unknown>>;
    fail(run: string, token: string, reason: AgentFailReason): Promise<ApiResult<unknown>>;
    release(run: string, token: string): Promise<ApiResult<unknown>>;
    /**
     * The answerer role's SSE stream (`GET /agent/answers/events`): `open` first, then the jobs handed to this answerer,
     * their withdrawals, a restored revision and the session's end, until the server ends it or `signal` aborts. Rejects
     * as `events` does.
     */
    answerEvents(signal: AbortSignal): AsyncIterable<AnswerStreamItem>;
    /** `POST /agent/answers/:job`: a job's result (or why it failed). */
    answerResult(job: string, result: Readonly<Record<string, unknown>>): Promise<ApiResult<unknown>>;
}

/**
 * The extractor role's entry point on the agent API (ADR 0031, section 3): `GET /agent/extractions/events` and
 * `POST /agent/extractions/:job`. A server with no knowledge store answers the stream 404.
 */
export interface ExtractionApi {
    /** The extractor's SSE stream: `open` first, then its jobs, their withdrawals and the session's end. Rejects as `events` does. */
    extractionEvents(signal: AbortSignal): AsyncIterable<ExtractionStreamItem>;
    /** A job's result (or why it failed). */
    extractionResult(job: string, result: ExtractionResultBody): Promise<ApiResult<unknown>>;
}

/** The light model's small jobs (a hotspot's name, ADR 0033): the extraction's stream and results on a path of their own. */
export interface HelperApi {
    helperEvents(signal: AbortSignal): AsyncIterable<ExtractionStreamItem>;
    helperResult(job: string, result: ExtractionResultBody): Promise<ApiResult<unknown>>;
}

/** The helpers' stream as the extractor's loop takes it (`startExtractor` follows either). */
export const helperStream = (api: HelperApi): ExtractionApi => ({
    extractionEvents: (signal) => api.helperEvents(signal),
    extractionResult: (job, result) => api.helperResult(job, result),
});

/** What the extractor role's stream carries. */
export type ExtractionStreamItem =
    | { readonly kind: 'open' }
    | { readonly kind: 'job'; readonly job: ExtractionJobBody }
    | { readonly kind: 'withdrawn'; readonly job: string }
    | { readonly kind: 'closed' };

/** What the answerer role's stream carries. */
export type AnswerStreamItem =
    | { readonly kind: 'open' }
    | { readonly kind: 'job'; readonly job: AgentAnswerStreamJob }
    | { readonly kind: 'withdrawn'; readonly job: string }
    | { readonly kind: 'restored' }
    | { readonly kind: 'closed' };

/** One turn of the read-only agent: its prompt (and the one for a process that continues), and how to stop it. */
export interface AnswerTurn {
    readonly prompt: string;
    /** The prompt for a process that took turns before (a warm answerer): the session so far since then, the files changed. */
    readonly continuedPrompt?: string;
    /** Aborted to stop the turn (withdrawn, timed out, the answerer stops). */
    readonly signal: AbortSignal;
}

/** A command's turn: what it returns (its candidates, an answer, or the next steps) picks the schema. */
export interface CommandTurn extends AnswerTurn {
    readonly type: CommandReplyShape;
}

/** What a turn of the read-only agent gave: its structured output (unvalidated), or why it gave none. */
export interface AnswerTurnResult {
    /** The structured output (`--json-schema`), else undefined. */
    readonly structured?: unknown;
    /** The final text (the output as JSON when structured). */
    readonly text: string;
    /** The model that answered, when the agent said. */
    readonly model?: string;
    /** Why there is no output: the process failed, exited, or the turn was stopped. */
    readonly error?: string;
    /** What the turn cost, when the agent said. */
    readonly usage?: TurnUsage;
}

/** What a turn cost: the tokens in (those read from and written to the prompt cache apart) and out, and dollars. */
export interface TurnUsage {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheCreationTokens?: number;
    readonly costUsd?: number;
}

/** An extractor's turn: the message, and what goes in the system prompt after the instructions (the workspace's stickies). */
export interface ExtractTurn extends AnswerTurn {
    /** The stable part of the job, appended to the system prompt after the role's instructions: the prompt cache keeps it. */
    readonly context?: string;
}

/**
 * The extractor (ADR 0031, section 3): a read-only agent with **no tools at all** (no file is read: its prompt holds
 * the talk and the items), replying with the extractor's schema; and the light model before it (`gate`), with no tools
 * either, replying whether to extract. One turn at a time.
 */
export interface ExtractAgent {
    extract(turn: ExtractTurn): Promise<AnswerTurnResult>;
    gate(turn: ExtractTurn): Promise<AnswerTurnResult>;
    /** The light model names a hotspot a person writes (ADR 0033); absent: such jobs fail (the server then names it). */
    hotspotName?(turn: ExtractTurn): Promise<AnswerTurnResult>;
    /** Ends what it keeps; resolves once it is gone. */
    close?(): Promise<void>;
}

/**
 * The read-only agent of the answerer role (Claude Code): stage 3 of the triage with no tools at all, answers and
 * proposals with the reading tools only (`Read`, `Grep`, `Glob`), enforced by the process's own tools, never by the
 * prompt. One turn of each at a time.
 */
export interface AnswerAgent {
    /** Stage 3: the light model, no tools. */
    triage(turn: AnswerTurn): Promise<AnswerTurnResult>;
    /** An answer or a proposal: the reading tools only. */
    answer(turn: AnswerTurn): Promise<AnswerTurnResult>;
    /** An interview's turn (`/es:start`, `/model:start`): the reading tools only, the interviewer's schema. */
    interview(turn: AnswerTurn): Promise<AnswerTurnResult>;
    /** A candidate or answer command of the `/` list: the reading tools only, the schema of its type, a fresh process. */
    command(turn: CommandTurn): Promise<AnswerTurnResult>;
    /** Forget the conversation (a warm process): the files it read were replaced. */
    reset?(reason: string): void;
    /** Ends the processes it keeps; resolves once they are gone. */
    close?(): Promise<void>;
}

/** One invocation of the agent on the workspace. */
export interface AgentInvocation {
    /** The whole prompt (`buildPrompt`); passed to the agent as data, never through a shell. */
    readonly prompt: string;
    /**
     * The prompt for an agent that continues the conversation of its previous run (a warm agent, which remembers the
     * files it read): the same, with the files changed since that run (`changedSinceYourLastRun`). Absent for the first
     * run; an agent that starts afresh takes `prompt`.
     */
    readonly continuedPrompt?: string;
    /** The tools the facilitator allows (`GET /agent/session`). */
    readonly allowedTools: readonly string[];
    /** How many requests the prompt numbers (the reply names them by number, 1 to this). */
    readonly requests: number;
    /** Aborted to stop the agent (a cancel, a lost lease, Ctrl+C): the agent and every process it started are killed. */
    readonly signal: AbortSignal;
    /**
     * Told what the agent is doing as it goes, in the protocol's phases (an adapter maps its own events; what it cannot
     * map it does not tell). Returns at once: the caller reports it without holding up the agent.
     */
    readonly onActivity?: (activity: RunActivity) => void;
}

/** How an invocation ended. */
export interface AgentOutcome {
    /** The agent process's exit code (-1 when it was killed by a signal). */
    readonly exitCode: number;
    /** How the agent says the run ended (`done` when its reply could not be read). Never logged, like all of the reply. */
    readonly outcome: ReplyOutcome;
    /** What the agent said it did, or why it declined ('' when its reply had none). */
    readonly summary: string;
    /** A clarification: the agent asks the facilitator this instead of guessing, as plain text. */
    readonly question?: string;
    /** The reply, validated against its shape and limits (requests by their number in the prompt); absent when it was not valid. */
    readonly reply?: ReplyData<number>;
}

/** Runs the agent (Claude Code) in the workspace root, one invocation at a time. */
export interface AgentRunner {
    run(invocation: AgentInvocation): Promise<AgentOutcome>;
    /**
     * Forget the conversation (a warm agent): the next run starts afresh, e.g. after a revision was restored. Says
     * why, for the log. A runner that keeps nothing between runs has none.
     */
    reset?(reason: string): void;
    /** Ends what the runner keeps running between runs (a warm agent's process); resolves once it is gone. */
    close?(): Promise<void>;
}

/**
 * `dt fmt` and `dt check` on the workspace: each resolves whether it ran (exit 0 or 1), not whether it found nothing.
 * The subscriber runs them only when the run changed files (else they are `skipped`).
 */
export interface DslTools {
    format(): Promise<boolean>;
    check(): Promise<boolean>;
}

/** The workspace's files, to see what an agent changed. */
export interface WorkspaceFiles {
    /**
     * Every file below the root (relative, `/`-separated) with a fingerprint that changes when it is written, except
     * `.domaintrail/` and the directories that are never the agent's (`.git`, `node_modules`); the runner's skips those
     * only dt writes too (the `files` knowledge store's `knowledge/`, which the session may write while the agent runs).
     */
    scan(): Promise<ReadonlyMap<string, string>>;
    /** The DSL sources (`.dt` and `.dtes` matching the configured `sources`), relative to the root. */
    sources(): Promise<ReadonlySet<string>>;
}

/** Time, for heartbeats and reconnection. */
export interface Clock {
    /** Resolves after `ms`, or early (without rejecting) when `signal` aborts. */
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
    /** Calls `tick` every `ms` until the returned function is called. */
    every(ms: number, tick: () => void): () => void;
}
