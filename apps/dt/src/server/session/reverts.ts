// The server's turn in the queue of runs (ADR 0026, amendment "a revert queues like any other change"): a revert is
// queued behind the other work, and when it reaches the head, the server — not an agent — tries it mechanically first
// (`revertNext`), behind the watcher hold, so that it goes through with no agent connected. Only a revert it cannot
// do is left queued for the agent, with why. The server is kicked whenever the queue may have moved: after any event
// (a run queued, ended, cancelled, a lease expired), on its lease ticker and at startup; one pass at a time.
import type { CollaborationUseCases, Collaboration, RevertOutcome } from '@domaintrail/collaboration';

export interface RevertQueueDeps {
    readonly session: Collaboration.SessionId;
    readonly collaboration: Pick<CollaborationUseCases, 'revertNext'>;
    /** The server's lease on the revert while it tries it (an agent's lease length: a try is far shorter). */
    readonly leaseMs: number;
    /** Runs a write with the watcher held (refreshed once after it when `wrote`). */
    readonly holdWatcher: <T>(work: () => Promise<T>, wrote: (result: T) => boolean) => Promise<T>;
    /** Sends the events of what the server did to the pages and the agent. */
    readonly pump: () => Promise<void>;
    readonly log: (line: string) => void;
}

export interface RevertQueue {
    /**
     * Takes the reverts at the head of the queue that the server has to try, one after the other, until the head is not
     * one (or a run is in progress). Resolves when the pass is over, including what a kick during it asked for.
     */
    kick(): Promise<void>;
    /** Takes no more reverts; resolves once the pass in flight, if any, is over (before the database closes). */
    stop(): Promise<void>;
}

const wroteFiles = (r: Awaited<ReturnType<CollaborationUseCases['revertNext']>>): boolean => r.ok && r.value.kind === 'reverted' && r.value.run.changed;

const describe = (o: RevertOutcome): string =>
    o.kind === 'leftToAgent'
        ? `left the revert ${o.run.id} to the agent (${o.obstacle.kind})`
        : o.run.changed
          ? `reverted mechanically (run ${o.run.id})`
          : `nothing left to revert (run ${o.run.id})`;

export function createRevertQueue(deps: RevertQueueDeps): RevertQueue {
    let running: Promise<void> | undefined;
    let again = false;
    let stopped = false;

    const pass = async (): Promise<void> => {
        do {
            again = false;
            if (stopped) return;
            for (;;) {
                const next = await deps.holdWatcher(() => deps.collaboration.revertNext({ session: deps.session, leaseMs: deps.leaseMs }), wroteFiles);
                if (!next.ok) {
                    // nothing for the server at the head, or an agent's run in progress: the next event kicks again.
                    // A write refused (the workspace changed meanwhile, …) keeps the revert queued and untried: the
                    // lease ticker kicks again
                    if (next.error.type !== 'NothingQueued' && next.error.type !== 'RunInProgress') deps.log(`revert not done now (${next.error.type})`);
                    break;
                }
                deps.log(describe(next.value));
                await deps.pump();
            }
        } while (again);
    };

    const kick = (): Promise<void> => {
        if (stopped) return running ?? Promise.resolve();
        again = true;
        running ??= pass()
            .catch((e: unknown) => deps.log(`reverting failed: ${e instanceof Error ? e.message : String(e)}`))
            .finally(() => {
                running = undefined;
                // a kick between the pass's last look and now
                if (again) void kick();
            });
        return running;
    };

    return {
        kick,
        async stop() {
            stopped = true;
            await running;
        },
    };
}
