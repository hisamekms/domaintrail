// The ports of the subscriber (`dt session subscribe`, ADR 0026, S6), defined here on its side: the session server's
// agent API, the agent that edits the workspace, the DSL tools run after it, the workspace's files, and time. The
// adapters are in `../infrastructure`, wired by composition (`startSubscriber`).
import type {
    AgentClaimed,
    AgentFinishBody,
    AgentLease,
    AgentParticipantsBody,
    AgentSessionBody,
    EventMessage,
    Json,
} from '@domaintrail/collaboration/protocol';
import type { Collaboration } from '@domaintrail/collaboration/generated/index';

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

/** What a call of the agent API answered; a transport failure (refused, reset, timed out) rejects instead. */
export type ApiResult<T> = { readonly ok: true; readonly value: T } | ApiFailure;

/** The SSE event names the subscriber acts on (`AGENT_EVENT_TYPES` of the protocol). */
export type StreamItem =
    /** The stream is open (first, and again after each reconnection): queued runs may have been missed meanwhile. */
    { readonly kind: 'open' } | { readonly kind: 'event'; readonly id: string; readonly type: string; readonly message: EventMessage };

/** `POST /agent/runs/:id/start` → 200. */
export interface Started {
    readonly run: Json<Collaboration.RunningAgentRun>;
    readonly baseRevision: Json<Collaboration.Revision>;
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
    claim(owner: string): Promise<ApiResult<AgentClaimed>>;
    start(run: string, token: string): Promise<ApiResult<Started>>;
    heartbeat(run: string, token: string): Promise<ApiResult<{ readonly lease: AgentLease }>>;
    finish(run: string, token: string, facts: Omit<AgentFinishBody, 'token'>): Promise<ApiResult<unknown>>;
    clarification(run: string, token: string, question: string): Promise<ApiResult<unknown>>;
    fail(run: string, token: string, reason: 'AgentError' | 'Interrupted'): Promise<ApiResult<unknown>>;
    release(run: string, token: string): Promise<ApiResult<unknown>>;
}

/** One invocation of the agent on the workspace. */
export interface AgentInvocation {
    /** The whole prompt (`buildPrompt`); passed to the agent as data, never through a shell. */
    readonly prompt: string;
    /** The tools the facilitator allows (`GET /agent/session`). */
    readonly allowedTools: readonly string[];
    /** Aborted to stop the agent (a cancel, a lost lease, Ctrl+C): the agent and every process it started are killed. */
    readonly signal: AbortSignal;
}

/** How an invocation ended. */
export interface AgentOutcome {
    /** The agent process's exit code (-1 when it was killed by a signal). */
    readonly exitCode: number;
    /** What the agent said it did (from its final outcome line); not logged, it may echo the requests. */
    readonly summary: string;
    /** The agent asks the facilitator this instead of guessing (its final outcome line). */
    readonly question?: string;
}

/** Runs the agent (Claude Code) in the workspace root, one invocation at a time. */
export interface AgentRunner {
    run(invocation: AgentInvocation): Promise<AgentOutcome>;
}

/** `dt fmt` and `dt check` on the workspace: each resolves whether it ran (exit 0 or 1), not whether it found nothing. */
export interface DslTools {
    format(): Promise<boolean>;
    check(): Promise<boolean>;
}

/** The workspace's files, to see what an agent changed. */
export interface WorkspaceFiles {
    /**
     * Every file below the root (relative, `/`-separated) with a fingerprint that changes when it is written, except
     * `.domaintrail/` and the directories that are never the agent's (`.git`, `node_modules`).
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
