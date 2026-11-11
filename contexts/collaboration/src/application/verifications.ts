// The factories of the verified types (ADR 0023): the checks a pure command cannot make because they read beyond its
// aggregate. Each is the only code that asserts its type; the check holds when it is made, so the stores enforce what
// they can where they save (a request is bundled while sent, one active run per session).
import { Collaboration, err, ok } from '../generated/index.js';
import { assumptionStatus } from '../domain/approvals.js';
import { markTargetStatus } from '../domain/marks.js';
import { changedPaths, workspacePath } from '../domain/snapshot.js';
import { revertableChanges, revertStatus } from '../domain/revert.js';
import { isAi } from '../domain/ai.js';
import { triageRoute } from '../domain/triage.js';
import type { Stores, UnitOfWork, WorkspaceSnapshot } from './ports.js';

export interface StoreVerifications {
    readonly makeActiveSession: Collaboration.MakeActiveSession;
    readonly makePendingRequest: Collaboration.MakePendingRequest;
    readonly makeOpenMarkTarget: Collaboration.MakeOpenMarkTarget;
    readonly makeReplyableTarget: Collaboration.MakeReplyableTarget;
    readonly makeMentionableParticipant: Collaboration.MakeMentionableParticipant;
    readonly makeDecidableAssumption: Collaboration.MakeDecidableAssumption;
    readonly makeRevertableRun: Collaboration.MakeRevertableRun;
    readonly makeAddressableRequest: Collaboration.MakeAddressableRequest;
    readonly makeProposableTriage: Collaboration.MakeProposableTriage;
}

/** The states of a run that a message may reply to: it ended, and it does not wait for an answer (a clarification has its form). */
export const REPLYABLE_STATES: readonly Collaboration.AgentRun['state'][] = ['Completed', 'Failed', 'Declined', 'Cancelled', 'Reverted'];

/** The checks over the stores, made inside the transaction that then uses the verified value. */
export function storeVerifications(stores: Stores): StoreVerifications {
    return {
        async makeActiveSession(id) {
            const session = stores.sessions.load(id);
            if (!session) return err({ type: 'Collaboration.SessionNotFound' });
            if (session.state === 'Closed') return err({ type: 'Collaboration.SessionAlreadyClosed' });
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory of the verified type: the check above is the evidence
            return ok(id as Collaboration.ActiveSession);
        },
        async makePendingRequest(id, session) {
            const request = stores.requests.load(id);
            if (!request) return err({ type: 'Collaboration.RequestNotFound', request: id });
            if (request.session !== session) return err({ type: 'Collaboration.RequestOfAnotherSession', request: id });
            if (request.state === 'Dismissed') return err({ type: 'Collaboration.RequestAlreadyDismissed', request: id });
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory of the verified type: the check above is the evidence
            return ok(id as Collaboration.PendingRequest);
        },
        async makeOpenMarkTarget(target, session) {
            // the session's requests and runs, in queue order: whether the target is there, and whether its vote closed
            const status = markTargetStatus(target, {
                requests: stores.requests.listBySession(session),
                runs: stores.runs.listBySession(session),
                approvals: stores.approvals.listBySession(session),
            });
            if (status === 'missing') return err({ type: 'Collaboration.MarkTargetNotFound' });
            if (status === 'closed') return err({ type: 'Collaboration.MarkTargetClosed' });
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory of the verified type: the check above is the evidence
            return ok(target as Collaboration.OpenMarkTarget);
        },
        async makeReplyableTarget(target, session) {
            if (target.kind === 'Message') {
                // any message of the session, one's own too, whatever its state
                const request = stores.requests.load(target.request);
                if (!request) return err({ type: 'Collaboration.RequestNotFound', request: target.request });
                if (request.session !== session) return err({ type: 'Collaboration.RequestOfAnotherSession', request: target.request });
            } else {
                const id = target.run;
                const run = stores.runs.load(id)?.run;
                if (!run) return err({ type: 'Collaboration.RunNotFound', run: id });
                if (run.session !== session) return err({ type: 'Collaboration.RunOfAnotherSession', run: id });
                if (!REPLYABLE_STATES.includes(run.state)) return err({ type: 'Collaboration.RunNotReplyable', run: id });
            }
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory of the verified type: the checks above are the evidence
            return ok(target as Collaboration.ReplyableTarget);
        },
        async makeMentionableParticipant(id, session) {
            // anyone who joined the session, online or not (the facilitator too), and the AI, which never joins
            if (isAi(id)) {
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory of the verified type: the AI is part of every session
                return ok(id as Collaboration.MentionableParticipant);
            }
            if (!stores.sessions.load(session)?.participants.some((p) => p.id === id))
                return err({ type: 'Collaboration.MentionedNotAParticipant', participant: id });
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory of the verified type: the check above is the evidence
            return ok(id as Collaboration.MentionableParticipant);
        },
        async makeDecidableAssumption(ref, session) {
            const run = stores.runs.load(ref.run)?.run;
            if (!run) return err({ type: 'Collaboration.RunNotFound', run: ref.run });
            if (run.session !== session) return err({ type: 'Collaboration.RunOfAnotherSession', run: ref.run });
            // completed with that assumption, neither approved nor taken over by a later run (a pick among them)
            switch (assumptionStatus(run, ref.assumption, stores.runs.listBySession(session), stores.approvals.listBySession(session))) {
                case 'notApprovable':
                    return err({ type: 'Collaboration.RunNotApprovable', run: run.id });
                case 'missing':
                    return err({ type: 'Collaboration.AssumptionNotFound', run: run.id });
                case 'closed':
                    return err({ type: 'Collaboration.AssumptionClosed', run: run.id });
            }
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory of the verified type: the checks above are the evidence
            return ok(ref as Collaboration.DecidableAssumption);
        },
        async makeRevertableRun(id, session) {
            const run = stores.runs.load(id)?.run;
            if (!run) return err({ type: 'Collaboration.RunNotFound', run: id });
            if (run.session !== session) return err({ type: 'Collaboration.RunOfAnotherSession', run: id });
            // it changed files, and no revert of it is done or under way
            if (!revertableChanges(run) || revertStatus(run, stores.runs.listBySession(session)).kind !== 'none')
                return err({ type: 'Collaboration.RunNotRevertable', run: id });
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory of the verified type: the checks above are the evidence
            return ok(id as Collaboration.RevertableRun);
        },
        async makeAddressableRequest(id, session) {
            const request = stores.requests.load(id);
            if (!request) return err({ type: 'Collaboration.RequestNotFound', request: id });
            if (request.session !== session) return err({ type: 'Collaboration.RequestOfAnotherSession', request: id });
            // a person's message: not the AI's answer, not a revert (the server's own work)
            if (isAi(request.author) || request.reverts !== undefined) return err({ type: 'Collaboration.RequestNotAddressable', request: id });
            // one triage per message (the store's unique index keeps it)
            if (stores.triages.ofRequest(id)) return err({ type: 'Collaboration.RequestAlreadyAddressed', request: id });
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory of the verified type: the checks above are the evidence
            return ok(id as Collaboration.AddressableRequest);
        },
        async makeProposableTriage(id, session) {
            const triage = stores.triages.load(id);
            if (!triage) return err({ type: 'Collaboration.TriageNotFound', triage: id });
            if (triage.session !== session) return err({ type: 'Collaboration.TriageOfAnotherSession', triage: id });
            const found = stores.sessions.load(session);
            const request = stores.requests.load(triage.request);
            // a participant's change request, not concluded: the facilitator's, a Solo session's and those the
            // facilitator addressed go to the queue without a proposal
            if (
                triage.state !== 'Decided' ||
                triage.outcome !== undefined ||
                !found ||
                !request ||
                triageRoute(triage, { mode: found.mode, authorIsFacilitator: request.author === found.facilitator }) !== 'propose'
            )
                return err({ type: 'Collaboration.TriageNotProposable', triage: id });
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory of the verified type: the checks above are the evidence
            return ok(id as Collaboration.ProposableTriage);
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
        if (!found.revision) return err({ type: 'Collaboration.RevisionNotFound', revision: id });
        if (found.revision.session !== session) return err({ type: 'Collaboration.RevisionOfAnotherSession', revision: id });
        const scan = await workspace.read();
        const [link] = scan.symlinks;
        if (link !== undefined) {
            const linked = workspacePath(link);
            return linked.ok ? err({ type: 'Collaboration.SymlinkInWorkspace', path: linked.value }) : linked;
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
        if (first !== undefined) return err({ type: 'Collaboration.ExternalChangesSinceSnapshot', paths: [first, ...rest] });
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the factory of the verified type: the checks above are the evidence
        return ok(id as Collaboration.RestorableRevision);
    };
}
