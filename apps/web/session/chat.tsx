// The session's chat in the conversation pillar (ADR 0026, amendment: messages and apply), the same for everyone: who
// is here and what the agent is doing at a glance, then two views. チャット: one stream of every message (each is chat;
// the facilitator applies some: a run), one card per run with the runs that continue it (`card.tsx`), the revisions
// confirmed or restored, and the composer of a message about the selection. AI の作業: everything sent to the AI, from
// start to end (awaiting an answer, running, queued, finished), with the same cards. The facilitator's controls are in the stream itself: send a message to the AI (the Bot button; … for sending
// it again, with a comment, or several together, also chosen with Shift/⌘), answer or pick an alternative on a card,
// cancel, and the menus of the cards and of the head.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react';
import {
    ArrowDown,
    Bot,
    ChevronRight,
    CircleCheck,
    CircleHelp,
    CircleMinus,
    CircleSlash,
    CircleX,
    Clock,
    Ellipsis,
    LoaderCircle,
    MessagesSquare,
    SendHorizontal,
    Ban,
    X,
    type LucideIcon,
} from 'lucide-react';
import type { ViewLocation } from '@domaintrail/collaboration/protocol';
import { useDismiss } from '../shared/layout';
import { motionMs } from '../shared/motion';
import { useT } from '../i18n';
import { useChatActions, type QuestionChoice } from './actions';
import { ActivityLine } from './activity';
import { sessionApi } from './api';
import { ChangedFiles, ReplyButton, RunCard } from './card';
import { AddReaction, ReactionRow, useMarking } from './mark-controls';
import { messageMarks, updatedCards } from './cards';
import { ChatProvider, useChat, type ChatContextValue, type Tx } from './chat-context';
import { ComposerResizer, useComposerSize } from './composer-resizer';
import { changeUnits, requestersOf, shownUnits, statusUnit, unfinishedCount, unitName, workGroups, type ChangeUnit, type UnitOutcome } from './history';
import {
    addChips,
    composerKey,
    matchCandidates,
    matchPeople,
    MAX_REQUEST_MENTIONS,
    MAX_REQUEST_TARGETS,
    ownTokenName,
    removeChip,
    type MentionCandidate,
    type PersonCandidate,
} from './mentions';
import { useTargetNaming } from './naming';
import { CollabMenu, CollabSummaryDialog, openPeople, useCollabSummary } from './collab-menu';
import { Avatar, failure, MentionedText, TargetChips } from './parts';
import { parseReplyText, referenceText } from './references';
import { isReplyable, messageReference, messageReplyTargets, repliesToMe, replyReference, replyTargetOf, replyTargets, type ReplyDraft } from './replies';
import { useRevisionTools } from './revisions';
import { CancelButton, CancelDialog, RowActions, StateLabel, StatusSizer, StatusSlot } from './status-slot';
import { latestRevision } from './state';
import {
    agentStatus,
    arrivedBelow,
    elapsed,
    isFacilitator,
    mentionablePeople,
    mentionsMe,
    participantAvatars,
    participantNames,
    speakerName,
    streamItems,
    targetShortText,
    targetText,
    type AgentStatus,
    type StreamItem,
} from './stream';
import { ComposerChips } from './composer-chips';
import { ComposerEditor, type ComposerEditorApi, type EditorQuery, type MentionLook } from './composer-editor';
import { mentionFits, type ComposerMention } from './composer-text';
import type { ModelTarget, TargetDraft } from './targets';
import { continued, isMac } from './views';
import type { ViewScope, ViewTarget } from './views';
import type { ComposerDraft, SessionData } from './useSession';

type RequestJson = SessionData['state']['requests'][number];
/** A unit to open and reveal in AI の作業 (the header status clicked); `n` tells a click on the same unit again apart. */
type Peek = { readonly key: string; readonly n: number };

/** A run's answer before anything was chosen. */
const NO_CHOICES: Readonly<Record<string, QuestionChoice>> = {};

const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Scrolls `list` (the scrolling box) so that `item` is wholly in it, as little as needed (`block: 'nearest'`), without
 * scrolling anything around the list.
 */
function keepInView(list: HTMLElement, item: HTMLElement): void {
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

/**
 * Caps the candidates' height to the room above the text, within the chat's view (under its header and tabs): however
 * tall the composer is, the list opens directly above the text and never over the header. It scrolls within itself.
 */
function fitAbove(list: HTMLElement): void {
    const anchor = list.parentElement;
    const view = list.closest('.chat-view');
    if (!anchor || !view) return;
    const room = anchor.getBoundingClientRect().top - view.getBoundingClientRect().top - 8;
    list.style.maxHeight = `min(16.25rem, 45vh, ${Math.max(48, Math.floor(room))}px)`;
}

/** The current time, ticking every second while `active`. */
function useNow(active: boolean): number {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        if (!active) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [active]);
    return now;
}

export function SessionChat(props: {
    session: SessionData;
    composer: ComposerDraft;
    /** What `#` offers. */
    candidates: readonly MentionCandidate[];
    /** The composer is asked to take the focus (the selection was just added with 💬 or `C`). */
    focusPending: boolean;
    onFocused: () => void;
    onNavigate: (target: ModelTarget) => void;
    /** This page's location (to tell who is on the same view). */
    location: ViewLocation;
    /** Opens the view another participant is on. */
    onOpenView: (target: ViewTarget) => void;
    /** What view names are made of, and which views this page can open. */
    viewScope: ViewScope;
    onClose: () => void;
}) {
    const { session, composer, focusPending } = props;
    const { state, me } = session;
    const t = useT();
    const tx = t.session;
    const names = participantNames(state, session.peers, me);
    const nameOf = (id: string): string => names.get(id) ?? id;
    const avatars = participantAvatars(session.peers, me);
    const avatarOf = (id: string): string | undefined => avatars.get(id);
    const live = session.status === 'live' && state.session.state === 'Open';
    const control = live && me.participant.role === 'facilitator';
    const status = agentStatus(state.runs);
    const items = useMemo(() => streamItems(state), [state]);
    const units = useMemo(() => changeUnits(state), [state]);
    const marks = useMemo(() => messageMarks(units), [units]);
    const unfinished = unfinishedCount(units);
    const running = state.runs.some((r) => r.state === 'Running');
    const now = useNow(running);
    const actions = useChatActions();
    const marking = useMarking(session);
    const revisions = useRevisionTools(state, tx);
    const [leaveError, setLeaveError] = useState<string | undefined>();
    const leave = async (): Promise<void> => {
        try {
            const left = await sessionApi.leave();
            if (left.logout) location.assign(left.logout);
            else location.reload();
        } catch (e) {
            setLeaveError(failure(e));
        }
    };
    const [view, setView] = useState<'chat' | 'history'>('chat');
    // the stream's scroll while チャット shows, put back as it shows again, with the browser's scroll anchoring off for
    // that frame: it would move the stream a little each time the panel comes back (at the bottom, the stream follows
    // the newest itself)
    const chatPanel = useRef<HTMLDivElement | null>(null);
    const streamTop = useRef<number | undefined>(undefined);
    const keepStreamTop = (e: UIEvent<HTMLDivElement>): void => {
        const el = e.target;
        if (el instanceof HTMLElement && el.classList.contains('chat-stream') && el.clientHeight > 0)
            streamTop.current = atBottomOf(el) ? undefined : el.scrollTop;
    };
    useLayoutEffect(() => {
        const el = chatPanel.current?.querySelector<HTMLElement>('.chat-stream');
        const top = streamTop.current;
        if (view !== 'chat' || !el || top === undefined) return;
        el.style.overflowAnchor = 'none';
        el.scrollTop = top;
        const frame = requestAnimationFrame(() => el.style.removeProperty('overflow-anchor'));
        return () => {
            cancelAnimationFrame(frame);
            el.style.removeProperty('overflow-anchor');
        };
    }, [view]);
    // the collab ended: its summary, shown once to everyone (and again from the notice)
    const ended = session.status === 'closed' || state.session.state === 'Closed';
    const summary = useCollabSummary(session, ended);
    const [summaryShown, setSummaryShown] = useState(false);
    const [summaryOpen, setSummaryOpen] = useState(false);
    useEffect(() => {
        if (!summary || summaryShown) return;
        setSummaryShown(true);
        setSummaryOpen(true);
    }, [summary, summaryShown]);
    // the reply being written (to an AI turn or a message): its chip above the composer; the composer takes the focus when it starts
    const [replyDraft, setReplyDraft] = useState<ReplyDraft | undefined>();
    const [replyFocus, setReplyFocus] = useState(0);
    const replies = useMemo(
        () => ({
            draft: replyDraft,
            start: (id: string): void => {
                const run = state.runs.find((r) => r.id === id);
                const ref = replyReference(units, id);
                if (!run || !ref || !isReplyable(run)) return;
                setReplyDraft({ kind: 'Run', run: id, name: ref.name });
                // the targets start with the replied run's requests' (editable as usual)
                composer.setValue(addChips(composer.value, replyTargets(run)).value);
                setView('chat');
                setReplyFocus((n) => n + 1);
            },
            startMessage: (id: string): void => {
                const request = state.requests.find((r) => r.id === id);
                if (!request) return;
                setReplyDraft({ kind: 'Message', request: id, author: request.author });
                // the targets start with the replied message's (editable as usual)
                composer.setValue(addChips(composer.value, messageReplyTargets(request)).value);
                setView('chat');
                setReplyFocus((n) => n + 1);
            },
            cancel: (): void => setReplyDraft(undefined),
            referenceOf: (run: string) => replyReference(units, run),
            messageReferenceOf: (request: string) => messageReference(state.requests, request),
        }),
        [replyDraft, state, composer, units],
    );
    // the selection confirmed for a request: the composer is in the chat
    useEffect(() => {
        if (focusPending) setView('chat');
    }, [focusPending]);

    // the messages chosen to apply together
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const selection = useMemo(
        () => ({
            active: selecting,
            ids: selected,
            toggle: (id: string) =>
                setSelected((s) => {
                    const next = new Set(s);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                }),
            start: (id: string) => {
                setSelecting(true);
                setSelected((s) => new Set([...s, id]));
            },
            clear: () => {
                setSelecting(false);
                setSelected(new Set());
            },
        }),
        [selecting, selected],
    );
    useEffect(() => {
        if (!selecting) return;
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') selection.clear();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [selecting, selection]);

    const [hovered, hover] = useState<string | undefined>();
    // the answers being chosen, per run: one draft for the chat's form and AI の作業's of the same run
    const [answerDrafts, setAnswerDrafts] = useState<Readonly<Record<string, Readonly<Record<string, QuestionChoice>>>>>({});
    const answers = useMemo(
        (): ChatContextValue['answers'] => ({
            of: (run) => answerDrafts[run] ?? NO_CHOICES,
            update: (run, f) => setAnswerDrafts((all) => ({ ...all, [run]: f(all[run] ?? NO_CHOICES) })),
        }),
        [answerDrafts],
    );
    const root = useRef<HTMLDivElement | null>(null);
    // an item of the stream, scrolled to the middle and marked for a moment (from AI の作業, a quote or a mark)
    const jump = useCallback((key: string): void => {
        setView('chat');
        requestAnimationFrame(() => {
            const el = root.current?.querySelector<HTMLElement>(`.chat-stream [data-item="${CSS.escape(key)}"]`);
            if (!el) return;
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            el.classList.add('chat-flash');
            setTimeout(() => el.classList.remove('chat-flash'), 1600);
        });
    }, []);

    // the header status clicked: AI の作業, at the unit it stands for (opened and revealed); the chat keeps its scroll
    const [peek, setPeek] = useState<Peek | undefined>();
    const peekStatus = (): void => {
        setView('history');
        const unit = statusUnit(status.kind, units);
        if (unit) setPeek((p) => ({ key: unit.key, n: (p?.n ?? 0) + 1 }));
    };

    // a person shown among the participants (a mention of them clicked): the collab menu opens at them
    const showPerson = useCallback((id: string): void => openPeople(id), []);
    // the unit whose run is being cancelled: the dialog asking first
    const [cancelling, setCancelling] = useState<string | undefined>();
    const closeCancel = useCallback((): void => setCancelling(undefined), []);
    const cancellingUnit = cancelling === undefined ? undefined : units.find((u) => u.key === cancelling);

    const context: ChatContextValue = {
        session,
        tx,
        now,
        nameOf,
        avatarOf,
        onNavigate: props.onNavigate,
        control,
        actions,
        confirmCancel: setCancelling,
        answers,
        revisions,
        marks,
        marking,
        classifications: me.participant.role === 'facilitator' ? session.classifications : undefined,
        selection,
        hovered,
        hover,
        jump,
        showPerson,
        replies,
    };

    return (
        <ChatProvider value={context}>
            <div className="session-chat" ref={root}>
                <ChatHeader
                    session={session}
                    status={status}
                    now={now}
                    live={live}
                    units={units}
                    location={props.location}
                    viewScope={props.viewScope}
                    onOpenView={props.onOpenView}
                    onLeave={() => void leave()}
                    onClose={props.onClose}
                    onPeek={peekStatus}
                    tx={tx}
                />
                <div className="segmented chat-views" role="tablist" aria-label={tx.chat.tabsLabel}>
                    {(['chat', 'history'] as const).map((v) => (
                        <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
                            {tx.chat.tabs[v]}
                            {/* AI の作業: how many units are not finished (running and queued), whichever tab is shown */}
                            {v === 'history' && unfinished > 0 && (
                                <span className="chat-views-badge" role="img" aria-label={tx.chat.history.unfinished(unfinished)}>
                                    {unfinished}
                                </span>
                            )}
                        </button>
                    ))}
                </div>
                {session.status === 'signed-out' && <p className="session-note chat-notice">{tx.signedOut}</p>}
                {ended && (
                    <p className="session-note chat-notice collab-ended">
                        {tx.closed}
                        {summary && (
                            <button className="chat-small" onClick={() => setSummaryOpen(true)}>
                                {tx.collab.showSummary}
                            </button>
                        )}
                    </p>
                )}
                {summary && summaryOpen && <CollabSummaryDialog summary={summary} tx={tx} onClose={() => setSummaryOpen(false)} />}
                {session.error && <p className="session-note chat-notice session-error">{tx.error(session.error)}</p>}
                {leaveError && <p className="session-note chat-notice session-error">{tx.error(leaveError)}</p>}
                {/* both stay mounted, so that switching keeps the stream's scroll and the open units of AI の作業 */}
                <div className="chat-view" role="tabpanel" hidden={view !== 'chat'} ref={chatPanel} onScrollCapture={keepStreamTop}>
                    <Stream items={items} />
                    <div className="chat-tray">
                        {revisions.node}
                        {actions.error && <p className="session-note chat-notice session-error">{tx.error(actions.error)}</p>}
                        {marking.error && <p className="session-note chat-notice session-error">{tx.error(marking.error)}</p>}
                        {actions.undo && <UndoBar />}
                        {control && selection.active && <SelectionBar />}
                    </div>
                    {live && (
                        <Composer
                            session={session}
                            composer={composer}
                            candidates={props.candidates}
                            focusPending={focusPending}
                            onFocused={props.onFocused}
                            reply={replyDraft}
                            replyFocus={replyFocus}
                            onReplyDone={() => setReplyDraft(undefined)}
                            tx={tx}
                        />
                    )}
                </div>
                <div className="chat-view" role="tabpanel" hidden={view !== 'history'}>
                    <History units={units} reveal={peek} />
                </div>
                {revisions.dialog}
                {control && cancellingUnit && <CancelDialog unit={cancellingUnit} onClose={closeCancel} />}
                <StatusSizer root={root} />
            </div>
        </ChatProvider>
    );
}

function ChatHeader(props: {
    session: SessionData;
    status: AgentStatus;
    now: number;
    live: boolean;
    units: readonly ChangeUnit[];
    location: ViewLocation;
    viewScope: ViewScope;
    onOpenView: (target: ViewTarget) => void;
    onLeave: () => void;
    onClose: () => void;
    onPeek: () => void;
    tx: Tx;
}) {
    const { session, status, tx } = props;
    const label =
        status.kind === 'running' ? tx.chat.status.running(elapsed(status.since, props.now)) : status.kind === 'idle' ? '' : tx.chat.status[status.kind];
    return (
        <div className="chat-header">
            <CollabMenu
                session={session}
                location={props.location}
                scope={props.viewScope}
                units={props.units}
                live={props.live}
                onOpenView={props.onOpenView}
                onLeave={props.onLeave}
            />
            {/* idle says nothing: only running, a question or a queued run shows; a click opens it in AI の作業 */}
            <span className="chat-status-slot" aria-live="polite">
                {status.kind !== 'idle' && (
                    <button
                        className={`chat-status status-${status.kind}`}
                        data-tooltip={tx.chat.peek}
                        aria-label={`${label} — ${tx.chat.peek}`}
                        onClick={props.onPeek}
                    >
                        <span className="chat-status-mark" aria-hidden>
                            {status.kind === 'running' ? '●' : status.kind === 'clarification' ? '?' : '…'}
                        </span>
                        {label}
                    </button>
                )}
            </span>
            <button className="icon-button" onClick={props.onClose} data-tooltip={tx.chat.close} aria-label={tx.chat.close}>
                <X size={16} aria-hidden />
            </button>
        </div>
    );
}

/** Whether a scrolled element is at its bottom (within a few pixels). */
const atBottomOf = (el: HTMLElement): boolean => el.scrollHeight - el.scrollTop - el.clientHeight < 24;
/** Whether `item` is wholly in the visible part of `list`. */
const inViewOf = (list: HTMLElement, item: HTMLElement): boolean => {
    const a = list.getBoundingClientRect();
    const b = item.getBoundingClientRect();
    return b.top >= a.top - 1 && b.bottom <= a.bottom + 1;
};

function Stream({ items }: { items: StreamItem[] }) {
    const { tx, jump, session } = useChat();
    const ref = useRef<HTMLDivElement | null>(null);
    // follows the newest item only while the reader is at the bottom (true until they scroll up)
    const atBottom = useRef(true);
    // the keys of the items there when the reader left the bottom, while they are away from it: 最新へ shows meanwhile,
    // with how many arrived since
    const [away, setAway] = useState<ReadonlySet<string> | undefined>();
    // on the way back to the bottom (最新へ): the smooth scroll does not count as leaving it, unless the reader scrolls
    const returning = useRef(false);
    const follow = (el: HTMLElement): void => {
        const bottom = atBottomOf(el);
        if (bottom) returning.current = false;
        if (returning.current) return;
        atBottom.current = bottom;
        setAway((known) => (bottom ? undefined : (known ?? new Set(items.map((i) => i.key)))));
    };
    const toBottom = (): void => {
        const el = ref.current;
        if (!el) return;
        if (atBottom.current) el.scrollTop = el.scrollHeight;
        // the bottom came into view without a scroll (the pane grew)
        else follow(el);
    };
    const toLatest = (): void => {
        const el = ref.current;
        if (!el) return;
        atBottom.current = true;
        returning.current = true;
        setAway(undefined);
        el.scrollTo({ top: el.scrollHeight, behavior: motionMs('--motion-enter') === 0 ? 'auto' : 'smooth' });
    };
    const me = session.me.participant.id;
    const arrived = away && arrivedBelow(items, away, me, (r) => mentionsMe(r, session.state, me) || repliesToMe(r, session.state.requests, session.state, me));
    const latestLabel = tx.chat.latest(arrived?.count ?? 0, arrived?.forMe ?? 0);
    const signature = items.map((i) => `${i.key}@${i.kind === 'card' ? i.updatedAt : i.at}`).join('|');
    useLayoutEffect(toBottom, [signature]);
    // the pane shown again, resized, or a bubble grown: still at the bottom
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(toBottom);
        observer.observe(el);
        for (const child of el.children) observer.observe(child);
        return () => observer.disconnect();
    }, [signature]);

    // a card that moved on while out of sight: a pill at the bottom goes to it
    const cards = items.flatMap((i) => (i.kind === 'card' ? [{ key: i.key, updatedAt: i.updatedAt, name: unitName(i.unit).text }] : []));
    const seen = useRef(new Map<string, string>());
    const [pill, setPill] = useState<{ key: string; name: string } | undefined>();
    useEffect(() => {
        const el = ref.current;
        const changed = updatedCards(cards, seen.current);
        for (const c of cards) seen.current.set(c.key, c.updatedAt);
        if (!el) return;
        const hidden = changed.filter((key) => {
            const item = el.querySelector<HTMLElement>(`[data-item="${CSS.escape(key)}"]`);
            return item && !inViewOf(el, item);
        });
        const last = hidden.at(-1);
        if (last) setPill({ key: last, name: cards.find((c) => c.key === last)?.name ?? '' });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signature]);
    const onScroll = (el: HTMLElement): void => {
        follow(el);
        if (!pill) return;
        const item = el.querySelector<HTMLElement>(`[data-item="${CSS.escape(pill.key)}"]`);
        if (item && inViewOf(el, item)) setPill(undefined);
    };

    const rows = streamRows(items, tx);
    const follows = continued(rows.map((r) => r.author));
    // the items there when the stream is first shown with something in it (the page loaded, the tab switched back):
    // only those posted after come in with motion
    const [initial] = useState(() => new Set<string>());
    if (initial.size === 0) for (const row of rows) initial.add(row.key);
    return (
        <div className="chat-stream-wrap">
            <div
                className="chat-stream"
                ref={ref}
                onScroll={(e) => onScroll(e.currentTarget)}
                onWheel={() => {
                    returning.current = false;
                }}
                onTouchStart={() => {
                    returning.current = false;
                }}
            >
                <ol className="chat-items">
                    {rows.map((row, i) => (
                        <li
                            key={row.key}
                            className={`chat-item chat-item-${row.kind}${follows[i] ? ' continued' : ''}${initial.has(row.key) ? '' : ' motion-pop motion-pop-up'}`}
                            data-item={row.key}
                            onAnimationEnd={(e) => {
                                // once in, it is an item like the others: shown again (the tab switched back), it does not come in again
                                if (e.target !== e.currentTarget || initial.has(row.key)) return;
                                initial.add(row.key);
                                e.currentTarget.classList.remove('motion-pop', 'motion-pop-up');
                            }}
                        >
                            {row.render(follows[i])}
                        </li>
                    ))}
                </ol>
            </div>
            {pill && (
                <button
                    className="chat-updated-pill"
                    onClick={() => {
                        jump(pill.key);
                        setPill(undefined);
                    }}
                >
                    <span className="chat-updated-pill-text">{tx.chat.cardUpdated(pill.name)}</span>
                </button>
            )}
            {/* away from the bottom: back to the newest, with how many arrived below (`@ n` when some are for me, as 💬) */}
            {arrived && (
                <button className="chat-latest motion-pop motion-pop-up" onClick={toLatest} aria-label={latestLabel} data-tooltip={latestLabel}>
                    <ArrowDown size={16} aria-hidden />
                    {arrived.forMe > 0 ? (
                        <span className="chat-launcher-count mentions" aria-hidden>
                            <span className="chat-launcher-at">@</span>
                            {arrived.forMe}
                        </span>
                    ) : (
                        arrived.count > 0 && (
                            <span className="chat-launcher-count" aria-hidden>
                                {arrived.count}
                            </span>
                        )
                    )}
                </button>
            )}
        </div>
    );
}

/** A line of the stream: a divider, a card, or a message of an author that may continue the one before. */
interface Row {
    readonly key: string;
    readonly kind: string;
    readonly author: string | undefined;
    readonly render: (continues: boolean) => ReactNode;
}

function streamRows(items: readonly StreamItem[], tx: Tx): Row[] {
    return items.map((item): Row => {
        switch (item.kind) {
            case 'session-start':
                return { key: item.key, kind: item.kind, author: undefined, render: () => <Divider at={item.at}>{tx.chat.started}</Divider> };
            case 'confirmed':
                return { key: item.key, kind: item.kind, author: undefined, render: () => <ConfirmedDivider item={item} /> };
            case 'restored':
                return {
                    key: item.key,
                    kind: item.kind,
                    author: undefined,
                    render: () => <Divider at={item.at}>{tx.chat.restored(item.from, item.revision)}</Divider>,
                };
            case 'message':
                return {
                    key: item.key,
                    kind: item.kind,
                    author: item.request.author,
                    render: (continues) => <MessageRow request={item.request} continues={continues} />,
                };
            case 'card':
                return { key: item.key, kind: item.kind, author: undefined, render: () => <RunCard unit={item.unit} /> };
        }
    });
}

function ConfirmedDivider({ item }: { item: Extract<StreamItem, { kind: 'confirmed' }> }) {
    const { tx, nameOf } = useChat();
    return <Divider at={item.at}>{tx.chat.confirmed(nameOf(item.by), item.revision)}</Divider>;
}

/**
 * A message of the stream: who sent it (「あなた」 for my own, ファシリ by the facilitator's name), its targets and text; at
 * the right of its name line, in the status slot, the mark of its latest run (`✓ 対応`; the card's name in its tooltip, a
 * click goes to the card), then the actions: for the facilitator, the tools to send it to the AI; ↩ and ☺+.
 */
function MessageRow({ request: r, continues }: { request: RequestJson; continues: boolean }) {
    const { session, tx, nameOf, avatarOf, onNavigate, control, marks, classifications, selection, hovered, hover, actions, jump, showPerson } = useChat();
    const author = nameOf(r.author);
    const avatarUrl = avatarOf(r.author);
    // it mentions me, or replies to my message: a faint background in my stream only (it asks for my attention)
    const toMe = mentionsMe(r, session.state, session.me.participant.id) || repliesToMe(r, session.state.requests, session.state, session.me.participant.id);
    const mine = r.author === session.me.participant.id;
    const facilitator = isFacilitator(session.state, r.author);
    const statuses = session.targets?.statuses[r.id];
    const mark = marks.get(r.id);
    // read as talk: no AI に送る button in the row (still in the … menu)
    const talk = classifications?.[r.id]?.kind === 'chat';
    const selected = selection.ids.has(r.id);
    const [note, setNote] = useState<string | undefined>();
    const choose = (e: React.MouseEvent): void => {
        if (!control) return;
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
            e.preventDefault();
            if (selection.active) selection.toggle(r.id);
            else selection.start(r.id);
        } else if (selection.active && !(e.target instanceof Element && e.target.closest('a, button, input'))) selection.toggle(r.id);
    };
    // the status slot (its mark, a link to the card), then the actions, in a group as wide on every row
    const side = (
        <div className="chat-message-side">
            <StatusSlot>
                {mark && (
                    <button
                        className={`chat-state state-${mark.state}`}
                        onClick={() => jump(`card:${mark.card}`)}
                        aria-label={tx.chat.markHint(mark.name, tx.chat.marks[mark.state])}
                        data-tooltip={tx.chat.markHint(mark.name, tx.chat.marks[mark.state])}
                    >
                        <StateLabel state={mark.state} label={tx.chat.marks[mark.state]} />
                    </button>
                )}
            </StatusSlot>
            <RowActions>
                {control && !selection.active && (
                    <span className="chat-apply">
                        {!mark && !talk && (
                            <button
                                className="icon-button chat-apply-button"
                                disabled={actions.busy}
                                onClick={() => void actions.apply([r.id])}
                                aria-label={tx.chat.apply}
                                data-tooltip={tx.chat.apply}
                            >
                                <Bot size={14} aria-hidden />
                            </button>
                        )}
                        <MessageMenu id={r.id} applied={mark !== undefined} talk={talk} onNote={() => setNote('')} />
                    </span>
                )}
                {/* ↩ just before ☺+, as on an AI turn */}
                {!selection.active && <ReplyButton to={{ kind: 'Message', request: r.id }} />}
                {/* last: ☺+ at the right end of every row, messages and turns alike */}
                {!selection.active && <AddReaction target={{ kind: 'Message', request: r.id }} />}
            </RowActions>
        </div>
    );
    return (
        <div
            className={`chat-row${selected ? ' selected' : ''}${hovered === r.id ? ' paired' : ''}${toMe ? ' mentions-me' : ''}`}
            onClickCapture={choose}
            // Shift / ⌘ chooses the message: no text selection
            onMouseDown={(e) => control && (e.shiftKey || e.metaKey || e.ctrlKey) && e.preventDefault()}
            onMouseEnter={() => hover(r.id)}
            onMouseLeave={() => hover(undefined)}
        >
            {control && selection.active && (
                <input type="checkbox" className="chat-select" checked={selected} onChange={() => selection.toggle(r.id)} aria-label={tx.chat.select} />
            )}
            <Bubble
                avatar={<Avatar id={r.author} name={author} {...(avatarUrl && { url: avatarUrl })} facilitator={facilitator} />}
                who={speakerName(r.author, session.me.participant.id, nameOf, tx.chat.you)}
                badge={facilitator && <span className="chat-role">{tx.chat.facilitatorShort}</span>}
                at={r.sentAt}
                continues={continues}
                className={`chat-bubble-request${mine ? ' mine' : ''}`}
                side={side}
            >
                {r.replyTo?.kind === 'Run' && <ReplyReferenceLine run={r.replyTo.run} />}
                {r.replyTo?.kind === 'Message' && <MessageReferenceLine request={r.replyTo.request} />}
                <TargetChips targets={r.targets} statuses={statuses} onNavigate={onNavigate} tx={tx} />
                <Clamped tx={tx}>
                    <MentionedText
                        body={r.body}
                        targets={r.targets}
                        statuses={statuses}
                        onNavigate={onNavigate}
                        mentions={r.mentions}
                        nameOf={nameOf}
                        onPerson={showPerson}
                        tx={tx}
                    />
                </Clamped>
                <ReactionRow target={{ kind: 'Message', request: r.id }} />
            </Bubble>
            {note !== undefined && (
                <form
                    className="chat-apply-note"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void actions.apply([r.id], note).then((ok) => ok && setNote(undefined));
                    }}
                >
                    <input
                        className="session-text"
                        autoFocus
                        value={note}
                        maxLength={4000}
                        placeholder={tx.runNote}
                        aria-label={tx.runNote}
                        onChange={(e) => setNote(e.target.value)}
                    />
                    <button type="submit" className="chat-small primary" disabled={actions.busy}>
                        <Bot size={12} aria-hidden /> {tx.chat.applyNow}
                    </button>
                    <button type="button" className="icon-button" onClick={() => setNote(undefined)} aria-label={tx.restoreFlow.cancel}>
                        <X size={13} aria-hidden />
                    </button>
                </form>
            )}
        </div>
    );
}

/**
 * The run a reply replies to, on one muted line at the top of the message: `↩ <its card's name>: the head of what it
 * said`; a click goes to its card (scrolled to and flashed, as a quote does).
 */
function ReplyReferenceLine({ run }: { run: string }) {
    const { tx, jump, replies } = useChat();
    const naming = useTargetNaming();
    const ref = replies.referenceOf(run);
    if (!ref) return null;
    const r = tx.chat.replies;
    // plain text in a button: an element the AI named reads as its name, not a link
    const head =
        ref.summary === undefined
            ? r.states[ref.state]
            : parseReplyText(ref.summary)
                  .map((seg) => (seg.kind === 'text' ? seg.text : referenceText(seg, naming).text))
                  .join('');
    return (
        <button className="chat-reply-ref" onClick={() => jump(`card:${ref.card}`)} data-tooltip={r.referenceHint(ref.name)}>
            <span className="chat-reply-ref-run">↩ {r.reference(ref.name)}:</span> <span className="chat-reply-ref-head">{head}</span>
        </button>
    );
}

/**
 * The message a reply replies to, on one muted line at the top of the reply: `↩ <its author>: the head of its body`;
 * a click goes to the message (scrolled to and flashed). Nothing when the session does not hold it.
 */
function MessageReferenceLine({ request }: { request: string }) {
    const { session, tx, nameOf, jump, replies } = useChat();
    const ref = replies.messageReferenceOf(request);
    if (!ref) return null;
    const who = speakerName(ref.author, session.me.participant.id, nameOf, tx.chat.you);
    return (
        <button className="chat-reply-ref" onClick={() => jump(`message:${ref.request}`)} data-tooltip={tx.chat.replies.messageReferenceHint(who)}>
            <span className="chat-reply-ref-run">↩ {who}:</span> <span className="chat-reply-ref-head">{ref.head}</span>
        </button>
    );
}

/**
 * A message's menu (the facilitator's, …): send it again (once sent) or anyway (classified as chat, where the button is
 * not shown), send it with a comment, choose it among several to send together.
 */
function MessageMenu({ id, applied, talk, onNote }: { id: string; applied: boolean; talk: boolean; onNote: () => void }) {
    const { tx, actions, selection } = useChat();
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    useDismiss(open, root, () => setOpen(false));
    const pick = (f: () => void) => (): void => {
        setOpen(false);
        f();
    };
    return (
        <div className="pane-menu" ref={root}>
            <button
                className="icon-button chat-apply-more"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={tx.chat.messageMenu}
                data-tooltip={tx.chat.messageMenu}
                onClick={() => setOpen(!open)}
            >
                <Ellipsis size={13} aria-hidden />
            </button>
            {open && (
                <div className="pane-menu-list" role="menu">
                    {(applied || talk) && (
                        <button role="menuitem" onClick={pick(() => void actions.apply([id]))}>
                            {applied ? tx.chat.applyAgain : tx.chat.applyAnyway}
                        </button>
                    )}
                    <button role="menuitem" onClick={pick(onNote)}>
                        {tx.chat.applyWithNote}
                    </button>
                    <button role="menuitem" onClick={pick(() => selection.start(id))}>
                        {tx.chat.selectMany}
                    </button>
                </div>
            )}
        </div>
    );
}

/** The bar of the messages chosen to send to the AI together, as one run. */
function SelectionBar() {
    const { tx, selection, actions } = useChat();
    const [note, setNote] = useState('');
    const [noting, setNoting] = useState(false);
    const n = selection.ids.size;
    const apply = async (): Promise<void> => {
        // in the stream's order
        const ids = [...document.querySelectorAll<HTMLElement>('.chat-stream [data-item^="message:"]')]
            .map((el) => el.dataset.item?.slice('message:'.length) ?? '')
            .filter((id) => selection.ids.has(id));
        if (await actions.apply(ids, note)) {
            selection.clear();
            setNote('');
            setNoting(false);
        }
    };
    return (
        <div className="chat-selection-bar" role="toolbar" aria-label={tx.chat.selected(n)}>
            <span className="chat-selection-count">{tx.chat.selected(n)}</span>
            {noting ? (
                <input
                    className="session-text"
                    autoFocus
                    value={note}
                    maxLength={4000}
                    placeholder={tx.runNote}
                    aria-label={tx.runNote}
                    onChange={(e) => setNote(e.target.value)}
                />
            ) : (
                <button className="chat-small" onClick={() => setNoting(true)}>
                    {tx.chat.addNote}
                </button>
            )}
            <button className="chat-small primary" disabled={n === 0 || actions.busy} onClick={() => void apply()}>
                <Bot size={12} aria-hidden /> {tx.chat.applySelected}
            </button>
            <button className="icon-button" onClick={() => selection.clear()} aria-label={tx.chat.clearSelection} data-tooltip={tx.chat.clearSelection}>
                <X size={14} aria-hidden />
            </button>
        </div>
    );
}

/** Right after sending to the AI: 取り消す, while the run is still queued. */
function UndoBar() {
    const { tx, actions, session } = useChat();
    const run = session.state.runs.find((r) => r.id === actions.undo?.run);
    const queued = !run || run.state === 'Queued';
    return (
        <div className="chat-undo" role="status">
            <span>{tx.chat.appliedAs}</span>
            {queued && (
                <button className="chat-small" onClick={() => actions.undoNow()}>
                    {tx.chat.undo}
                </button>
            )}
            <button className="icon-button" onClick={() => actions.dismissUndo()} aria-label={tx.restoreFlow.close}>
                <X size={13} aria-hidden />
            </button>
        </div>
    );
}

const OUTCOME_ICONS: Record<UnitOutcome, LucideIcon> = {
    changed: CircleCheck,
    unchanged: CircleMinus,
    clarification: CircleHelp,
    declined: Ban,
    failed: CircleX,
    cancelled: CircleSlash,
    running: LoaderCircle,
    queued: Clock,
};

/**
 * AI の作業: everything sent to the AI, from start to end, in groups — 答え待ち (the AI asked), 実行中, 待ち (in the
 * order they will run, numbered) and 終わったもの (newest first). すべて filters only the finished ones: by default those
 * that changed files. A unit is one block between lines: its head names the chunk (its title, else its first message)
 * with whose requests they were, how many runs and its time (the running one's elapsed time), then the files it changed
 * (a link to compare them); the facilitator cancels a running or queued unit with ✕ (a dialog asks first). A click on the block opens it:
 * under the same left edge, the unit's card (compact, with the AI's question to answer or vote on, as in the chat) and
 * a link to it in the chat. The card's own menu is the place of the facilitator's other actions on a unit.
 */
function History({ units: all, reveal }: { units: readonly ChangeUnit[]; reveal: Peek | undefined }) {
    const { tx } = useChat();
    const h = tx.chat.history;
    const [everything, setEverything] = useState(false);
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
    const ref = useRef<HTMLDivElement | null>(null);
    // the unit the header status stands for: opened (the others stay as they are), scrolled to and marked for a moment
    useEffect(() => {
        if (!reveal) return;
        setOpen((o) => (o.has(reveal.key) ? o : new Set([...o, reveal.key])));
        requestAnimationFrame(() => {
            const el = ref.current?.querySelector<HTMLElement>(`[data-unit="${CSS.escape(reveal.key)}"]`);
            if (!el) return;
            el.scrollIntoView({ block: 'start', behavior: 'smooth' });
            el.classList.add('chat-flash');
            setTimeout(() => el.classList.remove('chat-flash'), 1600);
        });
    }, [reveal]);
    const groups = workGroups(all);
    const finished = shownUnits(groups.finished, everything);
    const toggle = (key: string): void => {
        const next = new Set(open);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        setOpen(next);
    };
    const rows = (units: readonly ChangeUnit[], mark?: (i: number) => ReactNode): ReactNode => (
        <ol className="chat-units">
            {units.map((unit, i) => (
                <HistoryUnit key={unit.key} unit={unit} mark={mark?.(i)} open={open.has(unit.key)} onToggle={() => toggle(unit.key)} />
            ))}
        </ol>
    );
    return (
        <div className="chat-history" ref={ref}>
            {groups.awaiting.length > 0 && (
                <section className="chat-work-group awaiting">
                    <h3 className="chat-work-label">{h.groups.awaiting}</h3>
                    {rows(groups.awaiting)}
                </section>
            )}
            {groups.running.length > 0 && (
                <section className="chat-work-group running">
                    <h3 className="chat-work-label">{h.groups.running}</h3>
                    {rows(groups.running, () => (
                        <span className="chat-pulse chat-unit-pulse" aria-label={h.outcomes.running} role="img" />
                    ))}
                </section>
            )}
            {groups.queued.length > 0 && (
                <section className="chat-work-group queued">
                    <h3 className="chat-work-label">{h.groups.queued(groups.queued.length)}</h3>
                    {rows(groups.queued, (i) => (
                        <span className="chat-unit-order" role="img" aria-label={h.order(i + 1)}>
                            {i + 1}
                        </span>
                    ))}
                </section>
            )}
            {/* the filter is of the finished ones only: what is still going on always shows */}
            {groups.finished.length > 0 && (
                <section className="chat-work-group finished">
                    <div className="chat-work-label-row">
                        <h3 className="chat-work-label">{h.groups.finished}</h3>
                        <label className="check small" data-tooltip={h.allHint}>
                            <input type="checkbox" checked={everything} onChange={(e) => setEverything(e.target.checked)} />
                            {h.all}
                        </label>
                    </div>
                    {rows(finished)}
                </section>
            )}
        </div>
    );
}

function HistoryUnit({ unit, mark, open, onToggle }: { unit: ChangeUnit; mark: ReactNode; open: boolean; onToggle: () => void }) {
    const { tx, nameOf, control, now, jump } = useChat();
    const h = tx.chat.history;
    const Icon = OUTCOME_ICONS[unit.outcome];
    const name = unitName(unit);
    const asked = requestersOf(unit.requesters.map(nameOf));
    const who =
        asked.kind === 'names' ? h.requesters(asked.names.join(h.separator)) : asked.kind === 'more' ? h.requestersMore(asked.first, asked.others) : undefined;
    const span = unit.span;
    const paths = unit.paths ?? [];
    const last = unit.runs[unit.runs.length - 1].run;
    // the files line says which files (and how many); one run is the rule, said only when there were more
    const listed = paths.length > 0 && span !== undefined;
    const facts = [
        who,
        unit.runs.length > 1 ? h.runs(unit.runs.length) : undefined,
        !listed && unit.files !== undefined && unit.files > 0 ? h.files(unit.files) : undefined,
    ].filter((x) => x !== undefined);
    // the facilitator's ✕ on what has not finished (asking first); at the right end, before ›
    const cancellable = control && (last.state === 'Queued' || last.state === 'Running');
    // the card is mounted the first time the unit opens, and stays so that it folds away as it closes
    const [mounted, setMounted] = useState(open);
    if (open && !mounted) setMounted(true);
    return (
        <li
            className={`chat-unit outcome-${unit.outcome}${open ? ' open' : ''}${cancellable ? ' cancellable' : ''}${listed ? ' has-files' : ''}`}
            data-unit={unit.key}
        >
            <button className="chat-unit-head" aria-expanded={open} aria-label={open ? h.collapse : h.expand} onClick={onToggle}>
                <span className="chat-unit-mark">{mark ?? <Icon size={14} className="chat-unit-icon" aria-label={h.outcomes[unit.outcome]} />}</span>
                <span className="chat-unit-text">
                    <span
                        className={`chat-unit-title${name.kind === 'request' ? ' untitled' : ''}`}
                        {...(name.kind === 'request' && { 'data-tooltip': h.untitledHint })}
                    >
                        {name.text}
                    </span>
                    {/* small, under the title: whose requests, how many runs, and when (the running one: for how long) */}
                    <span className="chat-unit-facts">
                        {facts.map((f) => `${f} · `).join('')}
                        {last.state === 'Running' ? (
                            <span data-tooltip={h.elapsedHint}>{elapsed(last.startedAt, now)}</span>
                        ) : (
                            <>
                                <time dateTime={unit.start}>{time(unit.start)}</time>
                                {time(unit.at) !== time(unit.start) && (
                                    <>
                                        –<time dateTime={unit.at}>{time(unit.at)}</time>
                                    </>
                                )}
                            </>
                        )}
                    </span>
                    {last.state === 'Running' && <ActivityLine run={last.id} />}
                </span>
                {cancellable && <span className="chat-unit-cancel-space" aria-hidden />}
                <ChevronRight size={14} className="chat-unit-twisty" aria-hidden />
            </button>
            {cancellable && (
                <span className="chat-unit-cancel">
                    <CancelButton unit={unit} />
                </span>
            )}
            {/* what the chunk changed: its files (the page knows them, not the elements) after a file-diff icon, a link to
                compare the whole chunk. The line is part of the row: a click on it, but on the link, opens or closes the
                unit as the head does (a pointer's convenience; the head stays the one toggle for the keyboard) */}
            {listed && span && (
                <div
                    className="chat-unit-files"
                    onClick={(e) => {
                        if (!(e.target instanceof Element && e.target.closest('button'))) onToggle();
                    }}
                >
                    <ChangedFiles kind="unit" paths={paths} base={span.base} result={span.result} />
                </div>
            )}
            {/* the body unfolds like the tree's branches (a grid row from 0fr to 1fr) */}
            <div className="chat-unit-fold" inert={!open}>
                <div className="chat-unit-fold-inner">
                    {mounted && (
                        <div className="chat-unit-body">
                            <RunCard
                                unit={unit}
                                compact
                                actions={
                                    <button className="chat-small" onClick={() => jump(`card:${unit.key}`)}>
                                        <MessagesSquare size={12} aria-hidden /> {h.showInChat}
                                    </button>
                                }
                            />
                        </div>
                    )}
                </div>
            </div>
        </li>
    );
}

/**
 * The floating button opening the conversation while it is closed, with the agent's state as a mark (a spinner while
 * it runs, `?` while it waits for an answer) and how many messages and cards changed since the chat was last shown —
 * or, when some of those messages mention me, how many do (`@ 2`): the only sign that someone called me.
 */
export function ChatLauncher(props: { status: AgentStatus; unread: number; mentions: number; onOpen: () => void }) {
    const t = useT();
    const tx = t.session;
    const { status, unread, mentions } = props;
    const label = tx.chat.launcher(unread, mentions);
    return (
        <button className={`chat-launcher status-${status.kind}`} onClick={props.onOpen} aria-label={label} data-tooltip={label}>
            <MessagesSquare size={20} aria-hidden />
            {status.kind === 'running' && <LoaderCircle size={14} className="chat-launcher-mark spin" aria-hidden />}
            {status.kind === 'clarification' && (
                <span className="chat-launcher-mark question" aria-hidden>
                    ?
                </span>
            )}
            {mentions > 0 ? (
                <span className="chat-launcher-count mentions" aria-hidden>
                    <span className="chat-launcher-at">@</span>
                    {mentions}
                </span>
            ) : (
                unread > 0 && (
                    <span className="chat-launcher-count" aria-hidden>
                        {unread}
                    </span>
                )
            )}
        </button>
    );
}

function Divider({ at, children }: { at: string; children: ReactNode }) {
    return (
        <div className="chat-system">
            <span className="chat-system-text">{children}</span>
            <time className="chat-time" dateTime={at}>
                {time(at)}
            </time>
        </div>
    );
}

function Bubble(props: {
    avatar: ReactNode;
    who: string;
    badge?: ReactNode;
    meta?: ReactNode;
    at: string | undefined;
    /** It continues the bubble before, of the same author: no avatar nor name; the time on hover. */
    continues?: boolean;
    className?: string;
    /** At the right end of the name line (of a continued message, its first line): its mark, the facilitator's tools, ☺+. */
    side?: ReactNode;
    children: ReactNode;
}) {
    if (props.continues)
        return (
            <div className={`chat-message continued ${props.className ?? ''}`} {...(props.at && { title: time(props.at) })}>
                <span className="chat-avatar-space" aria-hidden />
                <div className="chat-message-main">
                    {props.side}
                    <div className="chat-bubble">{props.children}</div>
                </div>
            </div>
        );
    return (
        <div className={`chat-message ${props.className ?? ''}`}>
            {props.avatar}
            <div className="chat-message-main">
                <div className="chat-message-head">
                    <span className="chat-who">{props.who}</span>
                    {props.badge}
                    {props.meta}
                    {props.at && (
                        <time className="chat-time" dateTime={props.at}>
                            {time(props.at)}
                        </time>
                    )}
                    {props.side}
                </div>
                <div className="chat-bubble">{props.children}</div>
            </div>
        </div>
    );
}

/** A text clamped to a few lines, with a link to show the rest when it is longer. */
function Clamped({ children, tx }: { children: ReactNode; tx: Tx }) {
    const [open, setOpen] = useState(false);
    const [clamped, setClamped] = useState(false);
    const ref = useRef<HTMLParagraphElement | null>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (el && !open) setClamped(el.scrollHeight > el.clientHeight + 1);
    }, [children, open]);
    return (
        <>
            <p ref={ref} className={`chat-text${open ? '' : ' clamped'}`}>
                {children}
            </p>
            {clamped && !open && (
                <a className="chat-more" onClick={() => setOpen(true)}>
                    {tx.chat.showMore}
                </a>
            )}
        </>
    );
}

/** A candidate of the composer's list: an element after `#`, a person after `@`. */
type Suggestion =
    | { readonly kind: 'element'; readonly key: string; readonly element: MentionCandidate }
    | { readonly kind: 'person'; readonly key: string; readonly person: PersonCandidate };

/** A person offered after `@`: their avatar and name, the facilitator marked, those away said so. */
function PersonOption({ person, tx }: { person: PersonCandidate; tx: Tx }) {
    return (
        <>
            <span className="chat-mention-person">
                <Avatar id={person.id} name={person.name} {...(person.avatarUrl && { url: person.avatarUrl })} facilitator={person.role === 'facilitator'} />
                <span className="chat-mention-name">{person.name}</span>
                {person.role === 'facilitator' && <span className="chat-role">{tx.chat.facilitatorShort}</span>}
            </span>
            {!person.online && <span className="chat-mention-away muted">{tx.whereabouts.away}</span>}
        </>
    );
}

function Composer(props: {
    session: SessionData;
    composer: ComposerDraft;
    candidates: readonly MentionCandidate[];
    focusPending: boolean;
    onFocused: () => void;
    /** The run or message the message replies to, while a reply is written; `replyFocus` changes when one starts. */
    reply: ReplyDraft | undefined;
    replyFocus: number;
    onReplyDone: () => void;
    tx: Tx;
}) {
    const { session, composer, tx, reply, onReplyDone } = props;
    const personName = useChat().nameOf;
    const replyingTo =
        reply?.kind === 'Message'
            ? tx.chat.replies.replyingToMessage(speakerName(reply.author, session.me.participant.id, personName, tx.chat.you))
            : reply && tx.chat.replies.replyingTo(reply.name);
    const t = useT();
    const naming = useTargetNaming();
    const value = composer.value;
    const input = useRef<HTMLElement | null>(null);
    const editor = useRef<ComposerEditorApi | null>(null);
    const size = useComposerSize(input);
    // the `#query` or `@query` at the caret, as the editor reports it
    const [query, setQuery] = useState<EditorQuery | undefined>();
    const [active, setActive] = useState(0);
    // the `#` or `@` whose candidates were closed with Esc: they stay closed until another one
    const [dismissed, setDismissed] = useState<string | undefined>();
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [notice, setNotice] = useState<string | undefined>();
    // the chips shown whole (`+n` pressed); sending collapses them again
    const [chipsExpanded, setChipsExpanded] = useState(false);
    // `@` offers the others in the session: with no one else (or no session), it offers nothing and stays closed
    const people = useMemo(() => mentionablePeople(session.state, session.peers, session.me), [session.state, session.peers, session.me]);
    const queryKey = query && `${query.node}:${query.start}`;
    const open = query !== undefined && queryKey !== dismissed && (query.sign === '#' || people.length > 0);
    const matches: readonly Suggestion[] = !open
        ? []
        : query.sign === '#'
          ? matchCandidates(props.candidates, query.query).map((c) => ({ kind: 'element', key: c.key, element: c }))
          : matchPeople(people, query.query).map((p) => ({ kind: 'person', key: p.id, person: p }));
    const canSend = !sending && value.text.trim() !== '';
    const mac = isMac(typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent);
    // a chip shows the target's own name; its whole name is in the tooltip and the labels
    const nameOf = (target: TargetDraft): string => targetText(target, tx.workspace, naming);
    const shortOf = (target: TargetDraft): string => targetShortText(target, tx.workspace, naming);
    // a mention in the text: an element by its own name (its whole name in the tooltip), a person by their name
    const look = (m: ComposerMention): MentionLook =>
        m.kind === 'element' ? { label: `#${ownTokenName(m.name, m.target)}`, title: `#${nameOf(m.target)}` } : { label: `@${m.name}`, title: `@${m.name}` };
    const kindOf = (c: MentionCandidate): string => {
        const names: Readonly<Record<string, string>> = c.kind.language === 'dt' ? t.kinds : t.esKinds;
        return names[c.kind.kind] ?? c.kind.kind;
    };

    useEffect(() => setActive(0), [query?.start, query?.query]);
    // the active candidate stays in view when the keys move it (wrapping too); a hover moves it where the pointer
    // already is, so it never scrolls the list under the pointer
    const list = useRef<HTMLUListElement | null>(null);
    const hovered = useRef(false);
    useLayoutEffect(() => {
        const ul = list.current;
        if (!ul) return;
        fitAbove(ul);
        if (hovered.current) return;
        const item = ul.querySelector<HTMLElement>(`[data-index="${active}"]`);
        if (item) keepInView(ul, item);
    }, [active, open, matches.length, size.rows]);
    // the window resized (or the pane): the list still fits above the text
    useEffect(() => {
        if (!open) return;
        const refit = (): void => {
            if (list.current) fitAbove(list.current);
        };
        window.addEventListener('resize', refit);
        return () => window.removeEventListener('resize', refit);
    }, [open]);
    // the selection added with 💬 or `C`: the text takes the focus, the caret at its end
    const { focusPending, onFocused } = props;
    useEffect(() => {
        if (!focusPending || !editor.current) return;
        editor.current.focusEnd();
        onFocused();
    }, [focusPending, onFocused]);

    // a reply just started (↩ on an AI turn or a message): the text takes the focus, the caret at its end
    const { replyFocus } = props;
    useEffect(() => {
        if (replyFocus !== 0) editor.current?.focusEnd();
    }, [replyFocus]);

    const pick = (c: Suggestion | undefined): void => {
        if (!c || !query) return;
        const mention: ComposerMention =
            c.kind === 'element'
                ? { kind: 'element', name: c.element.mention, target: c.element.target }
                : { kind: 'person', name: c.person.name, person: c.person.id };
        if (!mentionFits(value, mention))
            return setNotice(c.kind === 'element' ? tx.chat.targetsLimit(MAX_REQUEST_TARGETS) : tx.chat.mentionsLimit(MAX_REQUEST_MENTIONS));
        setNotice(undefined);
        editor.current?.pick(query, mention);
    };

    const send = async (): Promise<void> => {
        const revision = latestRevision(session.state);
        if (!revision || !canSend) return;
        setSending(true);
        try {
            await sessionApi.sendRequest({
                targets: value.chips.map((c) => ({ ...c.target, sourceRevision: revision.id })),
                body: value.text,
                ...(reply && { replyTo: replyTargetOf(reply) }),
                ...(value.people.length > 0 && { mentions: value.people }),
            });
            await composer.clear();
            onReplyDone();
            setChipsExpanded(false);
            setError(undefined);
            setNotice(undefined);
        } catch (e) {
            setError(failure(e));
        } finally {
            setSending(false);
        }
    };

    return (
        <div className="chat-composer">
            <ComposerResizer {...size} label={tx.chat.resizeInput} />
            {reply && (
                <div className="chat-reply-chip motion-pop motion-pop-up" role="status">
                    <span className="chat-reply-chip-text">↩ {replyingTo}</span>
                    <button className="chat-chip-remove" onClick={onReplyDone} aria-label={tx.chat.replies.cancel} data-tooltip={tx.chat.replies.cancel}>
                        <X size={12} aria-hidden />
                    </button>
                </div>
            )}
            <div className="chat-composer-input">
                {open && (
                    <ul className="chat-mentions motion-pop motion-pop-up" role="listbox" aria-label={tx.chat.mentionHint} ref={list}>
                        {matches.length === 0 && (
                            <li className="chat-mention-none muted">{query.sign === '#' ? tx.chat.mentionNoMatch : tx.chat.personNoMatch}</li>
                        )}
                        {matches.map((c, i) => (
                            <li
                                key={c.key}
                                data-index={i}
                                role="option"
                                aria-selected={i === active}
                                className={`chat-mention-option${c.kind === 'person' ? ' person' : ''}${i === active ? ' active' : ''}`}
                                onMouseDown={(e) => {
                                    // keeps the focus (and the caret) in the text
                                    e.preventDefault();
                                    pick(c);
                                }}
                                onMouseEnter={() => {
                                    hovered.current = true;
                                    setActive(i);
                                }}
                            >
                                {c.kind === 'element' ? (
                                    <>
                                        <span className="chat-mention-name">{c.element.name}</span>
                                        <span className={`chat-mention-kind lang-${c.element.kind.language}`}>{kindOf(c.element)}</span>
                                        <span className="chat-mention-where muted">
                                            {c.element.where} · {c.element.qualified}
                                        </span>
                                    </>
                                ) : (
                                    <PersonOption person={c.person} tx={tx} />
                                )}
                            </li>
                        ))}
                    </ul>
                )}
                <ComposerEditor
                    value={value}
                    onChange={(v) => composer.setValue(v)}
                    look={look}
                    onQuery={setQuery}
                    placeholder={tx.chat.placeholder}
                    rows={size.rows}
                    input={input}
                    api={editor}
                    onBlur={() => setDismissed(queryKey)}
                    onFocus={() => setDismissed(undefined)}
                    onKeyDown={(e) => {
                        const action = composerKey(e, open && matches.length > 0);
                        if (action === 'none') {
                            if (e.key === 'Escape' && open) setDismissed(queryKey);
                            // Esc on an empty text stops the reply
                            else if (e.key === 'Escape' && reply && value.text === '' && !e.isComposing) onReplyDone();
                            return false;
                        }
                        hovered.current = false;
                        if (action === 'next') setActive((a) => (a + 1) % matches.length);
                        else if (action === 'previous') setActive((a) => (a - 1 + matches.length) % matches.length);
                        else if (action === 'pick') pick(matches[active]);
                        else if (action === 'close') setDismissed(queryKey);
                        else void send();
                        return true;
                    }}
                />
            </div>
            <div className="chat-composer-bar">
                <ComposerChips
                    chips={value.chips}
                    expanded={chipsExpanded}
                    onExpanded={setChipsExpanded}
                    nameOf={nameOf}
                    shortOf={shortOf}
                    onRemove={(i) => composer.setValue(removeChip(value, i))}
                    tx={tx}
                />
                <div className="chat-composer-actions">
                    {/* the shortcut is in the tooltip */}
                    <button
                        className="chat-send"
                        disabled={!canSend}
                        onClick={() => void send()}
                        aria-label={sending ? tx.chat.sending : tx.chat.send}
                        data-tooltip={tx.chat.sendHint(mac ? '⌘+Enter' : 'Ctrl+Enter')}
                    >
                        <SendHorizontal size={15} aria-hidden />
                    </button>
                </div>
            </div>
            {notice && <p className="session-note">{notice}</p>}
            {(error ?? composer.error) && <p className="session-note session-error">{tx.error(error ?? composer.error ?? '')}</p>}
        </div>
    );
}
