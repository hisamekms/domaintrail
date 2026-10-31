// The session's chat as the left pane shows it (ADR 0026), without React: the main stream ("本筋") of what the
// facilitator queued and what followed (the requests of each run, the facilitator's note, the agent's state as its
// messages, and the revision events worth a line), the requests still waiting for approval, the status at a glance and
// the names of the participants. Everything is derived from the session's state on the page: nothing here is sent.
import type { Me, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { listedParticipants, type Peers } from './presence';
import { changeUnits, type ChangeUnit } from './history';
import { timeline } from './timeline';
import { targetKey, targetName, type NamingContext, type TargetDraft } from './targets';

type RequestJson = SessionStateBody['requests'][number];
type RunJson = SessionStateBody['runs'][number];
type FrozenRequest = RunJson['input']['requests'][number];
type FailureReason = Extract<RunJson, { state: 'Failed' }>['reason'];
type RevisionJson = SessionStateBody['revisions'][number];
type ReplyJson = Extract<RunJson, { state: 'Declined' }>['reply'];
export type RequestProgress = ReplyJson['requests'][number]['status'];

/** A request a reply names: the frozen request of the run, and its number in the run (as the prompt numbered it). */
export interface ReplyRequest {
    readonly number: number;
    readonly request: FrozenRequest;
}

/**
 * The agent's reply as the page shows it: what the AI says (never a fact), with the requests it names resolved to the
 * run's frozen requests (author, body). A request it names that is not the run's is left out.
 */
export interface ReplyView {
    readonly summary: string;
    readonly requests: readonly { readonly request: ReplyRequest; readonly status: RequestProgress; readonly note?: string }[];
    readonly questions: readonly {
        readonly id: string;
        readonly text: string;
        readonly requests: readonly ReplyRequest[];
        readonly options: readonly { readonly id: string; readonly label: string; readonly detail?: string }[];
        readonly multiple: boolean;
    }[];
    readonly assumptions: readonly {
        readonly text: string;
        readonly requests: readonly ReplyRequest[];
        readonly alternatives: readonly { readonly id: string; readonly label: string }[];
    }[];
}

/** What the agent says about a run, from the run's state; `files`: how many sources the run changed (measured). */
export type AgentMessage =
    | { readonly kind: 'queued' }
    | { readonly kind: 'running'; readonly since: string }
    | {
          readonly kind: 'clarification';
          readonly question: string;
          readonly result: number | undefined;
          readonly files: number | undefined;
          readonly reply?: ReplyView;
      }
    | {
          readonly kind: 'completed';
          readonly changed: boolean;
          readonly result: number | undefined;
          readonly files: number | undefined;
          readonly reply?: ReplyView;
      }
    | { readonly kind: 'declined'; readonly result: number | undefined; readonly files: number | undefined; readonly reply: ReplyView }
    | { readonly kind: 'failed'; readonly reason: FailureReason }
    | { readonly kind: 'cancelled'; readonly by: string };

/** The reply of a run with the requests it names resolved to the run's frozen requests. */
export function replyView(input: RunJson['input'], reply: ReplyJson): ReplyView {
    const byId = new Map(input.requests.map((request, i) => [request.request, { number: i + 1, request }]));
    const resolve = (ids: readonly string[]): ReplyRequest[] => ids.flatMap((id) => byId.get(id) ?? []);
    return {
        summary: reply.summary,
        requests: reply.requests.flatMap((r) => {
            const request = byId.get(r.request);
            return request ? [{ request, status: r.status, ...(r.note !== undefined && { note: r.note }) }] : [];
        }),
        questions: reply.questions.map((q) => ({ id: q.id, text: q.text, requests: resolve(q.requests), options: q.options, multiple: q.multiple })),
        assumptions: reply.assumptions.map((a) => ({ text: a.text, requests: resolve(a.requests), alternatives: a.alternatives })),
    };
}

/**
 * How many sources differ between two revisions (added, changed or removed, by path and content hash): the files a
 * run changed, measured by the server's snapshots. `undefined` when either revision is not known.
 */
export function filesChanged(before: RevisionJson | undefined, after: RevisionJson | undefined): number | undefined {
    if (!before || !after) return undefined;
    if (before.id === after.id) return 0;
    const old = new Map(before.files.map((f) => [f.path, f.hash]));
    let n = 0;
    for (const f of after.files) {
        if (old.get(f.path) !== f.hash) n++;
        old.delete(f.path);
    }
    return n + old.size;
}

/**
 * One item of the main stream. `at` is where it stands (ISO); `key` is stable across updates of the same item. A card
 * stays where its first run was queued, `updatedAt` telling when it last changed.
 */
export type StreamItem =
    | { readonly kind: 'session-start'; readonly key: string; readonly at: string; readonly revision: number }
    | { readonly kind: 'message'; readonly key: string; readonly at: string; readonly request: RequestJson }
    | { readonly kind: 'card'; readonly key: string; readonly at: string; readonly updatedAt: string; readonly unit: ChangeUnit }
    | { readonly kind: 'confirmed'; readonly key: string; readonly at: string; readonly revision: number; readonly by: string }
    | { readonly kind: 'restored'; readonly key: string; readonly at: string; readonly revision: number; readonly from: number | undefined };

/** The numbers of the session's revisions, and the revisions by ID, for the agent's messages. */
export function revisionLookup(state: Pick<SessionStateBody, 'revisions' | 'runs'>): {
    readonly number: (id: string | undefined) => number | undefined;
    readonly revision: (id: string) => RevisionJson | undefined;
} {
    const numbers = new Map(timeline(state).map((e) => [e.revision.id, e.number]));
    const revisions = new Map(state.revisions.map((r) => [r.id, r]));
    return { number: (id) => (id === undefined ? undefined : numbers.get(id)), revision: (id) => revisions.get(id) };
}

/** The agent's message about a run, and when it was said: its latest change of state. */
export function agentMessage(run: RunJson, lookup: ReturnType<typeof revisionLookup>): { at: string; message: AgentMessage } {
    const revisionNumber = lookup.number;
    const files = (base: string, result: string): number | undefined => filesChanged(lookup.revision(base), lookup.revision(result));
    switch (run.state) {
        case 'Queued':
            return { at: run.queuedAt, message: { kind: 'queued' } };
        case 'Running':
            return { at: run.startedAt, message: { kind: 'running', since: run.startedAt } };
        case 'NeedsClarification':
            return {
                at: run.finishedAt,
                message: {
                    kind: 'clarification',
                    question: run.question,
                    result: revisionNumber(run.resultRevision),
                    files: files(run.baseRevision, run.resultRevision),
                    ...(run.reply && { reply: replyView(run.input, run.reply) }),
                },
            };
        case 'Completed':
            return {
                at: run.finishedAt,
                message: {
                    kind: 'completed',
                    changed: run.changed,
                    result: revisionNumber(run.resultRevision),
                    files: files(run.baseRevision, run.resultRevision),
                    ...(run.reply && { reply: replyView(run.input, run.reply) }),
                },
            };
        case 'Declined':
            return {
                at: run.finishedAt,
                message: {
                    kind: 'declined',
                    result: revisionNumber(run.resultRevision),
                    files: files(run.baseRevision, run.resultRevision),
                    reply: replyView(run.input, run.reply),
                },
            };
        case 'Failed':
            return { at: run.finishedAt, message: { kind: 'failed', reason: run.reason } };
        case 'Cancelled':
            return { at: run.cancelledAt, message: { kind: 'cancelled', by: run.cancelledBy } };
    }
}

/**
 * The main stream, oldest first: the session's start, every message as it was sent (each is chat; the facilitator
 * applies some), one card per change unit where its first run was queued (`history.ts`), and the revisions confirmed
 * or restored.
 */
export function streamItems(state: Pick<SessionStateBody, 'runs' | 'revisions' | 'requests'>): StreamItem[] {
    const numbers = new Map(timeline(state).map((e) => [e.revision.id, e.number]));
    const items: StreamItem[] = [];
    for (const r of state.revisions) {
        const revision = numbers.get(r.id) ?? 0;
        if (r.origin.kind === 'SessionStart') items.push({ kind: 'session-start', key: `start:${r.id}`, at: r.takenAt, revision });
        if (r.origin.kind === 'Restored')
            items.push({ kind: 'restored', key: `restored:${r.id}`, at: r.takenAt, revision, from: numbers.get(r.origin.restoredFrom) });
        if (r.state === 'Confirmed') items.push({ kind: 'confirmed', key: `confirmed:${r.id}`, at: r.confirmedAt, revision, by: r.confirmedBy });
    }
    for (const request of state.requests) items.push({ kind: 'message', key: `message:${request.id}`, at: request.sentAt, request });
    for (const unit of changeUnits(state)) items.push({ kind: 'card', key: `card:${unit.key}`, at: unit.start, updatedAt: unit.at, unit });
    // by time; items at the same moment keep the order they were pushed in (a message before the card applying it)
    return items
        .map((item, i) => ({ item, i }))
        .sort((a, b) => a.item.at.localeCompare(b.item.at) || a.i - b.i)
        .map(({ item }) => item);
}

/** When an item last changed: a card when its runs did, anything else when it was added. */
export const changedAt = (item: StreamItem): string => (item.kind === 'card' ? item.updatedAt : item.at);

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

/** A text on one line (whitespace collapsed), for the one-line rows. */
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * What a target is called on the page: its name now in the display mode (`targetName`), else the label it was taken
 * with (a target no longer in the sources, or no naming given), else its key; the whole workspace by the given word.
 */
export function targetText(target: Pick<TargetDraft, 'target' | 'label'>, workspace: string, naming?: NamingContext): string {
    if (target.target.kind === 'Workspace') return workspace;
    return (naming && targetName(target.target, naming)) ?? target.label ?? targetKey(target.target);
}

/** A request's targets on one line: the first one's name and how many more (`注文 +2`); none: the whole workspace. */
export function targetsSummary(targets: readonly Pick<TargetDraft, 'target' | 'label'>[], workspace: string, naming?: NamingContext): string {
    const [first, ...rest] = targets;
    if (!first) return workspace;
    const name = targetText(first, workspace, naming);
    return rest.length ? `${name} +${rest.length}` : name;
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

/** How the chat names a message's author: by the given word (「あなた」) when it is me, else by their name. */
export const speakerName = (author: string, me: string, nameOf: (id: string) => string, you: string): string => (author === me ? you : nameOf(author));

/** Whether a participant is the facilitator now: the session's facilitator, or who holds the role for it. */
export const isFacilitator = (state: Pick<SessionStateBody, 'session' | 'facilitatorHolder'>, id: string): boolean =>
    id === state.session.facilitator || id === state.facilitatorHolder;

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

/**
 * How many items of the stream changed after `seen` (an ISO time: when the chat was last shown): the messages sent and
 * the cards whose runs moved on (each change of a run's state counts). Nothing is unread before the chat was ever shown.
 */
export function unreadCount(items: readonly StreamItem[], seen: string | undefined): number {
    if (seen === undefined) return 0;
    return items.filter((i) => (i.kind === 'message' || i.kind === 'card') && changedAt(i) > seen).length;
}

/** When the stream last changed (its latest change), for `unreadCount`. */
export function latestAt(items: readonly StreamItem[]): string | undefined {
    let latest: string | undefined;
    for (const i of items) if (latest === undefined || changedAt(i) > latest) latest = changedAt(i);
    return latest;
}
