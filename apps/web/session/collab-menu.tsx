// The chat's collab menu (ADR 0026): one button in the chat's head — the avatars and how many are online — opening
// who is in the collab (`participants.tsx`) and what one can do with it: copy the invite link; the facilitator records
// the workspace, restores an earlier state of it (the last resort, chosen in a dialog, then the restore's own flow in
// the chat), hands the role over and ends the collab (asked first, with what is unfinished); a participant leaves.
// Once it ended, everyone sees its summary (`CollabSummaryDialog`). What the menu offers to whom is in `collab.ts`.
//
// Everyone downloads the sources (a ZIP of the .dt, .dtes and config files, `download.ts`).
//
// In the `link` identity mode the facilitator makes the invite link here (copied; a new one stops the previous) and
// stops it, removes a participant from the list, and lets each person who asks in (`JoinRequests`, in the chat's head).
//
// In Solo (`dt open`, one person) the button is a plain ⋯ and the popover holds no people, only the workspace's
// record, restore and download: the invite, the hand-over, the end and 退出 make sense only with others.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronDown, Ellipsis, X } from 'lucide-react';
import type { ViewLocation } from '@domaintrail/collaboration/protocol';
import { useDismiss } from '../shared/layout';
import { sessionApi } from './api';
import { downloadSources } from './download';
import { useChat, type Tx } from './chat-context';
import { collabMenuItems, collabSummary, hasUnfinished, hoursMinutes, inviteLink, unfinishedWork, type CollabMenuItem, type CollabSummary } from './collab';
import { unitName, type ChangeUnit } from './history';
import { restorePoints, type RestorePointEntry } from './timeline';
import { Avatar, failure } from './parts';
import { ParticipantsList, type PeopleFocus } from './participants';
import type { SessionData } from './useSession';
import { participantRows, type ViewScope, type ViewTarget } from './views';
import { Act } from '../shared/act';

/** How many avatars the button shows. */
const AVATARS = 3;

/** The event `openPeople` sends to the page's collab menu. */
const OPEN_PEOPLE = 'domaintrail:open-people';

/**
 * Opens the chat's collab menu on its participants; with a participant's ID, their row is scrolled to, focused and
 * marked (e.g. from an `@` mention of a person). Does nothing outside a collab (no menu listens).
 */
export function openPeople(participantId?: string): void {
    window.dispatchEvent(new CustomEvent<string | undefined>(OPEN_PEOPLE, { detail: participantId }));
}

/** The focusable controls of the popover, in order, for the arrow keys. */
const focusables = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('button:not(:disabled), li[tabindex]')];

export function CollabMenu(props: {
    /** The session is Solo: no people, only the workspace's tools. */
    solo: boolean;
    session: SessionData;
    location: ViewLocation;
    scope: ViewScope;
    units: readonly ChangeUnit[];
    /** The collab is open and this page in it. */
    live: boolean;
    onOpenView: (target: ViewTarget) => void;
    onLeave: () => void;
}) {
    const { session, live } = props;
    const { tx, revisions } = useChat();
    const [open, setOpen] = useState(false);
    const [focus, setFocus] = useState<PeopleFocus | undefined>();
    const [note, setNote] = useState<string | undefined>();
    const [ending, setEnding] = useState(false);
    const [restoring, setRestoring] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    const popover = useRef<HTMLDivElement>(null);
    const close = useCallback((): void => {
        setOpen(false);
        setFocus(undefined);
    }, []);
    useDismiss(open, root, close);

    useEffect(() => {
        const onOpen = (e: Event): void => {
            const participant: unknown = e instanceof CustomEvent ? e.detail : undefined;
            setOpen(true);
            setFocus(typeof participant === 'string' ? { participant, at: Date.now() } : undefined);
        };
        window.addEventListener(OPEN_PEOPLE, onOpen);
        return () => window.removeEventListener(OPEN_PEOPLE, onOpen);
    }, []);
    // opened (not on a participant): the first control takes the focus, so that the arrows move from there
    useEffect(() => {
        if (open && !focus && popover.current) focusables(popover.current)[0]?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const rows = participantRows(session.state, session.peers, session.me, props.location);
    const online = rows.filter((r) => r.where !== 'away').length;
    const label = tx.chat.participantsOnline(online, rows.length);
    const link = session.me.identity.provider === 'link';
    const items = collabMenuItems(session.me.participant.role, live, props.solo, link ? { inviteLive: Boolean(session.joining?.invite) } : undefined);

    const pick = (f: () => void | Promise<void>) => (): void => {
        close();
        button.current?.focus();
        void f();
    };
    const run: Record<CollabMenuItem, () => void | Promise<void>> = {
        invite: async () => {
            if (!link) {
                const address = inviteLink(location.origin);
                await navigator.clipboard?.writeText(address).catch(() => undefined);
                return setNote(tx.collab.inviteCopied(address));
            }
            try {
                const made = await sessionApi.invite();
                await navigator.clipboard?.writeText(made.link).catch(() => undefined);
                setNote(tx.collab.inviteMade(made.link));
            } catch (e) {
                setNote(tx.error(failure(e)));
            }
        },
        'stop-invite': async () => {
            try {
                await sessionApi.stopInvite();
                setNote(tx.collab.inviteStopped);
            } catch (e) {
                setNote(tx.error(failure(e)));
            }
        },
        record: () => revisions.take(),
        restore: () => setRestoring(true),
        'hand-over': async () => {
            try {
                const { link } = await sessionApi.facilitatorLink();
                await navigator.clipboard?.writeText(link).catch(() => undefined);
                setNote(tx.chat.linkIssued(link));
            } catch (e) {
                setNote(tx.error(failure(e)));
            }
        },
        'download-sources': async () => {
            try {
                await downloadSources();
            } catch (e) {
                setNote(tx.error(e instanceof Error ? e.message : String(e)));
            }
        },
        end: () => setEnding(true),
        leave: () => props.onLeave(),
    };
    const itemLabel: Record<CollabMenuItem, string> = {
        invite: link ? tx.collab.makeInvite : tx.collab.invite,
        'stop-invite': tx.collab.stopInvite,
        record: tx.takeRevision,
        restore: tx.collab.restore,
        'download-sources': tx.collab.downloadSources,
        'hand-over': tx.chat.handOver,
        end: tx.collab.end,
        leave: tx.leave,
    };

    const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
        if (!popover.current || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        const all = focusables(popover.current);
        if (all.length === 0) return;
        const i = all.findIndex((el) => el === document.activeElement);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length;
        e.preventDefault();
        all[next].focus();
    };
    // closed while the focus was in it (Escape): the focus goes back to the button
    const wasOpen = useRef(false);
    useEffect(() => {
        if (!open && wasOpen.current && document.activeElement === document.body) button.current?.focus();
        wasOpen.current = open;
    }, [open]);

    // alone with nothing to offer (ended): no menu
    if (props.solo && items.length === 0) return null;
    return (
        <div className="collab-menu" ref={root}>
            <button
                ref={button}
                className="collab-menu-button"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={props.solo ? tx.collab.menu : `${tx.collab.menu}: ${label}`}
                data-tooltip={tx.collab.menu}
                onClick={() => (open ? close() : setOpen(true))}
            >
                {props.solo ? (
                    <Ellipsis size={15} aria-hidden />
                ) : (
                    <>
                        <span className="chat-avatars">
                            {rows.slice(0, AVATARS).map((r) => (
                                <span key={r.id} className={`chat-avatar${r.where === 'away' ? ' away' : ''}`}>
                                    <Avatar id={r.id} name={r.name} {...(r.avatarUrl && { url: r.avatarUrl })} facilitator={r.role === 'facilitator'} />
                                </span>
                            ))}
                        </span>
                        <span className="chat-online">{tx.chat.onlineCount(online, rows.length)}</span>
                        <ChevronDown size={13} aria-hidden className="collab-menu-chevron" />
                    </>
                )}
            </button>
            {open && (
                <div ref={popover} className="collab-menu-popover motion-pop" role="dialog" aria-label={tx.collab.menu} onKeyDown={onKeyDown}>
                    {/* the people need no heading: the actions are set apart by a rule */}
                    {!props.solo && (
                        <>
                            <p className="visually-hidden" id="collab-menu-people">
                                {tx.collab.people}
                            </p>
                            <ParticipantsList
                                rows={rows}
                                scope={props.scope}
                                focus={focus}
                                {...(link &&
                                    live &&
                                    session.me.participant.role === 'facilitator' && {
                                        onRemove: (id: string) => {
                                            sessionApi.removeParticipant(id).catch((e: unknown) => setNote(tx.error(failure(e))));
                                        },
                                    })}
                                onOpenView={(target) => {
                                    props.onOpenView(target);
                                    close();
                                }}
                            />
                        </>
                    )}
                    {items.length > 0 && (
                        <div className="collab-menu-actions" role="menu" aria-label={tx.collab.actions}>
                            {items.map((item) => (
                                <button
                                    key={item}
                                    role="menuitem"
                                    className={item === 'end' ? 'menu-danger' : undefined}
                                    data-item={item}
                                    {...(item === 'invite' && { 'data-tooltip': link ? tx.collab.makeInviteHint : tx.collab.inviteHint })}
                                    onClick={pick(run[item])}
                                >
                                    {itemLabel[item]}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}
            {note && (
                <div className="pane-menu-list session-menu-note collab-menu-note" role="status">
                    <p className="small">{note}</p>
                    <Act kind="open" onClick={() => setNote(undefined)}>
                        {tx.restoreFlow.close}
                    </Act>
                </div>
            )}
            {ending && <EndDialog session={session} units={props.units} onClose={() => setEnding(false)} tx={tx} />}
            {restoring && (
                <RestoreDialog
                    session={session}
                    units={props.units}
                    onPick={(revision) => {
                        setRestoring(false);
                        revisions.restore(revision);
                    }}
                    onClose={() => setRestoring(false)}
                />
            )}
        </div>
    );
}

/**
 * 以前の状態に復元 (the facilitator's last resort): the states the workspace can go back to, newest first, each named by
 * what it was — the collab's start, before or after a unit of work, a record by someone, before or after a restore —
 * with its time (its revision's number in the tooltip). Choosing one closes the dialog; the chat asks before it
 * restores, and walks through external changes and a run in progress as any restore does.
 */
function RestoreDialog(props: { session: SessionData; units: readonly ChangeUnit[]; onPick: (revision: string) => void; onClose: () => void }) {
    const { tx, nameOf } = useChat();
    const c = tx.collab;
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const d = dialog.current;
        if (d && !d.open) d.showModal();
        return () => d?.close();
    }, []);
    const points = restorePoints(props.session.state);
    const unitOf = (run: string | undefined): string => {
        const unit = props.units.find((u) => u.runs.some((r) => r.run.id === run));
        return unit ? unitName(unit).text : '';
    };
    // a revert is named by the work it reverts (「〈作業名〉の打ち消しの前」), not by its own request's text
    const revertedBy = (run: string | undefined): string | undefined =>
        props.session.state.runs.find((r) => r.id === run)?.input.requests.find((q) => q.reverts !== undefined)?.reverts;
    const label = (p: RestorePointEntry): string => {
        const r = c.restorePoints;
        const reverted = revertedBy(p.run);
        switch (p.kind) {
            case 'RunBase':
                return reverted ? r.RevertBase(unitOf(reverted)) : r.RunBase(unitOf(p.run));
            case 'RunResult':
                return reverted ? r.RevertResult(unitOf(reverted)) : r.RunResult(unitOf(p.run));
            case 'Manual':
                return r.Manual(nameOf(p.by ?? ''));
            default:
                return r[p.kind];
        }
    };
    const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return (
        <dialog
            ref={dialog}
            className="session-dialog collab-dialog collab-restore"
            aria-labelledby="collab-restore-title"
            onClose={props.onClose}
            onClick={(e) => e.target === e.currentTarget && props.onClose()}
        >
            <div className="settings-dialog-header">
                <h2 id="collab-restore-title">{c.restoreTitle}</h2>
                <button className="icon-button" aria-label={c.close} data-tooltip={c.close} onClick={props.onClose}>
                    <X size={18} aria-hidden />
                </button>
            </div>
            <div className="settings-dialog-body collab-dialog-body">
                <p className="muted">{c.restoreBody}</p>
                {points.length === 0 ? (
                    <p className="muted">{c.restoreNone}</p>
                ) : (
                    <ul className="collab-restore-list">
                        {points.map((p) => (
                            <li key={p.revision}>
                                <Act
                                    kind="open"
                                    className="collab-restore-pick"
                                    data-revision={p.revision}
                                    data-tooltip={c.restorePick(p.number)}
                                    onClick={() => props.onPick(p.revision)}
                                >
                                    <time className="collab-restore-number" dateTime={p.takenAt}>
                                        {time(p.takenAt)}
                                    </time>
                                    <span>{label(p)}</span>
                                </Act>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </dialog>
    );
}

/** The facilitator ends the collab: what is unfinished, then 終える. */
function EndDialog(props: { session: SessionData; units: readonly ChangeUnit[]; onClose: () => void; tx: Tx }) {
    const { tx, onClose } = props;
    const c = tx.collab;
    const dialog = useRef<HTMLDialogElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const unfinished = unfinishedWork(props.session.state, props.units);
    useEffect(() => {
        const d = dialog.current;
        if (d && !d.open) d.showModal();
        return () => d?.close();
    }, []);
    const end = async (): Promise<void> => {
        setBusy(true);
        try {
            await sessionApi.close();
            onClose();
        } catch (e) {
            setError(failure(e));
            setBusy(false);
        }
    };
    const lines = (['queued', 'running', 'clarification'] as const).filter((k) => unfinished[k] > 0);
    return (
        <dialog
            ref={dialog}
            className="session-dialog collab-dialog collab-end"
            aria-labelledby="collab-end-title"
            onClose={onClose}
            onClick={(e) => e.target === e.currentTarget && onClose()}
        >
            <div className="settings-dialog-header">
                <h2 id="collab-end-title">{c.endTitle}</h2>
            </div>
            <div className="settings-dialog-body collab-dialog-body">
                {hasUnfinished(unfinished) ? (
                    <section className="collab-unfinished">
                        <h3>{c.unfinishedTitle}</h3>
                        <ul>
                            {lines.map((k) => (
                                <li key={k} className={`collab-unfinished-${k}`}>
                                    {c.unfinished[k](unfinished[k])}
                                </li>
                            ))}
                        </ul>
                    </section>
                ) : (
                    <p className="muted">{c.nothingUnfinished}</p>
                )}
                <p>{c.endBody}</p>
                {error && <p className="session-note session-error">{tx.error(error)}</p>}
                <div className="session-buttons collab-dialog-buttons">
                    <Act kind="stop" onClick={onClose} disabled={busy}>
                        {c.cancel}
                    </Act>
                    <Act kind="danger" className="collab-end-confirm" onClick={() => void end()} disabled={busy}>
                        {c.endConfirm}
                    </Act>
                </div>
            </div>
        </dialog>
    );
}

/** The summary of a collab that ended, from the state the page held then. */
export function useCollabSummary(session: SessionData, ended: boolean): CollabSummary | undefined {
    // when this page saw the end: the duration's end when the end event did not arrive
    const [endedAt, setEndedAt] = useState<string | undefined>();
    useEffect(() => {
        if (ended && endedAt === undefined) setEndedAt(new Date().toISOString());
    }, [ended, endedAt]);
    const { state, me, peers } = session;
    return useMemo(() => (ended ? collabSummary(state, me, peers, endedAt) : undefined), [ended, state, me, peers, endedAt]);
}

/** What everyone sees once the collab ended: its changes, who took part, how long it lasted, and where it is kept. */
export function CollabSummaryDialog(props: { summary: CollabSummary; onClose: () => void; tx: Tx }) {
    const { summary, tx, onClose } = props;
    const c = tx.collab;
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const d = dialog.current;
        if (d && !d.open) d.showModal();
        return () => d?.close();
    }, []);
    const duration = summary.duration === undefined ? undefined : hoursMinutes(summary.duration);
    return (
        <dialog
            ref={dialog}
            className="session-dialog collab-dialog collab-summary"
            aria-labelledby="collab-summary-title"
            onClose={onClose}
            onClick={(e) => e.target === e.currentTarget && onClose()}
        >
            <div className="settings-dialog-header">
                <h2 id="collab-summary-title">
                    {c.ended}
                    {duration && <span className="muted collab-summary-duration"> · {c.duration(duration.hours, duration.minutes)}</span>}
                </h2>
                <button className="icon-button" aria-label={c.close} data-tooltip={c.close} onClick={onClose}>
                    <X size={18} aria-hidden />
                </button>
            </div>
            <div className="settings-dialog-body collab-dialog-body">
                <section>
                    <h3>{c.changes(summary.units.length)}</h3>
                    {summary.units.length === 0 ? (
                        <p className="muted">{c.noChanges}</p>
                    ) : (
                        <ol className="collab-summary-units">
                            {summary.units.map((u) => (
                                <li key={u.key}>
                                    <span className="collab-summary-title">{u.title}</span>
                                    <span className="muted small">
                                        {tx.chat.history.files(u.files)} · {tx.chat.history.requesters(u.requesters.join(tx.chat.listSeparator))}
                                    </span>
                                </li>
                            ))}
                        </ol>
                    )}
                    {summary.others > 0 && <p className="muted small">{c.others(summary.others)}</p>}
                </section>
                <section>
                    <h3>{c.participants(summary.participants.length)}</h3>
                    <ul className="collab-summary-people">
                        {summary.participants.map((p) => (
                            <li key={p.id}>
                                <Avatar id={p.id} name={p.name} {...(p.avatarUrl && { url: p.avatarUrl })} facilitator={p.facilitator} />
                                {p.name}
                                {p.facilitator && <span className="chat-role"> {tx.roles.facilitator}</span>}
                            </li>
                        ))}
                    </ul>
                </section>
                <p className="muted small collab-summary-kept">{c.kept}</p>
            </div>
        </dialog>
    );
}
