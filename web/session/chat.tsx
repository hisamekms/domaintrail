// The session's chat in the conversation pillar (ADR 0026), the same for everyone: who is here and what the agent is
// doing at a glance, then two views: チャット — the main stream of what the facilitator queued and what followed
// (`stream.ts`), the requests still waiting for approval, and the composer of a request about the selection — and 履歴,
// the history of changes (`history.ts`). People talk in their meeting; nothing here is a chat between them: what they
// send are requests.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
    Ban,
    Bot,
    ChevronDown,
    ChevronRight,
    CircleCheck,
    CircleHelp,
    CircleMinus,
    CircleSlash,
    CircleX,
    Clock,
    LoaderCircle,
    LogOut,
    MessagesSquare,
    Play,
    Reply,
    SendHorizontal,
    X,
    type LucideIcon,
} from 'lucide-react';
import type { ViewLocation } from '@domaintrail/collaboration/protocol';
import { useT, type Messages } from '../i18n';
import { sessionApi } from './api';
import { Avatar, failure, MentionedText, TargetChips } from './parts';
import { ReplyDetails, ReplyFacts, ReplyQuestions, ReplyText } from './reply';
import { latestRevision } from './state';
import {
    agentStatus,
    elapsed,
    oneLine,
    participantNames,
    pendingRequests,
    streamItems,
    targetsSummary,
    targetText,
    type AgentMessage,
    type AgentStatus,
    type PendingRequest,
    type StreamItem,
} from './stream';
import { useTargetNaming } from './naming';
import { changeUnits, shownUnits, type ChangeUnit, type UnitOutcome } from './history';
import {
    bodyText,
    composerKey,
    editText,
    insertMention,
    matchCandidates,
    MAX_REQUEST_TARGETS,
    mentionQuery,
    removeChip,
    type MentionCandidate,
} from './mentions';
import { ParticipantsButton } from './participants';
import { dismiss, NO_DISMISSALS, suggestions, targetsToSend, type Dismissals } from './suggestions';
import { targetKey, type ModelTarget, type TargetDraft } from './targets';
import { continued, isMac } from './views';
import type { ViewScope, ViewTarget } from './views';
import type { ComposerDraft, SessionData } from './useSession';

type Tx = Messages['session'];
type FrozenRequest = Extract<StreamItem, { kind: 'queued' }>['requests'][number];

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
    /** What `@` offers. */
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
    const status = agentStatus(state.runs);
    const items = streamItems(state);
    const running = items.some((i) => i.kind === 'agent' && i.message.kind === 'running');
    const now = useNow(status.kind === 'running' || running);
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
    // the selection confirmed for a request: the composer is in the chat
    useEffect(() => {
        if (focusPending) setView('chat');
    }, [focusPending]);
    const root = useRef<HTMLDivElement | null>(null);
    // 履歴's チャットで見る: the run's first line in the stream, scrolled to the top and marked for a moment
    const showInChat = (run: string): void => {
        setView('chat');
        requestAnimationFrame(() => {
            const el = root.current?.querySelector<HTMLElement>(`.chat-stream [data-item="queued:${run}"]`);
            if (!el) return;
            el.scrollIntoView({ block: 'start', behavior: 'smooth' });
            el.classList.add('chat-flash');
            setTimeout(() => el.classList.remove('chat-flash'), 1600);
        });
    };

    return (
        <div className="session-chat" ref={root}>
            <ChatHeader
                session={session}
                status={status}
                now={now}
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
            {(session.status === 'closed' || state.session.state === 'Closed') && <p className="session-note chat-notice">{tx.closed}</p>}
            {session.error && <p className="session-note chat-notice session-error">{tx.error(session.error)}</p>}
            {leaveError && <p className="session-note chat-notice session-error">{tx.error(leaveError)}</p>}
            {/* both stay mounted, so that switching keeps the stream's scroll and the history's open units */}
            <div className="chat-view" role="tabpanel" hidden={view !== 'chat'}>
                <Stream session={session} items={items} now={now} nameOf={nameOf} onNavigate={props.onNavigate} tx={tx} />
                <Pending session={session} live={live} nameOf={nameOf} tx={tx} />
                {live && (
                    <Composer
                        session={session}
                        composer={composer}
                        selectionTargets={props.selectionTargets}
                        candidates={props.candidates}
                        focusPending={focusPending}
                        onFocused={props.onFocused}
                        tx={tx}
                    />
                )}
            </div>
            <div className="chat-view" role="tabpanel" hidden={view !== 'history'}>
                <History session={session} items={items} now={now} nameOf={nameOf} onNavigate={props.onNavigate} onShowInChat={showInChat} tx={tx} />
            </div>
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
 * 履歴: the change units, newest first — the runs that changed files, or all of them (すべて). A unit's row says what
 * the AI did; opened, it shows the unit's lines of the stream (the requests, the AI's question, the facilitator's
 * note, the result) and a link to them in the chat. `actions` is the place of the facilitator's actions on a unit
 * (none yet).
 */
function History(props: {
    session: SessionData;
    items: StreamItem[];
    now: number;
    nameOf: (id: string) => string;
    onNavigate: (target: ModelTarget) => void;
    onShowInChat: (run: string) => void;
    actions?: (unit: ChangeUnit) => ReactNode;
    tx: Tx;
}) {
    const { session, tx } = props;
    const h = tx.chat.history;
    const [all, setAll] = useState(false);
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
    const units = shownUnits(changeUnits(session.state), all);
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
                    <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
                    {h.all}
                </label>
            </div>
            {units.length === 0 && <p className="chat-empty muted small">{all ? h.emptyAll : h.empty}</p>}
            <ol className="chat-units">
                {units.map((unit) => (
                    <HistoryUnit key={unit.key} unit={unit} open={open.has(unit.key)} onToggle={() => toggle(unit.key)} {...props} />
                ))}
            </ol>
        </div>
    );
}

function HistoryUnit(props: {
    unit: ChangeUnit;
    open: boolean;
    onToggle: () => void;
    session: SessionData;
    items: StreamItem[];
    now: number;
    nameOf: (id: string) => string;
    onNavigate: (target: ModelTarget) => void;
    onShowInChat: (run: string) => void;
    actions?: (unit: ChangeUnit) => ReactNode;
    tx: Tx;
}) {
    const { unit, open, nameOf, tx } = props;
    const h = tx.chat.history;
    const first = unit.runs[0];
    const last = unit.runs[unit.runs.length - 1];
    const Icon = OUTCOME_ICONS[unit.outcome];
    const requesters = unit.requesters.map(nameOf).join(', ');
    const summary = unit.summary ?? fallbackSummary(last.run, nameOf, tx);
    const ids = new Set(unit.runs.map((r) => r.run.id));
    const items = props.items.filter((i) => (i.kind === 'queued' || i.kind === 'note' || i.kind === 'agent') && ids.has(i.key.slice(i.key.indexOf(':') + 1)));
    const rows = open ? streamRows(items, { now: props.now, session: props.session, nameOf, onNavigate: props.onNavigate, tx }) : [];
    const follows = continued(rows.map((r) => r.author));
    return (
        <li className={`chat-unit outcome-${unit.outcome}${open ? ' open' : ''}`} data-unit={unit.key}>
            <button className="chat-unit-head" aria-expanded={open} aria-label={open ? h.collapse : h.expand} onClick={props.onToggle}>
                <span className="chat-unit-line">
                    <Icon size={14} className="chat-unit-icon" aria-label={h.outcomes[unit.outcome]} />
                    <span className="chat-unit-runs">{h.runs(first.number, last.number)}</span>
                    {unit.files !== undefined && unit.files > 0 && <span className="chat-unit-files">{h.files(unit.files)}</span>}
                    <time className="chat-time" dateTime={unit.at}>
                        {time(unit.at)}
                    </time>
                    {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                </span>
                {/* opened, the result's own bubble says it */}
                {summary && !open && (
                    <span className="chat-unit-summary">
                        {unit.summary !== undefined ? <ReplyText text={unit.summary} onNavigate={props.onNavigate} /> : summary}
                    </span>
                )}
                {requesters && <span className="chat-unit-who muted">{h.requesters(requesters)}</span>}
            </button>
            {open && (
                <div className="chat-unit-body">
                    <ol className="chat-items compact">
                        {rows.map((row, i) => (
                            <li key={row.key} className={`chat-item chat-${row.kind}${follows[i] ? ' continued' : ''}`}>
                                {row.render(follows[i])}
                            </li>
                        ))}
                    </ol>
                    <div className="chat-unit-actions">
                        {props.actions?.(unit)}
                        <button className="chat-small" onClick={() => props.onShowInChat(first.run.id)}>
                            <MessagesSquare size={12} aria-hidden /> {h.showInChat}
                        </button>
                    </div>
                </div>
            )}
        </li>
    );
}

/** What a unit's row says when the AI said nothing (no structured reply): the run's state, as the chat says it. */
function fallbackSummary(run: ChangeUnit['runs'][number]['run'], nameOf: (id: string) => string, tx: Tx): string | undefined {
    const says = tx.chat.agentSays;
    switch (run.state) {
        case 'Completed':
            return run.changed ? says.completedChanged(undefined) : says.completedUnchanged;
        case 'Failed':
            return tx.failureReasons[run.reason];
        case 'Cancelled':
            return says.cancelled(nameOf(run.cancelledBy));
        case 'Queued':
            return says.queued;
        default:
            return undefined;
    }
}

/**
 * The floating button opening the conversation while it is closed, with the agent's state as a mark (a spinner while
 * it runs, `?` while it waits for an answer) and how many messages came since the chat was last shown (else how many
 * requests await approval).
 */
export function ChatLauncher(props: { status: AgentStatus; unread: number; pending: number; onOpen: () => void }) {
    const t = useT();
    const tx = t.session;
    const { status, unread, pending } = props;
    const label = tx.chat.launcher(unread, pending);
    return (
        <button className={`chat-launcher status-${status.kind}`} onClick={props.onOpen} aria-label={label} data-tooltip={label}>
            <MessagesSquare size={20} aria-hidden />
            {status.kind === 'running' && <LoaderCircle size={14} className="chat-launcher-mark spin" aria-hidden />}
            {status.kind === 'clarification' && (
                <span className="chat-launcher-mark question" aria-hidden>
                    ?
                </span>
            )}
            {unread > 0 ? (
                <span className="chat-launcher-count" aria-hidden>
                    {unread}
                </span>
            ) : (
                pending > 0 && (
                    <span className="chat-launcher-count pending" aria-hidden>
                        {pending}
                    </span>
                )
            )}
        </button>
    );
}

function ChatHeader(props: {
    session: SessionData;
    status: AgentStatus;
    now: number;
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
    return (
        <div className="chat-header">
            <ParticipantsButton session={session} location={props.location} scope={props.viewScope} onOpenView={props.onOpenView} />
            {/* idle says nothing: only running, a question or a queued run shows */}
            <span className="chat-status-slot" aria-live="polite">
                {status.kind !== 'idle' && (
                    <span className={`chat-status status-${status.kind}`} data-tooltip={tx.chat.statusHint[status.kind]}>
                        <span className="chat-status-mark" aria-hidden>
                            {status.kind === 'running' ? '●' : status.kind === 'clarification' ? '?' : '…'}
                        </span>
                        {label}
                    </span>
                )}
            </span>
            {session.status !== 'signed-out' && (
                <button className="icon-button" onClick={props.onLeave} data-tooltip={tx.leave} aria-label={tx.leave}>
                    <LogOut size={15} aria-hidden />
                </button>
            )}
            <button className="icon-button" onClick={props.onClose} data-tooltip={tx.chat.close} aria-label={tx.chat.close}>
                <X size={16} aria-hidden />
            </button>
        </div>
    );
}

/** Whether a scrolled element is at its bottom (within a few pixels). */
const atBottomOf = (el: HTMLElement): boolean => el.scrollHeight - el.scrollTop - el.clientHeight < 24;

function Stream(props: {
    session: SessionData;
    items: StreamItem[];
    now: number;
    nameOf: (id: string) => string;
    onNavigate: (target: ModelTarget) => void;
    tx: Tx;
}) {
    const { session, items, now, nameOf, tx } = props;
    const ref = useRef<HTMLDivElement | null>(null);
    // follows the newest item only while the reader is at the bottom (true until they scroll up)
    const atBottom = useRef(true);
    const toBottom = (): void => {
        const el = ref.current;
        if (el && atBottom.current) el.scrollTop = el.scrollHeight;
    };
    const signature = items.map((i) => `${i.key}@${i.at}`).join('|');
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
    const rows = streamRows(items, { now, session, nameOf, onNavigate: props.onNavigate, tx });
    const follows = continued(rows.map((r) => r.author));
    const substantive = items.some((i) => i.kind !== 'session-start');
    return (
        <div
            className="chat-stream"
            ref={ref}
            onScroll={(e) => {
                atBottom.current = atBottomOf(e.currentTarget);
            }}
        >
            <ol className="chat-items">
                {rows.map((row, i) => (
                    <li key={row.key} className={`chat-item chat-${row.kind}${follows[i] ? ' continued' : ''}`} data-item={row.key}>
                        {row.render(follows[i])}
                    </li>
                ))}
            </ol>
            {!substantive && <p className="chat-empty muted small">{tx.chat.empty}</p>}
        </div>
    );
}

/** A line of the stream: a divider, or a bubble of an author (`agent` for the AI) that may continue the one before. */
interface Row {
    readonly key: string;
    readonly kind: string;
    readonly author: string | undefined;
    readonly render: (continues: boolean) => ReactNode;
}

function streamRows(
    items: readonly StreamItem[],
    ctx: { now: number; session: SessionData; nameOf: (id: string) => string; onNavigate: (target: ModelTarget) => void; tx: Tx },
): Row[] {
    const { nameOf, tx } = ctx;
    const divider = (item: StreamItem, content: ReactNode): Row => ({
        key: item.key,
        kind: item.kind,
        author: undefined,
        render: () => <Divider at={item.at}>{content}</Divider>,
    });
    return items.flatMap((item): Row[] => {
        switch (item.kind) {
            case 'session-start':
                return [divider(item, tx.chat.started)];
            case 'confirmed':
                return [divider(item, tx.chat.confirmed(nameOf(item.by), item.revision))];
            case 'restored':
                return [divider(item, tx.chat.restored(item.from, item.revision))];
            case 'queued':
                return [
                    divider(
                        item,
                        <span data-tooltip={tx.chat.queued(nameOf(item.by))}>
                            <Play size={10} className="chat-run-play" aria-label={tx.chat.run(item.run)} /> {item.run} · {nameOf(item.by)}
                        </span>,
                    ),
                    ...item.requests.map((r): Row => ({
                        key: `${item.key}:${r.request}`,
                        kind: 'request',
                        author: r.author,
                        render: (continues) => (
                            <RequestBubble request={r} continues={continues} session={ctx.session} nameOf={nameOf} onNavigate={ctx.onNavigate} tx={tx} />
                        ),
                    })),
                ];
            case 'note':
                return [
                    {
                        key: item.key,
                        kind: item.kind,
                        author: item.by,
                        render: (continues) => (
                            <Bubble
                                avatar={<Avatar id={item.by} name={nameOf(item.by)} />}
                                who={nameOf(item.by)}
                                badge={<span className="chat-role">{tx.chat.facilitator}</span>}
                                at={item.at}
                                continues={continues}
                                className="chat-bubble-facilitator"
                            >
                                <div className="chat-with-icon">
                                    <Reply size={14} className="chat-icon" aria-label={tx.chat.note} />
                                    <Clamped tx={tx}>{item.text}</Clamped>
                                </div>
                            </Bubble>
                        ),
                    },
                ];
            case 'agent':
                return [
                    {
                        key: item.key,
                        kind: item.kind,
                        author: 'agent',
                        render: (continues) => (
                            <AgentBubble
                                message={item.message}
                                run={item.run}
                                at={item.at}
                                now={ctx.now}
                                continues={continues}
                                nameOf={nameOf}
                                onNavigate={ctx.onNavigate}
                                tx={tx}
                            />
                        ),
                    },
                ];
        }
    });
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
    children: ReactNode;
}) {
    if (props.continues)
        return (
            <div className={`chat-message continued ${props.className ?? ''}`} {...(props.at && { title: time(props.at) })}>
                <span className="chat-avatar-space" aria-hidden />
                <div className="chat-message-main">
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

function RequestBubble(props: {
    request: FrozenRequest;
    continues: boolean;
    session: SessionData;
    nameOf: (id: string) => string;
    onNavigate: (t: ModelTarget) => void;
    tx: Tx;
}) {
    const { request: r, session, tx } = props;
    const author = props.nameOf(r.author);
    const mine = r.author === session.me.participant.id;
    const sentAt = session.state.requests.find((q) => q.id === r.request)?.sentAt;
    const statuses = session.targets?.statuses[r.request];
    return (
        <Bubble
            avatar={<Avatar id={r.author} name={author} />}
            who={author}
            at={sentAt}
            continues={props.continues}
            className={`chat-bubble-request${mine ? ' mine' : ''}`}
        >
            <TargetChips targets={r.targets} statuses={statuses} onNavigate={props.onNavigate} tx={tx} />
            <Clamped tx={tx}>
                <MentionedText body={r.body} targets={r.targets} statuses={statuses} onNavigate={props.onNavigate} tx={tx} />
            </Clamped>
        </Bubble>
    );
}

function AgentBubble(props: {
    message: AgentMessage;
    run: number;
    at: string;
    now: number;
    continues: boolean;
    nameOf: (id: string) => string;
    onNavigate: (t: ModelTarget) => void;
    tx: Tx;
}) {
    const { message: m, tx } = props;
    const says = tx.chat.agentSays;
    let body: ReactNode;
    switch (m.kind) {
        case 'queued':
            body = <p className="chat-text muted">{says.queued}</p>;
            break;
        case 'running':
            body = (
                <p className="chat-text">
                    <span className="chat-pulse" aria-hidden />
                    {says.running(elapsed(m.since, props.now))}
                </p>
            );
            break;
        case 'clarification':
            body = m.reply ? (
                <>
                    {m.files !== undefined && m.files > 0 && <p className="reply-facts">{tx.chat.reply.applied(m.files)}</p>}
                    <p className="chat-text reply-summary">
                        <ReplyText text={m.reply.summary} onNavigate={props.onNavigate} />
                    </p>
                    <ReplyQuestions reply={m.reply} scope={`run-${props.run}`} nameOf={props.nameOf} onNavigate={props.onNavigate} tx={tx} />
                </>
            ) : (
                <div className="chat-with-icon">
                    <CircleHelp size={16} className="chat-icon" aria-label={says.clarification} />
                    <p className="chat-question">{m.question}</p>
                </div>
            );
            break;
        case 'completed':
            body = m.reply ? (
                <>
                    <ReplyFacts files={m.files} changed={m.changed} tx={tx} />
                    <ReplyDetails reply={m.reply} nameOf={props.nameOf} onNavigate={props.onNavigate} tx={tx} />
                </>
            ) : (
                <p className="chat-text">{m.changed ? says.completedChanged(m.result) : says.completedUnchanged}</p>
            );
            break;
        case 'declined':
            body = (
                <>
                    {m.files !== undefined && m.files > 0 && <p className="reply-facts">{tx.chat.reply.applied(m.files)}</p>}
                    <div className="chat-with-icon">
                        <Ban size={14} className="chat-icon" aria-label={tx.chat.reply.declined} />
                        <p className="chat-text">
                            <ReplyText text={m.reply.summary} onNavigate={props.onNavigate} />
                        </p>
                    </div>
                    <ReplyDetails reply={m.reply} summary={false} nameOf={props.nameOf} onNavigate={props.onNavigate} tx={tx} />
                </>
            );
            break;
        case 'failed':
            body = (
                <div className="chat-with-icon session-error">
                    <CircleX size={14} className="chat-icon" aria-label={says.failedLabel} />
                    <p className="chat-text">{tx.failureReasons[m.reason]}</p>
                </div>
            );
            break;
        case 'cancelled':
            body = <p className="chat-text muted">{says.cancelled(props.nameOf(m.by))}</p>;
            break;
    }
    return (
        <Bubble
            avatar={
                <span className="session-avatar chat-agent-avatar" aria-hidden>
                    <Bot size={15} />
                </span>
            }
            who={tx.chat.agent}
            meta={<span className="chat-run-tag">{tx.chat.run(props.run)}</span>}
            at={props.at}
            continues={props.continues}
            className={`chat-bubble-agent agent-${m.kind}`}
        >
            {body}
        </Bubble>
    );
}

function PendingRow({
    p,
    live,
    nameOf,
    tx,
    onError,
}: {
    p: PendingRequest;
    live: boolean;
    nameOf: (id: string) => string;
    tx: Tx;
    onError: (e: string | undefined) => void;
}) {
    const r = p.request;
    const naming = useTargetNaming();
    const target = targetsSummary(r.targets, tx.workspace, naming);
    const body = oneLine(bodyText(r.body, r.targets.length));
    return (
        <li className={`chat-pending-row${p.mine ? ' mine' : ''}`} data-request={r.id} title={`${nameOf(r.author)} · ${target}\n${r.body}`}>
            <span className="chat-pending-text">
                <span className="chat-pending-author">{nameOf(r.author)}</span>
                <span className="muted"> · </span>
                <span className="chat-pending-target">{target}</span>
                <span className="muted"> · </span>
                {body}
            </span>
            {p.mine && live && (
                <button
                    className="icon-button chat-dismiss"
                    aria-label={tx.dismiss}
                    data-tooltip={tx.dismiss}
                    onClick={(e) => {
                        e.stopPropagation();
                        sessionApi.dismissRequest(r.id).then(
                            () => onError(undefined),
                            (err: unknown) => onError(failure(err)),
                        );
                    }}
                >
                    <Ban size={13} aria-hidden />
                </button>
            )}
        </li>
    );
}

function Pending({ session, live, nameOf, tx }: { session: SessionData; live: boolean; nameOf: (id: string) => string; tx: Tx }) {
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const pending = pendingRequests(session.state, session.me.participant.id);
    if (pending.all.length === 0) return error ? <p className="session-note chat-notice session-error">{tx.error(error)}</p> : null;
    const rows = open ? pending.all : pending.preview;
    return (
        <section className={`chat-pending${open ? ' open' : ''}`}>
            <button
                className="chat-pending-head"
                aria-expanded={open}
                aria-label={tx.chat.pendingLabel(pending.all.length)}
                onClick={() => setOpen(!open)}
                data-tooltip={tx.chat.pendingHint}
            >
                <span>{tx.chat.pending}</span>
                <span className="chat-pending-count">{pending.all.length}</span>
                {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            </button>
            <ul className="chat-pending-list">
                {rows.map((p) => (
                    <PendingRow key={p.request.id} p={p} live={live} nameOf={nameOf} tx={tx} onError={setError} />
                ))}
            </ul>
            {!open && pending.more > 0 && (
                <a
                    className="chat-pending-more"
                    onClick={() => setOpen(true)}
                    aria-label={tx.chat.others(pending.more)}
                    data-tooltip={tx.chat.others(pending.more)}
                >
                    +{pending.more}
                </a>
            )}
            {error && <p className="session-note chat-notice session-error">{tx.error(error)}</p>}
        </section>
    );
}

function Composer(props: {
    session: SessionData;
    composer: ComposerDraft;
    selectionTargets: readonly TargetDraft[];
    candidates: readonly MentionCandidate[];
    focusPending: boolean;
    onFocused: () => void;
    tx: Tx;
}) {
    const { session, composer, selectionTargets, tx } = props;
    const t = useT();
    const naming = useTargetNaming();
    const value = composer.value;
    const input = useRef<HTMLTextAreaElement | null>(null);
    const [caret, setCaret] = useState(0);
    const [active, setActive] = useState(0);
    // the `@` whose candidates were closed with Esc: they stay closed until another `@`
    const [dismissed, setDismissed] = useState<number | undefined>();
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [notice, setNotice] = useState<string | undefined>();
    // the selection as dashed chips: sent as targets unless dismissed (until the selection changes); never stored
    const [dismissals, setDismissals] = useState<Dismissals>(NO_DISMISSALS);
    const suggested = suggestions(value, selectionTargets, dismissals);
    const query = mentionQuery(value.text, caret);
    const open = query !== undefined && query.start !== dismissed;
    const matches = open ? matchCandidates(props.candidates, query.query) : [];
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
        if (!ul || hovered.current) return;
        const item = ul.querySelector<HTMLElement>(`[data-index="${active}"]`);
        if (item) keepInView(ul, item);
    }, [active, open, matches.length]);
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

    const pick = (c: MentionCandidate | undefined): void => {
        if (!c || !query) return;
        const picked = insertMention(value, { start: query.start, end: caret }, c.target, c.mention);
        if (!picked) return setNotice(tx.chat.targetsLimit(MAX_REQUEST_TARGETS));
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
            await sessionApi.sendRequest({ targets: targets.map((t) => ({ ...t, sourceRevision: revision.id })), body: value.text });
            await composer.clear();
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
            <div className="chat-composer-input">
                {open && (
                    <ul className="chat-mentions" role="listbox" aria-label={tx.chat.mentionHint} ref={list}>
                        {matches.length === 0 && <li className="chat-mention-none muted">{tx.chat.mentionNoMatch}</li>}
                        {matches.map((c, i) => (
                            <li
                                key={c.key}
                                data-index={i}
                                role="option"
                                aria-selected={i === active}
                                className={`chat-mention-option${i === active ? ' active' : ''}`}
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
                                <span className="chat-mention-name">{c.name}</span>
                                <span className={`chat-mention-kind lang-${c.kind.language}`}>{kindOf(c)}</span>
                                <span className="chat-mention-where muted">
                                    {c.where} · {c.qualified}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
                <textarea
                    ref={input}
                    className="session-text chat-input"
                    rows={3}
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
                    {count === 0 ? (
                        <span className="chat-target kind-Workspace" data-tooltip={tx.chat.noTargets}>
                            {tx.workspace}
                        </span>
                    ) : (
                        value.chips.map((c, i) => (
                            <span
                                key={targetKey(c.target.target)}
                                className={`chat-chip kind-${c.target.target.kind}`}
                                data-tooltip={targetKey(c.target.target)}
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
                        ))
                    )}
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
