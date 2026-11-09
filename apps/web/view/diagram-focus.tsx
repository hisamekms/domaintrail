import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useT } from '../i18n';
import { motionMs } from '../shared/motion';

/** Gives an embedded diagram the whole browser tab while keeping it in the same React context. */
export function DiagramFocus(props: {
    open: boolean;
    title: string;
    origin?: DOMRect | undefined;
    onClose: () => void;
    children: ReactNode | ((requestClose: () => void) => ReactNode);
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const onClose = useRef(props.onClose);
    onClose.current = props.onClose;
    const [closing, setClosing] = useState(false);
    const t = useT();
    const requestClose = useCallback(() => {
        if (motionMs('--motion-diagram-focus') === 0) onClose.current();
        else setClosing(true);
    }, []);

    useLayoutEffect(() => {
        if (!props.open) return;
        const element = dialog.current;
        if (!element) return;
        const origin = props.origin;
        if (origin) {
            element.style.setProperty('--diagram-origin-x', `${origin.x}px`);
            element.style.setProperty('--diagram-origin-y', `${origin.y}px`);
            element.style.setProperty('--diagram-origin-scale-x', String(origin.width / window.innerWidth));
            element.style.setProperty('--diagram-origin-scale-y', String(origin.height / window.innerHeight));
        }
        element.showModal();
        return () => element.close();
    }, [props.open]);

    useEffect(() => {
        if (!closing) return;
        const timer = window.setTimeout(() => onClose.current(), motionMs('--motion-diagram-focus'));
        return () => window.clearTimeout(timer);
    }, [closing]);

    useEffect(() => {
        if (!props.open) setClosing(false);
    }, [props.open]);

    const content = typeof props.children === 'function' ? props.children(requestClose) : props.children;
    if (!props.open) return content;
    return createPortal(
        <dialog
            ref={dialog}
            className={`diagram-focus${closing ? ' closing' : ''}`}
            aria-label={props.title}
            onCancel={(event) => {
                event.preventDefault();
                requestClose();
            }}
        >
            <header className="diagram-focus-header">
                <strong>{props.title}</strong>
                <button type="button" className="icon-button" aria-label={t.closeDiagram} data-tooltip={t.closeDiagram} onClick={requestClose}>
                    <X size={18} aria-hidden />
                </button>
            </header>
            <div className="diagram-focus-body">{content}</div>
        </dialog>,
        document.body,
    );
}
