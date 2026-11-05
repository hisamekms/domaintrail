// The one place that turns the workspace's `knowledge` section into a `KnowledgeStore` (ADR 0031, section 5): `dt mcp`,
// the extraction of a session and the Live View all open the store here, so that they read and write the same one.
//
// - `files`: the items in `<root>/knowledge`, the deleted items and the extractions applied in the workspace's state
//   directory (outside it, `<state>/knowledge`).
// - `cloudflare`: not in this version yet (the Worker and its adapter come with K7 of docs/plans/knowledge.md); the
//   result says so, and the caller says it in its own words.
import * as path from 'node:path';
import {
    createFilesKnowledgeStore,
    err,
    Knowledge,
    KNOWLEDGE_DIR,
    ok,
    type KnowledgeStore,
    type ResolvedKnowledgeConfig,
    type Result,
} from '@domaintrail/knowledge';
import { workspaceState } from './state.js';

/** The store of a workspace, opened, and the project every call names. */
export interface OpenedKnowledgeStore {
    readonly kind: ResolvedKnowledgeConfig['store'];
    readonly store: KnowledgeStore;
    readonly project: Knowledge.ProjectName;
    /**
     * Completes the deletions past the undo window while nothing is written (the `files` store's sweep; a writer calls
     * it on a timer). Absent where the store sweeps by itself.
     */
    readonly sweep?: () => Promise<void>;
}

/** Why the workspace's store cannot be opened, as one line. */
export interface KnowledgeStoreUnavailable {
    readonly type: 'KnowledgeStoreUnavailable';
    readonly store: ResolvedKnowledgeConfig['store'];
    readonly message: string;
}

export interface KnowledgeStoreOptions {
    /** The workspace's state directory (default: opened as every command does, `workspaceState`); rejects with `StateError`. */
    readonly stateDir?: (root: string) => Promise<string>;
    /** The clock (tests). */
    readonly now?: () => Date;
}

/** The message of the `cloudflare` store before it is built. */
export const CLOUDFLARE_NOT_AVAILABLE =
    "the knowledge store 'cloudflare' is not available in this version of dt yet; use \"knowledge\": { \"store\": \"files\" } (in domaintrail.local.jsonc to try it out)";

/**
 * Opens the knowledge store the workspace at `root` names in `knowledge` (the resolved config's section). Rejects with
 * `StateError` when the state directory cannot be used; the store itself is opened lazily (nothing is read or written
 * until a call).
 */
export async function openKnowledgeStore(
    knowledge: ResolvedKnowledgeConfig,
    root: string,
    options: KnowledgeStoreOptions = {},
): Promise<Result<OpenedKnowledgeStore, KnowledgeStoreUnavailable>> {
    switch (knowledge.store) {
        case 'files': {
            const state = options.stateDir ? await options.stateDir(root) : (await workspaceState(root, (line) => console.error(line))).state;
            const store = createFilesKnowledgeStore({
                dir: path.join(root, KNOWLEDGE_DIR),
                project: knowledge.project,
                stateDir: path.join(state, KNOWLEDGE_DIR),
                ...(options.now && { now: options.now }),
            });
            return ok({ kind: 'files', store, project: knowledge.project, sweep: () => store.sweep() });
        }
        case 'cloudflare':
            return err({ type: 'KnowledgeStoreUnavailable', store: 'cloudflare', message: CLOUDFLARE_NOT_AVAILABLE });
    }
}
