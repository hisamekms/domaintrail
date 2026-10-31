// The session's chat in the left pane (ADR 0026), the same for everyone: who is here and what the agent is doing at a
// glance, the main stream of what the facilitator queued and what followed (`stream.ts`), the requests still waiting
// for approval, and the composer of a request about the selection. People talk in their meeting; nothing here is a
// chat between them: what they send are requests.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Bot, ChevronDown, ChevronRight, LogOut, PanelLeftClose } from 'lucide-react';
import type { TargetStatus } from '@domaintrail/collaboration/domain/targets';
import { useT, type Messages } from '../i18n';
import { sessionApi } from './api';
import { Avatar, failure } from './panel';
import { latestRevision } from './state';
import {
    agentStatus,
    elapsed,
    headerParticipants,
    oneLine,
    participantNames,
    pendingRequests,
    streamItems,
    targetText,
    type AgentMessage,
    type AgentStatus,
    type PendingRequest,
    type StreamItem,
} from './stream';
import { useTargetNaming } from './naming';
import { targetKey, WORKSPACE_TARGET, type ModelTarget, type TargetDraft } from './targets';
import type { ComposerDraft, SessionData } from './useSession';

type Tx = Messages['session'];
type FrozenRequest = Extract<StreamItem, { kind: 'queued' }>['requests'][number];

/** How many avatars the header shows before `+n`. */
const AVATARS = 8;

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
    /** What the selection can be a request about, if anything. */
    selectionTarget: TargetDraft | undefined;
    onNavigate: (target: ModelTarget) => void;
    onClose: () => void;
}) {
    const { session, composer, selectionTarget } = props;
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
            <ChatHeader session={session} status={status} now={now} onLeave={() => void leave()} onClose={props.onClose} tx={tx} />
            {session.status === 'signed-out' && <p className="session-note chat-notice">{tx.signedOut}</p>}
            {(session.status === 'closed' || state.session.state === 'Closed') && <p className="session-note chat-notice">{tx.closed}</p>}
            {session.error && <p className="session-note chat-notice session-error">{tx.error(session.error)}</p>}
            {leaveError && <p className="session-note chat-notice session-error">{tx.error(leaveError)}</p>}
            <Stream session={session} items={items} now={now} nameOf={nameOf} onNavigate={props.onNavigate} tx={tx} />
            <Pending session={session} live={live} nameOf={nameOf} tx={tx} />
            {live && <Composer session={session} composer={composer} selectionTarget={selectionTarget} tx={tx} />}
        </div>
    );
}

function ChatHeader(props: { session: SessionData; status: AgentStatus; now: number; onLeave: () => void; onClose: () => void; tx: Tx }) {
    const { session, status, tx } = props;
    const people = headerParticipants(session.state, session.peers, session.me);
    const online = people.filter((p) => p.online).length;
    const shown = people.slice(0, AVATARS);
    const label = status.kind === 'running' ? tx.chat.status.running(elapsed(status.since, props.now)) : tx.chat.status[status.kind];
    return (
        <div className="chat-header">
            <div
                className="chat-avatars"
                role="list"
                aria-label={tx.chat.participantsOnline(online, people.length)}
                data-tooltip={tx.chat.participantsOnline(online, people.length)}
            >
                {shown.map((p) => (
                    <span
                        key={p.id}
                        role="listitem"
                        className={`chat-avatar${p.online ? '' : ' away'}${p.role === 'facilitator' ? ' facilitator' : ''}`}
                        data-participant={p.name}
                        data-tooltip={`${p.name}${p.me ? ` (${tx.you})` : ''}${p.role === 'facilitator' ? ` · ${tx.roles.facilitator}` : ''}${p.online ? '' : ` · ${tx.chat.away}`}`}
                    >
                        <Avatar id={p.id} name={p.name} {...(p.avatarUrl && { url: p.avatarUrl })} />
                    </span>
                ))}
            </div>
            {/* the avatars may be cut off in a narrow pane: the count always tells who is here */}
            <span className="chat-online" aria-hidden>
                {tx.chat.onlineCount(online, people.length)}
            </span>
            <span className={`chat-status status-${status.kind}`} data-tooltip={tx.chat.statusHint[status.kind]} aria-live="polite">
                <span className="chat-status-mark" aria-hidden>
                    {status.kind === 'running' ? '●' : status.kind === 'clarification' ? '?' : status.kind === 'queued' ? '…' : '○'}
                </span>
                {label}
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
    const facilitator = session.state.session.facilitator;
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
                {items.map((item) => (
                    <li key={item.key} className={`chat-item chat-${item.kind}`} data-item={item.key}>
                        <Item item={item} now={now} session={session} facilitator={facilitator} nameOf={nameOf} onNavigate={props.onNavigate} tx={tx} />
                    </li>
                ))}
            </ol>
            {!substantive && <p className="chat-empty muted small">{tx.chat.empty}</p>}
        </div>
    );
}

function Item(props: {
    item: StreamItem;
    now: number;
    session: SessionData;
    facilitator: string;
    nameOf: (id: string) => string;
    onNavigate: (target: ModelTarget) => void;
    tx: Tx;
}) {
    const { item, nameOf, tx } = props;
    switch (item.kind) {
        case 'session-start':
            return <SystemLine at={item.at}>{tx.chat.sessionStarted(item.revision)}</SystemLine>;
        case 'confirmed':
            return <SystemLine at={item.at}>{tx.chat.confirmed(nameOf(item.by), item.revision)}</SystemLine>;
        case 'restored':
            return <SystemLine at={item.at}>{tx.chat.restored(item.from, item.revision)}</SystemLine>;
        case 'queued':
            return (
                <>
                    <SystemLine at={item.at}>
                        {tx.chat.queued(nameOf(item.by))} <span className="chat-run-tag">{tx.chat.run(item.run)}</span>
                    </SystemLine>
                    {item.requests.map((r) => (
                        <RequestBubble key={r.request} request={r} session={props.session} nameOf={nameOf} onNavigate={props.onNavigate} tx={tx} />
                    ))}
                </>
            );
        case 'note':
            return (
                <Bubble
                    avatar={<Avatar id={item.by} name={nameOf(item.by)} />}
                    who={nameOf(item.by)}
                    badge={<span className="chat-role">{tx.chat.facilitator}</span>}
                    at={item.at}
                    className="chat-bubble-facilitator"
                >
                    <span className="chat-label">{tx.chat.note}</span>
                    <Clamped text={item.text} tx={tx} />
                </Bubble>
            );
        case 'agent':
            return <AgentBubble message={item.message} run={item.run} at={item.at} now={props.now} nameOf={nameOf} tx={tx} />;
    }
}

function SystemLine({ at, children }: { at: string; children: ReactNode }) {
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
    className?: string;
    children: ReactNode;
}) {
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
function Clamped({ text, tx }: { text: string; tx: Tx }) {
    const [open, setOpen] = useState(false);
    const [clamped, setClamped] = useState(false);
    const ref = useRef<HTMLParagraphElement | null>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (el && !open) setClamped(el.scrollHeight > el.clientHeight + 1);
    }, [text, open]);
    return (
        <>
            <p ref={ref} className={`chat-text${open ? '' : ' clamped'}`}>
                {text}
            </p>
            {clamped && !open && (
                <a className="chat-more" onClick={() => setOpen(true)}>
                    {tx.chat.showMore}
                </a>
            )}
        </>
    );
}

function TargetChip({
    target,
    status,
    onNavigate,
    tx,
}: {
    target: FrozenRequest['target'];
    status: TargetStatus | undefined;
    onNavigate: (t: ModelTarget) => void;
    tx: Tx;
}) {
    const naming = useTargetNaming();
    const text = targetText(target, tx.workspace, naming);
    const kind = `chat-target kind-${target.target.kind}`;
    if (status === 'current' && target.target.kind !== 'Workspace')
        return (
            <a className={kind} onClick={() => onNavigate(target.target)} data-tooltip={tx.targetStatusHint.current}>
                {text}
            </a>
        );
    return (
        <span
            className={`${kind}${status === 'stale' ? ' stale' : ''}`}
            {...(status && status !== 'current' && { 'data-tooltip': tx.targetStatusHint[status] })}
        >
            {text}
        </span>
    );
}

function RequestBubble(props: { request: FrozenRequest; session: SessionData; nameOf: (id: string) => string; onNavigate: (t: ModelTarget) => void; tx: Tx }) {
    const { request: r, session, tx } = props;
    const author = props.nameOf(r.author);
    const mine = r.author === session.me.participant.id;
    const sentAt = session.state.requests.find((q) => q.id === r.request)?.sentAt;
    return (
        <Bubble
            avatar={<Avatar id={r.author} name={author} />}
            who={author}
            {...(mine && { badge: <span className="chat-mine">{tx.chat.mine}</span> })}
            at={sentAt}
            className={`chat-bubble-request${mine ? ' mine' : ''}`}
        >
            <TargetChip target={r.target} status={session.targets?.statuses[r.request]} onNavigate={props.onNavigate} tx={tx} />
            <Clamped text={r.body} tx={tx} />
        </Bubble>
    );
}

function AgentBubble(props: { message: AgentMessage; run: number; at: string; now: number; nameOf: (id: string) => string; tx: Tx }) {
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
                <>
                    <p className="chat-text">{says.clarification}</p>
                    <p className="chat-question">{m.question}</p>
                </>
            );
            break;
        case 'completed':
            body = <p className="chat-text">{m.changed ? says.completedChanged(m.result) : says.completedUnchanged}</p>;
            break;
        case 'failed':
            body = <p className="chat-text session-error">{says.failed(tx.failureReasons[m.reason])}</p>;
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
    const target = targetText(r.target, tx.workspace, naming);
    const body = oneLine(r.body);
    return (
        <li className={`chat-pending-row${p.mine ? ' mine' : ''}`} data-request={r.id} title={`${nameOf(r.author)} · ${target}\n${r.body}`}>
            {p.mine && <span className="chat-mine">{tx.chat.mine}</span>}
            <span className="chat-pending-text">
                <span className="chat-pending-author">{nameOf(r.author)}</span>
                <span className="muted"> · </span>
                <span className="chat-pending-target">{target}</span>
                <span className="muted"> · </span>
                {body}
            </span>
            {p.mine && live && (
                <button
                    className="chat-small"
                    onClick={(e) => {
                        e.stopPropagation();
                        sessionApi.dismissRequest(r.id).then(
                            () => onError(undefined),
                            (err: unknown) => onError(failure(err)),
                        );
                    }}
                >
                    {tx.dismiss}
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
            <button className="chat-pending-head" aria-expanded={open} onClick={() => setOpen(!open)} data-tooltip={tx.chat.pendingHint}>
                {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                <span>{tx.chat.pending(pending.all.length)}</span>
                <span className="chat-pending-toggle muted">{open ? tx.chat.collapse : pending.more > 0 ? tx.chat.expand : ''}</span>
            </button>
            <ul className="chat-pending-list">
                {rows.map((p) => (
                    <PendingRow key={p.request.id} p={p} live={live} nameOf={nameOf} tx={tx} onError={setError} />
                ))}
            </ul>
            {!open && pending.more > 0 && (
                <a className="chat-pending-more" onClick={() => setOpen(true)}>
                    {tx.chat.others(pending.more)}
                </a>
            )}
            {error && <p className="session-note chat-notice session-error">{tx.error(error)}</p>}
        </section>
    );
}

function Composer(props: { session: SessionData; composer: ComposerDraft; selectionTarget: TargetDraft | undefined; tx: Tx }) {
    const { session, composer, selectionTarget, tx } = props;
    const naming = useTargetNaming();
    // the selection is the target, unless the whole workspace was chosen for it; choosing something else selects it again
    const selectionKey = selectionTarget ? targetKey(selectionTarget.target) : undefined;
    const [wholeWorkspace, setWholeWorkspace] = useState(false);
    useEffect(() => setWholeWorkspace(false), [selectionKey]);
    const target = !wholeWorkspace && selectionTarget ? selectionTarget : WORKSPACE_TARGET;
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const body = composer.body;
    const canSend = !sending && body.trim() !== '';

    const send = async (): Promise<void> => {
        const revision = latestRevision(session.state);
        if (!revision || !canSend) return;
        setSending(true);
        try {
            await sessionApi.sendRequest({ target: { ...target, sourceRevision: revision.id }, body });
            await composer.clear();
            setError(undefined);
        } catch (e) {
            setError(failure(e));
        } finally {
            setSending(false);
        }
    };

    return (
        <div className="chat-composer">
            <div className="chat-composer-target">
                <span className="muted">{tx.chat.target}:</span>
                <span className={`chat-target kind-${target.target.kind}`} {...(!selectionTarget && { 'data-tooltip': tx.chat.noSelection })}>
                    {targetText(target, tx.workspace, naming)}
                </span>
                {selectionTarget &&
                    (wholeWorkspace ? (
                        <button className="chat-link" onClick={() => setWholeWorkspace(false)}>
                            {tx.chat.toSelection}
                        </button>
                    ) : (
                        <button className="chat-link" onClick={() => setWholeWorkspace(true)}>
                            {tx.chat.toWorkspace}
                        </button>
                    ))}
            </div>
            <textarea
                className="session-text chat-input"
                rows={3}
                maxLength={10_000}
                placeholder={tx.chat.placeholder}
                value={body}
                onChange={(e) => composer.setBody(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void send();
                    }
                }}
            />
            <div className="chat-composer-actions">
                <span className="chat-kept muted small">{body !== '' ? tx.chat.draftKept : ''}</span>
                <button className="chat-send" disabled={!canSend} onClick={() => void send()}>
                    {sending ? tx.chat.sending : tx.chat.send}
                </button>
            </div>
            {(error ?? composer.error) && <p className="session-note session-error">{tx.error(error ?? composer.error ?? '')}</p>}
        </div>
    );
}
