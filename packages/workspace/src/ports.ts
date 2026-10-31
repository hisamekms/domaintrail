/** Ends a subscription; resolves once what it held (a watcher, its timers) is released. */
export type Unsubscribe = () => Promise<void>;

/**
 * What a `WorkspaceWatcher` reports: each `add`, `change` or `unlink` of a source as it happens (`file` as watched,
 * below the root it was given), and `settled` once a burst of them is over (no event for the debounce time).
 */
export type SourceEvent = { kind: 'add' | 'change' | 'unlink'; file: string } | { kind: 'settled' };

/** Watches the sources of a workspace. */
export interface WorkspaceWatcher {
    /** Reports the changes to `onChanged` until unsubscribed; resolves once the watcher is ready to report them. */
    subscribe(onChanged: (event: SourceEvent) => void): Promise<Unsubscribe>;
}

/** Watches the git refs (`HEAD`, branches, `packed-refs`): a git baseline moves with its branch. */
export interface GitRefWatcher {
    /**
     * Calls `onChanged` once a burst of changes to the refs is over, until unsubscribed; resolves once the watcher is
     * ready. A change while `relevant` returns false is dropped: it neither starts nor extends a burst.
     */
    subscribe(onChanged: () => void, relevant?: () => boolean): Promise<Unsubscribe>;
}
