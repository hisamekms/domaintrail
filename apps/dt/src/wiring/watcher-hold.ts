// Holding the workspace watcher around a write of the sources (ADR 0026: a restore writes a past revision back; S7):
// while held, a settled burst of file events (or a moved git ref) does not refresh or publish the view; when the last
// hold is resumed, what was missed is refreshed and published once. After a write (`aroundWrite`) the view is refreshed
// on resume whether or not the watcher saw the write yet, and the watcher's late events of the written content (its
// echo) are absorbed, so that every page gets the written model in one publish.

/** How long after a write the watcher's events of the same content are taken as its echo. */
export const ECHO_MS = 5_000;

/** What the watchers ask before they refresh. */
export interface WatcherGate {
    /** Whether a hold is on: the watchers defer instead of refreshing. */
    readonly held: boolean;
    /** A refresh was due while held. */
    defer(kind: 'sources' | 'git'): void;
    /** Whether a settled burst of file events is only the echo of a write already refreshed and published. */
    readonly echo?: () => Promise<boolean>;
}

export interface WatcherHold extends WatcherGate {
    /** Holds the watchers' refresh and publish until the returned function is called (holds nest; resuming twice is a no-op). */
    hold(): () => Promise<void>;
    /** Runs `work` with the watchers held, and resumes them after it, whatever its outcome. */
    around<T>(work: () => Promise<T>): Promise<T>;
    /**
     * Runs `work`, a write of the sources, with the watchers held. On resume the sources are refreshed and published
     * once when `wrote(result)` (or when `work` threw: the workspace is then unknown), and the watcher's late events
     * for what is on disk then are absorbed for `ECHO_MS`.
     */
    aroundWrite<T>(work: () => Promise<T>, wrote: (result: T) => boolean): Promise<T>;
}

export interface WatcherHoldOptions {
    /** The sources' content now, as a comparable string (e.g. paths and hashes): what an echo is recognized by. */
    readonly fingerprint?: () => Promise<string>;
    /** Tells a failure to read the fingerprint (the echo is then refreshed as any change). */
    readonly log?: (line: string) => void;
    readonly now?: () => number;
}

/** A hold whose resume calls `refresh` with the kinds of refresh that were deferred, if any. */
export function createWatcherHold(
    refresh: (missed: { readonly sources: boolean; readonly git: boolean }) => Promise<void>,
    options: WatcherHoldOptions = {},
): WatcherHold {
    const now = options.now ?? Date.now;
    let holds = 0;
    let missed = { sources: false, git: false };
    let expected: { readonly print: string; readonly until: number } | undefined;
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
    const around = async <T>(work: () => Promise<T>): Promise<T> => {
        const resume = hold();
        try {
            return await work();
        } finally {
            await resume();
        }
    };
    const { fingerprint } = options;
    return {
        get held() {
            return holds > 0;
        },
        defer(kind) {
            missed = { ...missed, [kind]: true };
        },
        hold,
        around,
        async aroundWrite(work, wrote) {
            const resume = hold();
            let written = true;
            try {
                const result = await work();
                written = wrote(result);
                return result;
            } finally {
                if (written) {
                    missed = { ...missed, sources: true };
                    if (fingerprint) {
                        try {
                            expected = { print: await fingerprint(), until: now() + ECHO_MS };
                        } catch (e) {
                            expected = undefined;
                            options.log?.(`the sources could not be read after a write: ${e instanceof Error ? e.message : String(e)}`);
                        }
                    }
                }
                await resume();
            }
        },
        echo: async () => {
            const echo = expected;
            if (!echo || !fingerprint) return false;
            if (now() > echo.until) {
                expected = undefined;
                return false;
            }
            const print = await fingerprint();
            if (print === echo.print) return true;
            expected = undefined;
            return false;
        },
    };
}
