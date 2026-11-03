// The session's REST API as the page calls it (`/api/session/*`, ADR 0026). Called only once the page knows it is in
// a session (the socket sent `session.state`): under `dt view` none of these requests is made.
import type {
    AddressedBody,
    ApproveBody,
    ApprovedBody,
    ApproveProposalsBody,
    ProposalsApprovedBody,
    ComparisonBody,
    ErrorBody,
    MarkSetBody,
    Me,
    ModelChangesBody,
    QueueRunBody,
    RestoredBody,
    SendRequestBody,
    SessionStateBody,
    SetMarkBody,
    RevertRequestedBody,
} from '@domaintrail/collaboration/protocol';
import type { TargetStatus } from '@domaintrail/collaboration';

/**
 * A failed call: the server's error type (`FacilitatorOnly`, `InvalidInput`, …) or `Network`, its status, and the
 * error's other fields (`paths` of external changes, the `run` in progress, the `preRestore` revision, …).
 */
export class SessionApiError extends Error {
    constructor(
        readonly type: string,
        readonly status: number,
        message?: string,
        readonly detail: Readonly<Record<string, unknown>> = {},
    ) {
        super(message ?? type);
    }
}

const isErrorBody = (v: unknown): v is ErrorBody =>
    typeof v === 'object' &&
    v !== null &&
    'error' in v &&
    typeof v.error === 'object' &&
    v.error !== null &&
    'type' in v.error &&
    typeof v.error.type === 'string';

async function call<T>(path: string, init?: { method: 'POST'; body: unknown }): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`/api/session/${path}`, {
            ...(init && { method: init.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
            credentials: 'same-origin',
        });
    } catch (e) {
        throw new SessionApiError('Network', 0, e instanceof Error ? e.message : String(e));
    }
    let body: unknown;
    try {
        body = await res.json();
    } catch (e) {
        // every answer of the session API is JSON: anything else is an HTTP error, or a broken answer
        throw new SessionApiError(res.ok ? 'BadResponse' : 'HttpError', res.status, e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) {
        if (isErrorBody(body)) throw new SessionApiError(body.error.type, res.status, body.error.message, body.error);
        throw new SessionApiError('HttpError', res.status);
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the answer of our own server's session API
    return body as T;
}

export interface TargetStatuses {
    readonly contentHash: string;
    /** By request ID: one per target, in the request's order. */
    readonly statuses: Readonly<Record<string, readonly TargetStatus[]>>;
}

export const sessionApi = {
    me: (): Promise<Me> => call('me'),
    state: (): Promise<SessionStateBody> => call('state'),
    targets: (): Promise<TargetStatuses> => call('targets'),
    sendRequest: (body: SendRequestBody): Promise<unknown> => call('requests', { method: 'POST', body }),
    /** The facilitator's 「AI に送る」: addresses the messages to the AI (their triages open). */
    address: (requests: readonly string[]): Promise<AddressedBody> => call('requests/address', { method: 'POST', body: { requests } }),
    /** Approves open change proposals (the facilitator), each as is or edited: approved together, one run. */
    approveProposals: (body: ApproveProposalsBody): Promise<ProposalsApprovedBody> => call('proposals/approve', { method: 'POST', body }),
    /** Rejects an open change proposal (the facilitator), with a note to the requester if any. */
    rejectProposal: (id: string, note?: string): Promise<unknown> =>
        call(`proposals/${encodeURIComponent(id)}/reject`, { method: 'POST', body: note ? { note } : {} }),
    /** Withdraws my open change proposal (its requester). */
    withdrawProposal: (id: string): Promise<unknown> => call(`proposals/${encodeURIComponent(id)}/withdraw`, { method: 'POST', body: {} }),
    /** Another one-time facilitator link, to hand the role over. */
    facilitatorLink: (): Promise<{ link: string; expiresAt: string }> => call('facilitator/link', { method: 'POST', body: {} }),
    close: (): Promise<unknown> => call('close', { method: 'POST', body: {} }),
    queueRun: (body: QueueRunBody): Promise<{ run: { id: string } }> => call('runs', { method: 'POST', body }),
    /** Signs out (`dev`), or leaves an `access` session: `logout` is where the page goes then (Access's logout). */
    leave: (): Promise<{ left: boolean; logout?: string }> => call('leave', { method: 'POST', body: {} }),
    /** Places or takes off one of my marks (a vote or a reaction). */
    setMark: (body: SetMarkBody): Promise<MarkSetBody> => call('marks', { method: 'POST', body }),
    /** Approves an assumption of a completed run as it is (the facilitator): recorded, nothing sent to the AI. */
    approve: (body: ApproveBody): Promise<ApprovedBody> => call('approvals', { method: 'POST', body }),
    cancelRun: (id: string): Promise<unknown> => call(`runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }),
    /** Asks to revert the changes of a run (the facilitator), with the message everyone sees: queued, the server tries it first. */
    revertRun: (id: string, body: string): Promise<RevertRequestedBody> => call(`runs/${encodeURIComponent(id)}/revert`, { method: 'POST', body: { body } }),
    /** Records the workspace as it is now (the facilitator). */
    takeRevision: (): Promise<unknown> => call('revisions', { method: 'POST', body: {} }),
    /** Restores a revision (the facilitator); `recordExternalChanges` records the workspace's external changes first. */
    restoreRevision: (id: string, recordExternalChanges = false): Promise<RestoredBody> =>
        call(`revisions/${encodeURIComponent(id)}/restore`, { method: 'POST', body: recordExternalChanges ? { recordExternalChanges } : {} }),
    compareRevisions: (before: string, after: string): Promise<ComparisonBody> =>
        call(`revisions/${encodeURIComponent(before)}/compare/${encodeURIComponent(after)}`),
    /** What a unit changed between two revisions, in the model's words: the elements added, changed and removed. */
    modelChanges: (before: string, after: string): Promise<ModelChangesBody> =>
        call(`revisions/${encodeURIComponent(before)}/changes/${encodeURIComponent(after)}`),
};
