// Holding the workspace watcher around a write of the sources (ADR 0026: a restore writes a past revision back; S7):
// while held, a settled burst of file events (or a moved git ref) does not refresh or publish the view; when the last
// hold is resumed, what was missed is refreshed and published once.

/** What the watchers ask before they refresh. */
export interface WatcherGate {
    /** Whether a hold is on: the watchers defer instead of refreshing. */
    readonly held: boolean;
    /** A refresh was due while held. */
    defer(kind: 'sources' | 'git'): void;
}

export interface WatcherHold extends WatcherGate {
    /** Holds the watchers' refresh and publish until the returned function is called (holds nest; resuming twice is a no-op). */
    hold(): () => Promise<void>;
    /** Runs `work` with the watchers held, and resumes them after it, whatever its outcome. */
    around<T>(work: () => Promise<T>): Promise<T>;
}

/** A hold whose resume calls `refresh` with the kinds of refresh that were deferred, if any. */
export function createWatcherHold(refresh: (missed: { readonly sources: boolean; readonly git: boolean }) => Promise<void>): WatcherHold {
    let holds = 0;
    let missed = { sources: false, git: false };
    const hold = (): (() => Promise<void>) => {
        holds++;
        let resumed = false;
        return async () => {
            if (resumed) return;
            resumed = true;
            if (--holds > 0) return;
            const due = missed;
            missed = { sources: false, git: false };
            if (due.sources || due.git) await refresh(due);
        };
    };
    return {
        get held() {
            return holds > 0;
        },
        defer(kind) {
            missed = { ...missed, [kind]: true };
        },
        hold,
        async around(work) {
            const resume = hold();
            try {
                return await work();
            } finally {
                await resume();
            }
        },
    };
}
