import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useT } from '../i18n';

/** Gives an embedded diagram the whole browser tab while keeping it in the same React context. */
export function DiagramFocus(props: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
    const dialog = useRef<HTMLDialogElement>(null);
    const t = useT();

    useLayoutEffect(() => {
        if (!props.open) return;
        dialog.current?.showModal();
        return () => dialog.current?.close();
    }, [props.open]);

    if (!props.open) return props.children;
    return createPortal(
        <dialog
            ref={dialog}
            className="diagram-focus"
            aria-label={props.title}
            onCancel={(event) => {
                event.preventDefault();
                props.onClose();
            }}
        >
            <header className="diagram-focus-header">
                <strong>{props.title}</strong>
                <button type="button" className="icon-button" aria-label={t.closeDiagram} data-tooltip={t.closeDiagram} onClick={props.onClose}>
                    <X size={18} aria-hidden />
                </button>
            </header>
            <div className="diagram-focus-body">{props.children}</div>
        </dialog>,
        document.body,
    );
}
