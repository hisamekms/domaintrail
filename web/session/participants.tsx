// Who is in the session, behind one button of the chat's header (ADR 0026, Presence): the avatars and the count open a
// list of everyone with where they are (this page, the same view, another view and which, offline), and a way to open
// the view another participant is on (just the view: their camera and cursor are theirs). A mention of a person clicked
// in the chat opens the list at them, their row marked for a moment.
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight } from 'lucide-react';
import type { ViewLocation } from '@domaintrail/collaboration/protocol';
import { useT } from '../i18n';
import { useDismiss } from '../shared/layout';
import { Avatar } from './parts';
import type { SessionData } from './useSession';
import { canOpen, participantRows, viewName, viewTargetOf, type ParticipantRow, type ViewScope, type ViewTarget, type ViewWords } from './views';

/** How many avatars the button shows. */
const AVATARS = 6;

/** The first part of a label with a hint (`詳細 — すべての項目を表示` → `詳細`). */
const short = (label: string): string => label.split(' — ')[0];

export function ParticipantsButton(props: {
    session: SessionData;
    location: ViewLocation;
    scope: ViewScope;
    onOpenView: (target: ViewTarget) => void;
    /** A person to show (a mention of them clicked): `n` changes on each click. */
    focus?: { readonly id: string; readonly n: number };
}) {
    const { session, scope } = props;
    const t = useT();
    const tx = t.session;
    const [open, setOpen] = useState(false);
    const [offlineOpen, setOfflineOpen] = useState(false);
    const root = useRef<HTMLDivElement | null>(null);
    useDismiss(open, root, () => setOpen(false));
    const rows = participantRows(session.state, session.peers, session.me, props.location);
    const online = rows.filter((r) => r.where !== 'away');
    const offline = rows.filter((r) => r.where === 'away');
    const words: ViewWords = {
        views: t.views,
        structureLevels: {
            detail: short(t.structureLevels.detail),
            overview: short(t.structureLevels.overview),
            aggregates: short(t.structureLevels.aggregates),
        },
        stormingLevels: { 'big-picture': t.stormingLevels['big-picture'].label, 'design-level': t.stormingLevels['design-level'].label },
        allContexts: tx.chat.allContexts,
    };
    const label = tx.chat.participantsOnline(online.length, rows.length);

    // a mention clicked: the list opens (the offline part too, when they are away) at their row, marked for a moment
    const { focus } = props;
    const focusAway = focus !== undefined && offline.some((r) => r.id === focus.id);
    useEffect(() => {
        if (!focus) return;
        setOpen(true);
        if (focusAway) setOfflineOpen(true);
        // two frames: the list (and its offline part) is rendered by then
        let frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => {
                const el = root.current?.querySelector<HTMLElement>(`[data-participant-id="${CSS.escape(focus.id)}"]`);
                if (!el) return;
                el.scrollIntoView({ block: 'nearest' });
                el.classList.add('chat-flash');
                setTimeout(() => el.classList.remove('chat-flash'), 1600);
            });
        });
        return () => cancelAnimationFrame(frame);
        // each click once
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focus?.n]);

    const row = (r: ParticipantRow) => {
        const target = r.location && viewTargetOf(r.location);
        const name = target && viewName(target, words, scope);
        const openable = target !== undefined && canOpen(target, scope);
        return (
            <li key={r.id} className={`chat-person where-${r.where}`} data-participant={r.name} data-participant-id={r.id}>
                <Avatar id={r.id} name={r.name} {...(r.avatarUrl && { url: r.avatarUrl })} />
                <span className="chat-person-main">
                    <span className="chat-person-name">
                        {r.name}
                        {r.me && <span className="muted"> ({tx.you})</span>}
                        {r.role === 'facilitator' && <span className="chat-role"> {tx.roles.facilitator}</span>}
                    </span>
                    {/* your own row says nothing of where you are */}
                    {r.where !== 'here' && (
                        <span className="chat-person-where muted">
                            {r.where === 'another-view' && name ? tx.chat.anotherView(name) : tx.whereabouts[r.where]}
                        </span>
                    )}
                </span>
                {r.where === 'another-view' && (
                    <button
                        className="icon-button chat-person-go"
                        disabled={!openable}
                        aria-label={openable && name ? tx.chat.openView(name) : tx.chat.cannotOpen}
                        data-tooltip={openable && name ? tx.chat.openView(name) : tx.chat.cannotOpen}
                        onClick={() => {
                            if (!target) return;
                            props.onOpenView(target);
                            setOpen(false);
                        }}
                    >
                        <ArrowRight size={14} aria-hidden />
                    </button>
                )}
            </li>
        );
    };

    return (
        <div className="chat-people" ref={root}>
            <button
                className="chat-people-button"
                aria-expanded={open}
                aria-haspopup="dialog"
                aria-label={label}
                data-tooltip={label}
                onClick={() => setOpen(!open)}
            >
                <span className="chat-avatars">
                    {rows.slice(0, AVATARS).map((r) => (
                        <span key={r.id} className={`chat-avatar${r.where === 'away' ? ' away' : ''}${r.role === 'facilitator' ? ' facilitator' : ''}`}>
                            <Avatar id={r.id} name={r.name} {...(r.avatarUrl && { url: r.avatarUrl })} />
                        </span>
                    ))}
                </span>
                <span className="chat-online">{tx.chat.onlineCount(online.length, rows.length)}</span>
            </button>
            {open && (
                <div className="chat-people-popover motion-pop" role="dialog" aria-label={tx.chat.participantsTitle}>
                    <ul className="chat-people-list">{online.map(row)}</ul>
                    {offline.length > 0 && (
                        <>
                            <button className="chat-people-offline" aria-expanded={offlineOpen} onClick={() => setOfflineOpen(!offlineOpen)}>
                                {offlineOpen ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                                {tx.chat.offline(offline.length)}
                            </button>
                            {offlineOpen && <ul className="chat-people-list">{offline.map(row)}</ul>}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
