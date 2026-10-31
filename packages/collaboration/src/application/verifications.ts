// The factories of the verified types (ADR 0023): the checks a pure command cannot make because they read beyond its
// aggregate. Each is the only code that asserts its type; the check holds when it is made, so the stores enforce what
// they can where they save (a request is bundled while sent, one active run per session).
import { Collaboration, err, ok } from '../generated/index.js';
import { changedPaths, workspacePath } from '../domain/snapshot.js';
import type { Stores, UnitOfWork, WorkspaceSnapshot } from './ports.js';

export interface StoreVerifications {
    readonly makeActiveSession: Collaboration.MakeActiveSession;
    readonly makePendingRequest: Collaboration.MakePendingRequest;
}

/** The checks over the stores, made inside the transaction that then uses the verified value. */
export function storeVerifications(stores: Stores): StoreVerifications {
    return {
        async makeActiveSession(id) {
            const session = stores.sessions.load(id);
            if (!session) return err({ type: 'SessionNotFound' });
            if (session.state === 'Closed') return err({ type: 'SessionAlreadyClosed' });
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory of the verified type: the check above is the evidence
            return ok(id as Collaboration.ActiveSession);
        },
        async makePendingRequest(id, session) {
            const request = stores.requests.load(id);
            if (!request) return err({ type: 'RequestNotFound', request: id });
            if (request.session !== session) return err({ type: 'RequestOfAnotherSession', request: id });
            if (request.state === 'Dismissed') return err({ type: 'RequestAlreadyDismissed', request: id });
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory of the verified type: the check above is the evidence
            return ok(id as Collaboration.PendingRequest);
        },
    };
}

/**
 * Whether a revision of a session can be written back now: it exists in that session, no source of the workspace is a
 * symbolic link or outside the root, and the sources are those of the session's last revision (no external change
 * since that snapshot; take a revision to accept them). The writer checks again, against the pre-restore snapshot.
 */
export function restorableRevision(uow: UnitOfWork, workspace: WorkspaceSnapshot): Collaboration.MakeRestorableRevision {
    return async (id, session) => {
        const found = await uow.transaction(({ revisions }) => ({ revision: revisions.load(id), latest: revisions.latest(session) }));
        if (!found.revision) return err({ type: 'RevisionNotFound', revision: id });
        if (found.revision.session !== session) return err({ type: 'RevisionOfAnotherSession', revision: id });
        const scan = await workspace.read();
        const [link] = scan.symlinks;
        if (link !== undefined) {
            const linked = workspacePath(link);
            return linked.ok ? err({ type: 'SymlinkInWorkspace', path: linked.value }) : linked;
        }
        const current: { path: Collaboration.WorkspacePath; hash: Collaboration.ContentHash }[] = [];
        for (const f of scan.files) {
            const p = workspacePath(f.path);
            if (!p.ok) return p;
            const hash = Collaboration.makeContentHash(f.hash);
            if (!hash.ok) throw new Error(`The workspace adapter gave ${f.path} a hash that is not a SHA-256: ${f.hash}`);
            current.push({ path: p.value, hash: hash.value });
        }
        const [first, ...rest] = changedPaths(found.latest?.files ?? [], current);
        if (first !== undefined) return err({ type: 'ExternalChangesSinceSnapshot', paths: [first, ...rest] });
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory of the verified type: the checks above are the evidence
        return ok(id as Collaboration.RestorableRevision);
    };
}
