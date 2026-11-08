// その他 of a question (ADR 0026, amendment): the facilitator's own words, written in a dialog rather than in the row —
// the question at its top, a large text area, 決定 and キャンセル (⌘/Ctrl+Enter decides, Esc cancels) — and, once a
// question was answered, the same dialog to read the words in full.
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useChat } from './chat-context';
import { ReplyText } from './reply';
import { isMac } from './views';
import { Act } from '../shared/act';

/** The most characters of own words (the server's limit for an answer's text). */
export const OTHER_MAX = 2000;

/**
 * The dialog of その他, kept mounted so that it fades out as it closes: while `open`, a modal over the page with the
 * question (`question`) and the words (`text`) to edit — 決定 hands them over trimmed (empty: その他 is cleared, offered
 * only when there were words to clear) — or, `readOnly`, to read.
 */
export function OtherDialog({
    open,
    question,
    text,
    readOnly = false,
    onDecide,
    onClose,
}: {
    open: boolean;
    question: string;
    text: string;
    readOnly?: boolean;
    onDecide?: (text: string) => void;
    onClose: () => void;
}) {
    const { tx, onNavigate } = useChat();
    const o = tx.chat.reply.otherDialog;
    const dialog = useRef<HTMLDialogElement>(null);
    const area = useRef<HTMLTextAreaElement>(null);
    const [draft, setDraft] = useState(text);
    const mac = isMac(typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent);

    // a modal <dialog> traps the focus, closes on Escape (a cancel) and gives the focus back to what opened it; opening,
    // the words start as they are, the caret at their end
    useEffect(() => {
        const d = dialog.current;
        if (!d) return;
        if (open && !d.open) {
            setDraft(text);
            d.showModal();
            requestAnimationFrame(() => {
                const a = area.current;
                if (!a) return;
                a.focus();
                a.setSelectionRange(a.value.length, a.value.length);
            });
        } else if (!open && d.open) d.close();
        // the words are taken as they are when it opens, not as they change while it is open
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const decidable = !readOnly && (draft.trim() !== '' || text.trim() !== '');
    const decide = (): void => {
        if (!decidable) return;
        onDecide?.(draft.trim());
        onClose();
    };
    return (
        <dialog
            ref={dialog}
            className="session-dialog answer-other-dialog"
            aria-labelledby="answer-other-title"
            aria-describedby="answer-other-question"
            onClose={onClose}
            // a click on the backdrop lands on the dialog itself
            onClick={(e) => e.target === e.currentTarget && onClose()}
        >
            <div className="settings-dialog-header">
                <h2 id="answer-other-title">{o.title}</h2>
                <button type="button" className="icon-button" aria-label={o.close} data-tooltip={o.close} onClick={onClose}>
                    <X size={18} aria-hidden />
                </button>
            </div>
            <div className="settings-dialog-body answer-other-body">
                <p id="answer-other-question" className="answer-other-question">
                    <ReplyText text={question} onNavigate={onNavigate} />
                </p>
                {readOnly ? (
                    <p className="answer-other-text">{text}</p>
                ) : (
                    <textarea
                        ref={area}
                        className="session-text answer-other-input"
                        value={draft}
                        maxLength={OTHER_MAX}
                        rows={8}
                        aria-label={o.input}
                        placeholder={o.placeholder}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                decide();
                            }
                        }}
                    />
                )}
                <div className="answer-other-actions">
                    {readOnly ? (
                        <Act kind="open" onClick={onClose}>
                            {o.close}
                        </Act>
                    ) : (
                        <>
                            {decidable && (
                                <kbd className="chat-shortcut" aria-hidden>
                                    {mac ? '⌘↵' : 'Ctrl↵'}
                                </kbd>
                            )}
                            <Act kind="stop" onClick={onClose}>
                                {o.cancel}
                            </Act>
                            <Act kind="decide" disabled={!decidable} onClick={decide} data-tooltip={o.decideHint(mac ? '⌘+Enter' : 'Ctrl+Enter')}>
                                {o.decide}
                            </Act>
                        </>
                    )}
                </div>
            </div>
        </dialog>
    );
}
