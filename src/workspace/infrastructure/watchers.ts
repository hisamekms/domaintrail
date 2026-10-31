import * as path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { DEFAULT_SOURCES, IGNORED_DIRS } from '../../modeling/core/config.js';
import type { GitRefWatcher, SourceEvent, Unsubscribe, WorkspaceWatcher } from '../ports.js';
import { SourceScope } from './files.js';

/** Resolves once `watcher` is ready, with what closes it and clears the debounce timer. */
function whenReady(watcher: FSWatcher, timer: () => ReturnType<typeof setTimeout> | undefined): Promise<Unsubscribe> {
    return new Promise((resolve) =>
        watcher.once('ready', () =>
            resolve(async () => {
                clearTimeout(timer());
                await watcher.close();
                // an event may have come while closing
                clearTimeout(timer());
            }),
        ),
    );
}

/**
 * Watches the sources below `root` with chokidar, deciding with `SourceScope` like `findDomainFiles`: directories never
 * scanned and those ignored by `.gitignore` are not walked. A burst of events settles after `debounceMs` (default 80)
 * without one (e.g. an AI saving several files).
 */
export function createWorkspaceWatcher(
    root: string,
    options: { sources?: readonly string[]; respectGitignore?: boolean; debounceMs?: number } = {},
): WorkspaceWatcher {
    return {
        subscribe(onChanged: (event: SourceEvent) => void): Promise<Unsubscribe> {
            const scope = new SourceScope(root, options.sources ?? DEFAULT_SOURCES, options.respectGitignore ?? true);
            const watcher = watch(root, {
                ignoreInitial: true,
                ignored: (p, stats) => {
                    if (stats?.isDirectory()) return p !== scope.root && !scope.includesDirectory(p);
                    return IGNORED_DIRS.has(path.basename(p)) || (!!stats?.isFile() && scope.sourcePath(p) === undefined);
                },
            });
            let timer: ReturnType<typeof setTimeout> | undefined;
            for (const kind of ['add', 'change', 'unlink'] as const) {
                watcher.on(kind, (file: string) => {
                    onChanged({ kind, file });
                    clearTimeout(timer);
                    timer = setTimeout(() => onChanged({ kind: 'settled' }), options.debounceMs ?? 80);
                });
            }
            return whenReady(watcher, () => timer);
        },
    };
}

/** Watches `HEAD`, `refs` and `packed-refs` of the git directories `dirs` (not the objects); bursts settle after 200 ms. */
export function createGitRefWatcher(dirs: readonly string[]): GitRefWatcher {
    return {
        subscribe(onChanged: () => void, relevant: () => boolean = () => true): Promise<Unsubscribe> {
            const watcher = watch(
                dirs.flatMap((d) => ['HEAD', 'refs', 'packed-refs'].map((f) => path.join(d, f))),
                { ignoreInitial: true },
            );
            let timer: ReturnType<typeof setTimeout> | undefined;
            watcher.on('all', () => {
                if (!relevant()) return;
                clearTimeout(timer);
                timer = setTimeout(() => onChanged(), 200);
            });
            return whenReady(watcher, () => timer);
        },
    };
}
