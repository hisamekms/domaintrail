import { X } from 'lucide-react';
import type { Tx } from './chat-context';

/** The right column's views: the chat's stream and AI の作業. */
export type ChatView = 'chat' | 'history';

const CHAT_VIEWS: readonly ChatView[] = ['chat', 'history'];

/**
 * The head of the right column: its two views as tabs — AI の作業 with the number of units not finished (running and
 * queued), whichever tab is shown — and ✕, which closes the column.
 */
export function ChatHead(props: { view: ChatView; onView: (view: ChatView) => void; unfinished: number; onClose: () => void; tx: Tx }) {
    const { view, tx } = props;
    return (
        <div className="chat-head">
            <div className="segmented chat-views" role="tablist" aria-label={tx.chat.tabsLabel}>
                {CHAT_VIEWS.map((v) => (
                    <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'active' : ''} onClick={() => props.onView(v)}>
                        {tx.chat.tabs[v]}
                        {v === 'history' && props.unfinished > 0 && (
                            <span className="chat-views-badge" role="img" aria-label={tx.chat.history.unfinished(props.unfinished)}>
                                {props.unfinished}
                            </span>
                        )}
                    </button>
                ))}
            </div>
            <button className="icon-button" onClick={props.onClose} data-tooltip={tx.chat.close} aria-label={tx.chat.close}>
                <X size={16} aria-hidden />
            </button>
        </div>
    );
}
