// The workspace's state and cache directories, outside the workspace (ADR 0026, State outside the workspace), as the
// commands use them: opened (an older version's `.domaintrail/` moved there first) by every command that reads or
// writes them — the servers, the links and codes, `dt agent`, `dt generate ts` — and refused as a `StateError`.
import { openWorkspaceState, StateDirError, type WorkspaceDirs } from '@domaintrail/workspace';
import { StateError } from '../cli/ports.js';

/** The directories of the workspace at `root`, ready; `log` says the move of `.domaintrail/`. Rejects with `StateError`. */
export async function workspaceState(root: string, log: (line: string) => void = () => {}): Promise<WorkspaceDirs> {
    return openWorkspaceState(root, { log }).catch((e: unknown) => {
        if (e instanceof StateDirError) throw new StateError(e.message);
        throw e;
    });
}
