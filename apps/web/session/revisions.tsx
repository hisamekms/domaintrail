// The revisions as the chat's menus reach them (ADR 0026, S7 and the amendments "messages and apply" and "changes in the
// model's words"): what a unit of work changed, in a dialog — the model's elements added, changed and removed, then,
// folded, the comparison of its two revisions (each changed file's status and line diff, `.dt` and `.dtes` together,
// and the validations when either has a finding); and, for the facilitator, confirming (a mark, never a gate),
// recording the current state and restoring, with the two-step for external changes and the way through a run in
// progress. The words are the unit's: a revision
// and its number are only in tooltips and in the source diff.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { ComparedFileBody, ComparisonBody, SessionStateBody } from '@domaintrail/collaboration/protocol';
import { useT, type Messages } from '../i18n';
import { sessionApi, SessionApiError } from './api';
import { ChangeChip } from './card';
import { changeGroups, changeKey, changeWhat, useModelChanges } from './changes';
import { useTargetNaming } from './naming';
import { diffLines, restoreProblem, timeline, type TimelineEntry } from './timeline';

type Tx = Messages['session'];
type RevisionJson = SessionStateBody['revisions'][number];
type Validation = RevisionJson['validation'];

const VALIDATION_ROWS = ['dtErrors', 'dtesErrors', 'dtesWarnings', 'linkWarnings'] as const;
const LANGUAGES = ['Dt', 'Dtes'] as const;

const failure = (e: unknown): string => (e instanceof SessionApiError ? (e.message && e.message !== e.type ? `${e.type}: ${e.message}` : e.type) : String(e));
const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** What a restore goes back to: the state before a unit of work, or the one kept before a restore that failed midway. */
export type RestorePoint = 'work' | 'preRestore';

/** Where a restore stands: what the facilitator is asked next. */
type RestoreFlow = { readonly what: RestorePoint } & (
    | { readonly step: 'confirm'; readonly revision: string }
    | { readonly step: 'external'; readonly revision: string; readonly paths: readonly string[] }
    | { readonly step: 'run'; readonly revision: string; readonly run: string; readonly cancelled: boolean }
    | { readonly step: 'manual'; readonly revision: string; readonly preRestore: string; readonly cause: string; readonly message: string }
    | { readonly step: 'done'; readonly revision: string; readonly restored: string }
    | { readonly step: 'failed'; readonly revision: string; readonly message: string }
);

/** The changes of a unit of work: its revisions before and after, and the unit as the dialog names it. */
export interface ChangesSubject {
    readonly base: string;
    readonly result: string;
    /** Its name, whose messages and when, on one line. */
    readonly about: string;
}

/** What the chat's menus do with revisions: compare two, confirm one, restore one (asked first), record the workspace. */
export interface RevisionTools {
    /** The restore's box, while one is under way: placed in the chat. */
    readonly node: ReactNode;
    /** The changes' dialog, while one is open: placed outside the tabs, so that AI の作業 opens it too. */
    readonly dialog: ReactNode;
    showChanges(subject: ChangesSubject): void;
    confirm(revision: string): void;
    restore(revision: string): void;
    take(): void;
    /** A revision's number in the session (`#3`), for tooltips. */
    number(id: string): string;
}

/**
 * The facilitator's revision actions in the chat (ADR 0026, amendment): confirming (a mark, never a gate), recording
 * the current state and restoring, with the two-step for external changes and the way through a run in progress, and
 * the changes of a unit in a dialog. The server checks the role anyway.
 */
export function useRevisionTools(state: SessionStateBody, tx: Tx): RevisionTools {
    const entries = timeline(state);
    const numberOf = new Map(entries.map((e) => [e.revision.id, e.number]));
    const [showing, setShowing] = useState<ChangesSubject | undefined>();
    const [flow, setFlow] = useState<RestoreFlow | undefined>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const n = (id: string): string => String(numberOf.get(id) ?? '?');

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
    const restore = async (what: RestorePoint, revision: string, recordExternalChanges: boolean): Promise<void> => {
        setBusy(true);
        try {
            const r = await sessionApi.restoreRevision(revision, recordExternalChanges);
            setFlow({ what, step: 'done', revision, restored: r.restored.id });
        } catch (e) {
            const p = restoreProblem(e);
            if (p.kind === 'external') setFlow({ what, step: 'external', revision, paths: p.paths });
            else if (p.kind === 'run') setFlow({ what, step: 'run', revision, run: p.run, cancelled: false });
            else if (p.kind === 'manual') setFlow({ what, step: 'manual', revision, preRestore: p.preRestore, cause: p.cause, message: p.message });
            else setFlow({ what, step: 'failed', revision, message: p.message });
        } finally {
            setBusy(false);
        }
    };
    const cancelRun = async (what: RestorePoint, revision: string, run: string): Promise<void> => {
        if (await act(() => sessionApi.cancelRun(run))) setFlow({ what, step: 'run', revision, run, cancelled: true });
    };

    const node = (
        <>
            {flow && (
                <RestoreBox
                    flow={flow}
                    busy={busy}
                    onRestore={(revision, record) => void restore(flow.what, revision, record)}
                    onAsk={(revision) => setFlow({ what: 'preRestore', step: 'confirm', revision })}
                    onCancelRun={(revision, run) => void cancelRun(flow.what, revision, run)}
                    onClose={() => setFlow(undefined)}
                    tx={tx}
                />
            )}
            {error && (
                <p className="session-note session-error" role="status">
                    {tx.error(error)}
                </p>
            )}
        </>
    );
    return {
        node,
        dialog: showing && <ChangesDialog subject={showing} n={n} entries={entries} onClose={() => setShowing(undefined)} />,
        showChanges: setShowing,
        confirm: (revision) => void act(() => sessionApi.confirmRevision(revision)),
        restore: (revision) => setFlow({ what: 'work', step: 'confirm', revision }),
        take: () => void act(() => sessionApi.takeRevision()),
        number: n,
    };
}

function RestoreBox(props: {
    flow: RestoreFlow;
    busy: boolean;
    onRestore: (revision: string, recordExternalChanges: boolean) => void;
    onAsk: (revision: string) => void;
    onCancelRun: (revision: string, run: string) => void;
    onClose: () => void;
    tx: Tx;
}) {
    const { flow, busy, tx } = props;
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
                    text: r.confirm(flow.what),
                    actions: (
                        <button className="primary session-restore-confirm" disabled={busy} onClick={() => props.onRestore(flow.revision, false)}>
                            {r.restore(flow.what)}
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
                          text: r.run,
                          actions: (
                              <button className="primary session-restore-cancel-run" disabled={busy} onClick={() => props.onCancelRun(flow.revision, flow.run)}>
                                  {r.cancelRun}
                              </button>
                          ),
                      };
            case 'manual':
                return {
                    text: r.manual(`${flow.cause}: ${flow.message}`),
                    error: true,
                    actions: (
                        <button className="small" disabled={busy} onClick={() => props.onAsk(flow.preRestore)}>
                            {r.restorePre}
                        </button>
                    ),
                };
            case 'done':
                return { text: r.done(flow.what), actions: null };
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

/**
 * この作業の変更: the unit's name, whose messages and when; the elements it added, changed and removed (only the groups it
 * has), each with what it is, a click closing the dialog and going to it; at the bottom, folded, the source diff — the
 * comparison of the two revisions, asked for when it is first opened. When the model could not be
 * compared, a line says so and the source diff is open.
 */
function ChangesDialog(props: { subject: ChangesSubject; n: (id: string) => string; entries: readonly TimelineEntry[]; onClose: () => void }) {
    const { subject, n, onClose } = props;
    const t = useT();
    const tx = t.session;
    const c = tx.comparison;
    const naming = useTargetNaming();
    const dialog = useRef<HTMLDialogElement>(null);
    const changes = useModelChanges(subject.base, subject.result);
    // closed, but open by itself when the model could not be compared, until the facilitator toggles it
    const [sourceOpen, setSourceOpen] = useState<boolean | undefined>();
    const [data, setData] = useState<ComparisonBody | undefined>();
    const [error, setError] = useState<string | undefined>();
    const { base: before, result: after } = subject;
    const compared = changes.kind === 'loaded' && changes.body.complete;
    const unreadable = (changes.kind === 'loaded' && !changes.body.complete) || changes.kind === 'failed';
    const showSource = sourceOpen ?? unreadable;

    // a modal <dialog>: focus trapped, Escape closes it
    useEffect(() => {
        const d = dialog.current;
        if (d && !d.open) d.showModal();
        return () => d?.close();
    }, []);
    // the source diff is asked for once it is shown
    useEffect(() => {
        if (!showSource) return;
        let current = true;
        setData(undefined);
        sessionApi.compareRevisions(before, after).then(
            (body) => current && setData(body),
            (e: unknown) => current && setError(failure(e)),
        );
        return () => {
            current = false;
        };
    }, [before, after, showSource]);

    const heading = (id: string): string => {
        const e = props.entries.find((x) => x.revision.id === id);
        return e ? `#${e.number} ${tx.origins[e.revision.origin.kind]} · ${time(e.revision.takenAt)}` : `#${n(id)}`;
    };

    return (
        <dialog
            ref={dialog}
            className="session-dialog session-comparison session-changes"
            aria-labelledby="session-changes-title"
            onClose={onClose}
            onClick={(e) => e.target === e.currentTarget && onClose()}
        >
            <div className="settings-dialog-header">
                <div className="session-changes-heading">
                    <h2 id="session-changes-title">{c.title}</h2>
                    <p className="session-changes-about">{subject.about}</p>
                </div>
                <button className="icon-button" aria-label={c.close} data-tooltip={c.close} onClick={onClose}>
                    <X size={18} aria-hidden />
                </button>
            </div>
            <div className="settings-dialog-body session-comparison-body">
                {changes.kind === 'loading' && <p className="muted">{c.loading}</p>}
                {unreadable && <p className="session-changes-note">{c.notCompared}</p>}
                {changes.kind === 'loaded' &&
                    changeGroups(changes.body.changes).map((g) => (
                        <section key={g.change} className="session-changes-group">
                            <h3>{c.groups[g.change]}</h3>
                            <ul>
                                {g.items.map((item) => (
                                    <li key={changeKey(item)}>
                                        <ChangeChip change={item} onPick={onClose} />
                                        <span className="session-changes-what">{changeWhat(item, t, c.of, naming)}</span>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}
                {compared && changes.body.changes.length === 0 && <p className="session-changes-note">{c.noElementChanges}</p>}
                <details className="session-changes-source" open={showSource} onToggle={(e) => setSourceOpen(e.currentTarget.open)}>
                    <summary>{c.sourceDiff}</summary>
                    {showSource && (
                        <>
                            <p className="muted">
                                {heading(before)} → {heading(after)}
                            </p>
                            {error && <p className="session-note session-error">{tx.error(error)}</p>}
                            {!data && !error && <p className="muted">{c.loading}</p>}
                            {data && <ComparisonView data={data} n={n} tx={tx} />}
                        </>
                    )}
                </details>
            </div>
        </dialog>
    );
}

function ComparisonView({ data, n, tx }: { data: ComparisonBody; n: (id: string) => string; tx: Tx }) {
    const c = tx.comparison;
    // only the files that changed, by language; the validations only when either side has a finding
    const changed = data.files.filter((f) => f.status !== 'unchanged');
    const findings = VALIDATION_ROWS.some((k) => data.before.validation[k] > 0 || data.after.validation[k] > 0);
    return (
        <>
            {findings && (
                <ValidationSides
                    before={data.before.validation}
                    after={data.after.validation}
                    labels={[`#${n(data.before.id)}`, `#${n(data.after.id)}`]}
                    tx={tx}
                />
            )}
            {data.diffsOmitted && <p className="session-note">{c.omitted}</p>}
            {changed.length === 0 && <p className="muted small">{c.noChanges}</p>}
            {LANGUAGES.map((lang) => {
                const files = changed.filter((f) => f.language === lang);
                if (files.length === 0) return null;
                const counts = data.counts[lang];
                return (
                    <section key={lang} className={`session-comparison-language lang-${lang}`}>
                        <h3>
                            {c.languages[lang]}{' '}
                            <span className="muted small">
                                {(['added', 'removed', 'changed'] as const).map((s) => `${c.statuses[s]} ${counts[s]}`).join(' · ')}
                            </span>
                        </h3>
                        {files.map((f) => (
                            <FileDiff key={f.path} file={f} tx={tx} />
                        ))}
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
