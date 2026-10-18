import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Hovering an element with this attribute shows its text as a tooltip (icon buttons: their aria-label stays the accessible name). */
export const TOOLTIP_ATTR = 'data-tooltip';
/** Hover delay before a tooltip shows. */
const DELAY_MS = 400;
/** Gap between the element and the tooltip, and the least distance to the window's edges. */
const GAP = 6;
const MARGIN = 8;

/** Where a tooltip of `size` goes for an element at `anchor`: centred below it, above when there is no room, kept inside the window. */
export function placeTooltip(
    anchor: { left: number; top: number; right: number; bottom: number },
    size: { width: number; height: number },
    viewport: { width: number; height: number },
): { left: number; top: number } {
    const below = anchor.bottom + GAP;
    const above = anchor.top - GAP - size.height;
    const top = below + size.height <= viewport.height - MARGIN || above < MARGIN ? below : above;
    const centred = (anchor.left + anchor.right) / 2 - size.width / 2;
    const left = Math.max(MARGIN, Math.min(centred, viewport.width - MARGIN - size.width));
    return { left: Math.round(left), top: Math.round(top) };
}

const tooltipTarget = (node: EventTarget | null): HTMLElement | null =>
    node instanceof Element ? node.closest<HTMLElement>(`[${TOOLTIP_ATTR}]`) : null;

/**
 * Tooltips drawn by the app for every element with `data-tooltip` (native `title` tooltips are not shown reliably),
 * on hover after a short delay and on keyboard focus. Mounted once; it listens on the document,
 * never captures the pointer and hides as soon as a button is pressed, so canvas and pane drags are unaffected.
 */
export function Tooltips() {
    const [target, setTarget] = useState<HTMLElement | null>(null);
    const [, rerender] = useState(0);
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
    const tip = useRef<HTMLDivElement>(null);
    const text = target?.getAttribute(TOOLTIP_ATTR);

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        /** The element under the pointer, and the one whose tooltip is shown (or about to be). */
        let hovered: HTMLElement | null = null;
        let shown: HTMLElement | null = null;
        const show = (el: HTMLElement | null, delay: number) => {
            clearTimeout(timer);
            shown = el;
            if (!el || !delay) setTarget(el);
            else timer = setTimeout(() => setTarget(el), delay);
        };
        const hide = () => show(null, 0);
        const onOver = (e: PointerEvent) => {
            if (e.pointerType === 'touch') return;
            const el = tooltipTarget(e.target);
            if (el === hovered) return;
            hovered = el;
            // pressed buttons mean a drag (canvas, pane edges): no tooltips meanwhile
            show(e.buttons ? null : el, DELAY_MS);
        };
        const onFocus = (e: FocusEvent) => {
            const el = tooltipTarget(e.target);
            if (el?.matches(':focus-visible')) show(el, 0);
        };
        const onBlur = (e: FocusEvent) => {
            if (shown && shown === tooltipTarget(e.target) && shown !== hovered) hide();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') hide();
        };
        const onLeave = () => {
            hovered = null;
            hide();
        };
        document.addEventListener('pointerover', onOver);
        document.addEventListener('pointerdown', hide, true);
        document.addEventListener('focusin', onFocus);
        document.addEventListener('focusout', onBlur);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('scroll', hide, true);
        document.documentElement.addEventListener('pointerleave', onLeave);
        window.addEventListener('blur', onLeave);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('pointerover', onOver);
            document.removeEventListener('pointerdown', hide, true);
            document.removeEventListener('focusin', onFocus);
            document.removeEventListener('focusout', onBlur);
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('scroll', hide, true);
            document.documentElement.removeEventListener('pointerleave', onLeave);
            window.removeEventListener('blur', onLeave);
        };
    }, []);

    // follow the text while shown (e.g. a toggle switched with the keyboard); hide when the element goes away
    useEffect(() => {
        if (!target) return;
        const check = () => {
            if (target.isConnected && !target.closest('[inert]') && target.getAttribute(TOOLTIP_ATTR)) rerender((n) => n + 1);
            else setTarget(null);
        };
        const observer = new MutationObserver(check);
        observer.observe(target, { attributes: true, attributeFilter: [TOOLTIP_ATTR] });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert'] });
        return () => observer.disconnect();
    }, [target]);

    useLayoutEffect(() => {
        const el = tip.current;
        if (!target || !el) return setPos(null);
        // in the top layer, so that it also shows over the settings dialog
        if (el.showPopover && !el.matches(':popover-open')) el.showPopover();
        // measured at the left edge, where nothing narrows it (set directly: React keeps an unchanged position as is)
        el.style.left = '0px';
        const p = placeTooltip(target.getBoundingClientRect(), el.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
        el.style.left = `${p.left}px`;
        setPos(p);
    }, [target, text]);

    if (!target || !text) return null;
    return (
        <div ref={tip} className="tooltip" popover="manual" aria-hidden style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}>
            {text}
        </div>
    );
}
