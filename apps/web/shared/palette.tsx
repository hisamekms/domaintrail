// The command palette (⌘K / Ctrl+K, and the app bar's 探す): one field that finds what to do or where to go by name,
// whatever feature offers it. What it lists for a query is the caller's (`sections`): sections with a heading and a
// count, items with a mark, the parts of their label to mark and a name (an ID) at the right, items hung under an item
// and joined to it by a line, and ほか n 件 that lists the rest of a section. ↑ ↓ move, Enter runs, Escape closes. A
// modal dialog: the page behind waits.
import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/** A part of a text, to mark: from `start` to before `end`. */
export interface MarkedRange {
    readonly start: number;
    readonly end: number;
}

export interface PaletteItem {
    readonly id: string;
    readonly label: string;
    /** The parts of the label to mark (what was typed). */
    readonly labelMarks?: readonly MarkedRange[];
    /** A second, muted text (a kind, where it is, what it applies to). */
    readonly detail?: string;
    /** A short word before the detail of an item hung under another (what joins them: `ref`). */
    readonly tag?: string;
    /** Its name, at the right in monospace, with the parts to mark: shown when it was found by it. */
    readonly code?: { readonly text: string; readonly marks: readonly MarkedRange[] };
    readonly icon?: LucideIcon;
    /** Its mark at the left, in place of an icon (a kind's colour). */
    readonly mark?: ReactNode;
    /** Its key, shown at its right. */
    readonly keys?: string;
    /** Its full name, as a tooltip. */
    readonly title?: string;
    /** Items hung under it, joined to it by a line (the same thing seen elsewhere). */
    readonly mates?: readonly PaletteItem[];
    readonly run: () => void;
}

export interface PaletteSection {
    readonly id: string;
    readonly title: string;
    /** How many it found, beside its heading. */
    readonly count?: number;
    readonly items: readonly PaletteItem[];
    /** How many more it has: listed on 「ほか n 件」, which lists them. */
    readonly more?: number;
}

/** What the palette says around its list. */
export interface PaletteTexts {
    readonly label: string;
    readonly placeholder: string;
    readonly empty: string;
    readonly more: (n: number) => string;
}

/** A row the arrows move along: an item (or one hung under another), or a section's ほか n 件. */
export type PaletteRow = { readonly kind: 'item'; readonly item: PaletteItem } | { readonly kind: 'more'; readonly section: string };

/** The rows of the sections, in the order they are listed: each item, the items hung under it, its section's ほか n 件. */
export function paletteRows(sections: readonly PaletteSection[]): PaletteRow[] {
    return sections.flatMap((s): PaletteRow[] => [
        ...s.items.flatMap((item): PaletteRow[] => [{ kind: 'item', item }, ...(item.mates ?? []).map((m): PaletteRow => ({ kind: 'item', item: m }))]),
        ...(s.more ? [{ kind: 'more' as const, section: s.id }] : []),
    ]);
}

/**
 * Where the focus goes back when the palette closes without a pick: what had it when it opened, while it is still in
 * the page and is not the page itself; else nowhere (the stickies' Escape then clears their selection).
 */
export function focusBack(before: Element | null, doc: { readonly body: unknown; contains(node: Element): boolean }): Element | undefined {
    return before !== null && before !== doc.body && doc.contains(before) ? before : undefined;
}

/** Whether a key press opens the palette: ⌘K on a Mac, Ctrl+K elsewhere. */
export const isPaletteKey = (e: Pick<globalThis.KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, mac: boolean): boolean =>
    e.key.toLowerCase() === 'k' && !e.altKey && !e.shiftKey && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

/** The palette's key as it is shown: ⌘K on a Mac, Ctrl K elsewhere. */
export const paletteKeyText = (mac: boolean): string => (mac ? '⌘K' : 'Ctrl K');

/** Opens the palette on its key, wherever the focus is. */
export function usePaletteKey(mac: boolean, open: () => void): void {
    useEffect(() => {
        const onKey = (e: globalThis.KeyboardEvent): void => {
            if (!isPaletteKey(e, mac)) return;
            e.preventDefault();
            open();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [mac, open]);
}

/** A text with its marked parts in `<mark>`. */
function Marked({ text, marks }: { text: string; marks: readonly MarkedRange[] | undefined }): ReactNode {
    if (!marks?.length) return text;
    const out: ReactNode[] = [];
    let at = 0;
    for (const m of marks) {
        if (m.start < at) continue;
        out.push(text.slice(at, m.start), <mark key={m.start}>{text.slice(m.start, m.end)}</mark>);
        at = m.end;
    }
    out.push(text.slice(at));
    return out;
}

export function CommandPalette({
    texts,
    sections,
    onClose,
}: {
    texts: PaletteTexts;
    /** What is listed for a query; the sections whose ほか n 件 was picked (`expanded`) listed whole. */
    sections: (query: string, expanded: ReadonlySet<string>) => readonly PaletteSection[];
    onClose: () => void;
}): ReactNode {
    const [query, setQuery] = useState('');
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const [active, setActive] = useState(0);
    const dialog = useRef<HTMLDialogElement>(null);
    // what had the focus when it opened: given it back when the palette is closed without a pick
    const before = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement);
    const cancel = (): void => {
        onClose();
        const back = focusBack(before.current, document);
        if (back instanceof HTMLElement) back.focus({ preventScroll: true });
    };
    const list = useRef<HTMLUListElement>(null);
    const listId = useId();
    const shown = useMemo(() => sections(query, expanded), [sections, query, expanded]);
    const rows = useMemo(() => paletteRows(shown), [shown]);
    useEffect(() => {
        const d = dialog.current;
        if (d && !d.open) d.showModal();
    }, []);
    useEffect(() => {
        list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
    }, [active]);
    const pick = (row: PaletteRow | undefined): void => {
        if (!row) return;
        // ほか n 件: the rest of its section, the same row active (now the first of them)
        if (row.kind === 'more') return setExpanded((e) => new Set([...e, row.section]));
        onClose();
        row.item.run();
    };
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const step = e.key === 'ArrowDown' ? 1 : -1;
            setActive((a) => (rows.length === 0 ? 0 : (a + step + rows.length) % rows.length));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(rows[active]);
        }
    };
    // the rows' indexes, in the order they are drawn (the order of `rows`)
    let index = 0;
    const row = (key: string, className: string, content: ReactNode, title?: string): ReactNode => {
        const i = index++;
        return (
            <div
                key={key}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                data-index={i}
                className={className}
                title={title}
                onPointerMove={() => i !== active && setActive(i)}
                onClick={() => pick(rows[i])}
            >
                {content}
            </div>
        );
    };
    const item = (it: PaletteItem, mate: boolean): ReactNode => {
        const Icon = it.icon;
        return row(
            it.id,
            `command-palette-item${mate ? ' mate' : ''}`,
            <>
                <span className="command-palette-icon">{it.mark ?? (Icon && <Icon size={14} aria-hidden />)}</span>
                <span className="command-palette-label">
                    <Marked text={it.label} marks={it.labelMarks} />
                </span>
                <span className="command-palette-detail">
                    {it.tag !== undefined && <span className="command-palette-tag">{it.tag}</span>}
                    {it.tag !== undefined && ' · '}
                    {it.detail}
                </span>
                {it.code && (
                    <span className="command-palette-code">
                        <Marked text={it.code.text} marks={it.code.marks} />
                    </span>
                )}
                {it.keys !== undefined && <kbd>{it.keys}</kbd>}
            </>,
            it.title,
        );
    };
    return (
        <dialog
            ref={dialog}
            className="command-palette"
            aria-label={texts.label}
            onCancel={(e) => {
                // Escape: closed, nothing run; the event goes no further (the canvas keeps its selection)
                e.preventDefault();
                cancel();
            }}
            onClick={(e) => {
                // a click on the backdrop (the dialog's own box, outside its content)
                if (e.target === dialog.current) cancel();
            }}
        >
            <div className="command-palette-box">
                <input
                    className="command-palette-input"
                    role="combobox"
                    aria-expanded
                    aria-controls={listId}
                    aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
                    aria-label={texts.label}
                    placeholder={texts.placeholder}
                    value={query}
                    autoFocus
                    onChange={(e) => {
                        setQuery(e.target.value);
                        setExpanded(new Set());
                        setActive(0);
                    }}
                    onKeyDown={onKeyDown}
                />
                <ul ref={list} id={listId} className="command-palette-list" role="listbox" aria-label={texts.label}>
                    {rows.length === 0 && <li className="command-palette-empty">{texts.empty}</li>}
                    {shown.map((s) => (
                        <Fragment key={s.id}>
                            {s.items.length > 0 && (
                                <li role="presentation" className="command-palette-section" aria-hidden>
                                    <span>{s.title}</span>
                                    {s.count !== undefined && <span className="command-palette-count">{s.count}</span>}
                                </li>
                            )}
                            {s.items.map((it) => (
                                <li key={it.id} role="presentation" className={it.mates?.length ? 'command-palette-pair' : undefined}>
                                    {item(it, false)}
                                    {it.mates?.map((m) => item(m, true))}
                                </li>
                            ))}
                            {s.more ? (
                                <li role="presentation">{row(`${s.id}:more`, 'command-palette-item command-palette-more', texts.more(s.more))}</li>
                            ) : null}
                        </Fragment>
                    ))}
                </ul>
            </div>
        </dialog>
    );
}
