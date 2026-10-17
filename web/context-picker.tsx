import { useEffect, useRef, useState } from 'react';
import type { DisplayMode } from '../src/graph/ir';
import { nameIn } from './model-utils';

/** Toolbar dropdown that picks any number of bounded contexts; none selected means every context. */
export function ContextPicker(props: {
    contexts: string[];
    labels: Record<string, string>;
    selected: string[];
    mode: DisplayMode;
    onChange: (selected: string[]) => void;
}) {
    const { contexts, labels, selected, mode, onChange } = props;
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);

    // close on a click outside or on Escape
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const name = (c: string) => nameIn(mode, c, labels[c]);
    const summary =
        selected.length === 0 ? 'すべての BC' : selected.length <= 2 ? selected.map(name).join('、') : `${name(selected[0])} ほか ${selected.length - 1} BC`;
    const toggle = (c: string) => onChange(selected.includes(c) ? selected.filter((x) => x !== c) : contexts.filter((x) => x === c || selected.includes(x)));

    return (
        <div className="context-picker" ref={root}>
            <button aria-haspopup="listbox" aria-expanded={open} aria-label="表示する BC" onClick={() => setOpen(!open)}>
                BC: {summary} ▾
            </button>
            {open && (
                <div className="context-picker-menu" role="listbox" aria-multiselectable>
                    {contexts.map((c) => (
                        <label key={c} className="check" role="option" aria-selected={selected.includes(c)}>
                            <input type="checkbox" checked={selected.includes(c)} onChange={() => toggle(c)} />
                            {name(c)}
                        </label>
                    ))}
                    <div className="context-picker-actions">
                        <button disabled={selected.length === 0} onClick={() => onChange([])}>
                            すべての BC を表示
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
