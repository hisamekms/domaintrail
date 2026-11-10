// The subscriber of a session (`dt session subscribe`, ADR 0026, S6): follows the agent API's SSE stream, claims the
// next queued run, and runs it through the pipeline, one run at a time:
//
//   claim (naming what it can run: a revert) → start (the server takes the base revision, and gives the runs it continues
//   and the runs it reverts) → prompt → the agent, with heartbeats → the changed files are
//   only DSL sources? → `dt fmt`, `dt check` when it changed files (else both skipped) → finish {exitCode, formatted,
//   checked, reply} (the server decides the rest)
//
// or, instead of finish, a clarification (the agent asked questions), a decline (the agent will not do the requests,
// and says why) or a failure (`AgentError`: the agent could not
// run or changed other files; `Interrupted`: the subscriber was stopped; `ReadScopeTooLarge`:
// the runner refused the run, its deny list of what git ignores being too long). A cancel of the run (`run.cancel_requested`)
// or a lost lease stops the agent and ends the run's work: the server has already ended it. After a run, the next
// queued one is claimed without waiting for anyone. While the agent runs, what it is doing (as the runner maps it) is
// reported on change, at most once a second, never holding it up. An agent that keeps its conversation across runs
// (a warm one) is also given the prompt that says which files changed since its previous run (the scan after it
// against the scan before this one) and only the session so far since its previous run, is told to forget when a
// revision is restored, and is closed when the subscriber ends. Every prompt carries the session so far (ADR 0030,
// round 3): whole for a fresh agent. Functions over the ports only: no I/O of its own.
import { mapRequests } from '@domaintrail/collaboration';
import { AGENT_CAPABILITIES, AGENT_EVENT_TYPES, type AgentClaimed, type ToolOutcomeBody } from '@domaintrail/collaboration/protocol';
import {
    AgentApiError,
    ReadScopeTooLarge,
    type AgentApi,
    type AgentOutcome,
    type AgentRunner,
    type ApiResult,
    type Clock,
    type DslTools,
    type Started,
    type WorkspaceFiles,
} from './ports.js';
import { createActivityReporter } from './activity.js';
import { changesWorkingContext, journeyContext, type JourneyContext } from './journey-boundary.js';
import { buildPrompt, type Practice } from './prompt.js';
import { buildReviewPrompts, hasReview } from './review-prompt.js';
import type { AgentFinishReview } from '@domaintrail/collaboration/protocol';

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
    /** The shortest time between two reports of what the agent is doing (default a second). */
    readonly activityGapMs?: number;
    /** Reconnection delays of the stream: from `minMs`, doubling up to `maxMs`; ends when none opens for `giveUpMs`. */
    readonly reconnect?: { readonly minMs: number; readonly maxMs: number; readonly giveUpMs: number };
    /** The ways of working the prompts give for the DSLs a run is about (the guide's); none without it. */
    readonly practice?: Practice;
    /** The runner has the knowledge tools of `dt mcp` (ADR 0031): its prompt says when to use them. */
    readonly knowledge?: boolean;
    /** The review at a run's end (ADR 0034, `agent.run.review`); default: on. */
    readonly review?: boolean;
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

/**
 * The events after which a run may be claimable: a run queued; a revert the server reverted itself (the queue moved
 * on), or left to the agent. A revert the server has not tried yet is never given to the agent.
 */
const CLAIMABLE: ReadonlySet<string> = new Set([
    AGENT_EVENT_TYPES['Collaboration.RunQueued'],
    AGENT_EVENT_TYPES['Collaboration.RunReverted'],
    AGENT_EVENT_TYPES['Collaboration.RevertLeftToAgent'],
]);

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

/** A question may accompany an edit; publish it only after both workspace tools accept the edit. */
export async function validateClarificationEdit(tools: DslTools): Promise<boolean> {
    if (!(await tools.format())) return false;
    return tools.check();
}

/** The changed paths that are not DSL sources, before or after: what the agent must not touch (ADR 0026). */
export function changesOutsideSources(changed: readonly string[], sources: ReadonlySet<string>): string[] {
    return changed.filter((p) => !sources.has(p) || !(p.endsWith('.dt') || p.endsWith('.dtes')));
}

/** A reply without the review's report (ADR 0034): the report goes with the finish on its own, never in the reply. */
function withoutReview<R>(reply: R & { readonly review?: unknown }): Omit<R, 'review'> {
    const { review: _, ...rest } = reply;
    return rest;
}

/** Most paths a log line names. */
const SHOWN_PATHS = 20;
/** Longest path a log line shows. */
const SHOWN_PATH_LENGTH = 200;

/**
 * Paths an agent chose, safe for a log line: each one quoted as JSON with every control character (C0, DEL, C1) and
 * bidirectional control escaped, cut to 200 characters, at most 20 of them.
 */
export function showPaths(paths: readonly string[]): string {
    const quoted = paths.slice(0, SHOWN_PATHS).map((p) =>
        JSON.stringify(p.length > SHOWN_PATH_LENGTH ? `${p.slice(0, SHOWN_PATH_LENGTH)}…` : p).replace(
            // oxlint-disable-next-line no-control-regex -- escaping the control characters is the point
            /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
            (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
        ),
    );
    return quoted.join(', ') + (paths.length > SHOWN_PATHS ? `, and ${paths.length - SHOWN_PATHS} more` : '');
}

export function startSubscriber(deps: SubscriberDeps, options: SubscriberOptions): Subscriber {
    const { api, clock, log } = deps;
    const reconnect = options.reconnect ?? DEFAULT_RECONNECT;
    // what every prompt of a run says alike: the ways of working, and the knowledge tools when the runner has them
    const fixed = { ...(options.practice && { practice: options.practice }), ...(options.knowledge && { knowledge: true }) };
    const heartbeatMs = options.heartbeatMs ?? Math.max(50, Math.floor(options.leaseMs / 4));
    const stopping = new AbortController();
    let end: SubscriberEnd | undefined;
    let resolveDone: (end: SubscriberEnd) => void = () => {};
    const done = new Promise<SubscriberEnd>((resolve) => (resolveDone = resolve));
    /** The run in hand, and how to stop its agent when the facilitator cancels it. */
    let current: { readonly run: string; readonly cancel: AbortController } | undefined;
    /**
     * The non-DSL paths an agent changed, shown for the log (`showPaths`), or `<scan failed>`: once set, the subscriber
     * claims no more runs (a person reviews them and restarts it).
     */
    let halted: string | undefined;
    /** The workspace as the agent left it at the end of its previous run (scanned after it): what it last saw. */
    let lastAgentScan: ReadonlyMap<string, string> | undefined;
    /** The last entry of the session so far the agent's previous run was given. */
    let lastSoFar: number | undefined;
    let lastJourney: JourneyContext | undefined;

    /** Stops claiming because of what the run `id` left (`shown`: escaped paths, or why they are unknown). */
    const halt = (id: string, shown: string): void => {
        halted ??= shown;
        log(`not claiming further runs: review ${shown} (left by run ${id}), then restart the subscriber`);
    };

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
            const started = await api.start(id, token, lastSoFar);
            if (!started.ok) {
                if (isFinal(started)) return log(`run ${id}: not started (${started.type})`);
                log(`run ${id}: not started (${started.status} ${started.type}); releasing it`);
                await complete('released', id, () => api.release(id, token));
                return;
            }
            if (started.value.journeys) {
                const nextJourney = journeyContext(started.value.journeys);
                if (changesWorkingContext(lastJourney, nextJourney)) {
                    deps.runner.reset?.('the current journey or its Design Level goal changed');
                    lastAgentScan = undefined;
                }
                lastJourney = nextJourney;
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
                await runPipeline(id, token, run.input, started.value, cancel.signal);
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

    const runPipeline = async (id: string, token: string, input: AgentClaimed['run']['input'], started: Started, cancelled: AbortSignal): Promise<void> => {
        const previousRuns = started.previousRuns ?? [];
        const revert = started.revert ?? [];
        // a revert is never run without the changes it reverts: the agent would take it for a request of its own
        const reverts = input.requests.flatMap((r) => (r.reverts === undefined ? [] : [r.reverts]));
        if (reverts.some((u) => !revert.some((d) => d.run.id === u))) {
            log(`run ${id}: the server gave not the changes of the run it reverts`);
            return complete('failed (AgentError)', id, () => api.fail(id, token, 'AgentError'));
        }
        const names = await api.participants().then(
            (r) => new Map(r.ok ? r.value.participants.map((p) => [p.id, p.name]) : []),
            (e: unknown) => {
                log(`run ${id}: the participants' names are unavailable (${message(e)})`);
                return new Map<string, string>();
            },
        );
        const sourcesBefore = await deps.workspace.sources();
        const before = await deps.workspace.scan();

        /**
         * What the agent changed outside the DSL sources, scanned once after it, on every way out: found or unknown (the
         * scan failed), the subscriber stops claiming. `undefined` until scanned.
         */
        let inspected: { changed: number; outside: boolean; stormings: boolean } | undefined;
        /** What the agent left; `again`: scanned anew (after the review's turn, which may have changed more). */
        const inspect = async (again = false): Promise<{ changed: number; outside: boolean; stormings: boolean }> => {
            if (inspected && !(again && !inspected.outside)) return inspected;
            try {
                const after = await deps.workspace.scan();
                lastAgentScan = after;
                const changed = changedPaths(before, after);
                const sources = new Set([...sourcesBefore, ...(await deps.workspace.sources())]);
                const outside = changesOutsideSources(changed, sources);
                if (outside.length) {
                    const shown = showPaths(outside);
                    log(`run ${id}: the agent changed files other than .dt/.dtes sources: ${shown}`);
                    // they stay on disk and may change how the next agent runs (e.g. `.claude/` settings)
                    halt(id, shown);
                }
                inspected = { changed: changed.length, outside: outside.length > 0, stormings: changed.some((p) => p.endsWith('.dtes')) };
            } catch (e) {
                // what the agent left is unknown: fail closed
                log(`run ${id}: the workspace could not be scanned after the agent: ${message(e)}`);
                halt(id, '<scan failed>');
                inspected = { changed: 0, outside: true, stormings: false };
            }
            return inspected;
        };

        try {
            const signal = AbortSignal.any([cancelled, stopping.signal]);
            // what the agent is doing, for the pages: a change at most once a second, a failure only logged
            const activity = createActivityReporter({
                send: (a) => api.activity(id, token, a),
                clock,
                log: (line) => log(`run ${id}: ${line}`),
                ...(options.activityGapMs !== undefined && { gapMs: options.activityGapMs }),
            });
            let outcome: AgentOutcome;
            const nonce = deps.nonce();
            /** The run's prompt for an agent that starts afresh (the review's fresh prompt starts with it). */
            let runPrompt = '';
            // for an agent that remembers its previous run: what changed since (people, another agent, dt fmt, a restore),
            // and the session so far since then
            const sinceLast = lastAgentScan && changedPaths(lastAgentScan, before);
            const soFar = started.sessionSoFar;
            const soFarSince = started.sessionSoFarSince ?? soFar;
            if (soFar) lastSoFar = soFar.last;
            // the journeys when it starts: the run keeps within the current one
            const journeys = started.journeys ? { journeys: started.journeys } : {};
            // what people edited by hand since the previous run (ADR 0033): their wording is kept
            const peopleEdits = started.peopleEdits && started.peopleEdits.length > 0 ? { peopleEdits: started.peopleEdits } : {};
            runPrompt = buildPrompt(input, names, nonce, previousRuns, revert, {
                ...(soFar && { sessionSoFar: soFar.text }),
                ...fixed,
                ...journeys,
                ...peopleEdits,
            });
            try {
                outcome = await deps.runner.run({
                    prompt: runPrompt,
                    ...(sinceLast && {
                        continuedPrompt: buildPrompt(input, names, nonce, previousRuns, revert, {
                            ...fixed,
                            ...journeys,
                            ...peopleEdits,
                            changedSinceYourLastRun: sinceLast,
                            ...(soFarSince && { sessionSoFar: soFarSince.text }),
                        }),
                    }),
                    allowedTools: options.allowedTools,
                    requests: input.requests.length,
                    signal,
                    onActivity: (a) => activity.report(a),
                });
            } catch (e) {
                activity.stop();
                await inspect();
                if (cancelled.aborted) return log(`run ${id}: cancelled; the agent was stopped`);
                if (stopping.signal.aborted) return complete('failed (Interrupted)', id, () => api.fail(id, token, 'Interrupted'));
                log(`run ${id}: the agent could not run: ${message(e)}`);
                // the read scope could not be kept whole: said as such, so that the page tells what to do
                if (e instanceof ReadScopeTooLarge) return complete('failed (ReadScopeTooLarge)', id, () => api.fail(id, token, 'ReadScopeTooLarge'));
                return complete('failed (AgentError)', id, () => api.fail(id, token, 'AgentError'));
            }
            activity.stop();
            let { changed, outside } = await inspect();
            if (cancelled.aborted) return log(`run ${id}: cancelled; the agent was stopped`);
            if (stopping.signal.aborted) return complete('failed (Interrupted)', id, () => api.fail(id, token, 'Interrupted'));
            log(`run ${id}: the agent exited with ${outcome.exitCode}`);
            if (outside) return complete('failed (AgentError)', id, () => api.fail(id, token, 'AgentError'));
            // the review at the run's end (ADR 0034): a done run that changed stormings checks its neighbourhood, in the
            // same run, before it is finished
            let reviewed: AgentFinishReview | undefined;
            if (outcome.exitCode === 0 && outcome.outcome === 'done' && (await inspect()).stormings) {
                const r = await review(id, token, input.requests.length, runPrompt, nonce, signal);
                if (r.kind === 'cancelled') {
                    await inspect(true);
                    if (cancelled.aborted) return log(`run ${id}: cancelled; the agent was stopped`);
                    return complete('failed (Interrupted)', id, () => api.fail(id, token, 'Interrupted'));
                }
                if (r.kind === 'reviewed') {
                    reviewed = r.review;
                    ({ changed, outside } = await inspect(true));
                    if (outside) return complete('failed (AgentError)', id, () => api.fail(id, token, 'AgentError'));
                }
            }
            // the reply names requests by their number in the prompt: back to the frozen input's IDs
            const reply = outcome.reply && mapRequests(outcome.reply, (n) => input.requests[n - 1]?.request ?? '');
            if (outcome.exitCode === 0 && outcome.outcome === 'clarification' && outcome.question !== undefined) {
                // A provisional Design Level edit may accompany a question. Format and check it before publishing
                // the question so the next turn and the UI see the canonical source. The normal review turn applies
                // to completed work; a clarification keeps this edit open for the person's answer and next run.
                if (changed > 0) {
                    const valid = await validateClarificationEdit(deps.tools);
                    ({ changed, outside } = await inspect(true));
                    if (outside || !valid) return complete('failed (AgentError)', id, () => api.fail(id, token, 'AgentError'));
                }
                const question = outcome.question;
                return complete(`asks for clarification (${changed} file(s) changed)`, id, () => api.clarification(id, token, question, reply));
            }
            if (outcome.exitCode === 0 && outcome.outcome === 'declined' && reply) {
                return complete(`declined (${changed} file(s) changed)`, id, () => api.decline(id, token, reply));
            }
            // nothing changed (an answer, a run that found nothing to do): no dt fmt nor dt check (ADR 0030)
            const outcomeOf = (ran: boolean): ToolOutcomeBody => (ran ? 'ran' : 'failed');
            const formatted: ToolOutcomeBody = changed === 0 ? 'skipped' : outcomeOf(await deps.tools.format());
            const checked: ToolOutcomeBody = changed === 0 ? 'skipped' : outcomeOf(await deps.tools.check());
            if (cancelled.aborted) return log(`run ${id}: cancelled`);
            await complete(
                `finished (${changed} file(s) changed; dt fmt ${formatted}, dt check ${checked})`,
                id,
                // the reply of a done run only: a question or a decline that did not end the run is dropped
                () =>
                    api.finish(id, token, {
                        exitCode: outcome.exitCode,
                        formatted,
                        checked,
                        ...(outcome.outcome === 'done' && reply && { reply: withoutReview(reply) }),
                        ...(reviewed && { review: reviewed }),
                    }),
            );
        } finally {
            // any other way out (an exception) still looks at what the agent left
            await inspect();
        }
    };

    /**
     * The review's turn (ADR 0034): stage 0 of the server, then, when there is anything to check, one more turn of the
     * agent with it — the same conversation for a warm agent — whose `review` is what it says it fixed and kept. A
     * failure of the server's review or of the turn ends the review, never the run (`skipped`; a failed turn is still
     * `reviewed`, with nothing said).
     */
    const review = async (
        id: string,
        token: string,
        requests: number,
        runPrompt: string,
        nonce: string,
        signal: AbortSignal,
    ): Promise<{ readonly kind: 'skipped' } | { readonly kind: 'cancelled' } | { readonly kind: 'reviewed'; readonly review: AgentFinishReview }> => {
        if (!api.review || options.review === false) return { kind: 'skipped' };
        let body;
        try {
            const r = await api.review(id, token);
            if (!r.ok) {
                log(`run ${id}: no review (${r.status} ${r.type})`);
                return { kind: 'skipped' };
            }
            body = r.value;
        } catch (e) {
            log(`run ${id}: no review (${message(e)})`);
            return { kind: 'skipped' };
        }
        if (!body.complete || !hasReview(body)) return { kind: 'skipped' };
        log(
            `run ${id}: reviewing (${body.findings.length} found, ${body.neighbourhood.length} in the neighbourhood, ${body.knowledge?.length ?? 0} knowledge item(s))`,
        );
        const prompts = buildReviewPrompts(body, runPrompt, nonce);
        const activity = createActivityReporter({
            send: (a) => api.activity(id, token, a),
            clock,
            log: (line) => log(`run ${id}: ${line}`),
            ...(options.activityGapMs !== undefined && { gapMs: options.activityGapMs }),
        });
        try {
            const outcome = await deps.runner.run({
                prompt: prompts.fresh,
                continuedPrompt: prompts.continued,
                allowedTools: options.allowedTools,
                requests,
                signal,
                onActivity: (a) => activity.report(a),
            });
            if (signal.aborted) return { kind: 'cancelled' };
            const said = outcome.reply?.review;
            log(`run ${id}: reviewed (exit ${outcome.exitCode}; ${said?.fixed.length ?? 0} fixed, ${said?.kept.length ?? 0} kept)`);
            return {
                kind: 'reviewed',
                review: {
                    fixed: said?.fixed ?? [],
                    kept: said?.kept ?? [],
                    ...(said && said.knowledge.length > 0 && { knowledge: said.knowledge }),
                    ...(said && said.retire.length > 0 && { retire: said.retire }),
                },
            };
        } catch (e) {
            if (signal.aborted) return { kind: 'cancelled' };
            log(`run ${id}: the review's turn could not run: ${message(e)}`);
            return { kind: 'reviewed', review: { fixed: [], kept: [] } };
        } finally {
            activity.stop();
        }
    };

    /** Claims and runs queued runs until none is left (or, with `once`, after one); never again once halted. */
    const work = async (): Promise<void> => {
        while (!end) {
            if (!woken || halted) {
                if (woken && halted) {
                    woken = false;
                    log(`a run is queued, but no run is claimed until the subscriber is restarted (review ${halted})`);
                }
                await new Promise<void>((resolve) => (wakeWorker = resolve));
                wakeWorker = () => {};
                continue;
            }
            woken = false;
            while (!end && !halted) {
                let claimed: ApiResult<AgentClaimed>;
                try {
                    claimed = await api.claim(deps.owner, AGENT_CAPABILITIES);
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
                else if (halted) break;
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
                    // a run queued, or the queue moved past a revert the server took first: something may be claimable
                    if (CLAIMABLE.has(item.type)) wake();
                    else if (item.type === 'session.closed') finish('closed');
                    else if (item.type === 'revision.restored') deps.runner.reset?.('a revision was restored');
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
    void Promise.all([worker, stream])
        .then(() => deps.runner.close?.())
        .catch((e: unknown) => log(`the agent could not be closed: ${message(e)}`))
        .then(() => resolveDone(end ?? 'stopped'));

    return {
        done,
        async stop() {
            finish('stopped');
            return done;
        },
    };
}
