import { PanelLeftClose } from 'lucide-react';
import type { ReactNode } from 'react';
import type { DomainModel, ModelDiff } from '@domaintrail/modeling';
import type { Diagnostic } from '@domaintrail/kernel';
import type { DisplayMode } from '@domaintrail/visualization';
import { useT } from './i18n';
import { namer, type Select } from './model-utils';

/** The head of a list of the left pane: its title, what else it holds, and the button collapsing the pane. */
function ListHead({ title, children, onClose }: { title: ReactNode; children?: ReactNode; onClose: () => void }) {
    const t = useT();
    return (
        <div className="list-head">
            <span className="list-title">{title}</span>
            {children}
            <button className="icon-button" onClick={onClose} data-tooltip={t.closeExplorer} aria-label={t.closeExplorer}>
                <PanelLeftClose size={16} aria-hidden />
            </button>
        </div>
    );
}

/** How many errors and warnings there are (the badges of the activity bar). */
export function problemCounts(diagnostics: readonly Diagnostic[]): { errors: number; warnings: number } {
    const errors = diagnostics.filter((d) => d.severity === 'error').length;
    return { errors, warnings: diagnostics.length - errors };
}

/** How many items were added, changed or removed since the baseline. */
export const changeCount = (diff: ModelDiff): number => diff.added.length + diff.changed.length + diff.removed.length;

/** The 問題 list of the left pane: every diagnostic, a click locating it. */
export function ProblemsList({ items, onLocate, onClose }: { items: readonly Diagnostic[]; onLocate: (d: Diagnostic) => void; onClose: () => void }) {
    const t = useT();
    const { errors, warnings } = problemCounts(items);
    return (
        <div className="list">
            <ListHead title={t.problems} onClose={onClose}>
                {errors > 0 && <span className="count count-error">{errors}</span>}
                {warnings > 0 && <span className="count count-warning">{warnings}</span>}
            </ListHead>
            <div className="list-body">
                {items.length === 0 ? (
                    <p className="muted pad">{t.noProblems}</p>
                ) : (
                    <ul className="problems">
                        {items.map((d, i) => (
                            <li key={i}>
                                <button className={`problem problem-${d.severity}`} onClick={() => onLocate(d)}>
                                    <span className="problem-icon" aria-label={t.severity[d.severity]}>
                                        {d.severity === 'error' ? '✕' : '!'}
                                    </span>
                                    <span className="problem-main">
                                        <span className="problem-msg">{d.message}</span>
                                        {d.hint && <span className="problem-hint">{d.hint}</span>}
                                        <span className="problem-where muted">
                                            <code>{d.code}</code> {d.file}:{d.start.line}:{d.start.column}
                                            {d.elementId && ` · ${d.elementId}`}
                                        </span>
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}

/**
 * The 差分 list of the left pane: what the model is compared with (`picker`, the baseline's button opening its menu)
 * at its top, then the items added, changed and removed since then; a removed item opens in the inspector as it was in
 * the baseline.
 */
export function ChangesList(props: {
    diff: ModelDiff;
    model: DomainModel | null;
    mode: DisplayMode;
    /** The baseline's name, and whether it is a git revision (else the previous save). */
    baseline?: string;
    gitBaseline?: boolean;
    picker: ReactNode;
    onSelect: Select;
    onClose: () => void;
}) {
    const { diff, model, mode, baseline } = props;
    const t = useT();
    const total = changeCount(diff);
    const name = namer(mode, model).id;
    const groups: [keyof ModelDiff, string][] = [
        ['added', t.added],
        ['changed', t.changed],
        ['removed', t.removed],
    ];
    return (
        <div className="list">
            <ListHead title={t.changes} onClose={props.onClose}>
                {total > 0 && <span className="count">{total}</span>}
            </ListHead>
            <div className="list-picker">{props.picker}</div>
            <div className="list-body">
                {total === 0 ? (
                    <p className="muted pad">{props.gitBaseline && baseline ? t.noChangesSince(baseline) : t.noChanges}</p>
                ) : (
                    groups
                        .filter(([key]) => diff[key].length > 0)
                        .map(([key, label]) => (
                            <section key={key} className="changes-group">
                                <h3>
                                    {label} <span className="muted">{diff[key].length}</span>
                                </h3>
                                <ul>
                                    {diff[key].map((id) => (
                                        <li key={id} className={`diffrow diffrow-${key}`}>
                                            <a onClick={() => props.onSelect(id)}>{key === 'removed' ? id : name(id)}</a>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        ))
                )}
            </div>
        </div>
    );
}
