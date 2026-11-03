// The state and cache directories of a workspace, ready to use (./state-dirs.ts): both made and recorded; and the
// state of a gone workspace of the same name said when this one's is made (the workspace moved: its session is kept
// under the old path's hash).
import {
    type StateEnvironment,
    type WorkspaceDirs,
    checkOutsideWorkspace,
    currentEnvironment,
    movedFrom,
    shownPath,
    workspaceDirectory,
    workspaceDirs,
} from './state-dirs.js';

export interface WorkspaceStateOptions {
    /** Where the hints are said. */
    readonly log?: (line: string) => void;
    readonly environment?: StateEnvironment;
}

/**
 * The state and cache directories of the workspace at `root`, made (0700) and recorded. Rejects with `StateDirError`
 * when they cannot be used: inside the workspace (or it inside them), recorded for another workspace, or links.
 */
export async function openWorkspaceState(root: string, options: WorkspaceStateOptions = {}): Promise<WorkspaceDirs> {
    const log = options.log ?? (() => {});
    const dirs = workspaceDirs(root, options.environment ?? currentEnvironment());
    checkOutsideWorkspace(dirs);
    const { made } = await workspaceDirectory(dirs.roots.state, dirs.state, dirs.workspace);
    await workspaceDirectory(dirs.roots.cache, dirs.cache, dirs.workspace);
    if (made)
        for (const old of await movedFrom(dirs))
            log(
                `${shownPath(old.dir)} holds the files of ${old.workspace}, which no longer exists. If this workspace was moved from there, stop dt and move them (but its workspace.json) into ${shownPath(dirs.state)} to continue that session; \`dt session prune --yes\` removes them.`,
            );
    return dirs;
}
