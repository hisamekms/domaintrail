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
    InviteBody,
    MarkSetBody,
    Me,
    ModelChangesBody,
    QueueRunBody,
    RestoredBody,
    SendRequestBody,
    SentBody,
    SessionStateBody,
    SetMarkBody,
    StartCommandBody,
    StartInterviewBody,
    RevertRequestedBody,
} from '@domaintrail/collaboration/protocol';
import type { TargetStatus } from '@domaintrail/collaboration';
import { isSignInRedirect, reloadForSignIn, SAME_ORIGIN } from '../app/sign-in';

/**
 * A failed call: the server's error type (`FacilitatorOnly`, `InvalidInput`, …), `Network`, or `SignInRequired` (the
 * edge in front, Cloudflare Access, answered with a redirect to its sign-in: the page reloads), its status, and the
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
            ...SAME_ORIGIN,
        });
    } catch (e) {
        throw new SessionApiError('Network', 0, e instanceof Error ? e.message : String(e));
    }
    if (isSignInRedirect(res)) {
        // the Access session ran out: Access answers for the server, with its sign-in page; a reload goes there
        reloadForSignIn();
        throw new SessionApiError('SignInRequired', 0, 'Sign in again.');
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
    sendRequest: (body: SendRequestBody): Promise<SentBody> => call('requests', { method: 'POST', body }),
    /** The facilitator's 「AI に送る」: addresses the messages to the AI (their triages open). */
    address: (requests: readonly string[]): Promise<AddressedBody> => call('requests/address', { method: 'POST', body: { requests } }),
    /** Approves open change proposals (the facilitator), each as is or edited: approved together, one run. */
    approveProposals: (body: ApproveProposalsBody): Promise<ProposalsApprovedBody> => call('proposals/approve', { method: 'POST', body }),
    /** Rejects an open change proposal (the facilitator), with a note to the requester if any. */
    rejectProposal: (id: string, note?: string): Promise<unknown> =>
        call(`proposals/${encodeURIComponent(id)}/reject`, { method: 'POST', body: note ? { note } : {} }),
    /** Hands the AI's answer or proposal for a message out again, once the server gave it up (the facilitator). */
    retryAnswer: (request: string): Promise<unknown> => call(`requests/${encodeURIComponent(request)}/retry-answer`, { method: 'POST', body: {} }),
    /** Starts a candidate or answer command (`/es:exceptions`, `/es:recap`). */
    startCommand: (body: StartCommandBody): Promise<unknown> => call('commands', { method: 'POST', body }),
    /** Applies the candidates checked of a candidate command (the facilitator, whoever started it): one run. */
    applyCandidates: (id: string, chosen: readonly number[]): Promise<unknown> =>
        call(`commands/${encodeURIComponent(id)}/apply`, { method: 'POST', body: { chosen } }),
    /** Stops a command (its starter or the facilitator). */
    stopCommand: (id: string): Promise<unknown> => call(`commands/${encodeURIComponent(id)}/stop`, { method: 'POST', body: {} }),
    /** Starts the `/es:start` or `/model:start` interview (anyone). */
    startInterview: (body: StartInterviewBody): Promise<unknown> => call('interviews', { method: 'POST', body }),
    /** Confirms an interview's brief, as is or with its text edited (the facilitator; a participant's: the approval): a run writes it. */
    confirmInterview: (id: string, text?: string): Promise<unknown> =>
        call(`interviews/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: text === undefined ? {} : { text } }),
    /** Rejects an interview's brief, with an optional note to its starter (the facilitator): the interview ends. */
    rejectInterview: (id: string, note?: string): Promise<unknown> =>
        call(`interviews/${encodeURIComponent(id)}/reject`, { method: 'POST', body: note ? { note } : {} }),
    /** Stops an interview (its starter or the facilitator). */
    stopInterview: (id: string): Promise<unknown> => call(`interviews/${encodeURIComponent(id)}/stop`, { method: 'POST', body: {} }),
    /** Withdraws my open change proposal (its requester). */
    withdrawProposal: (id: string): Promise<unknown> => call(`proposals/${encodeURIComponent(id)}/withdraw`, { method: 'POST', body: {} }),
    /** Another one-time facilitator link, to hand the role over. */
    facilitatorLink: (): Promise<{ link: string; expiresAt: string }> => call('facilitator/link', { method: 'POST', body: {} }),
    close: (): Promise<unknown> => call('close', { method: 'POST', body: {} }),
    /** `link`: a new invite link (the facilitator; the previous one stops working). */
    invite: (): Promise<InviteBody> => call('invite', { method: 'POST', body: {} }),
    /** `link`: stops the invite link (the facilitator). */
    stopInvite: (): Promise<{ revoked: boolean }> => call('invite/revoke', { method: 'POST', body: {} }),
    /** `link`: lets a pending join request in, or turns it away (the facilitator). */
    decideJoin: (id: string, decision: 'approve' | 'deny'): Promise<unknown> =>
        call(`join-requests/${encodeURIComponent(id)}/${decision}`, { method: 'POST', body: {} }),
    /** `link`: removes a participant: their sign-in ends, their pages close (the facilitator). */
    removeParticipant: (id: string): Promise<unknown> => call(`participants/${encodeURIComponent(id)}/remove`, { method: 'POST', body: {} }),
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
