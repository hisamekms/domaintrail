import { GitCompare, PanelBottomClose, PanelBottomOpen } from 'lucide-react';
import type { Diagnostic } from '@domaintrail/modeling/core/diagnostics';
import { useT } from './i18n';
import type { ModelDiff } from '@domaintrail/visualization/domain/graph/diff';
import type { DomainModel } from '@domaintrail/modeling/model/model';
import type { DisplayMode } from '@domaintrail/visualization/domain/graph/ir';
import { namer, type Select } from './model-utils';

export type BottomTab = 'problems' | 'changes';

/** Bottom pane: problems (diagnostics) and changes since the baseline. Collapsed to its tab bar. */
export function BottomPanel(props: {
    tab: BottomTab;
    mode: DisplayMode;
    open: boolean;
    model: DomainModel | null;
    diagnostics: Diagnostic[];
    diff: ModelDiff;
    /** The baseline's name, and whether it is a git revision (else the previous save). */
    baseline?: string;
    gitBaseline?: boolean;
    /** Opens (or closes) the menu choosing the baseline, next to the heading; absent: the baseline cannot be changed here. */
    onBaseline?: (anchor: HTMLElement) => void;
    onTab: (tab: BottomTab) => void;
    onToggle: () => void;
    onLocate: (d: Diagnostic) => void;
    onSelect: Select;
}) {
    const t = useT();
    const errors = props.diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = props.diagnostics.length - errors;
    const changes = props.diff.added.length + props.diff.changed.length + props.diff.removed.length;
    const pick = (tab: BottomTab) => {
        if (props.open && props.tab === tab) props.onToggle();
        else {
            props.onTab(tab);
            if (!props.open) props.onToggle();
        }
    };
    return (
        <div className="bottom">
            <div className="bottom-bar">
                <button className={props.open && props.tab === 'problems' ? 'active' : ''} onClick={() => pick('problems')}>
                    {t.problems}
                    {errors > 0 && <span className="count count-error">{errors}</span>}
                    {warnings > 0 && <span className="count count-warning">{warnings}</span>}
                    {errors + warnings === 0 && <span className="muted"> 0</span>}
                </button>
                <button className={props.open && props.tab === 'changes' ? 'active' : ''} onClick={() => pick('changes')}>
                    {t.changes} {changes > 0 ? <span className="count">{changes}</span> : <span className="muted">0</span>}
                </button>
                <button
                    className="icon-button bottom-toggle"
                    onClick={props.onToggle}
                    data-tooltip={props.open ? t.closeBottom : t.openBottom}
                    aria-label={props.open ? t.closeBottom : t.openBottom}
                >
                    {props.open ? <PanelBottomClose size={16} aria-hidden /> : <PanelBottomOpen size={16} aria-hidden />}
                </button>
            </div>
            {/* kept while closed, so that it slides out with the pane */}
            <div className="bottom-body" inert={!props.open}>
                {props.tab === 'problems' ? <Problems items={props.diagnostics} onLocate={props.onLocate} /> : <Changes {...props} />}
            </div>
        </div>
    );
}

function Problems({ items, onLocate }: { items: Diagnostic[]; onLocate: (d: Diagnostic) => void }) {
    const t = useT();
    if (items.length === 0) return <p className="muted pad">{t.noProblems}</p>;
    return (
        <table className="problems">
            <tbody>
                {items.map((d, i) => (
                    <tr key={i} className={`problem problem-${d.severity}`} onClick={() => onLocate(d)}>
                        <td className="problem-icon">{d.severity === 'error' ? '✕' : '!'}</td>
                        <td>
                            <code>{d.code}</code>
                        </td>
                        <td className="problem-msg">
                            {d.message}
                            {d.hint && <div className="problem-hint">{d.hint}</div>}
                        </td>
                        <td className="muted nowrap">
                            {d.file}:{d.start.line}:{d.start.column}
                        </td>
                        <td className="muted nowrap">{d.elementId ?? ''}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function Changes({
    diff,
    model,
    mode,
    baseline,
    gitBaseline,
    onBaseline,
    onSelect,
}: {
    diff: ModelDiff;
    model: DomainModel | null;
    mode: DisplayMode;
    baseline?: string;
    gitBaseline?: boolean;
    onBaseline?: (anchor: HTMLElement) => void;
    onSelect: Select;
}) {
    const t = useT();
    // what the changes are relative to; a click opens the menu that changes it
    const heading = baseline && (
        <button
            className="changes-baseline"
            aria-haspopup="listbox"
            disabled={!onBaseline}
            onClick={(e) => onBaseline?.(e.currentTarget)}
            data-tooltip={t.changeBaseline}
        >
            <GitCompare size={14} aria-hidden />
            {t.changesSince(baseline)}
            <span aria-hidden>▾</span>
        </button>
    );
    if (!diff.added.length && !diff.changed.length && !diff.removed.length) {
        return (
            <div className="pad">
                {heading}
                <p className="muted">{gitBaseline && baseline ? t.noChangesSince(baseline) : t.noChanges}</p>
            </div>
        );
    }
    const name = namer(mode, model).id;
    const groups: [keyof ModelDiff, string][] = [
        ['added', t.added],
        ['changed', t.changed],
        ['removed', t.removed],
    ];
    return (
        <div className="changes-wrap">
            {heading}
            <div className="changes">
                {groups.map(([key, label]) => (
                    <div key={key} className="changes-col">
                        <h3>
                            {label} <span className="muted">{diff[key].length}</span>
                        </h3>
                        {diff[key].map((id) => (
                            <div key={id} className={`sub diffrow diffrow-${key}`}>
                                {/* a removed item opens in the inspector as it was in the baseline */}
                                <a onClick={() => onSelect(id)}>{key === 'removed' ? id : name(id)}</a>
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}
