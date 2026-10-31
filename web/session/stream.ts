// The session's chat as the left pane shows it (ADR 0026), without React: the main stream ("本筋") of what the
// facilitator queued and what followed (the requests of each run, the facilitator's note, the agent's state as its
// messages, and the revision events worth a line), the requests still waiting for approval, the status at a glance and
// the names of the participants. Everything is derived from the session's state on the page: nothing here is sent.
import type { Me, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { listedParticipants, type Peers } from './presence';
import { timeline } from './timeline';
import { targetKey, type TargetDraft } from './targets';

type RequestJson = SessionStateBody['requests'][number];
type RunJson = SessionStateBody['runs'][number];
type FrozenRequest = RunJson['input']['requests'][number];
type FailureReason = Extract<RunJson, { state: 'Failed' }>['reason'];

/** What the agent says about a run, from the run's state. */
export type AgentMessage =
    | { readonly kind: 'queued' }
    | { readonly kind: 'running'; readonly since: string }
    | { readonly kind: 'clarification'; readonly question: string; readonly result: number | undefined }
    | { readonly kind: 'completed'; readonly changed: boolean; readonly result: number | undefined }
    | { readonly kind: 'failed'; readonly reason: FailureReason }
    | { readonly kind: 'cancelled'; readonly by: string };

/** One item of the main stream. `at` is when it happened (ISO); `key` is stable across updates of the same item. */
export type StreamItem =
    | { readonly kind: 'session-start'; readonly key: string; readonly at: string; readonly revision: number }
    | {
          readonly kind: 'queued';
          readonly key: string;
          readonly at: string;
          readonly run: number;
          readonly by: string;
          readonly requests: readonly FrozenRequest[];
      }
    | { readonly kind: 'note'; readonly key: string; readonly at: string; readonly run: number; readonly by: string; readonly text: string }
    | { readonly kind: 'agent'; readonly key: string; readonly at: string; readonly run: number; readonly message: AgentMessage }
    | { readonly kind: 'confirmed'; readonly key: string; readonly at: string; readonly revision: number; readonly by: string }
    | { readonly kind: 'restored'; readonly key: string; readonly at: string; readonly revision: number; readonly from: number | undefined };

/** The agent's message about a run, and when it was said: its latest change of state. */
function agentMessage(run: RunJson, revisionNumber: (id: string | undefined) => number | undefined): { at: string; message: AgentMessage } {
    switch (run.state) {
        case 'Queued':
            return { at: run.queuedAt, message: { kind: 'queued' } };
        case 'Running':
            return { at: run.startedAt, message: { kind: 'running', since: run.startedAt } };
        case 'NeedsClarification':
            return { at: run.finishedAt, message: { kind: 'clarification', question: run.question, result: revisionNumber(run.resultRevision) } };
        case 'Completed':
            return { at: run.finishedAt, message: { kind: 'completed', changed: run.changed, result: revisionNumber(run.resultRevision) } };
        case 'Failed':
            return { at: run.finishedAt, message: { kind: 'failed', reason: run.reason } };
        case 'Cancelled':
            return { at: run.cancelledAt, message: { kind: 'cancelled', by: run.cancelledBy } };
    }
}

/**
 * The main stream, oldest first: the session's start, each run as it was queued (with its requests), the
 * facilitator's note on it, the agent's message about it (one per run, at its latest change of state), and the
 * revisions confirmed or restored. Requests not in any run are not in it (see `pendingRequests`).
 */
export function streamItems(state: Pick<SessionStateBody, 'runs' | 'revisions'>): StreamItem[] {
    const numbers = new Map(timeline(state).map((e) => [e.revision.id, e.number]));
    const revisionNumber = (id: string | undefined): number | undefined => (id === undefined ? undefined : numbers.get(id));
    const runs = [...state.runs].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    const items: StreamItem[] = [];
    for (const r of state.revisions) {
        const revision = numbers.get(r.id) ?? 0;
        if (r.origin.kind === 'SessionStart') items.push({ kind: 'session-start', key: `start:${r.id}`, at: r.takenAt, revision });
        if (r.origin.kind === 'Restored')
            items.push({ kind: 'restored', key: `restored:${r.id}`, at: r.takenAt, revision, from: numbers.get(r.origin.restoredFrom) });
        if (r.state === 'Confirmed') items.push({ kind: 'confirmed', key: `confirmed:${r.id}`, at: r.confirmedAt, revision, by: r.confirmedBy });
    }
    runs.forEach((run, i) => {
        const n = i + 1;
        items.push({ kind: 'queued', key: `queued:${run.id}`, at: run.queuedAt, run: n, by: run.queuedBy, requests: run.input.requests });
        if (run.input.note) items.push({ kind: 'note', key: `note:${run.id}`, at: run.queuedAt, run: n, by: run.queuedBy, text: run.input.note });
        const { at, message } = agentMessage(run, revisionNumber);
        items.push({ kind: 'agent', key: `agent:${run.id}`, at, run: n, message });
    });
    // by time; items at the same moment keep the order they were pushed in (a run's request, note, then the agent)
    return items
        .map((item, i) => ({ item, i }))
        .sort((a, b) => a.item.at.localeCompare(b.item.at) || a.i - b.i)
        .map(({ item }) => item);
}

/** The status of the session's agent at a glance. */
export type AgentStatus =
    | { readonly kind: 'running'; readonly since: string }
    | { readonly kind: 'clarification' }
    | { readonly kind: 'queued' }
    | { readonly kind: 'idle' };

/**
 * What the agent is doing: running (a run is), waiting for a run to start (one is queued), waiting for an answer (the
 * latest run asked a question), or idle.
 */
export function agentStatus(runs: readonly RunJson[]): AgentStatus {
    const running = runs.find((r) => r.state === 'Running');
    if (running?.state === 'Running') return { kind: 'running', since: running.startedAt };
    if (runs.some((r) => r.state === 'Queued')) return { kind: 'queued' };
    let latest: RunJson | undefined;
    for (const r of runs) if (!latest || r.queuedAt >= latest.queuedAt) latest = r;
    return latest?.state === 'NeedsClarification' ? { kind: 'clarification' } : { kind: 'idle' };
}

/** Elapsed time as `m:ss` (or `h:mm:ss` from an hour on); never negative. */
export function elapsed(since: string, now: number): string {
    const total = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** A request waiting for approval, as the pending list shows it. */
export interface PendingRequest {
    readonly request: RequestJson;
    /** Sent by the participant this page is signed in as. */
    readonly mine: boolean;
}

/** The pending requests and the few the collapsed list shows. */
export interface PendingRequests {
    /** All of them: mine first, newest first within each group. */
    readonly all: readonly PendingRequest[];
    /** The first `limit` of them. */
    readonly preview: readonly PendingRequest[];
    /** How many the preview leaves out. */
    readonly more: number;
}

/**
 * The requests waiting for the facilitator: sent (not dismissed) and in no run yet. Mine first, then the others',
 * newest first within each.
 */
export function pendingRequests(state: Pick<SessionStateBody, 'requests' | 'runs'>, me: string, limit = 3): PendingRequests {
    const inRuns = new Set(state.runs.flatMap((r) => r.input.requests.map((q) => q.request)));
    const all = state.requests
        .filter((r) => r.state === 'Sent' && !inRuns.has(r.id))
        .map((request) => ({ request, mine: request.author === me }))
        .sort((a, b) => Number(b.mine) - Number(a.mine) || b.request.sentAt.localeCompare(a.request.sentAt) || a.request.id.localeCompare(b.request.id));
    const preview = all.slice(0, limit);
    return { all, preview, more: all.length - preview.length };
}

/** A text on one line (whitespace collapsed), for the one-line rows. */
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** What a target is called in the chat: its label, else its key; the whole workspace by the given word. */
export function targetText(target: Pick<TargetDraft, 'target' | 'label'>, workspace: string): string {
    return target.target.kind === 'Workspace' ? workspace : (target.label ?? targetKey(target.target));
}

/**
 * The names participants are known by now: the ones they joined with, the facilitator's after its holder, then the
 * names their pages (and this page) are signed in with.
 */
export function participantNames(state: Pick<SessionStateBody, 'session' | 'facilitatorHolder'>, peers: Peers, me: Me): Map<string, string> {
    const names = new Map<string, string>(state.session.participants.map((p) => [p.id, p.name]));
    for (const p of listedParticipants(state)) names.set(p.id, p.name);
    for (const p of peers.values()) names.set(p.participant.id, p.participant.name);
    names.set(me.participant.id, me.participant.name);
    return names;
}

/** A participant in the header's row of avatars. */
export interface HeaderParticipant {
    readonly id: string;
    readonly name: string;
    readonly role: 'facilitator' | 'participant';
    readonly online: boolean;
    readonly me: boolean;
    readonly avatarUrl?: string;
}

/** The participants for the header: me first, then the others online, then those away, by name within each. */
export function headerParticipants(state: Pick<SessionStateBody, 'session' | 'facilitatorHolder'>, peers: Peers, me: Me): HeaderParticipant[] {
    const names = participantNames(state, peers, me);
    const online = new Set<string>([...peers.values()].map((p) => p.participant.id));
    const avatars = new Map<string, string>();
    for (const p of peers.values()) if (p.participant.avatarUrl) avatars.set(p.participant.id, p.participant.avatarUrl);
    if (me.participant.avatarUrl) avatars.set(me.participant.id, me.participant.avatarUrl);
    const rank = (p: HeaderParticipant): number => (p.me ? 0 : p.online ? 1 : 2);
    return listedParticipants(state)
        .map((p): HeaderParticipant => {
            const avatarUrl = avatars.get(p.id);
            const mine = p.id === me.participant.id;
            return {
                id: p.id,
                name: names.get(p.id) ?? p.name,
                role: p.role,
                online: mine || online.has(p.id),
                me: mine,
                ...(avatarUrl && { avatarUrl }),
            };
        })
        .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
