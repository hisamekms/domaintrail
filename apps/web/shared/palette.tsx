// The command palette (⌘K / Ctrl+K): one field that finds what to do or where to go by name, whatever feature offers it.
// Each feature gives its items (an action on the selection, an element to go to, …) in sections; typing keeps those
// whose words contain what is typed; ↑ ↓ move, Enter runs, Escape closes. A modal dialog: the page behind waits.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface PaletteItem {
    readonly id: string;
    readonly label: string;
    /** A second, muted line of words that also match (a kind, an ID, what it applies to). */
    readonly detail?: string;
    readonly icon?: LucideIcon;
    /** Its key, shown at its right. */
    readonly keys?: string;
    /** The section it is listed in (the order of first appearance). */
    readonly section: string;
    readonly run: () => void;
}

/** The items whose label or detail holds every word of `query` (case and width of the letters ignored), in order. */
export function matchItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
    const words = query.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [...items];
    return items.filter((item) => {
        const text = `${item.label} ${item.detail ?? ''}`.normalize('NFKC').toLowerCase();
        return words.every((w) => text.includes(w));
    });
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

/** Most items listed at once: typing narrows them. */
const SHOWN = 50;

export function CommandPalette({
    label,
    placeholder,
    empty,
    items,
    onClose,
}: {
    label: string;
    placeholder: string;
    empty: string;
    items: readonly PaletteItem[];
    onClose: () => void;
}): ReactNode {
    const [query, setQuery] = useState('');
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
    const shown = useMemo(() => matchItems(items, query).slice(0, SHOWN), [items, query]);
    useEffect(() => {
        const d = dialog.current;
        if (d && !d.open) d.showModal();
    }, []);
    useEffect(() => setActive(0), [query]);
    useEffect(() => {
        list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
    }, [active]);
    const pick = (item: PaletteItem | undefined): void => {
        if (!item) return;
        onClose();
        item.run();
    };
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const step = e.key === 'ArrowDown' ? 1 : -1;
            setActive((a) => (shown.length === 0 ? 0 : (a + step + shown.length) % shown.length));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(shown[active]);
        }
    };
    let section: string | undefined;
    return (
        <dialog
            ref={dialog}
            className="command-palette"
            aria-label={label}
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
                    aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
                    aria-label={label}
                    placeholder={placeholder}
                    value={query}
                    autoFocus
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                />
                <ul ref={list} id={listId} className="command-palette-list" role="listbox" aria-label={label}>
                    {shown.length === 0 && <li className="command-palette-empty">{empty}</li>}
                    {shown.map((item, i) => {
                        const heading = item.section !== section ? item.section : undefined;
                        section = item.section;
                        const Icon = item.icon;
                        return (
                            <li key={item.id} role="presentation">
                                {heading !== undefined && (
                                    <div className="command-palette-section" aria-hidden>
                                        {heading}
                                    </div>
                                )}
                                <div
                                    id={`${listId}-${i}`}
                                    role="option"
                                    aria-selected={i === active}
                                    data-index={i}
                                    className="command-palette-item"
                                    onPointerMove={() => setActive(i)}
                                    onClick={() => pick(item)}
                                >
                                    <span className="command-palette-icon">{Icon && <Icon size={14} aria-hidden />}</span>
                                    <span className="command-palette-label">{item.label}</span>
                                    {item.detail !== undefined && <span className="command-palette-detail">{item.detail}</span>}
                                    {item.keys !== undefined && <kbd>{item.keys}</kbd>}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            </div>
        </dialog>
    );
}
