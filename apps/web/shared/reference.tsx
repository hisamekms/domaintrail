// The chat's references, drawn the same wherever they appear (the chat's replies, a knowledge item's sources and
// stickies): a muted line `↩ who: the head of what was said` that goes to it, and a `#name` chip that goes to an element.
import type { ReactElement, ReactNode } from 'react';

/**
 * One muted line, `↩ who: head` (the head cut to the room); a click goes to what it names. Without `onClick` it is
 * only text: what it names is not on this page.
 */
export function ReferenceLine({ who, head, tooltip, onClick }: { who: string; head: ReactNode; tooltip: string; onClick?: () => void }): ReactElement {
    const inner = (
        <>
            <span className="chat-reply-ref-run">↩ {who}:</span> <span className="chat-reply-ref-head">{head}</span>
        </>
    );
    if (!onClick)
        return (
            <span className="chat-reply-ref" data-tooltip={tooltip}>
                {inner}
            </span>
        );
    return (
        <button className="chat-reply-ref" onClick={onClick} data-tooltip={tooltip}>
            {inner}
        </button>
    );
}

/** A `#name` chip that goes to its element (`kind`: the target's kind, as the chat marks its chips). */
export function TargetLink({ name, tooltip, kind, onClick }: { name: string; tooltip: string; kind: string; onClick: () => void }): ReactElement {
    return (
        <a className={`chat-chip chat-target kind-${kind}`} onClick={onClick} data-tooltip={tooltip}>
            <span className="chat-chip-name">#{name}</span>
        </a>
    );
}
