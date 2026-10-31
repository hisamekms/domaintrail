// The subscriber of a session (`dt session subscribe`, ADR 0026, S6): follows the agent API's SSE stream, claims the
// next queued run, and runs it through the pipeline, one run at a time:
//
//   claim → start (the server takes the base revision) → prompt → the agent, with heartbeats → the changed files are
//   only DSL sources? → `dt fmt`, `dt check` → finish {exitCode, formatted, checked} (the server decides the rest)
//
// or, instead of finish, a clarification (the agent asked a question) or a failure (`AgentError`: the agent could not
// run or changed other files; `Interrupted`: the subscriber was stopped). A cancel of the run (`run.cancel_requested`)
// or a lost lease stops the agent and ends the run's work: the server has already ended it. After a run, the next
// queued one is claimed without waiting for anyone. Functions over the ports only: no I/O of its own.
import type { AgentClaimed } from '@domaintrail/collaboration/protocol';
import { AgentApiError, type AgentApi, type AgentOutcome, type AgentRunner, type ApiResult, type Clock, type DslTools, type WorkspaceFiles } from './ports.js';
import { buildPrompt } from './prompt.js';

export interface SubscriberDeps {
    readonly api: AgentApi;
    readonly runner: AgentRunner;
    readonly tools: DslTools;
    readonly workspace: WorkspaceFiles;
    readonly clock: Clock;
    /** Who claims (shown to the facilitator), e.g. `claude@host`. */
    readonly owner: string;
    /** A random string per run (the prompt's block delimiter). */
    readonly nonce: () => string;
    /** Progress for the person running it: run IDs, states and counts only, never a request's text or a token. */
    readonly log: (line: string) => void;
}

export interface SubscriberOptions {
    /** The tools the facilitator allows and the lease's length (`GET /agent/session`). */
    readonly allowedTools: readonly string[];
    readonly leaseMs: number;
    /** Handle one run (waiting for one if none is queued), then end. */
    readonly once?: boolean;
    /** How often the lease is renewed (default a quarter of `leaseMs`). */
    readonly heartbeatMs?: number;
    /** Reconnection delays of the stream: from `minMs`, doubling up to `maxMs`; ends when none opens for `giveUpMs`. */
    readonly reconnect?: { readonly minMs: number; readonly maxMs: number; readonly giveUpMs: number };
}

/** Why a subscriber ended. */
export type SubscriberEnd =
    /** `once`: its run is done. */
    | 'once'
    /** The session closed. */
    | 'closed'
    /** `stop()` was called. */
    | 'stopped'
    /** The session server is gone or no longer knows the credential. */
    | 'lost';

export interface Subscriber {
    /** Resolves when the subscriber ends. */
    readonly done: Promise<SubscriberEnd>;
    /**
     * Stops: a claimed run not started yet is released, a running one's agent is stopped and the run failed as
     * `Interrupted`. Resolves once that is done.
     */
    stop(): Promise<SubscriberEnd>;
}

const DEFAULT_RECONNECT = { minMs: 500, maxMs: 5_000, giveUpMs: 60_000 };
/** How often a completion is tried again after a transport failure (it is idempotent on the server). */
const COMPLETION_TRIES = 5;

/** A run's state on the server may have moved on: cancelled, lease expired or taken. Nothing more to do for it. */
const isFinal = (r: ApiResult<unknown>): boolean => !r.ok && (r.status === 409 || r.status === 404);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Paths whose fingerprint differs between the scans (added, changed or removed). */
export function changedPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
    const changed = new Set<string>();
    for (const [p, print] of after) if (before.get(p) !== print) changed.add(p);
    for (const p of before.keys()) if (!after.has(p)) changed.add(p);
    return [...changed].sort();
}

/** The changed paths that are not DSL sources, before or after: what the agent must not touch (ADR 0026). */
export function changesOutsideSources(changed: readonly string[], sources: ReadonlySet<string>): string[] {
    return changed.filter((p) => !sources.has(p) || !(p.endsWith('.dt') || p.endsWith('.dtes')));
}

export function startSubscriber(deps: SubscriberDeps, options: SubscriberOptions): Subscriber {
    const { api, clock, log } = deps;
    const reconnect = options.reconnect ?? DEFAULT_RECONNECT;
    const heartbeatMs = options.heartbeatMs ?? Math.max(50, Math.floor(options.leaseMs / 4));
    const stopping = new AbortController();
    let end: SubscriberEnd | undefined;
    let resolveDone: (end: SubscriberEnd) => void = () => {};
    const done = new Promise<SubscriberEnd>((resolve) => (resolveDone = resolve));
    /** The run in hand, and how to stop its agent when the facilitator cancels it. */
    let current: { readonly run: string; readonly cancel: AbortController } | undefined;

    // the worker sleeps until something may be queued: an event, a reconnection, a failure to retry
    let woken = true;
    let wakeWorker: () => void = () => {};
    const wake = (): void => {
        woken = true;
        wakeWorker();
    };

    const finish = (why: SubscriberEnd): void => {
        if (end) return;
        end = why;
        stopping.abort();
        wakeWorker();
    };

    /** Calls a completion until the server answers (a transport failure is tried again; the server replays a repeat). */
    const complete = async (what: string, run: string, call: () => Promise<ApiResult<unknown>>): Promise<void> => {
        for (let attempt = 1; ; attempt++) {
            try {
                const r = await call();
                if (r.ok) return log(`run ${run}: ${what}`);
                if (isFinal(r)) return log(`run ${run}: ${what} refused (${r.type}): the run already ended on the server`);
                return log(`run ${run}: ${what} refused (${r.status} ${r.type})`);
            } catch (e) {
                if (attempt >= COMPLETION_TRIES) return log(`run ${run}: ${what} failed: ${message(e)}`);
                log(`run ${run}: ${what} failed (${message(e)}), trying again`);
                await clock.sleep(reconnect.minMs * attempt);
            }
        }
    };

    /** Runs a claimed run through the pipeline. */
    const handle = async ({ run, lease }: AgentClaimed): Promise<void> => {
        const id = run.id;
        const token = lease.token;
        const cancel = new AbortController();
        current = { run: id, cancel };
        try {
            if (stopping.signal.aborted) {
                await complete('released', id, () => api.release(id, token));
                return;
            }
            const started = await api.start(id, token);
            if (!started.ok) {
                if (isFinal(started)) return log(`run ${id}: not started (${started.type})`);
                log(`run ${id}: not started (${started.status} ${started.type}); releasing it`);
                await complete('released', id, () => api.release(id, token));
                return;
            }
            log(`run ${id}: started (${run.input.requests.length} request(s), base revision ${started.value.baseRevision.id})`);

            let lost = false;
            const stopBeating = clock.every(heartbeatMs, () => {
                api.heartbeat(id, token).then(
                    (r) => {
                        if (r.ok || !isFinal(r) || lost) return;
                        lost = true;
                        log(`run ${id}: the lease is gone (${r.type}); stopping the agent`);
                        cancel.abort();
                    },
                    (e: unknown) => log(`run ${id}: heartbeat failed: ${message(e)}`),
                );
            });
            try {
                await runPipeline(id, token, run.input, cancel.signal);
            } catch (e) {
                // the workspace could not be scanned, the participants not read…: the run fails, the next one is taken
                log(`run ${id}: ${message(e)}`);
                if (!cancel.signal.aborted) await complete('failed (AgentError)', id, () => api.fail(id, token, 'AgentError'));
            } finally {
                stopBeating();
            }
        } finally {
            current = undefined;
        }
    };

    const runPipeline = async (id: string, token: string, input: AgentClaimed['run']['input'], cancelled: AbortSignal): Promise<void> => {
        const names = await api.participants().then(
            (r) => new Map(r.ok ? r.value.participants.map((p) => [p.id, p.name]) : []),
            (e: unknown) => {
                log(`run ${id}: the participants' names are unavailable (${message(e)})`);
                return new Map<string, string>();
            },
        );
        const sourcesBefore = await deps.workspace.sources();
        const before = await deps.workspace.scan();
        const signal = AbortSignal.any([cancelled, stopping.signal]);
        let outcome: AgentOutcome;
        try {
            outcome = await deps.runner.run({ prompt: buildPrompt(input, names, deps.nonce()), allowedTools: options.allowedTools, signal });
        } catch (e) {
            if (cancelled.aborted) return log(`run ${id}: cancelled; the agent was stopped`);
            if (stopping.signal.aborted) return complete('failed (Interrupted)', id, () => api.fail(id, token, 'Interrupted'));
            log(`run ${id}: the agent could not run: ${message(e)}`);
            return complete('failed (AgentError)', id, () => api.fail(id, token, 'AgentError'));
        }
        if (cancelled.aborted) return log(`run ${id}: cancelled; the agent was stopped`);
        if (stopping.signal.aborted) return complete('failed (Interrupted)', id, () => api.fail(id, token, 'Interrupted'));
        log(`run ${id}: the agent exited with ${outcome.exitCode}`);

        const changed = changedPaths(before, await deps.workspace.scan());
        const sources = new Set([...sourcesBefore, ...(await deps.workspace.sources())]);
        const outside = changesOutsideSources(changed, sources);
        if (outside.length) {
            const shown = outside.slice(0, 20).join(', ') + (outside.length > 20 ? `, and ${outside.length - 20} more` : '');
            log(`run ${id}: the agent changed files other than .dt/.dtes sources: ${shown}`);
            return complete('failed (AgentError)', id, () => api.fail(id, token, 'AgentError'));
        }
        if (outcome.question !== undefined && outcome.exitCode === 0) {
            return complete(`asks for clarification (${changed.length} file(s) changed)`, id, () => api.clarification(id, token, outcome.question ?? ''));
        }
        const formatted = await deps.tools.format();
        const checked = await deps.tools.check();
        if (cancelled.aborted) return log(`run ${id}: cancelled`);
        await complete(
            `finished (${changed.length} file(s) changed; dt fmt ${formatted ? 'ran' : 'did not run'}, dt check ${checked ? 'ran' : 'did not run'})`,
            id,
            () => api.finish(id, token, { exitCode: outcome.exitCode, formatted, checked }),
        );
    };

    /** Claims and runs queued runs until none is left (or, with `once`, after one). */
    const work = async (): Promise<void> => {
        while (!end) {
            if (!woken) {
                await new Promise<void>((resolve) => (wakeWorker = resolve));
                wakeWorker = () => {};
                continue;
            }
            woken = false;
            while (!end) {
                let claimed: ApiResult<AgentClaimed>;
                try {
                    claimed = await api.claim(deps.owner);
                } catch (e) {
                    log(`claiming failed: ${message(e)}`);
                    void clock.sleep(reconnect.minMs, stopping.signal).then(wake);
                    break;
                }
                if (!claimed.ok) {
                    if (claimed.status === 401) finish('lost');
                    else if (claimed.type !== 'NothingQueued' && claimed.type !== 'RunInProgress') log(`claiming refused (${claimed.status} ${claimed.type})`);
                    break;
                }
                await handle(claimed.value);
                if (options.once) finish('once');
            }
        }
    };

    /** Follows the SSE stream, reconnecting with `Last-Event-ID`. */
    const follow = async (): Promise<void> => {
        let lastEventId: string | undefined;
        let delay = reconnect.minMs;
        /** Since when no stream could be opened. */
        let failingSince = Date.now();
        while (!end) {
            try {
                for await (const item of api.events(lastEventId, stopping.signal)) {
                    if (item.kind === 'open') {
                        delay = reconnect.minMs;
                        failingSince = Number.POSITIVE_INFINITY;
                        wake();
                        continue;
                    }
                    lastEventId = item.id;
                    if (item.type === 'run.queued') wake();
                    else if (item.type === 'session.closed') finish('closed');
                    else if (item.type === 'run.cancel_requested' && item.message.type === 'run.cancelled' && item.message.event.runId === current?.run) {
                        log(`run ${current.run}: cancel requested`);
                        current.cancel.abort();
                    }
                }
            } catch (e) {
                if (end) break;
                if (e instanceof AgentApiError && (e.status === 401 || e.status === 404)) {
                    log(`the session server refused the stream (${e.status} ${e.type})`);
                    finish('lost');
                    break;
                }
                log(`the event stream broke (${message(e)}); reconnecting`);
            }
            if (end) break;
            failingSince = Math.min(failingSince, Date.now());
            if (Date.now() - failingSince > reconnect.giveUpMs) {
                log('the session server is unreachable');
                finish('lost');
                break;
            }
            await clock.sleep(delay, stopping.signal);
            delay = Math.min(delay * 2, reconnect.maxMs);
        }
    };

    const fail = (what: string) => (e: unknown) => {
        log(`${what} failed: ${message(e)}`);
        finish('lost');
    };
    const worker = work().catch(fail('the subscriber'));
    const stream = follow().catch(fail('the event stream'));
    void Promise.all([worker, stream]).then(() => resolveDone(end ?? 'stopped'));

    return {
        done,
        async stop() {
            finish('stopped');
            return done;
        },
    };
}
