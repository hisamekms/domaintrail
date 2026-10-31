// The revision timeline of the session panel (ADR 0026, S7): every revision with its origin, time, validation per DSL
// and confirmed mark; two chosen revisions compared in a dialog (each file's status and line diff, `.dt` and `.dtes`
// together); and, for the facilitator, confirming (a mark, never a gate), recording the current state and restoring,
// with the two-step for external changes and the way through a run in progress. Participants see it all read-only;
// the server checks the role anyway.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { ComparedFileBody, ComparisonBody, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { useT, type Messages } from '../i18n';
import { sessionApi, SessionApiError } from './api';
import { chooseForComparison, comparisonPair, diffLines, restoreProblem, timeline, type OriginDetail, type TimelineEntry } from './timeline';

type Tx = Messages['session'];
type RevisionJson = SessionStateBody['revisions'][number];
type Validation = RevisionJson['validation'];

const VALIDATION_ROWS = ['dtErrors', 'dtesErrors', 'dtesWarnings', 'linkWarnings'] as const;
const LANGUAGES = ['Dt', 'Dtes'] as const;

const failure = (e: unknown): string => (e instanceof SessionApiError ? (e.message && e.message !== e.type ? `${e.type}: ${e.message}` : e.type) : String(e));
const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Where a restore stands: what the facilitator is asked next. */
type RestoreFlow =
    | { readonly step: 'confirm'; readonly revision: string }
    | { readonly step: 'external'; readonly revision: string; readonly paths: readonly string[] }
    | { readonly step: 'run'; readonly revision: string; readonly run: string; readonly cancelled: boolean }
    | { readonly step: 'manual'; readonly revision: string; readonly preRestore: string; readonly cause: string; readonly message: string }
    | { readonly step: 'done'; readonly revision: string; readonly restored: string }
    | { readonly step: 'failed'; readonly revision: string; readonly message: string };

export function Revisions(props: { state: SessionStateBody; facilitator: boolean; live: boolean; nameOf: (id: string) => string; tx: Tx }) {
    const { state, facilitator, live, nameOf, tx } = props;
    const entries = timeline(state);
    const numberOf = new Map(entries.map((e) => [e.revision.id, e.number]));
    const runNumber = (id: string): number | undefined => {
        const i = [...state.runs].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)).findIndex((r) => r.id === id);
        return i < 0 ? undefined : i + 1;
    };
    const [chosen, setChosen] = useState<readonly string[]>([]);
    const [comparing, setComparing] = useState<readonly [string, string] | undefined>();
    const [flow, setFlow] = useState<RestoreFlow | undefined>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const pair = comparisonPair(chosen, state.revisions);
    const control = facilitator && live;

    const act = async (f: () => Promise<unknown>): Promise<boolean> => {
        setBusy(true);
        try {
            await f();
            setError(undefined);
            return true;
        } catch (e) {
            setError(failure(e));
            return false;
        } finally {
            setBusy(false);
        }
    };

    const restore = async (revision: string, recordExternalChanges: boolean): Promise<void> => {
        setBusy(true);
        try {
            const r = await sessionApi.restoreRevision(revision, recordExternalChanges);
            setFlow({ step: 'done', revision, restored: r.restored.id });
        } catch (e) {
            const p = restoreProblem(e);
            if (p.kind === 'external') setFlow({ step: 'external', revision, paths: p.paths });
            else if (p.kind === 'run') setFlow({ step: 'run', revision, run: p.run, cancelled: false });
            else if (p.kind === 'manual') setFlow({ step: 'manual', revision, preRestore: p.preRestore, cause: p.cause, message: p.message });
            else setFlow({ step: 'failed', revision, message: p.message });
        } finally {
            setBusy(false);
        }
    };

    const cancelRun = async (revision: string, run: string): Promise<void> => {
        if (await act(() => sessionApi.cancelRun(run))) setFlow({ step: 'run', revision, run, cancelled: true });
    };

    const n = (id: string): string => String(numberOf.get(id) ?? '?');

    return (
        <section className="session-section session-revisions-section">
            <h3>{tx.revisions(state.revisions.length)}</h3>
            <div className="session-buttons">
                <button className="session-compare" disabled={!pair} onClick={() => pair && setComparing(pair)}>
                    {pair ? tx.compare(n(pair[0]), n(pair[1])) : tx.chooseTwo}
                </button>
                {control && (
                    <button className="session-take" disabled={busy} onClick={() => void act(() => sessionApi.takeRevision())}>
                        {tx.takeRevision}
                    </button>
                )}
            </div>
            {flow && (
                <RestoreBox
                    flow={flow}
                    busy={busy}
                    n={n}
                    runNumber={runNumber}
                    onRestore={(revision, record) => void restore(revision, record)}
                    onAsk={(revision) => setFlow({ step: 'confirm', revision })}
                    onCancelRun={(revision, run) => void cancelRun(revision, run)}
                    onClose={() => setFlow(undefined)}
                    tx={tx}
                />
            )}
            {error && <p className="session-note session-error">{tx.error(error)}</p>}
            <ol className="session-list session-revisions">
                {entries.map((e) => (
                    <RevisionItem
                        key={e.revision.id}
                        entry={e}
                        chosen={chosen.includes(e.revision.id)}
                        onChoose={(on) => setChosen((c) => chooseForComparison(c, e.revision.id, on))}
                        control={control}
                        busy={busy}
                        onConfirm={() => void act(() => sessionApi.confirmRevision(e.revision.id))}
                        onRestore={() => setFlow({ step: 'confirm', revision: e.revision.id })}
                        nameOf={nameOf}
                        tx={tx}
                    />
                ))}
            </ol>
            {comparing && <ComparisonDialog pair={comparing} n={n} entries={entries} onClose={() => setComparing(undefined)} />}
        </section>
    );
}

function originText(o: OriginDetail, nameOf: (id: string) => string, tx: Tx): string {
    const d = tx.originDetails;
    switch (o.kind) {
        case 'SessionStart':
            return tx.origins.SessionStart;
        case 'RunBase':
        case 'RunResult':
            return `${tx.origins[o.kind]} · ${d.run(o.run)}`;
        case 'Manual':
            return `${tx.origins.Manual} · ${d.by(nameOf(o.by))}`;
        case 'PreRestore':
            return `${tx.origins.PreRestore} · ${d.restoring(o.restoring)}`;
        case 'Restored':
            return `${tx.origins.Restored} · ${d.restoredFrom(o.from, o.preRestore)}`;
    }
}

function RevisionItem(props: {
    entry: TimelineEntry;
    chosen: boolean;
    onChoose: (on: boolean) => void;
    control: boolean;
    busy: boolean;
    onConfirm: () => void;
    onRestore: () => void;
    nameOf: (id: string) => string;
    tx: Tx;
}) {
    const { entry, tx } = props;
    const r = entry.revision;
    return (
        <li className={`session-revision state-${r.state}${entry.latest ? ' latest' : ''}`} data-revision={r.id} data-number={entry.number}>
            <div className="session-row">
                <input
                    type="checkbox"
                    aria-label={tx.chooseForComparison(entry.number)}
                    checked={props.chosen}
                    onChange={(e) => props.onChoose(e.target.checked)}
                />
                <span className="session-revision-number">#{entry.number}</span>
                <span className="session-revision-origin">{originText(entry.origin, props.nameOf, tx)}</span>
                <span className="muted small">{time(r.takenAt)}</span>
                {entry.latest && <span className="session-status">{tx.latest}</span>}
                {r.state === 'Confirmed' && (
                    <span className="session-status status-current session-confirmed" data-tooltip={time(r.confirmedAt)}>
                        ✓ {tx.confirmed} · {props.nameOf(r.confirmedBy)}
                    </span>
                )}
            </div>
            <div className="muted small session-validation">
                {[
                    tx.validationCounts.dt(r.validation.dtErrors),
                    tx.validationCounts.dtes(r.validation.dtesErrors, r.validation.dtesWarnings),
                    tx.validationCounts.links(r.validation.linkWarnings),
                ].join(' · ')}
                {r.validation.stale && ` · ${tx.staleValidation}`}
            </div>
            {props.control && (r.state === 'Recorded' || !entry.sameAsLatest) && (
                <div className="session-row session-revision-actions">
                    {r.state === 'Recorded' && (
                        <button className="small session-confirm" disabled={props.busy} onClick={props.onConfirm} data-tooltip={tx.confirmHint}>
                            {tx.confirm}
                        </button>
                    )}
                    {!entry.sameAsLatest && (
                        <button className="small session-restore-button" disabled={props.busy} onClick={props.onRestore}>
                            {tx.restore}
                        </button>
                    )}
                </div>
            )}
        </li>
    );
}

function RestoreBox(props: {
    flow: RestoreFlow;
    busy: boolean;
    n: (id: string) => string;
    runNumber: (id: string) => number | undefined;
    onRestore: (revision: string, recordExternalChanges: boolean) => void;
    onAsk: (revision: string) => void;
    onCancelRun: (revision: string, run: string) => void;
    onClose: () => void;
    tx: Tx;
}) {
    const { flow, busy, n, tx } = props;
    const r = tx.restoreFlow;
    const close = (
        <button className="small" onClick={props.onClose}>
            {flow.step === 'done' || flow.step === 'failed' ? r.close : r.cancel}
        </button>
    );
    const body = ((): { text: string; error?: boolean; actions: ReactNode } => {
        switch (flow.step) {
            case 'confirm':
                return {
                    text: r.confirm(n(flow.revision)),
                    actions: (
                        <button className="primary session-restore-confirm" disabled={busy} onClick={() => props.onRestore(flow.revision, false)}>
                            {r.restore(n(flow.revision))}
                        </button>
                    ),
                };
            case 'external':
                return {
                    text: r.external(flow.paths.join(', ')),
                    actions: (
                        <button className="primary session-restore-two-step" disabled={busy} onClick={() => props.onRestore(flow.revision, true)}>
                            {r.recordThenRestore}
                        </button>
                    ),
                };
            case 'run':
                return flow.cancelled
                    ? {
                          text: r.cancelled,
                          actions: (
                              <button className="primary" disabled={busy} onClick={() => props.onRestore(flow.revision, false)}>
                                  {r.retry}
                              </button>
                          ),
                      }
                    : {
                          text: r.run(props.runNumber(flow.run)),
                          actions: (
                              <button className="primary session-restore-cancel-run" disabled={busy} onClick={() => props.onCancelRun(flow.revision, flow.run)}>
                                  {r.cancelRun}
                              </button>
                          ),
                      };
            case 'manual':
                return {
                    text: r.manual(`${flow.cause}: ${flow.message}`, n(flow.preRestore)),
                    error: true,
                    actions: (
                        <button className="small" disabled={busy} onClick={() => props.onAsk(flow.preRestore)}>
                            {r.restorePre(n(flow.preRestore))}
                        </button>
                    ),
                };
            case 'done':
                return { text: r.done(n(flow.revision), n(flow.restored)), actions: null };
            case 'failed':
                return { text: r.failed(flow.message), error: true, actions: null };
        }
    })();
    return (
        <div className={`session-note session-restore step-${flow.step}${body.error ? ' session-error' : ''}`} role="status">
            <p>{body.text}</p>
            <div className="session-buttons">
                {body.actions}
                {close}
            </div>
        </div>
    );
}

function ComparisonDialog(props: { pair: readonly [string, string]; n: (id: string) => string; entries: readonly TimelineEntry[]; onClose: () => void }) {
    const { pair, n, onClose } = props;
    const t = useT();
    const tx = t.session;
    const c = tx.comparison;
    const dialog = useRef<HTMLDialogElement>(null);
    const [data, setData] = useState<ComparisonBody | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [before, after] = pair;

    // a modal <dialog>: focus trapped, Escape closes it
    useEffect(() => {
        const d = dialog.current;
        if (d && !d.open) d.showModal();
        return () => d?.close();
    }, []);
    useEffect(() => {
        let current = true;
        setData(undefined);
        sessionApi.compareRevisions(before, after).then(
            (body) => current && setData(body),
            (e: unknown) => current && setError(failure(e)),
        );
        return () => {
            current = false;
        };
    }, [before, after]);

    const heading = (id: string): string => {
        const e = props.entries.find((x) => x.revision.id === id);
        return e ? `#${e.number} ${tx.origins[e.revision.origin.kind]} · ${time(e.revision.takenAt)}` : `#${n(id)}`;
    };

    return (
        <dialog
            ref={dialog}
            className="session-dialog session-comparison"
            aria-labelledby="session-comparison-title"
            onClose={onClose}
            onClick={(e) => e.target === e.currentTarget && onClose()}
        >
            <div className="settings-dialog-header">
                <h2 id="session-comparison-title">{c.title(n(before), n(after))}</h2>
                <button className="icon-button" aria-label={c.close} data-tooltip={c.close} onClick={onClose}>
                    <X size={18} aria-hidden />
                </button>
            </div>
            <div className="settings-dialog-body session-comparison-body">
                <p className="muted">
                    {heading(before)} → {heading(after)}
                </p>
                {error && <p className="session-note session-error">{tx.error(error)}</p>}
                {!data && !error && <p className="muted">{c.loading}</p>}
                {data && <ComparisonView data={data} n={n} tx={tx} />}
            </div>
        </dialog>
    );
}

function ComparisonView({ data, n, tx }: { data: ComparisonBody; n: (id: string) => string; tx: Tx }) {
    const c = tx.comparison;
    return (
        <>
            <ValidationSides before={data.before.validation} after={data.after.validation} labels={[`#${n(data.before.id)}`, `#${n(data.after.id)}`]} tx={tx} />
            {data.diffsOmitted && <p className="session-note">{c.omitted}</p>}
            {LANGUAGES.map((lang) => {
                const files = data.files.filter((f) => f.language === lang);
                if (files.length === 0) return null;
                const counts = data.counts[lang];
                const changed = files.filter((f) => f.status !== 'unchanged');
                const unchanged = files.filter((f) => f.status === 'unchanged');
                return (
                    <section key={lang} className={`session-comparison-language lang-${lang}`}>
                        <h3>
                            {c.languages[lang]}{' '}
                            <span className="muted small">
                                {(['added', 'removed', 'changed', 'unchanged'] as const).map((s) => `${c.statuses[s]} ${counts[s]}`).join(' · ')}
                            </span>
                        </h3>
                        {changed.length === 0 && <p className="muted small">{c.noChanges}</p>}
                        {changed.map((f) => (
                            <FileDiff key={f.path} file={f} tx={tx} />
                        ))}
                        {unchanged.length > 0 && (
                            <p className="muted small session-unchanged">
                                {c.statuses.unchanged}: {unchanged.map((f) => f.path).join(', ')}
                            </p>
                        )}
                    </section>
                );
            })}
        </>
    );
}

function FileDiff({ file, tx }: { file: ComparedFileBody; tx: Tx }) {
    const c = tx.comparison;
    const diff = file.diff;
    return (
        <details className={`session-file status-${file.status}`} data-path={file.path} open>
            <summary>
                <span className="session-file-path">{file.path}</span>
                <span className={`session-status file-${file.status}`}>{c.statuses[file.status]}</span>
                {diff?.kind === 'diff' && (
                    <span className="small">
                        <span className="diff-count-add">+{diff.added}</span> <span className="diff-count-remove">−{diff.removed}</span>
                    </span>
                )}
            </summary>
            {!diff && <p className="muted small">{c.omittedFile}</p>}
            {diff?.kind === 'tooLarge' && <p className="muted small">{c.tooLarge}</p>}
            {diff?.kind === 'diff' && (
                <>
                    <pre className="session-diff">
                        {diffLines(diff.unified).map((l, i) => (
                            <span key={i} className={`diff-line diff-${l.kind}`}>
                                {l.text}
                                {'\n'}
                            </span>
                        ))}
                    </pre>
                    {diff.truncated && <p className="muted small">{c.truncated}</p>}
                </>
            )}
        </details>
    );
}

function ValidationSides({ before, after, labels, tx }: { before: Validation; after: Validation; labels: readonly [string, string]; tx: Tx }) {
    return (
        <table className="session-table session-validation-sides">
            <caption className="muted">{tx.comparison.validation}</caption>
            <thead>
                <tr>
                    <th />
                    <th>{labels[0]}</th>
                    <th>{labels[1]}</th>
                </tr>
            </thead>
            <tbody>
                {VALIDATION_ROWS.map((k) => (
                    <tr key={k} className={after[k] > before[k] ? 'worse' : after[k] < before[k] ? 'better' : ''}>
                        <th>{tx.validationRows[k]}</th>
                        <td>{before[k]}</td>
                        <td>{after[k]}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
