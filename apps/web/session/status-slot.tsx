// The status slot of a chat row (ADR 0026, amendment): at the right end of the row's header, the same on messages and AI
// turns, so that what is active can be read down one column. It takes room only when the row has a status, then as much
// as the longest text it can show in the current language (measured once, set on the chat as `--chat-status-width`),
// its content at the left, so that the glyphs stand in one column. A message's slot holds a link to its AI turn, not a
// state: the state is the work's, shown once on the turn. Also the facilitator's cancel of a run: a bordered ✕ right
// after the slot that asks first, in a modal dialog; and the row's actions, a small toolbar floating at its top right.
import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { ArrowDown, Bot, X } from 'lucide-react';
import type { MarkState, MessageMark } from './cards';
import { useChat } from './chat-context';
import { unitName, type ChangeUnit } from './history';
import { cancelPrompt, slotLabels, STATE_GLYPH } from './status';
import { Act } from '../shared/act';

/** A state as the slot shows it: its glyph (a pulsing dot while running) and its word, in the state's color. */
export function StateLabel({ state, label }: { state: MarkState; label: string }) {
    return (
        <>
            {state === 'running' ? <span className="chat-pulse" aria-hidden /> : <span aria-hidden>{STATE_GLYPH[state]}</span>}
            {label}
        </>
    );
}

/**
 * A sent message's slot: a small link to the AI turn of its latest run, the AI's avatar in small and ↓, muted (its
 * state, and that it goes there, in the tooltip); a click goes to the turn.
 */
export function TurnLink({ mark }: { mark: MessageMark }) {
    const { tx, jump } = useChat();
    const hint = tx.chat.toTurn(tx.chat.marks[mark.state]);
    return (
        <button className="chat-turn-link" onClick={() => jump(`card:${mark.card}`)} aria-label={hint} data-tooltip={hint}>
            <span className="session-avatar chat-agent-avatar" aria-hidden>
                <Bot />
            </span>
            <ArrowDown aria-hidden />
        </button>
    );
}

/** The slot itself: nothing when the row has no status, so that the header keeps its width. */
export function StatusSlot({ children }: { children?: ReactNode }): ReactNode {
    return children ? <span className="chat-status-cell">{children}</span> : null;
}

/**
 * A row's actions (the facilitator's tools, ↩, ☺+ last): a small toolbar over the row's top right, shown while the row
 * is hovered or holds the focus (or one of its menus is open), always on touch; it takes no room in the header.
 */
export function RowActions({ children }: { children?: ReactNode }): ReactNode {
    return <span className="chat-actions">{children}</span>;
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
 * The confirmation before a cancel, over the page: running, 実行を中止しますか？ (its work so far is lost); queued,
 * 待ちの実行を中止しますか？ — then the unit's name, and やめる (the focus starts there; Esc too) or 実行を中止. It follows the run:
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
                <Act ref={keep} kind="stop" onClick={onClose}>
                    {d.keep}
                </Act>
                <Act kind="danger" onClick={confirm}>
                    {d.confirm}
                </Act>
            </div>
        </dialog>
    );
}
