// The status slot of a chat row (ADR 0026, amendment): one fixed-width slot right before the row's actions, the same on
// messages and AI turns, so that what is active can be read down one column. The slot is as wide as the longest text
// it can show in the current language (measured once, set on the chat as `--chat-status-width`); a row without a
// status keeps it empty. Also the facilitator's cancel of a run: a bordered ✕ that asks first, in a modal dialog.
import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import type { MarkState } from './cards';
import { useChat } from './chat-context';
import { unitName, type ChangeUnit } from './history';
import { cancelPrompt, slotLabels, STATE_GLYPH } from './status';

/** A state as the slot shows it: its glyph (a pulsing dot while running) and its word, in the state's color. */
export function StateLabel({ state, label }: { state: MarkState; label: string }) {
    return (
        <>
            {state === 'running' ? <span className="chat-pulse" aria-hidden /> : <span aria-hidden>{STATE_GLYPH[state]}</span>}
            {label}
        </>
    );
}

/** The slot itself: empty when the row has no status, so that the actions after it line up too. */
export function StatusSlot({ children }: { children?: ReactNode }) {
    return <span className="chat-status-cell">{children}</span>;
}

/**
 * A row's actions after its slot, at its right end: as wide on every row (the most a row of the reader's has: the
 * facilitator's four, a participant's ↩ and ☺+), so that the slots line up whichever actions a row offers.
 */
export function RowActions({ children }: { children?: ReactNode }) {
    const { control } = useChat();
    return <span className={`chat-actions${control ? ' control' : ''}`}>{children}</span>;
}

/**
 * Sizes every slot of the chat (`root`) to the longest text it can show: all of them laid over each other, hidden, and
 * the width they take set on the chat. Measured again as it changes size (the language, the fonts loading).
 */
export function StatusSizer({ root }: { root: RefObject<HTMLElement | null> }) {
    const { tx } = useChat();
    const sizer = useRef<HTMLSpanElement>(null);
    const labels = slotLabels(tx.chat.marks);
    useLayoutEffect(() => {
        const el = sizer.current;
        const chat = root.current;
        if (!el || !chat) return;
        const apply = (): void => chat.style.setProperty('--chat-status-width', `${Math.ceil(el.getBoundingClientRect().width)}px`);
        apply();
        const observer = new ResizeObserver(apply);
        observer.observe(el);
        return () => observer.disconnect();
    }, [root]);
    return (
        <span className="chat-status-sizer" ref={sizer} aria-hidden>
            {labels.map((label) => (
                <span key={label} className="chat-state">
                    <StateLabel state="partial" label={label} />
                </span>
            ))}
        </span>
    );
}

/** The facilitator's cancel of a unit's running or queued run: a bordered ✕ (danger on hover), asking first. */
export function CancelButton({ unit }: { unit: ChangeUnit }) {
    const { tx, confirmCancel } = useChat();
    return (
        <button
            type="button"
            className="chat-cancel-button"
            onClick={() => confirmCancel(unit.key)}
            aria-label={tx.chat.cancelRun}
            data-tooltip={tx.chat.cancelRun}
        >
            <X size={12} aria-hidden />
        </button>
    );
}

/**
 * The confirmation before a cancel, over the page: running, 実行を取り消しますか？ (its work so far is lost); queued,
 * 依頼を取り消しますか？ — then the unit's name, and やめる (the focus starts there; Esc too) or 取り消す. It follows the run:
 * as it starts, the title changes; once it ended, the dialog closes.
 */
export function CancelDialog({ unit, onClose }: { unit: ChangeUnit; onClose: () => void }) {
    const { tx, actions } = useChat();
    const d = tx.chat.cancelDialog;
    const dialog = useRef<HTMLDialogElement>(null);
    const keep = useRef<HTMLButtonElement>(null);
    const last = unit.runs[unit.runs.length - 1].run;
    const prompt = cancelPrompt(last.state, d);
    useEffect(() => {
        const el = dialog.current;
        if (el && !el.open) {
            el.showModal();
            keep.current?.focus();
        }
        return () => el?.close();
    }, []);
    useEffect(() => {
        if (!prompt) onClose();
    }, [prompt, onClose]);
    if (!prompt) return null;
    const name = unitName(unit).text;
    const confirm = (): void => {
        onClose();
        void actions.cancel(last.id);
    };
    return (
        <dialog
            ref={dialog}
            className="session-dialog cancel-dialog"
            aria-labelledby="cancel-dialog-title"
            aria-describedby="cancel-dialog-name"
            onClose={onClose}
            // a click on the backdrop lands on the dialog itself
            onClick={(e) => e.target === e.currentTarget && onClose()}
        >
            <h2 id="cancel-dialog-title" className="cancel-dialog-title">
                {prompt.title}
            </h2>
            <p id="cancel-dialog-name" className="cancel-dialog-name" title={name}>
                {name}
            </p>
            {prompt.lost && <p className="cancel-dialog-lost">{prompt.lost}</p>}
            <div className="cancel-dialog-buttons">
                <button ref={keep} type="button" className="cancel-dialog-button" onClick={onClose}>
                    {d.keep}
                </button>
                <button type="button" className="cancel-dialog-button danger" onClick={confirm}>
                    {d.confirm}
                </button>
            </div>
        </dialog>
    );
}
