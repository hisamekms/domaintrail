// The one place that turns the workspace's `knowledge` section into a `KnowledgeStore` (ADR 0031, section 5): `dt mcp`,
// the extraction of a session and the Live View all open the store here, so that they read and write the same one.
//
// - `files`: the items in `<root>/knowledge`, the deleted items and the extractions applied in the workspace's state
//   directory (outside it, `<state>/knowledge`).
// - `cloudflare`: the Worker at `knowledge.url`, reached with the Access service token of the environment
//   (`knowledgeCredentials`). Without one, the result says which variables to set (a Worker on a loopback host —
//   `wrangler dev` — is reached without one).
//
// The token goes where `knowledge.url` says, and that comes from the workspace's config, which a commit can change. So
// the `cloudflare` store is built only with the proof that the workspace's security-relevant settings — `knowledge.url`
// and `knowledge.project` among them — were approved as they are now (`SettingsApproval`, made only by
// `approveSettings` and `checkApproved` of cli/trust.ts, checked by `approvedFor`): no caller can skip the check, and a
// proof made before the URL changed proves nothing.
import * as path from 'node:path';
import {
    cloudflareKnowledgeStore,
    createFilesKnowledgeStore,
    err,
    knowledgeCredentials,
    missingCredentialsMessage,
    Knowledge,
    KNOWLEDGE_DIR,
    ok,
    type KnowledgeStore,
    type ResolvedKnowledgeConfig,
    type Result,
} from '@domaintrail/knowledge';
import { approvedFor, type SettingsApproval } from '../cli/trust.js';
import type { ResolvedConfig } from '../config/config.js';
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
    /** Where the `cloudflare` store's service token is read (default: `process.env`). */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** The `cloudflare` store's `fetch` (tests). */
    readonly fetch?: typeof fetch;
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** Why the `cloudflare` store is not opened without the approval of the settings. */
export const NOT_APPROVED =
    "the knowledge store 'cloudflare' sends its service token to knowledge.url, and this workspace's settings (knowledge.url and knowledge.project among them) are not approved as they are now: run `dt open` (or `dt collab`, `dt agent`) in a terminal once to approve them";

/**
 * Opens the knowledge store `cfg` names in its `knowledge` section, for the workspace at `cfg.root`. The `cloudflare`
 * store needs `approval`, the proof that `cfg`'s security-relevant settings were approved as they are now (see the
 * module's comment); the `files` store sends nothing anywhere and needs none. Rejects with `StateError` when the state
 * directory cannot be used; the store itself is opened lazily (nothing is read or written until a call).
 */
export async function openKnowledgeStore(
    cfg: ResolvedConfig,
    approval: SettingsApproval | undefined,
    options: KnowledgeStoreOptions = {},
): Promise<Result<OpenedKnowledgeStore, KnowledgeStoreUnavailable>> {
    const { knowledge, root } = cfg;
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
        case 'cloudflare': {
            if (!approvedFor(approval, cfg)) return err({ type: 'KnowledgeStoreUnavailable', store: 'cloudflare', message: NOT_APPROVED });
            const credentials = knowledgeCredentials(options.env ?? process.env);
            const loopback = LOOPBACK.includes(new URL(knowledge.url).hostname);
            if (!credentials.ok && !loopback)
                return err({ type: 'KnowledgeStoreUnavailable', store: 'cloudflare', message: missingCredentialsMessage(credentials.error) });
            const store = cloudflareKnowledgeStore({
                url: knowledge.url,
                ...(credentials.ok && { serviceToken: credentials.value }),
                ...(options.fetch && { fetch: options.fetch }),
            });
            return ok({ kind: 'cloudflare', store, project: knowledge.project });
        }
    }
}
