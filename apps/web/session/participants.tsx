// Who is in the collab (ADR 0026, Presence), the first part of the chat's collab menu (`collab-menu.tsx`): everyone
// with where they are (this page, the same view, another view and which, offline), and a way to open the view another
// participant is on (just the view: their camera and cursor are theirs).
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, UserX } from 'lucide-react';
import { useT } from '../i18n';
import { Avatar } from './parts';
import { canOpen, viewName, viewTargetOf, type ParticipantRow, type ViewScope, type ViewTarget, type ViewWords } from './views';

/** The first part of a label with a hint (`詳細 — すべての項目を表示` → `詳細`). */
const short = (label: string): string => label.split(' — ')[0];

/** A participant to show in the list, asked for at `at` (each ask shows them again). */
export interface PeopleFocus {
    readonly participant: string;
    readonly at: number;
}

export function ParticipantsList(props: {
    rows: readonly ParticipantRow[];
    scope: ViewScope;
    onOpenView: (target: ViewTarget) => void;
    /** A participant to show: their row is scrolled to, focused and marked for a moment (the offline ones shown if needed). */
    focus: PeopleFocus | undefined;
    /** `link`, the facilitator: removes a participant who signed in with a cookie of this mode (their pages close). */
    onRemove?: (id: string) => void;
}) {
    const { rows, scope, focus } = props;
    const t = useT();
    const tx = t.session;
    const [offlineOpen, setOfflineOpen] = useState(false);
    const root = useRef<HTMLDivElement | null>(null);
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

    const focusOffline = focus !== undefined && offline.some((r) => r.id === focus.participant);
    useEffect(() => {
        if (focusOffline) setOfflineOpen(true);
    }, [focusOffline, focus]);
    useEffect(() => {
        if (!focus) return;
        const el = root.current?.querySelector<HTMLElement>(`[data-participant-id="${CSS.escape(focus.participant)}"]`);
        if (!el) return;
        el.scrollIntoView({ block: 'nearest' });
        el.focus();
        el.classList.add('chat-flash');
        const timer = setTimeout(() => el.classList.remove('chat-flash'), 1600);
        return () => clearTimeout(timer);
    }, [focus, offlineOpen]);

    const row = (r: ParticipantRow) => {
        const target = r.location && viewTargetOf(r.location);
        const name = target && viewName(target, words, scope);
        const openable = target !== undefined && canOpen(target, scope);
        return (
            <li key={r.id} className={`chat-person where-${r.where}`} data-participant={r.name} data-participant-id={r.id} tabIndex={-1}>
                <Avatar id={r.id} name={r.name} {...(r.avatarUrl && { url: r.avatarUrl })} facilitator={r.role === 'facilitator'} />
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
                {props.onRemove && !r.me && r.role !== 'facilitator' && r.id.startsWith('link:') && (
                    <button
                        className="icon-button chat-person-go"
                        aria-label={tx.chat.remove(r.name)}
                        data-tooltip={tx.chat.remove(r.name)}
                        onClick={() => props.onRemove?.(r.id)}
                    >
                        <UserX size={14} aria-hidden />
                    </button>
                )}
                {r.where === 'another-view' && (
                    <button
                        className="icon-button chat-person-go"
                        disabled={!openable}
                        aria-label={openable && name ? tx.chat.openView(name) : tx.chat.cannotOpen}
                        data-tooltip={openable && name ? tx.chat.openView(name) : tx.chat.cannotOpen}
                        onClick={() => target && props.onOpenView(target)}
                    >
                        <ArrowRight size={14} aria-hidden />
                    </button>
                )}
            </li>
        );
    };

    return (
        <div className="chat-people" ref={root}>
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
    );
}
