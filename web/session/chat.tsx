// The session's chat in the left pane (ADR 0026), the same for everyone: who is here and what the agent is doing at a
// glance, the main stream of what the facilitator queued and what followed (`stream.ts`), the requests still waiting
// for approval, and the composer of a request about the selection. People talk in their meeting; nothing here is a
// chat between them: what they send are requests.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Ban, Bot, ChevronDown, ChevronRight, CircleHelp, CircleX, LogOut, PanelLeftClose, Play, Plus, Reply, SendHorizontal, X } from 'lucide-react';
import type { ViewLocation } from '@domaintrail/collaboration/protocol';
import { useT, type Messages } from '../i18n';
import { sessionApi } from './api';
import { Avatar, failure, MentionedText, TargetChips } from './parts';
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
import {
    addChips,
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
import { targetKey, type ModelTarget, type TargetDraft } from './targets';
import { continued, isMac } from './views';
import type { ViewScope, ViewTarget } from './views';
import type { ComposerDraft, SessionData } from './useSession';

type Tx = Messages['session'];
type FrozenRequest = Extract<StreamItem, { kind: 'queued' }>['requests'][number];

const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
    onNavigate: (target: ModelTarget) => void;
    /** This page's location (to tell who is on the same view). */
    location: ViewLocation;
    /** Opens the view another participant is on. */
    onOpenView: (target: ViewTarget) => void;
    /** What view names are made of, and which views this page can open. */
    viewScope: ViewScope;
    onClose: () => void;
}) {
    const { session, composer } = props;
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

    return (
        <div className="session-chat">
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
            {session.status === 'signed-out' && <p className="session-note chat-notice">{tx.signedOut}</p>}
            {(session.status === 'closed' || state.session.state === 'Closed') && <p className="session-note chat-notice">{tx.closed}</p>}
            {session.error && <p className="session-note chat-notice session-error">{tx.error(session.error)}</p>}
            {leaveError && <p className="session-note chat-notice session-error">{tx.error(leaveError)}</p>}
            <Stream session={session} items={items} now={now} nameOf={nameOf} onNavigate={props.onNavigate} tx={tx} />
            <Pending session={session} live={live} nameOf={nameOf} tx={tx} />
            {live && <Composer session={session} composer={composer} selectionTargets={props.selectionTargets} candidates={props.candidates} tx={tx} />}
        </div>
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
                <PanelLeftClose size={16} aria-hidden />
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
                            <AgentBubble message={item.message} run={item.run} at={item.at} now={ctx.now} continues={continues} nameOf={nameOf} tx={tx} />
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

function AgentBubble(props: { message: AgentMessage; run: number; at: string; now: number; continues: boolean; nameOf: (id: string) => string; tx: Tx }) {
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
            body = (
                <div className="chat-with-icon">
                    <CircleHelp size={16} className="chat-icon" aria-label={says.clarification} />
                    <p className="chat-question">{m.question}</p>
                </div>
            );
            break;
        case 'completed':
            body = <p className="chat-text">{m.changed ? says.completedChanged(m.result) : says.completedUnchanged}</p>;
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
            await sessionApi.sendRequest({ targets: value.chips.map((c) => ({ ...c.target, sourceRevision: revision.id })), body: value.text });
            await composer.clear();
            setError(undefined);
            setNotice(undefined);
        } catch (e) {
            setError(failure(e));
        } finally {
            setSending(false);
        }
    };

    const inChips = new Set(value.chips.map((c) => targetKey(c.target.target)));
    const addable = selectionTargets.filter((s) => !inChips.has(targetKey(s.target)));
    const [onlySelected] = selectionTargets;

    return (
        <div className="chat-composer">
            <div className="chat-composer-input">
                {open && (
                    <ul className="chat-mentions" role="listbox" aria-label={tx.chat.mentionHint}>
                        {matches.length === 0 && <li className="chat-mention-none muted">{tx.chat.mentionNoMatch}</li>}
                        {matches.map((c, i) => (
                            <li
                                key={c.key}
                                role="option"
                                aria-selected={i === active}
                                className={`chat-mention-option${i === active ? ' active' : ''}`}
                                onMouseDown={(e) => {
                                    // keeps the focus (and the caret) in the text
                                    e.preventDefault();
                                    pick(c);
                                }}
                                onMouseEnter={() => setActive(i)}
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
                        if (action === 'next') setActive((a) => (a + 1) % matches.length);
                        else if (action === 'previous') setActive((a) => (a - 1 + matches.length) % matches.length);
                        else if (action === 'pick') pick(matches[active]);
                        else if (action === 'close') setDismissed(query?.start);
                        else void send();
                    }}
                />
            </div>
            {onlySelected && (
                <div className="chat-selection">
                    <span className="muted">{selectionTargets.length > 1 ? tx.chat.selectedMany(selectionTargets.length) : tx.chat.selected}</span>
                    {selectionTargets.length === 1 && <span className="chat-selection-name">{nameOf(onlySelected)}</span>}
                    <button
                        className="chat-add"
                        disabled={addable.length === 0 || value.chips.length >= MAX_REQUEST_TARGETS}
                        aria-label={tx.chat.addSelection}
                        data-tooltip={addable.length === 0 ? tx.chat.alreadyAdded : tx.chat.addSelection}
                        onClick={() => {
                            const added = addChips(value, addable);
                            composer.setValue(added.value);
                            setNotice(added.skipped ? tx.chat.targetsLimit(MAX_REQUEST_TARGETS) : undefined);
                        }}
                    >
                        <Plus size={13} aria-hidden />
                    </button>
                </div>
            )}
            <div className="chat-composer-bar">
                <div className="chat-chips" aria-label={tx.chat.target}>
                    {value.chips.length === 0 ? (
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
                    {value.chips.length > 0 && <span className="muted small">{tx.chat.targetCount(value.chips.length, MAX_REQUEST_TARGETS)}</span>}
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
