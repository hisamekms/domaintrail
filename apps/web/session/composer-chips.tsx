// The composer's chips, the request's targets (ADR 0026, the composer), collapsed to two rows: the last item of the
// second row is `+n`, the chips not shown (the latest added), which shows them all, followed by a collapse button. Every
// chip stays rendered so that its width can be measured; those not shown are taken out of the flow, hidden and inert.
import { ChevronUp, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Tx } from './chat-context';
import { collapsedCount } from './chip-rows';
import { MAX_REQUEST_TARGETS, type ComposerChip } from './mentions';
import { targetKey, type TargetDraft } from './targets';

export function ComposerChips(props: {
    chips: readonly ComposerChip[];
    /** All chips shown (`+n` pressed). */
    expanded: boolean;
    onExpanded: (expanded: boolean) => void;
    /** A target's whole name (the tooltip, the labels) and its own name (the chip). */
    nameOf: (target: TargetDraft) => string;
    shortOf: (target: TargetDraft) => string;
    onRemove: (index: number) => void;
    tx: Tx;
}): ReactNode {
    const { chips, expanded, nameOf, shortOf, tx } = props;
    const box = useRef<HTMLDivElement | null>(null);
    // how many chips fit in two rows with `+n` after them; measured after every render, before it is painted
    const [fit, setFit] = useState(chips.length);
    const [, setWidth] = useState(0);
    useLayoutEffect(() => {
        const el = box.current;
        if (!el) return;
        const widths = [...el.querySelectorAll<HTMLElement>(':scope > .chat-chip')].map((c) => c.getBoundingClientRect().width);
        const more = el.querySelector<HTMLElement>(':scope > .chat-chips-more')?.getBoundingClientRect().width ?? 0;
        const gap = Number.parseFloat(getComputedStyle(el).columnGap) || 0;
        setFit(collapsedCount(widths, el.clientWidth, gap, more));
    });
    // the chat's width changed: measured again
    useLayoutEffect(() => {
        const el = box.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => setWidth(el.clientWidth));
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    const shown = expanded ? chips.length : Math.min(fit, chips.length);
    const hidden = chips.length - shown;
    const collapsible = fit < chips.length;
    return (
        <div
            className="chat-chips"
            ref={box}
            aria-label={chips.length > 0 ? `${tx.chat.target} ${tx.chat.targetCount(chips.length, MAX_REQUEST_TARGETS)}` : tx.chat.target}
        >
            {chips.map((c, i) => {
                const out = i >= shown;
                return (
                    <span
                        key={targetKey(c.target.target)}
                        className={`chat-chip kind-${c.target.target.kind}${out ? ' measured' : ''}`}
                        data-tooltip={`${nameOf(c.target)}\n${targetKey(c.target.target)}`}
                        {...(out && { 'aria-hidden': true, inert: true })}
                    >
                        <span className="chat-chip-name">{shortOf(c.target)}</span>
                        <button className="chat-chip-remove" aria-label={tx.chat.removeTarget(nameOf(c.target))} onClick={() => props.onRemove(i)}>
                            <X size={12} aria-hidden />
                        </button>
                    </span>
                );
            })}
            {/* always there to be measured; shown only while chips are hidden */}
            <button
                className={`chat-chips-more${hidden > 0 ? '' : ' measured'}`}
                aria-label={tx.chat.moreTargets(hidden)}
                data-tooltip={tx.chat.moreTargets(hidden)}
                onClick={() => props.onExpanded(true)}
                {...(hidden === 0 && { 'aria-hidden': true, inert: true })}
            >
                +{hidden}
            </button>
            {expanded && collapsible && (
                <button
                    className="chat-chips-less"
                    aria-label={tx.chat.collapseTargets}
                    data-tooltip={tx.chat.collapseTargets}
                    onClick={() => props.onExpanded(false)}
                >
                    <ChevronUp size={14} aria-hidden />
                </button>
            )}
        </div>
    );
}
