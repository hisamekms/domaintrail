// The state and cache directories of a workspace, ready to use (./state-dirs.ts): an older version's `.domaintrail/`
// moved there first (./legacy-state.ts); both made and recorded; and the state of a gone workspace of the same name
// said when this one's is made (the workspace moved: its session is kept under the old path's hash). And `dt session
// prune`: the directories of workspaces that are gone (or unused for a while), listed, removed only when asked.
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { moveLegacyState } from './legacy-state.js';
import {
    type StateEnvironment,
    type WorkspaceDirs,
    checkOutsideWorkspace,
    currentEnvironment,
    exists,
    movedFrom,
    processAlive,
    readWorkspaceRecord,
    shownPath,
    stateRoots,
    workspaceDirectory,
    workspaceDirs,
} from './state-dirs.js';

export interface WorkspaceStateOptions {
    /** Where the move of `.domaintrail/` and the hints are said. */
    readonly log?: (line: string) => void;
    readonly environment?: StateEnvironment;
}

/**
 * The state and cache directories of the workspace at `root`, made (0700) and recorded, `.domaintrail/` moved there
 * first. Rejects with `StateDirError` when they cannot be used: inside the workspace (or it inside them), recorded for
 * another workspace, links, or an older version's server running on `.domaintrail/`.
 */
export async function openWorkspaceState(root: string, options: WorkspaceStateOptions = {}): Promise<WorkspaceDirs> {
    const log = options.log ?? (() => {});
    const dirs = workspaceDirs(root, options.environment ?? currentEnvironment());
    checkOutsideWorkspace(dirs);
    await moveLegacyState(dirs, log);
    const { made } = await workspaceDirectory(dirs.roots.state, dirs.state, dirs.workspace);
    await workspaceDirectory(dirs.roots.cache, dirs.cache, dirs.workspace);
    if (made)
        for (const old of await movedFrom(dirs))
            log(
                `${shownPath(old.dir)} holds the files of ${old.workspace}, which no longer exists. If this workspace was moved from there, stop dt and move them (but its workspace.json) into ${shownPath(dirs.state)} to continue that session; \`dt session prune --yes\` removes them.`,
            );
    return dirs;
}

/** A directory of a workspace that `dt session prune` removes. */
export interface PrunableDir {
    readonly dir: string;
    readonly kind: 'state' | 'cache';
    /** The workspace it was recorded for (none: a move that stopped half way). */
    readonly workspace?: string;
    /** `gone`: the workspace no longer exists; `unused`: not used for the days asked; `unfinished`: a move's leftover copy. */
    readonly reason: 'gone' | 'unused' | 'unfinished';
    readonly lastUsed: Date;
}

export interface PruneOptions {
    /** Also the directories of existing workspaces not used for this many days. */
    readonly olderThanDays?: number;
    /** Remove them (else only listed). */
    readonly remove: boolean;
    readonly environment?: StateEnvironment;
    readonly now?: Date;
}

/** When `dir` was last used: the latest change of it or of what is directly in it. */
async function lastUsed(dir: string): Promise<Date> {
    let latest = (await lstat(dir)).mtimeMs;
    for (const name of await readdir(dir).catch(() => [])) {
        const s = await lstat(path.join(dir, name)).catch(() => undefined);
        if (s && s.mtimeMs > latest) latest = s.mtimeMs;
    }
    return new Date(latest);
}

/** Whether the server whose address is in the state directory `dir` still runs. */
async function serving(dir: string): Promise<boolean> {
    try {
        const v: unknown = JSON.parse(await readFile(path.join(dir, 'server.json'), 'utf8'));
        return typeof v === 'object' && v !== null && 'pid' in v && typeof v.pid === 'number' && processAlive(v.pid);
    } catch {
        return false;
    }
}

/**
 * The directories of workspaces that are gone (or, with `olderThanDays`, not used for that long), in the state root
 * and the cache root, removed when `remove`. A directory without a record is not dt's to judge and is left out; so is
 * the state of a running server.
 */
export async function pruneStateDirs(options: PruneOptions): Promise<PrunableDir[]> {
    const roots = stateRoots(options.environment ?? currentEnvironment());
    const now = options.now ?? new Date();
    const found: PrunableDir[] = [];
    for (const kind of ['state', 'cache'] as const) {
        const root = roots[kind];
        for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
            if (!entry.isDirectory()) continue;
            const dir = path.join(root, entry.name);
            const used = await lastUsed(dir);
            const unfinished = /^\..+\.moving-(\d+)-[0-9a-f]+$/.exec(entry.name);
            if (unfinished) {
                if (!processAlive(Number(unfinished[1]))) found.push({ dir, kind, reason: 'unfinished', lastUsed: used });
                continue;
            }
            const record = await readWorkspaceRecord(dir);
            if (!record) continue;
            if (kind === 'state' && (await serving(dir))) continue;
            const unused = options.olderThanDays !== undefined && now.getTime() - used.getTime() > options.olderThanDays * 86_400_000;
            const reason = !(await exists(record.path)) ? 'gone' : unused ? 'unused' : undefined;
            if (reason) found.push({ dir, kind, workspace: record.path, reason, lastUsed: used });
        }
    }
    if (options.remove) for (const p of found) await rm(p.dir, { recursive: true, force: true });
    return found;
}
