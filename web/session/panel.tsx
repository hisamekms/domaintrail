// The session panel (ADR 0026): the participants and where they are, the request composer and my drafts, the queue of
// sent requests with their targets' status, the runs, and the revision timeline (`revisions.tsx`). The facilitator's
// controls (bundling requests into a run, cancelling one, dismissing others' requests, confirming and restoring
// revisions) are shown to the facilitator only; the server checks the role anyway.
import { useState, type ReactNode } from 'react';
import { PanelRightClose, Trash2 } from 'lucide-react';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import { useT, type Messages } from '../i18n';
import { sessionApi, SessionApiError } from './api';
import { sendable } from './drafts';
import { Revisions } from './revisions';
import { initials, participantColor, whereabouts as whereaboutsOf, type Whereabouts } from './presence';
import { latestRevision } from './state';
import { targetKey, WORKSPACE_TARGET, type ModelTarget, type TargetDraft } from './targets';
import type { Drafts, SessionData } from './useSession';
import type { ViewLocation } from '@domaintrail/collaboration/protocol';

type RequestJson = SessionStateBody['requests'][number];
type RunJson = SessionStateBody['runs'][number];
type RevisionJson = SessionStateBody['revisions'][number];
type Validation = RevisionJson['validation'];

const failure = (e: unknown): string => (e instanceof SessionApiError ? (e.message && e.message !== e.type ? `${e.type}: ${e.message}` : e.type) : String(e));

const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function SessionPanel(props: {
    session: SessionData;
    drafts: Drafts;
    /** This page's location (to tell who is on the same view). */
    location: ViewLocation;
    /** What the selection can be a request about, if anything. */
    selectionTarget: TargetDraft | undefined;
    onNavigate: (target: ModelTarget) => void;
    onShowInspector: () => void;
    onClose: () => void;
}) {
    const { session, drafts, selectionTarget } = props;
    const { state, me } = session;
    const t = useT();
    const tx = t.session;
    const facilitator = me.participant.role === 'facilitator';
    // the names the participants are signed in with now (the facilitator's participant is named after the role)
    const names = new Map<string, string>(state.session.participants.map((p) => [p.id, p.name]));
    for (const p of session.peers.values()) names.set(p.participant.id, p.participant.name);
    names.set(me.participant.id, me.participant.name);
    const nameOf = (id: string): string => names.get(id) ?? id;
    const live = session.status === 'live' && state.session.state === 'Open';
    const [leaveError, setLeaveError] = useState<string | undefined>();
    const leave = async (): Promise<void> => {
        try {
            const left = await sessionApi.leave();
            // access: on to Cloudflare Access's logout; dev: the join form again
            if (left.logout) location.assign(left.logout);
            else location.reload();
        } catch (e) {
            setLeaveError(failure(e));
        }
    };

    return (
        <div className="session-panel">
            <div className="pane-title pane-title-row">
                <span>{tx.title}</span>
                <span className="session-actions">
                    {session.status !== 'signed-out' && (
                        <button className="small" onClick={() => void leave()}>
                            {tx.leave}
                        </button>
                    )}
                    <button className="small" onClick={props.onShowInspector}>
                        {tx.showInspector}
                    </button>
                    <button className="icon-button" onClick={props.onClose} data-tooltip={tx.close} aria-label={tx.close}>
                        <PanelRightClose size={16} aria-hidden />
                    </button>
                </span>
            </div>
            <div className="session-body">
                {session.status === 'signed-out' && <p className="session-note">{tx.signedOut}</p>}
                {(session.status === 'closed' || state.session.state === 'Closed') && <p className="session-note">{tx.closed}</p>}
                {session.error && <p className="session-note session-error">{tx.error(session.error)}</p>}
                {leaveError && <p className="session-note session-error">{tx.error(leaveError)}</p>}
                <Participants session={session} location={props.location} nameOf={nameOf} tx={tx} />
                {live && <Composer drafts={drafts} selectionTarget={selectionTarget} state={state} tx={tx} />}
                <Requests session={session} facilitator={facilitator} live={live} nameOf={nameOf} onNavigate={props.onNavigate} tx={tx} />
                <Runs runs={state.runs} requests={state.requests} revisions={state.revisions} facilitator={facilitator} live={live} nameOf={nameOf} tx={tx} />
                <Revisions state={state} facilitator={facilitator} live={live} nameOf={nameOf} tx={tx} />
            </div>
        </div>
    );
}

type Tx = Messages['session'];

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="session-section">
            <h3>{title}</h3>
            {children}
        </section>
    );
}

function Avatar({ id, name, url }: { id: string; name: string; url?: string }) {
    // only an https avatar is shown; anything else gets the initials
    if (url?.startsWith('https://')) return <img className="session-avatar" src={url} alt="" referrerPolicy="no-referrer" />;
    return (
        <span className="session-avatar" style={{ background: participantColor(id) }} aria-hidden>
            {initials(name)}
        </span>
    );
}

function Participants({ session, location, nameOf, tx }: { session: SessionData; location: ViewLocation; nameOf: (id: string) => string; tx: Tx }) {
    const { state, me, peers } = session;
    const where = whereaboutsOf(peers, location);
    const avatars = new Map<string, string>();
    for (const p of peers.values()) if (p.participant.avatarUrl) avatars.set(p.participant.id, p.participant.avatarUrl);
    const roleOf = (id: string): 'facilitator' | 'participant' => (id === state.session.facilitator ? 'facilitator' : 'participant');
    const rows = state.session.participants.map((p) => {
        const w: Whereabouts = p.id === me.participant.id ? 'here' : (where.get(p.id) ?? 'away');
        return { id: p.id, name: nameOf(p.id), role: roleOf(p.id), where: w };
    });
    const order: Record<Whereabouts, number> = { here: 0, 'same-view': 1, 'another-view': 2, away: 3 };
    rows.sort((a, b) => order[a.where] - order[b.where] || a.name.localeCompare(b.name));
    return (
        <Section title={tx.participants(rows.filter((r) => r.where !== 'away').length)}>
            <ul className="session-list session-participants">
                {rows.map((r) => (
                    <li key={r.id} className={`session-participant where-${r.where}`} data-participant={r.name}>
                        <Avatar id={r.id} name={r.name} url={r.id === me.participant.id ? me.participant.avatarUrl : avatars.get(r.id)} />
                        <span className="session-name">
                            {r.name}
                            {r.where === 'here' && <span className="muted small"> ({tx.you})</span>}
                        </span>
                        <span className={`session-role role-${r.role}`}>{tx.roles[r.role]}</span>
                        <span className="session-where muted small">{tx.whereabouts[r.where]}</span>
                    </li>
                ))}
            </ul>
        </Section>
    );
}

function TargetLabel({ target, tx }: { target: TargetDraft; tx: Tx }) {
    return (
        <span className={`session-target kind-${target.target.kind}`}>
            {target.target.kind === 'Workspace' ? tx.workspace : (target.label ?? targetKey(target.target))}
        </span>
    );
}

function Composer({ drafts, selectionTarget, state, tx }: { drafts: Drafts; selectionTarget: TargetDraft | undefined; state: SessionStateBody; tx: Tx }) {
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const [sending, setSending] = useState(false);
    const [failures, setFailures] = useState<string[]>([]);
    const toSend = sendable(drafts.drafts, selected);

    const send = async (): Promise<void> => {
        const revision = latestRevision(state);
        if (!revision) return;
        setSending(true);
        const failed: string[] = [];
        // each draft is its own request; a draft is removed only once the server took it
        for (const draft of toSend) {
            try {
                await sessionApi.sendRequest({ target: { ...draft.target, sourceRevision: revision.id }, body: draft.body });
                await drafts.remove(draft.id);
            } catch (e) {
                failed.push(failure(e));
            }
        }
        setSelected((s) => new Set([...s].filter((id) => drafts.drafts.some((d) => d.id === id) && !toSend.some((d) => d.id === id))));
        setFailures(failed);
        setSending(false);
    };

    return (
        <>
            <Section title={tx.compose}>
                <p className="muted small session-selection">
                    {selectionTarget ? tx.selection(selectionTarget.label ?? targetKey(selectionTarget.target)) : tx.nothingSelected}
                </p>
                <div className="session-buttons">
                    <button disabled={!selectionTarget} onClick={() => selectionTarget && drafts.add(selectionTarget)}>
                        {tx.draftAboutSelection}
                    </button>
                    <button onClick={() => drafts.add(WORKSPACE_TARGET)}>{tx.draftAboutWorkspace}</button>
                </div>
            </Section>
            <Section title={tx.drafts(drafts.drafts.length)}>
                <p className="muted small">{tx.draftsPrivate}</p>
                {drafts.error && <p className="session-note session-error">{tx.error(drafts.error)}</p>}
                <ul className="session-list session-drafts">
                    {drafts.drafts.map((d) => (
                        <li key={d.id} className="session-draft">
                            <div className="session-row">
                                <input
                                    type="checkbox"
                                    aria-label={tx.selectDraft}
                                    checked={selected.has(d.id)}
                                    onChange={(e) =>
                                        setSelected((s) => {
                                            const next = new Set(s);
                                            if (e.target.checked) next.add(d.id);
                                            else next.delete(d.id);
                                            return next;
                                        })
                                    }
                                />
                                <TargetLabel target={d.target} tx={tx} />
                                <button
                                    className="icon-button"
                                    onClick={() => void drafts.remove(d.id)}
                                    data-tooltip={tx.deleteDraft}
                                    aria-label={tx.deleteDraft}
                                >
                                    <Trash2 size={14} aria-hidden />
                                </button>
                            </div>
                            <textarea
                                className="session-text"
                                rows={3}
                                maxLength={10_000}
                                placeholder={tx.draftPlaceholder}
                                value={d.body}
                                onChange={(e) => drafts.edit(d.id, { body: e.target.value })}
                            />
                        </li>
                    ))}
                </ul>
                {drafts.drafts.length > 0 && (
                    <button className="primary" disabled={sending || toSend.length === 0} onClick={() => void send()}>
                        {tx.send(toSend.length)}
                    </button>
                )}
                {failures.map((f, i) => (
                    <p key={i} className="session-note session-error">
                        {tx.sendFailed(f)}
                    </p>
                ))}
            </Section>
        </>
    );
}

function Requests(props: {
    session: SessionData;
    facilitator: boolean;
    live: boolean;
    nameOf: (id: string) => string;
    onNavigate: (target: ModelTarget) => void;
    tx: Tx;
}) {
    const { session, facilitator, live, nameOf, tx } = props;
    const { state, me, targets } = session;
    const [selected, setSelected] = useState<readonly string[]>([]);
    const [note, setNote] = useState('');
    const [error, setError] = useState<string | undefined>();
    const pending = new Set(state.requests.filter((r) => r.state === 'Sent').map((r) => r.id));
    const chosen = selected.filter((id) => pending.has(id));
    const requests = [...state.requests].sort((a, b) => b.sentAt.localeCompare(a.sentAt));

    const act = async (f: () => Promise<unknown>): Promise<boolean> => {
        try {
            await f();
            setError(undefined);
            return true;
        } catch (e) {
            setError(failure(e));
            return false;
        }
    };
    const queue = async (): Promise<void> => {
        const trimmed = note.trim();
        // in the order they were sent
        const ordered = state.requests.filter((r) => chosen.includes(r.id)).map((r) => r.id);
        if (await act(() => sessionApi.queueRun({ requests: ordered, ...(trimmed && { note: trimmed }) }))) {
            setSelected([]);
            setNote('');
        }
    };

    return (
        <Section title={tx.requests(state.requests.length)}>
            {requests.length === 0 && <p className="muted small">{tx.noRequests}</p>}
            <ul className="session-list session-requests">
                {requests.map((r) => (
                    <RequestItem
                        key={r.id}
                        request={r}
                        author={nameOf(r.author)}
                        status={targets?.statuses[r.id]}
                        selectable={facilitator && live && r.state === 'Sent'}
                        selected={chosen.includes(r.id)}
                        onSelect={(on) => setSelected((s) => (on ? [...s, r.id] : s.filter((id) => id !== r.id)))}
                        canDismiss={live && r.state === 'Sent' && (facilitator || r.author === me.participant.id)}
                        onDismiss={() => void act(() => sessionApi.dismissRequest(r.id))}
                        onNavigate={props.onNavigate}
                        tx={tx}
                    />
                ))}
            </ul>
            {facilitator && live && pending.size > 0 && (
                <div className="session-facilitator">
                    <textarea
                        className="session-text"
                        rows={2}
                        maxLength={4000}
                        placeholder={tx.runNote}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                    />
                    <button className="primary" disabled={chosen.length === 0} onClick={() => void queue()}>
                        {tx.queueRun(chosen.length)}
                    </button>
                </div>
            )}
            {error && <p className="session-note session-error">{tx.error(error)}</p>}
        </Section>
    );
}

function RequestItem(props: {
    request: RequestJson;
    author: string;
    status: 'current' | 'stale' | 'unknown' | undefined;
    selectable: boolean;
    selected: boolean;
    onSelect: (on: boolean) => void;
    canDismiss: boolean;
    onDismiss: () => void;
    onNavigate: (target: ModelTarget) => void;
    tx: Tx;
}) {
    const { request: r, status, tx } = props;
    const target = r.target.target;
    const navigable = status === 'current' && target.kind !== 'Workspace';
    return (
        <li className={`session-request state-${r.state}`} data-request={r.id}>
            <div className="session-row">
                {props.selectable && (
                    <input type="checkbox" aria-label={tx.selectRequest} checked={props.selected} onChange={(e) => props.onSelect(e.target.checked)} />
                )}
                {navigable ? (
                    <a className="session-target-link" onClick={() => props.onNavigate(target)} data-tooltip={tx.targetStatusHint.current}>
                        <TargetLabel target={r.target} tx={tx} />
                    </a>
                ) : (
                    <TargetLabel target={r.target} tx={tx} />
                )}
                {status && (
                    <span className={`session-status status-${status}`} data-tooltip={tx.targetStatusHint[status]}>
                        {tx.targetStatus[status]}
                    </span>
                )}
            </div>
            <p className="session-body-text">{r.body}</p>
            <div className="session-row muted small">
                <span>
                    {props.author} · {time(r.sentAt)}
                </span>
                {r.state === 'Dismissed' && <span className="session-status status-dismissed">{tx.dismissed}</span>}
                {props.canDismiss && (
                    <button className="small" onClick={props.onDismiss}>
                        {tx.dismiss}
                    </button>
                )}
            </div>
        </li>
    );
}

function Runs(props: {
    runs: SessionStateBody['runs'];
    requests: SessionStateBody['requests'];
    revisions: SessionStateBody['revisions'];
    facilitator: boolean;
    live: boolean;
    nameOf: (id: string) => string;
    tx: Tx;
}) {
    const { runs, facilitator, live, nameOf, tx } = props;
    const [error, setError] = useState<string | undefined>();
    const sorted = [...runs].sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
    const revision = (id: string | undefined): RevisionJson | undefined => props.revisions.find((r) => r.id === id);
    const cancel = (id: string): void => {
        sessionApi.cancelRun(id).then(
            () => setError(undefined),
            (e: unknown) => setError(failure(e)),
        );
    };
    return (
        <Section title={tx.runs(runs.length)}>
            {runs.length === 0 && <p className="muted small">{tx.noRuns}</p>}
            <ul className="session-list session-runs">
                {sorted.map((run) => (
                    <RunItem
                        key={run.id}
                        run={run}
                        base={'baseRevision' in run ? revision(run.baseRevision) : undefined}
                        result={'resultRevision' in run ? revision(run.resultRevision) : undefined}
                        canCancel={facilitator && live && (run.state === 'Queued' || run.state === 'Running')}
                        onCancel={() => cancel(run.id)}
                        nameOf={nameOf}
                        tx={tx}
                    />
                ))}
            </ul>
            {error && <p className="session-note session-error">{tx.error(error)}</p>}
        </Section>
    );
}

function RunItem(props: {
    run: RunJson;
    base: RevisionJson | undefined;
    result: RevisionJson | undefined;
    canCancel: boolean;
    onCancel: () => void;
    nameOf: (id: string) => string;
    tx: Tx;
}) {
    const { run, tx } = props;
    return (
        <li className={`session-run run-${run.state}`} data-run={run.id}>
            <div className="session-row">
                <span className={`session-status run-state-${run.state}`}>{tx.runStates[run.state]}</span>
                <span className="muted small">
                    {tx.queuedBy(props.nameOf(run.queuedBy))} · {time(run.queuedAt)}
                </span>
                {props.canCancel && (
                    <button className="small" onClick={props.onCancel}>
                        {tx.cancelRun}
                    </button>
                )}
            </div>
            <ol className="session-run-requests">
                {run.input.requests.map((r) => (
                    <li key={r.request}>
                        <TargetLabel target={r.target} tx={tx} />: <span className="session-body-text">{r.body}</span>
                    </li>
                ))}
            </ol>
            {run.input.note && (
                <p className="small">
                    <span className="muted">{tx.note}: </span>
                    {run.input.note}
                </p>
            )}
            {run.state === 'NeedsClarification' && (
                <p className="small">
                    <span className="muted">{tx.question}: </span>
                    {run.question}
                </p>
            )}
            {run.state === 'Failed' && <p className="small session-error">{tx.failureReasons[run.reason]}</p>}
            {run.state === 'Completed' && <p className="small">{run.changed ? tx.changed : tx.unchanged}</p>}
            {(run.state === 'Completed' || run.state === 'Failed') && run.report && <Report report={run.report} tx={tx} />}
            {props.base && props.result && <ValidationDiff before={props.base.validation} after={props.result.validation} tx={tx} />}
        </li>
    );
}

function Report({ report, tx }: { report: NonNullable<Extract<RunJson, { state: 'Failed' }>['report']>; tx: Tx }) {
    const yes = (b: boolean): string => (b ? tx.yes : tx.no);
    return (
        <table className="session-table small">
            <caption className="muted">{tx.report}</caption>
            <tbody>
                <tr>
                    <th>{tx.reportRows.exitCode}</th>
                    <td>{report.exitCode}</td>
                </tr>
                <tr>
                    <th>{tx.reportRows.formatted}</th>
                    <td>{yes(report.formatted)}</td>
                </tr>
                <tr>
                    <th>{tx.reportRows.checked}</th>
                    <td>{yes(report.checked)}</td>
                </tr>
                <tr>
                    <th>{tx.reportRows.newDtErrors}</th>
                    <td>{report.newDtErrors}</td>
                </tr>
                <tr>
                    <th>{tx.reportRows.unparsedDtes}</th>
                    <td>{report.unparsedDtes}</td>
                </tr>
            </tbody>
        </table>
    );
}

const VALIDATION_ROWS = ['dtErrors', 'dtesErrors', 'dtesWarnings', 'linkWarnings'] as const;

function ValidationDiff({ before, after, tx }: { before: Validation; after: Validation; tx: Tx }) {
    return (
        <table className="session-table small">
            <caption className="muted">{tx.diagnostics}</caption>
            <tbody>
                {VALIDATION_ROWS.map((k) => (
                    <tr key={k} className={after[k] > before[k] ? 'worse' : after[k] < before[k] ? 'better' : ''}>
                        <th>{tx.validationRows[k]}</th>
                        <td>
                            {before[k]} → {after[k]}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
