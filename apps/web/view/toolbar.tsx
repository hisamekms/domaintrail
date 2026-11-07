import { Funnel, type LucideIcon } from 'lucide-react';
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useT } from '../i18n';
import { useDismiss } from '../shared/layout';

/**
 * The parts of the view bar (the row above the canvas), the same in every view, left to right: the domain model's view
 * switch, the subject (what is looked at), the level (how much of it), then at the right end the 絞り込み button (what
 * is hidden) and 書き出し (the catalog: 印刷). What is shown is set here; how it is looked at (the camera, the density,
 * the legend), in the canvas's controls.
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
 * Whether a button's text label is hidden (a narrow bar shows its switches and its right end's buttons as icons:
 * styles.css), so that its name is then its tooltip.
 */
export function useLabelHidden(ref: RefObject<HTMLElement | null>): boolean {
    const [hidden, setHidden] = useState(false);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const check = (): void => setHidden(el.getClientRects().length === 0);
        check();
        const observer = new ResizeObserver(check);
        observer.observe(el);
        const bar = el.closest('.view-toolbar, .app-bar');
        if (bar) observer.observe(bar);
        return () => observer.disconnect();
    }, [ref]);
    return hidden;
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

/** The toolbar's right part: the 絞り込み button and 書き出し (or 印刷), never shrunk. */
export function ToolbarEnd({ children }: { children: ReactNode }) {
    return <div className="toolbar-end">{children}</div>;
}

export interface PickerOption {
    value: string;
    label: string;
    /** The group it is listed under (a stage's name): a heading before the first option of each group. */
    group?: string | undefined;
    /** Drawn before its label (an exception's mark). */
    icon?: ReactNode;
}

/**
 * A dropdown that picks one thing to look at (a storming, a stage). The button shows the choice, cut short with an
 * ellipsis when narrow (the whole of it as a tooltip); the list opens below it (`MenuPicker`). With one option it is the
 * option's name, not a button.
 */
export function SubjectPicker(props: { label: string; value: string; options: PickerOption[]; onChange: (value: string) => void }) {
    const { label, value, options, onChange } = props;
    const text = useRef<HTMLSpanElement>(null);
    const current = options.find((o) => o.value === value) ?? options[0];
    const clipped = useClipped(text, current?.label ?? '');
    if (!current) return null;
    if (options.length === 1) return <SubjectName label={label} text={current.label} />;
    return (
        <MenuPicker
            className="subject-picker"
            buttonClass="toolbar-button"
            label={label}
            buttonLabel={`${label}: ${current.label}`}
            tooltip={clipped ? `${label}: ${current.label}` : undefined}
            value={current.value}
            options={options}
            onChange={onChange}
        >
            <span ref={text} className="toolbar-button-text">
                {current.label}
            </span>
            <span className="toolbar-caret" aria-hidden>
                ▾
            </span>
        </MenuPicker>
    );
}

/**
 * A button that opens a list to pick one option from (a listbox, its options under their groups' headings): it opens
 * below the button, the chosen option focused; the arrow keys, Home and End move, and a choice, Escape, Tab or a press
 * outside close it. `value`: the option chosen, if one of them is.
 */
export function MenuPicker(props: {
    /** The list's name. */
    label: string;
    /** The button's accessible name (else its text). */
    buttonLabel?: string | undefined;
    tooltip?: string | undefined;
    className: string;
    buttonClass?: string | undefined;
    value: string | undefined;
    options: readonly PickerOption[];
    onChange: (value: string) => void;
    /** The button's content. */
    children: ReactNode;
}) {
    const { label, value, options, onChange } = props;
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    const list = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setOpen(false), []);
    useDismiss(open, root, close);
    useMenuInside(open, list);

    // the chosen option (else the first) has the focus once the list opens
    useEffect(() => {
        if (!open) return;
        const items = list.current?.querySelectorAll<HTMLElement>('[role="option"]');
        (list.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? items?.[0])?.focus();
    }, [open]);

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
    const focusable = options.some((o) => o.value === value) ? value : options[0]?.value;

    return (
        <div className={props.className} ref={root}>
            <button
                ref={button}
                className={`menu-picker-button${props.buttonClass ? ` ${props.buttonClass}` : ''}`}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={props.buttonLabel}
                data-tooltip={props.tooltip}
                onClick={() => setOpen(!open)}
                onKeyDown={(e) => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        setOpen(true);
                    }
                }}
            >
                {props.children}
            </button>
            {open && (
                <div className="toolbar-menu subject-menu motion-pop" role="listbox" aria-label={label} ref={list} onKeyDown={onListKey}>
                    {options.map((o, i) => (
                        <Fragment key={o.value}>
                            {o.group !== undefined && o.group !== options[i - 1]?.group && (
                                <div className="subject-menu-group" role="presentation">
                                    {o.group}
                                </div>
                            )}
                            <button role="option" aria-selected={o.value === value} tabIndex={o.value === focusable ? 0 : -1} onClick={() => choose(o.value)}>
                                {o.icon}
                                {o.label}
                            </button>
                        </Fragment>
                    ))}
                </div>
            )}
        </div>
    );
}

/** A part of the subject that is not picked here (one storming, the focused contexts): its name, cut short when narrow. */
export function SubjectName({ label, text }: { label: string; text: string }) {
    const ref = useRef<HTMLSpanElement>(null);
    const clipped = useClipped(ref, text);
    return (
        <span ref={ref} className="subject-picker subject-name" aria-label={label} data-tooltip={clipped ? text : undefined}>
            {text}
        </span>
    );
}

/**
 * A switch of a bar (the worlds in the app bar, the views in the view bar): each choice an icon and its name, the name
 * hidden on a narrow bar (styles.css), and then its tooltip; the name stays its accessible name.
 */
export function NameSwitch<K extends string>(props: {
    label: string;
    className: string;
    choices: readonly K[];
    value: K;
    icons: Record<K, LucideIcon>;
    names: Record<K, string>;
    onChange: (choice: K) => void;
}) {
    const { choices, value, onChange } = props;
    return (
        <div className={`segmented small name-switch ${props.className}`} role="group" aria-label={props.label}>
            {choices.map((k) => (
                <NameSwitchButton key={k} icon={props.icons[k]} name={props.names[k]} active={value === k} onClick={() => onChange(k)} />
            ))}
        </div>
    );
}

function NameSwitchButton(props: { icon: LucideIcon; name: string; active: boolean; onClick: () => void }) {
    const Icon = props.icon;
    const text = useRef<HTMLSpanElement>(null);
    const iconOnly = useLabelHidden(text);
    return (
        <button
            className={props.active ? 'active' : ''}
            aria-pressed={props.active}
            aria-label={props.name}
            data-tooltip={iconOnly ? props.name : undefined}
            onClick={props.onClick}
        >
            <Icon size={15} aria-hidden />
            <span ref={text} className="switch-label">
                {props.name}
            </span>
        </button>
    );
}

/** Icon buttons that pick a level (how much of the subject is drawn); each one's name is its tooltip. */
export function LevelSwitch<L extends string>(props: {
    label: string;
    levels: readonly L[];
    value: L;
    icons: Record<L, LucideIcon>;
    /**
     * The level's name (for screen readers), its tooltip (the name, with what it shows) and maybe a short text beside
     * its icon, hidden on a narrow view bar (styles.css).
     */
    names: (level: L) => { label: string; tooltip: string; text?: string };
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
                        {name.text && <span className="level-label">{name.text}</span>}
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
    const text = useRef<HTMLSpanElement>(null);
    const iconOnly = useLabelHidden(text);
    const label = count ? t.filters.active(count) : t.filters.label;
    return (
        <div className="filter-popover" ref={root}>
            <button
                className={`toolbar-button filter-button${count ? ' active' : ''}`}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={label}
                data-tooltip={iconOnly && !open ? label : undefined}
                onClick={() => setOpen(!open)}
            >
                <Funnel size={13} aria-hidden />
                <span ref={text} className="filter-button-text toolbar-end-label">
                    {t.filters.label}
                </span>
                {count > 0 && <span className="filter-count">{count}</span>}
            </button>
            {open && (
                <div className="toolbar-menu filter-menu motion-pop" role="dialog" ref={menu} aria-label={t.filters.label}>
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
