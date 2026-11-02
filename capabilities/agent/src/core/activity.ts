// Reporting what a running run is doing (ADR 0026, amendment: what a running run is doing): the agent adapter tells
// each activity as it maps one; this sends a change only, at most once per `gapMs` (the latest waiting one replaces an
// older one), without ever holding up the agent: a report is not awaited, and a failure is logged and ignored.
import { sameActivity } from '@domaintrail/collaboration';
import type { RunActivity } from '@domaintrail/collaboration/protocol';
import type { ApiResult, Clock } from './ports.js';

/** The shortest time between two reports of a run. */
export const ACTIVITY_GAP_MS = 1_000;

export interface ActivityReporter {
    /** The agent's activity now: sent if it changed, now or once the gap since the last report has passed. */
    report(activity: RunActivity): void;
    /** Nothing more is sent (the agent returned); a waiting activity is dropped. */
    stop(): void;
}

export interface ActivityReporterDeps {
    readonly send: (activity: RunActivity) => Promise<ApiResult<unknown>>;
    readonly clock: Clock;
    /** Why a report did not reach the server (never the activity's subject). */
    readonly log: (line: string) => void;
    readonly gapMs?: number;
}

export function createActivityReporter(deps: ActivityReporterDeps): ActivityReporter {
    const gapMs = deps.gapMs ?? ACTIVITY_GAP_MS;
    const stopping = new AbortController();
    /** The latest activity told (sent or waiting), the latest sent, and the one waiting for the gap to pass. */
    let told: RunActivity | undefined;
    let sent: RunActivity | undefined;
    let waiting: RunActivity | undefined;
    let cooling = false;

    const send = (activity: RunActivity): void => {
        sent = activity;
        cooling = true;
        deps.send(activity).then(
            (r) => {
                if (!r.ok) deps.log(`activity refused (${r.status} ${r.type})`);
            },
            (e: unknown) => deps.log(`activity failed: ${e instanceof Error ? e.message : String(e)}`),
        );
        void deps.clock.sleep(gapMs, stopping.signal).then(() => {
            cooling = false;
            const next = waiting;
            waiting = undefined;
            if (next && !stopping.signal.aborted && !sameActivity(next, sent)) send(next);
        });
    };

    return {
        report(activity) {
            if (stopping.signal.aborted || sameActivity(activity, told)) return;
            told = activity;
            if (cooling) waiting = activity;
            else send(activity);
        },
        stop() {
            waiting = undefined;
            stopping.abort();
        },
    };
}
