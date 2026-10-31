import { Funnel, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useT } from '../i18n';
import { useDismiss } from '../shared/layout';

/**
 * The parts of the view toolbar, the same in every view, left to right: the subject (what is looked at), the level
 * (how much of it), then at the right end the 絞り込み button (what is hidden) and the canvas's menu ⋯.
 */

/** Whether the element's text is cut short (so that the whole of it is shown as a tooltip). */
export function useClipped(ref: RefObject<HTMLElement | null>, text: string): boolean {
    const [clipped, setClipped] = useState(false);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const check = (): void => setClipped(el.scrollWidth > el.clientWidth);
        check();
        const observer = new ResizeObserver(check);
        observer.observe(el);
        return () => observer.disconnect();
    }, [ref, text]);
    return clipped;
}

/**
 * Keeps an open menu of the toolbar within the toolbar's width (the pane's), moving it left when it would stick out at
 * the right, and narrowing it (its items cut short) when the pane is narrower than it.
 */
export function useMenuInside(open: boolean, menu: RefObject<HTMLElement | null>): void {
    useLayoutEffect(() => {
        const el = menu.current;
        const bar = el?.closest('.view-toolbar');
        if (!open || !el || !bar) return;
        const fit = (): void => {
            el.style.transform = '';
            el.style.maxWidth = '';
            const box = bar.getBoundingClientRect();
            el.style.maxWidth = `min(24rem, ${box.width}px)`;
            const r = el.getBoundingClientRect();
            const shift = Math.max(0, r.right - box.right) - Math.max(0, box.left - r.left);
            if (shift) el.style.transform = `translateX(${-shift}px)`;
        };
        fit();
        const observer = new ResizeObserver(fit);
        observer.observe(bar);
        return () => observer.disconnect();
    }, [open, menu]);
}

/** The toolbar's left part: the subject and the level, shrinking (the subject's names cut short) before the row wraps. */
export function ToolbarSubject({ children }: { children: ReactNode }) {
    return <div className="toolbar-subject">{children}</div>;
}

/** The toolbar's right part: the 絞り込み button and the menu ⋯, never shrunk. */
export function ToolbarEnd({ children }: { children: ReactNode }) {
    return <div className="toolbar-end">{children}</div>;
}

export interface PickerOption {
    value: string;
    label: string;
}

/**
 * A dropdown that picks one thing to look at (a storming, a timeline). The button shows the choice, cut short with an
 * ellipsis when narrow (the whole of it as a tooltip); the list opens below it, moves with the arrow keys, and closes
 * on a choice, on Escape or on a click outside it. With one option it is the option's name, not a button.
 */
export function SubjectPicker(props: { label: string; value: string; options: PickerOption[]; onChange: (value: string) => void }) {
    const { label, value, options, onChange } = props;
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const text = useRef<HTMLSpanElement>(null);
    const current = options.find((o) => o.value === value) ?? options[0];
    const clipped = useClipped(text, current?.label ?? '');
    const close = useCallback(() => setOpen(false), []);
    useDismiss(open, root, close);
    useMenuInside(open, list);

    // the chosen option has the focus once the list opens
    useEffect(() => {
        if (open) list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    }, [open]);

    if (!current) return null;
    if (options.length === 1)
        return (
            <span ref={text} className="subject-picker subject-name" aria-label={label} data-tooltip={clipped ? current.label : undefined}>
                {current.label}
            </span>
        );

    const choose = (v: string): void => {
        setOpen(false);
        button.current?.focus();
        if (v !== value) onChange(v);
    };
    const onListKey = (e: KeyboardEvent<HTMLDivElement>): void => {
        const items = [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
        const at = items.findIndex((item) => item === document.activeElement);
        const next =
            e.key === 'ArrowDown'
                ? Math.min(items.length - 1, at + 1)
                : e.key === 'ArrowUp'
                  ? Math.max(0, at - 1)
                  : e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? items.length - 1
                      : -1;
        if (next >= 0) {
            e.preventDefault();
            items[next]?.focus();
        } else if (e.key === 'Escape' || e.key === 'Tab') {
            setOpen(false);
            if (e.key === 'Escape') button.current?.focus();
        }
    };

    return (
        <div className="subject-picker" ref={root}>
            <button
                ref={button}
                className="toolbar-button"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={`${label}: ${current.label}`}
                data-tooltip={clipped ? `${label}: ${current.label}` : undefined}
                onClick={() => setOpen(!open)}
                onKeyDown={(e) => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        setOpen(true);
                    }
                }}
            >
                <span ref={text} className="toolbar-button-text">
                    {current.label}
                </span>
                <span className="toolbar-caret" aria-hidden>
                    ▾
                </span>
            </button>
            {open && (
                <div className="toolbar-menu subject-menu" role="listbox" aria-label={label} ref={list} onKeyDown={onListKey}>
                    {options.map((o) => (
                        <button
                            key={o.value}
                            role="option"
                            aria-selected={o.value === current.value}
                            tabIndex={o.value === current.value ? 0 : -1}
                            onClick={() => choose(o.value)}
                        >
                            {o.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

/** Icon buttons that pick a level (how much of the subject is drawn); each one's name is its tooltip. */
export function LevelSwitch<L extends string>(props: {
    label: string;
    levels: readonly L[];
    value: L;
    icons: Record<L, LucideIcon>;
    /** The level's name (for screen readers) and its tooltip (the name, with what it shows). */
    names: (level: L) => { label: string; tooltip: string };
    onChange: (level: L) => void;
}) {
    const { levels, value, icons, names, onChange } = props;
    return (
        <div className="segmented small icons level-switch" role="group" aria-label={props.label}>
            {levels.map((l) => {
                const Icon: LucideIcon = icons[l];
                const name = names(l);
                return (
                    <button
                        key={l}
                        className={value === l ? 'active' : ''}
                        aria-pressed={value === l}
                        onClick={() => onChange(l)}
                        data-tooltip={name.tooltip}
                        aria-label={name.label}
                    >
                        <Icon size={15} aria-hidden />
                    </button>
                );
            })}
        </div>
    );
}

/**
 * The view's one 絞り込み button: a popover of what can be hidden. While anything is narrowed the button shows how
 * many narrowings are active, and the popover offers to clear them all.
 */
export function FilterPopover(props: { count: number; onClear: () => void; children: ReactNode }) {
    const { count, onClear, children } = props;
    const t = useT();
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    useDismiss(
        open,
        root,
        useCallback(() => setOpen(false), []),
    );
    useMenuInside(open, menu);
    return (
        <div className="filter-popover" ref={root}>
            <button
                className={`toolbar-button filter-button${count ? ' active' : ''}`}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={count ? t.filters.active(count) : t.filters.label}
                onClick={() => setOpen(!open)}
            >
                <Funnel size={13} aria-hidden />
                <span className="filter-button-text">{t.filters.label}</span>
                {count > 0 && <span className="filter-count">{count}</span>}
            </button>
            {open && (
                <div className="toolbar-menu filter-menu" role="dialog" ref={menu} aria-label={t.filters.label}>
                    <div className="filter-menu-head">
                        <span>{t.filters.label}</span>
                        <button className="filter-clear" disabled={count === 0} onClick={onClear}>
                            {t.filters.clear}
                        </button>
                    </div>
                    {children}
                </div>
            )}
        </div>
    );
}

/** A titled part of the 絞り込み popover. */
export function FilterSection({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="filter-section" aria-label={title}>
            <h3>{title}</h3>
            {children}
        </section>
    );
}
