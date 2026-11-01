// Working together with others ("collab", ADR 0026's session as the UI names it), without React: what the chat's
// collab menu offers to whom, what is still unfinished when the facilitator ends it, and the summary everyone sees once
// it ended. Everything is derived from the session's state the page already holds: after the end the server
// identifies no one any more, so the summary needs no call.
import type { Me, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { changeUnits, shownUnits, type ChangeUnit } from './history';
import { bodyText } from './mentions';
import { listedParticipants, type Peers } from './presence';
import { oneLine, participantNames } from './stream';

type RevisionJson = SessionStateBody['revisions'][number];

/**
 * An action of the collab menu (below its list of participants). Today the page is only ever in a collab (`dt session
 * start`); a solo page (`dt view`, one person) would get a menu of its own here, 「👤 1 人 ▾」 with `start` (コラボを始める),
 * once the page can start one.
 */
export type CollabMenuItem = 'invite' | 'record' | 'hand-over' | 'end' | 'leave';

/**
 * The actions of the collab menu for a role. Everyone can copy the invite link. The facilitator records the workspace,
 * hands the role over and ends the collab; a participant leaves. The facilitator has no 退出: leaving would leave the
 * collab without anyone to apply, answer or end it — they hand the role over first (and can leave then, as a
 * participant), or end it. `live` false (ended, or signed out): only the list.
 */
export function collabMenuItems(role: Me['participant']['role'], live: boolean): CollabMenuItem[] {
    if (!live) return [];
    return role === 'facilitator' ? ['invite', 'record', 'hand-over', 'end'] : ['invite', 'leave'];
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
    /** Results of runs recorded since the last revision confirmed (all of them when none was), not confirmed. */
    readonly unconfirmed: number;
}

/** Whether there is anything unfinished. */
export const hasUnfinished = (u: Unfinished): boolean => u.queued + u.running + u.clarification + u.unconfirmed > 0;

/** What is not finished in a session's state: runs waiting or running, questions unanswered, results not confirmed. */
export function unfinishedWork(state: Pick<SessionStateBody, 'runs' | 'revisions'>, units: readonly ChangeUnit[] = changeUnits(state)): Unfinished {
    const lastConfirmed = state.revisions.reduce<string | undefined>(
        (at, r) => (r.state === 'Confirmed' && (at === undefined || r.takenAt > at) ? r.takenAt : at),
        undefined,
    );
    const unconfirmed = state.revisions.filter(
        (r: RevisionJson) => r.origin.kind === 'RunResult' && r.state === 'Recorded' && (lastConfirmed === undefined || r.takenAt > lastConfirmed),
    ).length;
    return {
        queued: state.runs.filter((r) => r.state === 'Queued').length,
        running: state.runs.filter((r) => r.state === 'Running').length,
        clarification: units.filter((u) => u.outcome === 'clarification').length,
        unconfirmed,
    };
}

/** How long to keep the title of a unit to one line of the summary. */
const TITLE_LENGTH = 60;

/**
 * A change unit's title. For now the first request's text on one line (its mentions as `@name`), cut at 60
 * characters; the one place to switch to a derived title of the unit.
 */
export function unitTitle(unit: ChangeUnit): string {
    const first = unit.runs[0].run.input.requests[0];
    const text = oneLine(bodyText(first.body, first.targets.length));
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
    readonly participants: readonly { readonly id: string; readonly name: string; readonly facilitator: boolean }[];
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
    const units = changeUnits(state);
    const changed = shownUnits(units, false).sort((a, b) => a.start.localeCompare(b.start));
    const end = state.session.state === 'Closed' ? state.session.closedAt : endedAt;
    const participants = listedParticipants(state)
        .map((p) => ({ id: p.id, name: names.get(p.id) ?? p.name, facilitator: p.role === 'facilitator' }))
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
