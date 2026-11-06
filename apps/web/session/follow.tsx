// Following in a session (docs/live-view.md, "Following"): whom the page follows (`view/follow.ts`) and what that does
// here — the AI followed from a request the reader sends (or their proposal approved), a participant followed to the
// view they are on and what their canvas shows (their presence's `camera`, ADR 0026), stopped when they leave — and how
// it shows: a small round toggle (◉ / ○) for the AI in the app bar and on each row of the participants, the followee's
// avatar first in the people button with a ring, and a thin frame round the canvas in the followee's color.
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import type { CameraBounds, Presence, SessionStateBody, ViewLocation } from '@domaintrail/collaboration/protocol';
import { useT } from '../i18n';
import { motionMs } from '../shared/motion';
import { isFollowing, type Follow, type Followee } from '../view/follow';
import type { AiPresence } from './ai';
import type { AgentStatus } from './stream';
import { hasCanvas, sameLocation } from './location';
import { participantColor, type Peers } from './presence';
import { canOpen, openViewTarget, viewTargetOf, type ViewScope, type ViewTarget } from './views';

type ProposalJson = NonNullable<SessionStateBody['proposals']>[number];

/** The AI's color as the page draws it (its avatar, its status). */
export const AI_COLOR = 'var(--agent-active)';

/** The color of whom the page follows: the AI's, or the participant's (their cursor's). */
export const followeeColor = (f: Followee): string => (f.kind === 'ai' ? AI_COLOR : participantColor(f.participant));

/** The style that gives an element the followee's color (`--follow-color`). */
export function followStyle(f: Followee): CSSProperties {
    const style: CSSProperties & Record<'--follow-color', string> = { '--follow-color': followeeColor(f) };
    return style;
}

/** The page of a participant the page follows: the first of theirs that shows a canvas's camera, else their first. */
export function followedPage(peers: Peers, participant: string): Presence | undefined {
    const pages = [...peers.values()].filter((p) => p.participant.id === participant);
    return pages.find((p) => p.camera && hasCanvas(p.location)) ?? pages[0];
}

/** The participants with a page in the session (a followee without one has left). */
export const presentParticipants = (peers: Peers): Set<string> => new Set([...peers.values()].map((p) => p.participant.id));

/** Whether a location is of 詰めて表示 (its layout's key says so: `location.ts`). */
const compactOf = (location: ViewLocation): boolean => location.layoutKey.endsWith('~compact');

/** What following a participant's page does on this page now: open their view, their spacing, fit their camera. */
export interface PersonMove {
    readonly view?: ViewTarget;
    readonly compact?: boolean;
    readonly camera?: CameraBounds;
}

/**
 * What following `their` page does on a page at `mine` (`compact`: its 詰めて表示): nothing while they are where no
 * canvas is (the catalog, a view loading) or on a view this page cannot open (`canOpen`); the following goes on, and
 * starts again once they are back. On their view, their camera (once they sent one); else their view, and their
 * spacing (the same layout, for their camera to fit).
 */
export function personMove(their: Pick<Presence, 'location' | 'camera'>, mine: ViewLocation, scope: ViewScope, compact: boolean): PersonMove {
    if (!hasCanvas(their.location)) return {};
    const target = viewTargetOf(their.location);
    if (!target || !canOpen(target, scope)) return {};
    if (sameLocation(their.location, mine)) return their.camera ? { camera: their.camera } : {};
    const here = viewTargetOf(mine);
    const theirCompact = compactOf(their.location);
    return {
        ...(JSON.stringify(here) !== JSON.stringify(target) && { view: target }),
        ...(theirCompact !== compact && { compact: theirCompact }),
    };
}

/**
 * Follows a participant's page while the reader follows them: their view and spacing through the bare setters, their
 * camera fitted to this canvas (gliding, unless the OS reduces motion); stopped when they leave the session.
 */
export function usePersonFollow(follow: Follow, peers: Peers, mine: ViewLocation, scope: ViewScope): void {
    const { followee, present } = follow;
    useEffect(() => present(presentParticipants(peers)), [peers, present]);
    const participant = followee?.kind === 'person' ? followee.participant : undefined;
    const page = participant === undefined ? undefined : followedPage(peers, participant);
    /** The last move made, so that the same one is not made again (a reader's own move between stops the following). */
    const made = useRef('');
    const key = page ? JSON.stringify([page.location, page.camera ?? null, mine]) : '';
    useEffect(() => {
        if (!page) {
            made.current = '';
            return;
        }
        if (made.current === key) return;
        made.current = key;
        const to = follow.moves();
        const move = personMove(page, mine, scope, to.settings.compact);
        if (move.compact !== undefined) to.settings.setCompact(move.compact);
        if (move.view) openViewTarget(move.view, to);
        if (move.camera && to.canvas) to.canvas.fitBounds(move.camera, { inset: 0, animate: motionMs('--motion-medium') > 0 });
        // the key stands for the page, its camera and where this page is
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, scope]);
}

/**
 * The app bar's toggle of following the AI (案 e3): beside its status while it works (running, queued, waiting for an
 * answer) and is connected; otherwise only while the reader follows it, faint (nothing to follow now, and a press stops
 * it); else none — not while no agent is connected (its 「○ AI 接続なし」 would read alike).
 */
export function aiToggle(status: AgentStatus, presence: AiPresence, followee: Followee | null): 'none' | 'shown' | 'faint' {
    if (status.kind !== 'idle' && presence.kind === 'connected') return 'shown';
    return isFollowing(followee, 'ai') ? 'faint' : 'none';
}

/** The proposals of `me` that were approved (each then runs): their IDs. */
export const approvedProposalsOf = (proposals: readonly ProposalJson[], me: string): string[] =>
    proposals.filter((p) => p.state === 'Approved' && p.requestedBy === me).map((p) => p.id);

/**
 * The reader's change proposal approved while the page is open (its run starts): the page follows the AI, as when the
 * reader sends a request to it. The ones approved before the page saw them are not followed.
 */
export function useFollowApproved(follow: Follow, proposals: readonly ProposalJson[] | undefined, me: string | undefined): void {
    const known = useRef<Set<string> | null>(null);
    const { asked } = follow;
    useEffect(() => {
        if (!proposals || me === undefined) return;
        const approved = approvedProposalsOf(proposals, me);
        if (known.current === null) {
            known.current = new Set(approved);
            return;
        }
        const fresh = approved.filter((id) => !known.current?.has(id));
        for (const id of fresh) known.current.add(id);
        if (fresh.length > 0) asked();
    }, [proposals, me, asked]);
}

/**
 * The round toggle of following someone: ◉ while followed, ○ else, in their color; `faint` while there is nothing to
 * follow (the AI idle). Its name says what a press does (AI を追う, 佐藤を追うのをやめる).
 */
export function FollowToggle(props: { followee: Followee; name: string; on: boolean; faint?: boolean; onToggle: () => void }): ReactNode {
    const t = useT().session.follow;
    const label = props.on ? t.stop(props.name) : t.start(props.name);
    return (
        <button
            type="button"
            className={`icon-button follow-toggle${props.on ? ' on' : ''}${props.faint ? ' faint' : ''}`}
            style={followStyle(props.followee)}
            aria-pressed={props.on}
            aria-label={label}
            data-tooltip={label}
            onClick={props.onToggle}
        >
            <span className="follow-toggle-mark" aria-hidden />
        </button>
    );
}

/** The thin frame round the canvas while the page follows someone, in their color; faint while the AI followed is idle. */
export function FollowFrame({ followee, faint }: { followee: Followee | null; faint: boolean }): ReactNode {
    if (!followee) return null;
    return <div className={`follow-frame${faint ? ' faint' : ''}`} style={followStyle(followee)} aria-hidden />;
}
