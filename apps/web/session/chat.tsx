// The session's chat in the conversation pillar (ADR 0026, amendment: messages and apply), the same for everyone: who
// is here and what the agent is doing at a glance, then two views. チャット: one stream of every message (each is chat;
// the facilitator applies some: a run), one card per run with the runs that continue it (`card.tsx`), the revisions
// confirmed or restored, and the composer of a message about the selection. 履歴: the history of changes, the same
// cards. The facilitator's controls are in the stream itself: apply on a message (⤓, ▾ with a note, several selected
// with Shift/⌘), answer or pick an alternative on a card, cancel, and the menus of the cards and of the head.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
    ArrowDownToLine,
    ChevronDown,
    ChevronRight,
    CircleCheck,
    CircleHelp,
    CircleMinus,
    CircleSlash,
    CircleX,
    Clock,
    FileDiff,
    LoaderCircle,
    MessagesSquare,
    SendHorizontal,
    Ban,
    X,
    type LucideIcon,
} from 'lucide-react';
import type { ViewLocation } from '@domaintrail/collaboration/protocol';
import { useDismiss } from '../shared/layout';
import { useT } from '../i18n';
import { useChatActions } from './actions';
import { sessionApi } from './api';
import { RunCard } from './card';
import { AddReaction, ReactionRow, useMarking } from './mark-controls';
import { messageMarks, updatedCards, type MarkState } from './cards';
import { ChatProvider, useChat, type ChatContextValue, type Tx } from './chat-context';
import { ComposerResizer, useComposerSize } from './composer-resizer';
import { changeUnits, cutList, requestersOf, shownUnits, unitName, type ChangeUnit, type UnitOutcome } from './history';
import {
    addChips,
    composerKey,
    editText,
    insertMention,
    insertPerson,
    matchCandidates,
    matchPeople,
    MAX_REQUEST_MENTIONS,
    MAX_REQUEST_TARGETS,
    mentionQuery,
    removeChip,
    type MentionCandidate,
    type PersonCandidate,
} from './mentions';
import { useTargetNaming } from './naming';
import { CollabMenu, CollabSummaryDialog, openPeople, useCollabSummary } from './collab-menu';
import { Avatar, failure, MentionedText, TargetChips } from './parts';
import { parseReplyText, referenceText } from './references';
import { isReplyable, replyReference, replyTargets, type ReplyDraft } from './replies';
import { useRevisionTools } from './revisions';
import { latestRevision } from './state';
import {
    agentStatus,
    elapsed,
    isFacilitator,
    mentionablePeople,
    mentionsMe,
    participantNames,
    speakerName,
    streamItems,
    targetText,
    type AgentStatus,
    type StreamItem,
} from './stream';
import { dismiss, NO_DISMISSALS, suggestions, targetsToSend, type Dismissals } from './suggestions';
import { targetKey, type ModelTarget, type TargetDraft } from './targets';
import { continued, isMac } from './views';
import type { ViewScope, ViewTarget } from './views';
import type { ComposerDraft, SessionData } from './useSession';

type RequestJson = SessionData['state']['requests'][number];

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
    /** What the selection can be a request about: one target, or several for a selection of several shapes. */
    selectionTargets: readonly TargetDraft[];
    /** What `#` offers. */
    candidates: readonly MentionCandidate[];
    /** The composer is asked to take the focus (the selection was just confirmed with 💬 or `C`). */
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
    const live = session.status === 'live' && state.session.state === 'Open';
    const control = live && me.participant.role === 'facilitator';
    const status = agentStatus(state.runs);
    const items = useMemo(() => streamItems(state), [state]);
    const units = useMemo(() => changeUnits(state), [state]);
    const marks = useMemo(() => messageMarks(units), [units]);
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
    // the reply being written (to an AI turn): its chip above the composer; the composer takes the focus when it starts
    const [replyDraft, setReplyDraft] = useState<ReplyDraft | undefined>();
    const [replyFocus, setReplyFocus] = useState(0);
    const replies = useMemo(
        () => ({
            draft: replyDraft,
            start: (id: string): void => {
                const run = state.runs.find((r) => r.id === id);
                const ref = replyReference(units, id);
                if (!run || !ref || !isReplyable(run)) return;
                setReplyDraft({ run: id, name: ref.name });
                // the targets start with the replied run's requests' (editable as usual)
                composer.setValue(addChips(composer.value, replyTargets(run)).value);
                setView('chat');
                setReplyFocus((n) => n + 1);
            },
            cancel: (): void => setReplyDraft(undefined),
            referenceOf: (run: string) => replyReference(units, run),
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
    const root = useRef<HTMLDivElement | null>(null);
    // an item of the stream, scrolled to the middle and marked for a moment (from 履歴, a quote or a mark)
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

    // a person shown among the participants (a mention of them clicked): the collab menu opens at them
    const showPerson = useCallback((id: string): void => openPeople(id), []);

    const context: ChatContextValue = {
        session,
        tx,
        now,
        nameOf,
        onNavigate: props.onNavigate,
        control,
        actions,
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
                    control={control}
                    live={live}
                    units={units}
                    location={props.location}
                    viewScope={props.viewScope}
                    onOpenView={props.onOpenView}
                    onLeave={() => void leave()}
                    onClose={props.onClose}
                    tx={tx}
                />
                <div className="segmented chat-views" role="tablist" aria-label={tx.chat.tabsLabel}>
                    {(['chat', 'history'] as const).map((v) => (
                        <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
                            {tx.chat.tabs[v]}
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
                {/* both stay mounted, so that switching keeps the stream's scroll and the history's open units */}
                <div className="chat-view" role="tabpanel" hidden={view !== 'chat'}>
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
                            selectionTargets={props.selectionTargets}
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
                    <History units={units} />
                </div>
                {revisions.dialog}
            </div>
        </ChatProvider>
    );
}

function ChatHeader(props: {
    session: SessionData;
    status: AgentStatus;
    now: number;
    control: boolean;
    live: boolean;
    units: readonly ChangeUnit[];
    location: ViewLocation;
    viewScope: ViewScope;
    onOpenView: (target: ViewTarget) => void;
    onLeave: () => void;
    onClose: () => void;
    tx: Tx;
}) {
    const { session, status, tx } = props;
    const label =
        status.kind === 'running' ? tx.chat.status.running(elapsed(status.since, props.now)) : status.kind === 'idle' ? '' : tx.chat.status[status.kind];
    const runningRun = session.state.runs.find((r) => r.state === 'Running');
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
            {/* idle says nothing: only running, a question or a queued run shows */}
            <span className="chat-status-slot" aria-live="polite">
                {status.kind !== 'idle' && (
                    <span className={`chat-status status-${status.kind}`} data-tooltip={tx.chat.statusHint[status.kind]}>
                        <span className="chat-status-mark" aria-hidden>
                            {status.kind === 'running' ? '●' : status.kind === 'clarification' ? '?' : '…'}
                        </span>
                        {label}
                        {props.control && runningRun && <CancelButton run={runningRun.id} />}
                    </span>
                )}
            </span>
            <button className="icon-button" onClick={props.onClose} data-tooltip={tx.chat.close} aria-label={tx.chat.close}>
                <X size={16} aria-hidden />
            </button>
        </div>
    );
}

function CancelButton({ run }: { run: string }) {
    const { tx, actions } = useChat();
    return (
        <button className="run-card-cancel" onClick={() => void actions.cancel(run)} aria-label={tx.chat.cancelRun} data-tooltip={tx.chat.cancelRun}>
            <X size={11} aria-hidden />
        </button>
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
    const { tx, jump } = useChat();
    const ref = useRef<HTMLDivElement | null>(null);
    // follows the newest item only while the reader is at the bottom (true until they scroll up)
    const atBottom = useRef(true);
    const toBottom = (): void => {
        const el = ref.current;
        if (el && atBottom.current) el.scrollTop = el.scrollHeight;
    };
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
        atBottom.current = atBottomOf(el);
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
    const substantive = items.some((i) => i.kind !== 'session-start');
    return (
        <div className="chat-stream-wrap">
            <div className="chat-stream" ref={ref} onScroll={(e) => onScroll(e.currentTarget)}>
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
                {!substantive && <p className="chat-empty muted small">{tx.chat.empty}</p>}
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

const MARK_GLYPH: Record<MarkState, string> = {
    queued: '…',
    running: '●',
    clarification: '?',
    question: '?',
    done: '✓',
    partial: '◐',
    skipped: '–',
    declined: '⊘',
    failed: '✕',
    cancelled: '⊘',
};

/**
 * A message of the stream: who sent it (「あなた」 for my own, ファシリ by the facilitator's name), its targets and text; at its right end, the mark of its latest run (`✓`;
 * the card's name and the state in its tooltip, a click goes to the card) and, for the facilitator, how it reads and the tools to apply it.
 */
function MessageRow({ request: r, continues }: { request: RequestJson; continues: boolean }) {
    const { session, tx, nameOf, onNavigate, control, marks, classifications, selection, hovered, hover, actions, jump, showPerson } = useChat();
    const author = nameOf(r.author);
    // it mentions me: a faint background in my stream only (it asks for my attention)
    const toMe = mentionsMe(r, session.state, session.me.participant.id);
    const mine = r.author === session.me.participant.id;
    const facilitator = isFacilitator(session.state, r.author);
    const statuses = session.targets?.statuses[r.id];
    const mark = marks.get(r.id);
    const classification = classifications?.[r.id];
    const talk = classification?.kind === 'chat';
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
    const side = (
        <div className="chat-message-side">
            {control && classification && classification.kind !== 'unknown' && (
                <span
                    className={`chat-class class-${classification.kind}`}
                    data-tooltip={tx.chat.classificationHint(tx.chat.classification[classification.kind], classification.probability)}
                >
                    {tx.chat.classification[classification.kind]}
                </span>
            )}
            {mark && (
                <button
                    className={`chat-mark mark-${mark.state}`}
                    onClick={() => jump(`card:${mark.card}`)}
                    aria-label={tx.chat.markHint(mark.name, tx.chat.marks[mark.state])}
                    data-tooltip={tx.chat.markHint(mark.name, tx.chat.marks[mark.state])}
                >
                    {MARK_GLYPH[mark.state]}
                </button>
            )}
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
                            <ArrowDownToLine size={14} aria-hidden />
                        </button>
                    )}
                    <MessageMenu id={r.id} applied={mark !== undefined} talk={talk} onNote={() => setNote('')} />
                </span>
            )}
            {/* last: ☺+ at the right end of every row, messages and turns alike */}
            {!selection.active && <AddReaction target={{ kind: 'Message', request: r.id }} />}
        </div>
    );
    return (
        <div
            className={`chat-row${selected ? ' selected' : ''}${hovered === r.id ? ' paired' : ''}${talk ? ' talk' : ''}${toMe ? ' mentions-me' : ''}`}
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
                avatar={<Avatar id={r.author} name={author} />}
                who={speakerName(r.author, session.me.participant.id, nameOf, tx.chat.you)}
                badge={facilitator && <span className="chat-role">{tx.chat.facilitatorShort}</span>}
                at={r.sentAt}
                continues={continues}
                className={`chat-bubble-request${mine ? ' mine' : ''}`}
                side={side}
            >
                {r.replyTo !== undefined && <ReplyReferenceLine run={r.replyTo} />}
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
                        <ArrowDownToLine size={12} aria-hidden /> {tx.chat.applyNow}
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

/** A message's menu (the facilitator's): apply with a note (▾), choose it among several, apply it anyway. */
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
                <ChevronDown size={13} aria-hidden />
            </button>
            {open && (
                <div className="pane-menu-list" role="menu">
                    <button role="menuitem" onClick={pick(onNote)}>
                        {tx.chat.applyWithNote}
                    </button>
                    <button role="menuitem" onClick={pick(() => selection.start(id))}>
                        {tx.chat.selectMany}
                    </button>
                    {(applied || talk) && (
                        <button role="menuitem" onClick={pick(() => void actions.apply([id]))}>
                            {applied ? tx.chat.applyAgain : tx.chat.applyAnyway}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

/** The bar of the messages chosen to apply together, as one run. */
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
                <ArrowDownToLine size={12} aria-hidden /> {tx.chat.applySelected}
            </button>
            <button className="icon-button" onClick={() => selection.clear()} aria-label={tx.chat.clearSelection} data-tooltip={tx.chat.clearSelection}>
                <X size={14} aria-hidden />
            </button>
        </div>
    );
}

/** Right after applying: 取り消す, while the run is still queued. */
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
 * 履歴: the change units, newest first — the runs that changed files, or all of them (すべて). A unit's heading names
 * the chunk (its title, else its first message) with its time span, whose requests they were, how many runs and files,
 * and the files it changed (a link to compare them); opened, it shows the unit's card (compact) and a link to it in the chat. The card's own menu is the
 * place of the facilitator's actions on a unit.
 */
function History({ units: all }: { units: readonly ChangeUnit[] }) {
    const { tx } = useChat();
    const h = tx.chat.history;
    const [everything, setEverything] = useState(false);
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
    const units = shownUnits(all, everything);
    const toggle = (key: string): void => {
        const next = new Set(open);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        setOpen(next);
    };
    return (
        <div className="chat-history">
            <div className="chat-history-bar">
                <label className="check small" data-tooltip={h.allHint}>
                    <input type="checkbox" checked={everything} onChange={(e) => setEverything(e.target.checked)} />
                    {h.all}
                </label>
            </div>
            {units.length === 0 && <p className="chat-empty muted small">{everything ? h.emptyAll : h.empty}</p>}
            <ol className="chat-units">
                {units.map((unit) => (
                    <HistoryUnit key={unit.key} unit={unit} open={open.has(unit.key)} onToggle={() => toggle(unit.key)} />
                ))}
            </ol>
        </div>
    );
}

function HistoryUnit({ unit, open, onToggle }: { unit: ChangeUnit; open: boolean; onToggle: () => void }) {
    const { tx, nameOf, jump, revisions } = useChat();
    const h = tx.chat.history;
    const Icon = OUTCOME_ICONS[unit.outcome];
    const name = unitName(unit);
    const asked = requestersOf(unit.requesters.map(nameOf));
    const who =
        asked.kind === 'names' ? h.requesters(asked.names.join(h.separator)) : asked.kind === 'more' ? h.requestersMore(asked.first, asked.others) : undefined;
    const facts = [who, h.runs(unit.runs.length), unit.files !== undefined && unit.files > 0 ? h.files(unit.files) : undefined].filter((x) => x !== undefined);
    const changed = cutList(unit.paths ?? [], 3);
    const span = unit.span;
    // the card is mounted the first time the unit opens, and stays so that it folds away as it closes
    const [mounted, setMounted] = useState(open);
    if (open && !mounted) setMounted(true);
    return (
        <li className={`chat-unit outcome-${unit.outcome}${open ? ' open' : ''}`} data-unit={unit.key}>
            <button className="chat-unit-head" aria-expanded={open} aria-label={open ? h.collapse : h.expand} onClick={onToggle}>
                <span className="chat-unit-line">
                    <Icon size={14} className="chat-unit-icon" aria-label={h.outcomes[unit.outcome]} />
                    <span
                        className={`chat-unit-title${name.kind === 'request' ? ' untitled' : ''}`}
                        {...(name.kind === 'request' && { 'data-tooltip': h.untitledHint })}
                    >
                        {name.text}
                    </span>
                    <span className="chat-time">
                        <time dateTime={unit.start}>{time(unit.start)}</time>
                        {time(unit.at) !== time(unit.start) && (
                            <>
                                –<time dateTime={unit.at}>{time(unit.at)}</time>
                            </>
                        )}
                    </span>
                    <ChevronRight size={14} className="chat-unit-twisty" aria-hidden />
                </span>
                <span className="chat-unit-facts">{facts.join(' · ')}</span>
            </button>
            {/* what the chunk changed: its files (the page knows them, not the elements) after a file-diff icon, a link to
                compare the whole chunk */}
            {changed.shown.length > 0 && span && (
                <p className="chat-unit-changes" aria-label={h.changedFiles}>
                    <FileDiff size={13} className="chat-unit-changes-icon" aria-hidden />
                    <button
                        type="button"
                        className="chat-unit-changes-link"
                        onClick={() => revisions.compare(span.base, span.result)}
                        data-tooltip={`${h.changedFilesHint}: ${(unit.paths ?? []).join(', ')}`}
                    >
                        {changed.shown.map(baseName).join(h.separator)}
                    </button>
                    {changed.more > 0 && <span className="chat-unit-more"> {h.more(changed.more)}</span>}
                </p>
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

/** A path's last segment (`billing.dt` of `src/billing.dt`). */
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

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
                <Avatar id={person.id} name={person.name} {...(person.avatarUrl && { url: person.avatarUrl })} />
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
    selectionTargets: readonly TargetDraft[];
    candidates: readonly MentionCandidate[];
    focusPending: boolean;
    onFocused: () => void;
    /** The run the message replies to, while a reply is written; `replyFocus` changes when one starts. */
    reply: ReplyDraft | undefined;
    replyFocus: number;
    onReplyDone: () => void;
    tx: Tx;
}) {
    const { session, composer, selectionTargets, tx, reply, onReplyDone } = props;
    const t = useT();
    const naming = useTargetNaming();
    const value = composer.value;
    const input = useRef<HTMLTextAreaElement | null>(null);
    const size = useComposerSize(input);
    const [caret, setCaret] = useState(0);
    const [active, setActive] = useState(0);
    // the `#` or `@` whose candidates were closed with Esc: they stay closed until another one
    const [dismissed, setDismissed] = useState<number | undefined>();
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [notice, setNotice] = useState<string | undefined>();
    // the selection as dashed chips: sent as targets unless dismissed (until the selection changes); never stored
    const [dismissals, setDismissals] = useState<Dismissals>(NO_DISMISSALS);
    const suggested = suggestions(value, selectionTargets, dismissals);
    const query = mentionQuery(value.text, caret);
    // `@` offers the others in the session: with no one else (or no session), it offers nothing and stays closed
    const people = useMemo(() => mentionablePeople(session.state, session.peers, session.me), [session.state, session.peers, session.me]);
    const open = query !== undefined && query.start !== dismissed && (query.sign === '#' || people.length > 0);
    const matches: readonly Suggestion[] = !open
        ? []
        : query.sign === '#'
          ? matchCandidates(props.candidates, query.query).map((c) => ({ kind: 'element', key: c.key, element: c }))
          : matchPeople(people, query.query).map((p) => ({ kind: 'person', key: p.id, person: p }));
    const canSend = !sending && value.text.trim() !== '';
    const mac = isMac(typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent);
    const nameOf = (target: TargetDraft): string => targetText(target, tx.workspace, naming);
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
    const track = (): void => setCaret(input.current?.selectionStart ?? 0);
    // the caret after a pick: placed as soon as the picked text is rendered, before the next key is handled
    const pendingCaret = useRef<number | undefined>(undefined);
    useLayoutEffect(() => {
        const to = pendingCaret.current;
        if (to === undefined || !input.current) return;
        pendingCaret.current = undefined;
        input.current.focus();
        input.current.setSelectionRange(to, to);
        setCaret(to);
    });
    const moveCaret = (to: number): void => {
        pendingCaret.current = to;
    };
    // the selection confirmed with 💬 or `C`: the text takes the focus, the caret at its end
    const { focusPending, onFocused } = props;
    useEffect(() => {
        const el = input.current;
        if (!focusPending || !el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
        setCaret(el.value.length);
        onFocused();
    }, [focusPending, onFocused]);

    // a reply just started (↩ on an AI turn): the text takes the focus, the caret at its end
    const { replyFocus } = props;
    useEffect(() => {
        const el = input.current;
        if (replyFocus === 0 || !el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
        setCaret(el.value.length);
    }, [replyFocus]);

    const pick = (c: Suggestion | undefined): void => {
        if (!c || !query) return;
        const at = { start: query.start, end: caret };
        const picked =
            c.kind === 'element' ? insertMention(value, at, c.element.target, c.element.mention) : insertPerson(value, at, c.person.id, c.person.name);
        if (!picked) return setNotice(c.kind === 'element' ? tx.chat.targetsLimit(MAX_REQUEST_TARGETS) : tx.chat.mentionsLimit(MAX_REQUEST_MENTIONS));
        setNotice(undefined);
        composer.setValue(picked.value);
        moveCaret(picked.caret);
    };

    const send = async (): Promise<void> => {
        const revision = latestRevision(session.state);
        if (!revision || !canSend) return;
        setSending(true);
        try {
            const targets = targetsToSend(value, suggested);
            await sessionApi.sendRequest({
                targets: targets.map((t) => ({ ...t, sourceRevision: revision.id })),
                body: value.text,
                ...(reply && { replyTo: reply.run }),
                ...(value.people.length > 0 && { mentions: value.people }),
            });
            await composer.clear();
            onReplyDone();
            // what was just sent is not suggested again for the same selection
            setDismissals(suggested.targets.reduce((d, t) => dismiss(d, selectionTargets, t), dismissals));
            setError(undefined);
            setNotice(undefined);
        } catch (e) {
            setError(failure(e));
        } finally {
            setSending(false);
        }
    };

    const count = value.chips.length + suggested.targets.length;

    return (
        <div className="chat-composer">
            <ComposerResizer {...size} label={tx.chat.resizeInput} />
            {reply && (
                <div className="chat-reply-chip motion-pop motion-pop-up" role="status">
                    <span className="chat-reply-chip-text">↩ {tx.chat.replies.replyingTo(reply.name)}</span>
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
                <textarea
                    ref={input}
                    className="session-text chat-input"
                    rows={size.rows}
                    maxLength={10_000}
                    placeholder={tx.chat.placeholder}
                    value={value.text}
                    onChange={(e) => {
                        composer.setValue(editText(value, e.target.value));
                        setCaret(e.target.selectionStart);
                    }}
                    onSelect={track}
                    onClick={track}
                    onBlur={() => setDismissed(query?.start)}
                    onFocus={() => setDismissed(undefined)}
                    onKeyDown={(e) => {
                        const action = composerKey(e.nativeEvent, open && matches.length > 0);
                        if (action === 'none') {
                            if (e.key === 'Escape' && open) setDismissed(query.start);
                            // Esc on an empty text stops the reply
                            else if (e.key === 'Escape' && reply && value.text === '' && !e.nativeEvent.isComposing) onReplyDone();
                            return;
                        }
                        e.preventDefault();
                        hovered.current = false;
                        if (action === 'next') setActive((a) => (a + 1) % matches.length);
                        else if (action === 'previous') setActive((a) => (a - 1 + matches.length) % matches.length);
                        else if (action === 'pick') pick(matches[active]);
                        else if (action === 'close') setDismissed(query?.start);
                        else void send();
                    }}
                />
            </div>
            <div className="chat-composer-bar">
                <div className="chat-chips" aria-label={tx.chat.target}>
                    {value.chips.map((c, i) => (
                        <span
                            key={targetKey(c.target.target)}
                            className={`chat-chip kind-${c.target.target.kind}`}
                            data-tooltip={`${nameOf(c.target)}\n${targetKey(c.target.target)}`}
                        >
                            <span className="chat-chip-number">{i + 1}</span>
                            <span className="chat-chip-name">{nameOf(c.target)}</span>
                            <button
                                className="chat-chip-remove"
                                aria-label={tx.chat.removeTarget(nameOf(c.target))}
                                onClick={() => composer.setValue(removeChip(value, i))}
                            >
                                <X size={12} aria-hidden />
                            </button>
                        </span>
                    ))}
                    {suggested.targets.map((s, i) => (
                        <span
                            key={`suggested:${targetKey(s.target)}`}
                            className={`chat-chip suggested kind-${s.target.kind}`}
                            role="note"
                            aria-label={tx.chat.suggested(nameOf(s))}
                            data-tooltip={tx.chat.suggested(nameOf(s))}
                        >
                            <span className="chat-chip-number" aria-hidden>
                                {value.chips.length + i + 1}
                            </span>
                            <span className="chat-chip-name">{nameOf(s)}</span>
                            <button
                                className="chat-chip-remove"
                                aria-label={tx.chat.dismissSuggestion(nameOf(s))}
                                onClick={() => setDismissals(dismiss(dismissals, selectionTargets, s))}
                            >
                                <X size={12} aria-hidden />
                            </button>
                        </span>
                    ))}
                    {count > 0 && <span className="muted small">{tx.chat.targetCount(count, MAX_REQUEST_TARGETS)}</span>}
                    {suggested.overLimit > 0 && <span className="muted small">{tx.chat.targetsLimit(MAX_REQUEST_TARGETS)}</span>}
                </div>
                <div className="chat-composer-actions">
                    {/* the shortcut, only while there is something to send */}
                    {value.text.trim() !== '' && (
                        <kbd className="chat-shortcut" aria-hidden>
                            {mac ? '⌘↵' : 'Ctrl↵'}
                        </kbd>
                    )}
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
