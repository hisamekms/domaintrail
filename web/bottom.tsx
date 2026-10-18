import { PanelBottomClose, PanelBottomOpen } from 'lucide-react';
import type { Diagnostic } from '../src/core/diagnostics';
import type { ModelDiff } from '../src/graph/diff';
import type { DomainModel } from '../src/model/model';
import type { DisplayMode } from '../src/graph/ir';
import { namer, type Select } from './model-utils';

export type BottomTab = 'problems' | 'changes';

/** Bottom pane: problems (diagnostics) and changes since the previous model. Collapsed to its tab bar. */
export function BottomPanel(props: {
    tab: BottomTab;
    mode: DisplayMode;
    open: boolean;
    model: DomainModel | null;
    diagnostics: Diagnostic[];
    diff: ModelDiff;
    onTab: (tab: BottomTab) => void;
    onToggle: () => void;
    onLocate: (d: Diagnostic) => void;
    onSelect: Select;
}) {
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
                    問題
                    {errors > 0 && <span className="count count-error">{errors}</span>}
                    {warnings > 0 && <span className="count count-warning">{warnings}</span>}
                    {errors + warnings === 0 && <span className="muted"> 0</span>}
                </button>
                <button className={props.open && props.tab === 'changes' ? 'active' : ''} onClick={() => pick('changes')}>
                    変更 {changes > 0 ? <span className="count">{changes}</span> : <span className="muted">0</span>}
                </button>
                <button
                    className="icon-button bottom-toggle"
                    onClick={props.onToggle}
                    title={props.open ? '問題・変更を閉じる' : '問題・変更を開く'}
                    aria-label={props.open ? '問題・変更を閉じる' : '問題・変更を開く'}
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
    if (items.length === 0) return <p className="muted pad">問題はありません。</p>;
    return (
        <table className="problems">
            <tbody>
                {items.map((d, i) => (
                    <tr key={i} className={`problem problem-${d.severity}`} onClick={() => onLocate(d)}>
                        <td className="problem-icon">{d.severity === 'error' ? '✕' : '!'}</td>
                        <td>
                            <code>{d.code}</code>
                        </td>
                        <td className="problem-msg">{d.message}</td>
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

function Changes({ diff, model, mode, onSelect }: { diff: ModelDiff; model: DomainModel | null; mode: DisplayMode; onSelect: Select }) {
    if (!diff.added.length && !diff.changed.length && !diff.removed.length) {
        return <p className="muted pad">直前の正常モデルからの変更はありません。</p>;
    }
    const name = namer(mode, model).id;
    const groups: [keyof ModelDiff, string][] = [
        ['added', '追加'],
        ['changed', '変更'],
        ['removed', '削除'],
    ];
    return (
        <div className="changes">
            {groups.map(([key, label]) => (
                <div key={key} className="changes-col">
                    <h3>
                        {label} <span className="muted">{diff[key].length}</span>
                    </h3>
                    {diff[key].map((id) => (
                        <div key={id} className={`sub diffrow diffrow-${key}`}>
                            {key === 'removed' ? <span>{id}</span> : <a onClick={() => onSelect(id)}>{name(id)}</a>}
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
}
