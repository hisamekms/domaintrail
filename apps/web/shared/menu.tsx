// A menu of actions (docs/ui-rules.md): `role="menu"` with its items as `menuitem`s, in groups under a small heading,
// each with its icon and its key; the arrow keys move between the items (Home and End to the ends), Enter or Space
// runs one, Escape or Tab closes it and gives the focus back. It opens at a point of its container (a right-click) or
// under a button, kept inside the container.
import { Fragment, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { useDismissOutside } from './layout';

export interface MenuItem {
    readonly id: string;
    readonly label: string;
    readonly icon?: LucideIcon;
    /** The item's key, shown at its right (`F2`, `⌘⇧C`). */
    readonly keys?: string;
    /** Said in a tooltip (what exactly it does, e.g. the element it goes to). */
    readonly hint?: string;
    /** The heading of the group it is in: a new heading starts a group. */
    readonly group?: string;
    readonly run: () => void;
}

/**
 * The menu, at `at` (its top-left corner, relative to the positioned container it is drawn in), moved left or up to
 * stay inside it. It takes the focus on its first item and gives it back to what had it when it closes.
 */
export function ActionMenu({
    label,
    items,
    at,
    onClose,
}: {
    label: string;
    items: readonly MenuItem[];
    at: { x: number; y: number };
    onClose: () => void;
}): ReactNode {
    const ref = useRef<HTMLDivElement>(null);
    const [place, setPlace] = useState(at);
    const before = useRef<Element | null>(null);
    useLayoutEffect(() => {
        before.current = document.activeElement;
        const menu = ref.current;
        const box = menu?.offsetParent;
        if (menu && box instanceof HTMLElement) {
            const x = Math.max(0, Math.min(at.x, box.clientWidth - menu.offsetWidth - 4));
            const y = Math.max(0, Math.min(at.y, box.clientHeight - menu.offsetHeight - 4));
            setPlace({ x, y });
        }
        menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
        return () => {
            if (before.current instanceof HTMLElement && document.contains(before.current)) before.current.focus();
        };
    }, [at]);
    useDismissOutside(true, () => [ref.current], onClose);
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
        const all = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
        const focused = document.activeElement;
        const i = all.findIndex((b) => b === focused);
        const go = (n: number): void => {
            e.preventDefault();
            all[(n + all.length) % all.length]?.focus();
        };
        if (e.key === 'ArrowDown') go(i + 1);
        else if (e.key === 'ArrowUp') go(i < 0 ? all.length - 1 : i - 1);
        else if (e.key === 'Home') go(0);
        else if (e.key === 'End') go(all.length - 1);
        else if (e.key === 'Escape' || e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
        }
    };
    let group: string | undefined;
    return (
        <div ref={ref} className="action-menu motion-pop" role="menu" aria-label={label} style={{ left: place.x, top: place.y }} onKeyDown={onKeyDown}>
            {items.map((item, i) => {
                const heading = item.group !== undefined && item.group !== group ? item.group : undefined;
                group = item.group ?? group;
                const Icon = item.icon;
                return (
                    <Fragment key={item.id}>
                        {heading !== undefined && (
                            <>
                                {i > 0 && <div className="action-menu-separator" role="separator" />}
                                <div className="action-menu-group" aria-hidden>
                                    {heading}
                                </div>
                            </>
                        )}
                        <button
                            type="button"
                            role="menuitem"
                            tabIndex={-1}
                            {...(item.hint !== undefined && { 'data-tooltip': item.hint })}
                            onClick={() => {
                                onClose();
                                item.run();
                            }}
                        >
                            <span className="action-menu-icon">{Icon && <Icon size={14} aria-hidden />}</span>
                            <span className="action-menu-label">{item.label}</span>
                            {item.keys !== undefined && <kbd>{item.keys}</kbd>}
                        </button>
                    </Fragment>
                );
            })}
        </div>
    );
}
