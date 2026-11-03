// A message's bubble in the chat (ADR 0026): its author's avatar and name, a badge, its time and its status slot on the
// name line (a message continuing the one before of the same author: none of that, the time on hover), then its body;
// and a text clamped to a few lines with a link to the rest. Shared by people's messages, the AI's answers and the
// change proposals.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useChat, type Tx } from './chat-context';

export const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function Bubble(props: {
    avatar: ReactNode;
    who: string;
    badge?: ReactNode;
    meta?: ReactNode;
    at: string | undefined;
    /** It continues the bubble before, of the same author: no avatar nor name; the time on hover. */
    continues?: boolean;
    className?: string;
    /** At the right end of the name line (of a continued message, a line of its own above the body): its status slot. */
    side?: ReactNode;
    children: ReactNode;
}) {
    if (props.continues)
        return (
            <div className={`chat-message continued ${props.className ?? ''}`} {...(props.at && { title: time(props.at) })}>
                <span className="chat-avatar-space" aria-hidden />
                <div className="chat-message-main">
                    {props.side}
                    <div className="chat-bubble">{props.children}</div>
                </div>
            </div>
        );
    return (
        <div className={`chat-message ${props.className ?? ''}`}>
            {props.avatar}
            <div className="chat-message-main">
                <div className="chat-message-head">
                    <span className="chat-who">{props.who}</span>
                    {props.badge}
                    {props.meta}
                    {props.at && (
                        <time className="chat-time" dateTime={props.at}>
                            {time(props.at)}
                        </time>
                    )}
                    {props.side}
                </div>
                <div className="chat-bubble">{props.children}</div>
            </div>
        </div>
    );
}

/**
 * The classes of a clamped text: `clamped` while it is not opened (history), `cut` too when it is taller than the clamp
 * (measured): only then does the last line of the AI's Markdown fade out (the CSS), so that one that fits shows whole,
 * unfaded.
 */
export function clampedClass(input: { readonly blocks: boolean; readonly className?: string; readonly open: boolean; readonly cut: boolean }): string {
    const { blocks, className, open, cut } = input;
    return `chat-text${blocks ? ' chat-markdown' : ''}${className ? ` ${className}` : ''}${open ? '' : ' clamped'}${cut && !open ? ' cut' : ''}`;
}

/**
 * A text clamped to a few lines, with a link to show the rest when it is longer, if it was there when the page loaded
 * (`revealKey`: its key, `message:<id>`, `proposal:<id>`, `run:<id>`; see `reveal.ts`); one that arrived while the page
 * is open shows in full, and one opened stays open. `blocks`: its children are blocks (the AI's Markdown), in a
 * `<div>` clamped by its height.
 */
export function Clamped({
    children,
    tx,
    revealKey,
    blocks = false,
    className,
}: {
    children: ReactNode;
    tx: Tx;
    revealKey: string;
    blocks?: boolean;
    className?: string;
}) {
    const { reveal } = useChat();
    const [open, setOpen] = useState(() => !reveal.clamps(revealKey));
    const [clamped, setClamped] = useState(false);
    const ref = useRef<HTMLParagraphElement & HTMLDivElement>(null);
    const Tag = blocks ? 'div' : 'p';
    useLayoutEffect(() => {
        const el = ref.current;
        if (el && !open) setClamped(el.scrollHeight > el.clientHeight + 1);
    }, [children, open]);
    return (
        <>
            <Tag ref={ref} className={clampedClass({ blocks, className, open, cut: clamped })}>
                {children}
            </Tag>
            {clamped && !open && (
                <a
                    className="chat-more"
                    onClick={() => {
                        reveal.open(revealKey);
                        setOpen(true);
                    }}
                >
                    {tx.chat.showMore}
                </a>
            )}
        </>
    );
}
