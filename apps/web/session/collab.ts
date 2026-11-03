// Working together with others ("collab", ADR 0026's session as the UI names it), without React: what the chat's
// collab menu offers to whom, what is still unfinished when the facilitator ends it, and the summary everyone sees once
// it ended. Everything is derived from the session's state the page already holds: after the end the server
// identifies no one any more, so the summary needs no call.
import type { Me, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { changeUnits, shownUnits, unitName, type ChangeUnit } from './history';
import { listedParticipants, type Peers } from './presence';
import { participantAvatars, participantNames } from './stream';

/** An action of the collab menu (below its list of participants). */
export type CollabMenuItem = 'invite' | 'record' | 'restore' | 'download-sources' | 'hand-over' | 'end' | 'leave';

/**
 * The actions of the collab menu for a role. Everyone can copy the invite link and download the sources (a ZIP of the
 * `.dt`, `.dtes` and config files, to share without git). The facilitator records the workspace,
 * restores an earlier state of it (the last resort: a unit of work is reverted from its card), hands the role over and
 * ends the collab; a participant leaves. The facilitator has no 退出: leaving would leave the
 * collab without anyone to apply, answer or end it — they hand the role over first (and can leave then, as a
 * participant), or end it. `live` false (ended, or signed out): only the list. In Solo (`dt open`): only the
 * workspace's record, restore and download — no one to invite or hand over to, and the session goes on with the next
 * `dt open`.
 */
export function collabMenuItems(role: Me['participant']['role'], live: boolean, solo = false): CollabMenuItem[] {
    if (!live) return [];
    if (solo) return role === 'facilitator' ? ['record', 'restore', 'download-sources'] : ['download-sources'];
    return role === 'facilitator' ? ['invite', 'record', 'restore', 'download-sources', 'hand-over', 'end'] : ['invite', 'download-sources', 'leave'];
}

/**
 * The link to invite someone: the address of the page's origin. That is the Live View the participants open — in
 * `access` mode the public URL behind Cloudflare Access, which is the origin this page was opened at; in `dev` mode the
 * local server. Opening it signs them in (the join form, or Access) as a participant.
 */
export const inviteLink = (origin: string): string => `${origin.replace(/\/+$/, '')}/`;

/** What is not finished when the facilitator ends the collab. */
export interface Unfinished {
    readonly queued: number;
    readonly running: number;
    /** Units whose latest run asks a question nobody answered yet. */
    readonly clarification: number;
}

/** Whether there is anything unfinished. */
export const hasUnfinished = (u: Unfinished): boolean => u.queued + u.running + u.clarification > 0;

/** What is not finished in a session's state: runs waiting or running, questions unanswered. */
export function unfinishedWork(state: Pick<SessionStateBody, 'runs' | 'revisions'>, units: readonly ChangeUnit[] = changeUnits(state)): Unfinished {
    return {
        queued: state.runs.filter((r) => r.state === 'Queued').length,
        running: state.runs.filter((r) => r.state === 'Running').length,
        clarification: units.filter((u) => u.outcome === 'clarification').length,
    };
}

/** How long to keep the title of a unit to one line of the summary. */
const TITLE_LENGTH = 60;

/**
 * A change unit's title in the summary: its name (`unitName`: the title the AI gave its first run that has one, else
 * the head of its first message), cut at 60 characters.
 */
export function unitTitle(unit: ChangeUnit): string {
    const text = unitName(unit).text;
    return text.length > TITLE_LENGTH ? `${text.slice(0, TITLE_LENGTH - 1)}…` : text;
}

/** One change of the summary. */
export interface SummaryUnit {
    readonly key: string;
    readonly title: string;
    readonly files: number;
    /** Who asked for it, by name. */
    readonly requesters: readonly string[];
}

/** The summary of a collab that ended. */
export interface CollabSummary {
    /** The units that changed files, in the order they started. */
    readonly units: readonly SummaryUnit[];
    /** The units that changed nothing (no change, declined, failed, cancelled, …). */
    readonly others: number;
    /** Everyone who took part, the facilitator first, then by name. */
    readonly participants: readonly { readonly id: string; readonly name: string; readonly facilitator: boolean; readonly avatarUrl?: string }[];
    /** From the start to the end, in milliseconds; undefined when the end is not known. */
    readonly duration: number | undefined;
}

/**
 * The summary of a collab from the state the page holds when it ends: its changes, who took part, how long it lasted
 * (to `closedAt` from the end event, else to `endedAt`: when the page saw it end).
 */
export function collabSummary(
    state: Pick<SessionStateBody, 'session' | 'facilitatorHolder' | 'runs' | 'revisions'>,
    me: Me,
    peers: Peers,
    endedAt?: string,
): CollabSummary {
    const names = participantNames(state, peers, me);
    const avatars = participantAvatars(peers, me);
    const units = changeUnits(state);
    const changed = shownUnits(units, false).sort((a, b) => a.start.localeCompare(b.start));
    const end = state.session.state === 'Closed' ? state.session.closedAt : endedAt;
    const participants = listedParticipants(state)
        .map((p) => {
            const avatarUrl = avatars.get(p.id);
            return { id: p.id, name: names.get(p.id) ?? p.name, facilitator: p.role === 'facilitator', ...(avatarUrl && { avatarUrl }) };
        })
        .sort((a, b) => Number(b.facilitator) - Number(a.facilitator) || a.name.localeCompare(b.name));
    return {
        units: changed.map((u) => ({ key: u.key, title: unitTitle(u), files: u.files ?? 0, requesters: u.requesters.map((id) => names.get(id) ?? id) })),
        others: units.length - changed.length,
        participants,
        duration: end === undefined ? undefined : Math.max(0, Date.parse(end) - Date.parse(state.session.startedAt)),
    };
}

/** A duration in whole hours and minutes (at least one minute). */
export function hoursMinutes(ms: number): { hours: number; minutes: number } {
    const total = Math.max(1, Math.round(ms / 60_000));
    return { hours: Math.floor(total / 60), minutes: total % 60 };
}
