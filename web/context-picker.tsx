import { Eye, EyeDashed, EyeOff } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DisplayMode } from '@domaintrail/visualization/domain/graph/ir';
import { useT } from './i18n';
import { useDismiss } from './shared/layout';
import { nameIn } from './model-utils';

/**
 * Toolbar dropdown that picks the bounded contexts to draw. With some but not all selected, the eye of each other
 * context shows or hides it as stubs. The first row selects, shows or hides them all. Without `onHiddenChange` there
 * are no stubs, and so no eyes (the catalog). The button stays on one line: when narrow its summary ends in an ellipsis
 * and the whole of it shows as a tooltip.
 */
export function ContextPicker(props: {
    contexts: string[];
    labels: Record<string, string>;
    selected: string[];
    /** Contexts not drawn as stubs (only ones that are not selected). */
    hidden?: string[];
    mode: DisplayMode;
    onChange: (selected: string[]) => void;
    onHiddenChange?: (hidden: string[]) => void;
}) {
    const { contexts, labels, selected, hidden = [], mode, onChange, onHiddenChange } = props;
    const t = useT();
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);

    useDismiss(
        open,
        root,
        useCallback(() => setOpen(false), []),
    );

    const name = (c: string) => nameIn(mode, c, labels[c]);
    const all = selected.length === contexts.length;
    const summary =
        (all
            ? t.allContexts
            : selected.length === 0
              ? t.none
              : selected.length <= 2
                ? selected.map(name).join(t.listSeparator)
                : t.moreContexts(name(selected[0]), selected.length - 1)) + (hidden.length ? t.hiddenContexts(hidden.length) : '');
    const toggle = (c: string) => onChange(selected.includes(c) ? selected.filter((x) => x !== c) : contexts.filter((x) => x === c || selected.includes(x)));
    const toggleHidden = (c: string) =>
        onHiddenChange?.(hidden.includes(c) ? hidden.filter((x) => x !== c) : contexts.filter((x) => x === c || hidden.includes(x)));
    /** The contexts the eyes apply to: the ones drawn as stubs, so none when all or none are selected. */
    const stubs = selected.length === 0 ? [] : contexts.filter((c) => !selected.includes(c));
    const allHidden = stubs.length > 0 && stubs.every((c) => hidden.includes(c));
    const someHidden = hidden.length > 0 && !allHidden;
    const checkAll = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (checkAll.current) checkAll.current.indeterminate = !all && selected.length > 0;
    });
    const label = useRef<HTMLSpanElement>(null);
    const [clipped, setClipped] = useState(false);
    useLayoutEffect(() => {
        const el = label.current;
        if (!el) return;
        const check = () => setClipped(el.scrollWidth > el.clientWidth);
        check();
        const observer = new ResizeObserver(check);
        observer.observe(el);
        return () => observer.disconnect();
    }, [summary]);

    return (
        <div className="context-picker" ref={root}>
            <button
                className="context-picker-button"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={t.contextsToShow}
                data-tooltip={clipped ? `BC: ${summary}` : undefined}
                onClick={() => setOpen(!open)}
            >
                <span ref={label} className="context-picker-summary">
                    BC: {summary}
                </span>
                <span aria-hidden>▾</span>
            </button>
            {open && (
                <div className="context-picker-menu" role="listbox" aria-multiselectable>
                    <div className="context-picker-row context-picker-all">
                        <label className="check">
                            <input ref={checkAll} type="checkbox" checked={all} onChange={() => onChange(all ? [] : contexts)} />
                            {t.allContexts}
                        </label>
                        {onHiddenChange && (
                            <button
                                className="icon-button"
                                disabled={stubs.length === 0}
                                aria-label={t.allStubs}
                                data-tooltip={stubs.length === 0 ? undefined : hidden.length ? t.showAllStubs : t.hideAllStubs}
                                onClick={() => onHiddenChange(hidden.length ? [] : stubs)}
                            >
                                {allHidden ? (
                                    <EyeOff size={14} aria-hidden />
                                ) : someHidden ? (
                                    <EyeDashed size={14} aria-hidden />
                                ) : (
                                    <Eye size={14} aria-hidden />
                                )}
                            </button>
                        )}
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
                                {onHiddenChange && (
                                    <button
                                        className="icon-button"
                                        disabled={eyeDisabled}
                                        aria-pressed={!isHidden}
                                        aria-label={t.contextStubs(name(c))}
                                        data-tooltip={eyeDisabled ? undefined : isHidden ? t.showStubs : t.hideStubs}
                                        onClick={() => toggleHidden(c)}
                                    >
                                        {isHidden ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
