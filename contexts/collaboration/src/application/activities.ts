// What the running runs are doing (ADR 0026, amendment: what a running run is doing): the latest activity the agent
// reported for each running run, in memory only, like presence. Nothing is stored and no event is made: a server
// started again knows none, and a page that connects gets those held now. The caller checks the run's lease before it
// sets one, and ends a run's activity once the run left `Running`.
import type { RunActivity } from '../domain/activity.js';
import { sameActivity } from '../domain/activity.js';

/** The events that end a running run: its activity is dropped when one of them is read. */
export const RUN_ENDING_EVENTS = ['RunCompleted', 'RunNeedsClarification', 'RunDeclined', 'RunFailed', 'RunCancelled'] as const;

export interface RunActivities {
    /** Holds the run's latest activity; whether it changed (the same activity again changes nothing). */
    set(run: string, activity: RunActivity): boolean;
    /** Drops the run's activity (it ended); whether there was one. */
    end(run: string): boolean;
    /** Every activity held, by run ID. */
    all(): Readonly<Record<string, RunActivity>>;
}

export function createRunActivities(): RunActivities {
    const latest = new Map<string, RunActivity>();
    return {
        set(run, activity) {
            if (sameActivity(latest.get(run), activity)) return false;
            latest.set(run, activity.subject === undefined ? { phase: activity.phase } : { phase: activity.phase, subject: activity.subject });
            return true;
        },
        end: (run) => latest.delete(run),
        all: () => Object.fromEntries(latest),
    };
}
