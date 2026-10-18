import { Eye, EyeDashed, EyeOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DisplayMode } from '../src/graph/ir';
import { useDismiss } from './layout';
import { nameIn } from './model-utils';

/**
 * Toolbar dropdown that picks the bounded contexts to draw. With some but not all selected, the eye of each other
 * context shows or hides it as stubs. The first row selects, shows or hides them all.
 */
export function ContextPicker(props: {
    contexts: string[];
    labels: Record<string, string>;
    selected: string[];
    /** Contexts not drawn as stubs (only ones that are not selected). */
    hidden: string[];
    mode: DisplayMode;
    onChange: (selected: string[]) => void;
    onHiddenChange: (hidden: string[]) => void;
}) {
    const { contexts, labels, selected, hidden, mode, onChange, onHiddenChange } = props;
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);

    useDismiss(open, root, useCallback(() => setOpen(false), []));

    const name = (c: string) => nameIn(mode, c, labels[c]);
    const all = selected.length === contexts.length;
    const summary =
        (all ? 'すべての BC' : selected.length === 0 ? 'なし' : selected.length <= 2 ? selected.map(name).join('、') : `${name(selected[0])} ほか ${selected.length - 1} BC`) +
        (hidden.length ? ` · ${hidden.length} BC 非表示` : '');
    const toggle = (c: string) => onChange(selected.includes(c) ? selected.filter((x) => x !== c) : contexts.filter((x) => x === c || selected.includes(x)));
    const toggleHidden = (c: string) => onHiddenChange(hidden.includes(c) ? hidden.filter((x) => x !== c) : contexts.filter((x) => x === c || hidden.includes(x)));
    /** The contexts the eyes apply to: the ones drawn as stubs, so none when all or none are selected. */
    const stubs = selected.length === 0 ? [] : contexts.filter((c) => !selected.includes(c));
    const allHidden = stubs.length > 0 && stubs.every((c) => hidden.includes(c));
    const someHidden = hidden.length > 0 && !allHidden;
    const checkAll = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (checkAll.current) checkAll.current.indeterminate = !all && selected.length > 0;
    });

    return (
        <div className="context-picker" ref={root}>
            <button aria-haspopup="listbox" aria-expanded={open} aria-label="表示する BC" onClick={() => setOpen(!open)}>
                BC: {summary} ▾
            </button>
            {open && (
                <div className="context-picker-menu" role="listbox" aria-multiselectable>
                    <div className="context-picker-row context-picker-all">
                        <label className="check">
                            <input ref={checkAll} type="checkbox" checked={all} onChange={() => onChange(all ? [] : contexts)} />
                            すべての BC
                        </label>
                        <button
                            className="icon-button"
                            disabled={stubs.length === 0}
                            aria-label="スタブをまとめて表示"
                            title={stubs.length === 0 ? undefined : hidden.length ? 'すべてスタブとして表示する' : 'すべてのスタブを表示しない'}
                            onClick={() => onHiddenChange(hidden.length ? [] : stubs)}
                        >
                            {allHidden ? <EyeOff size={14} aria-hidden /> : someHidden ? <EyeDashed size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
                        </button>
                    </div>
                    {contexts.map((c) => {
                        const isHidden = hidden.includes(c);
                        // the eye applies to stubs only: not without a selection, nor to a selected context
                        const eyeDisabled = selected.length === 0 || selected.includes(c);
                        return (
                            <div key={c} className={`context-picker-row${isHidden ? ' context-hidden' : ''}`}>
                                <label className="check" role="option" aria-selected={selected.includes(c)}>
                                    <input type="checkbox" checked={selected.includes(c)} onChange={() => toggle(c)} />
                                    {name(c)}
                                </label>
                                <button
                                    className="icon-button"
                                    disabled={eyeDisabled}
                                    aria-pressed={!isHidden}
                                    aria-label={`${name(c)} をスタブとして表示`}
                                    title={eyeDisabled ? undefined : isHidden ? 'スタブとして表示する' : 'スタブを表示しない'}
                                    onClick={() => toggleHidden(c)}
                                >
                                    {isHidden ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
