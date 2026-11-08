// The selection's 💬 (ADR 0026, the composer): a small button next to the selected shapes on the canvas, following the
// camera, hidden while the canvas is dragged, panned or moving, and the same button next to the selected element's name
// in the inspector's heading. It adds the selection as the request's targets and puts the caret in the composer, as the
// `C` key does; once every selected element is a chip it shows as added, and only opens the chat.
import { Check, MessageSquarePlus } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { useCanvasValue, type DiagramCanvas } from '../view/diagram';

/** Room between the selection's bounds and the button. */
const GAP = 6;
const SIZE = 28;

/** What a 💬 shows and does. */
export interface AddAction {
    /** Every selected element already is a chip. */
    readonly added: boolean;
    readonly label: string;
    readonly addedLabel: string;
    readonly onAdd: () => void;
}

/** The 💬 itself: `MessageSquarePlus`, or a muted ✓ once added. */
export function AddButton({ action, style }: { action: AddAction; style?: CSSProperties }): ReactNode {
    const label = action.added ? action.addedLabel : action.label;
    return (
        <button
            className={`add-to-request${action.added ? ' added' : ''}`}
            style={style}
            aria-label={label}
            data-tooltip={label}
            // keeps the canvas's selection: the click must not reach the canvas
            onPointerDown={(e) => e.stopPropagation()}
            onClick={action.onAdd}
        >
            {action.added ? <Check size={15} aria-hidden /> : <MessageSquarePlus size={15} aria-hidden />}
        </button>
    );
}

export function SelectionAction({ canvas, action }: { canvas: DiagramCanvas | null; action: AddAction | undefined }): ReactNode {
    const at = useCanvasValue(
        canvas,
        (c) => {
            if (!c || c.selectedIds().length === 0) return undefined;
            if (c.isMoving()) return undefined;
            const bounds = c.selectionBounds();
            if (!bounds) return undefined;
            // the top right corner, outside the items
            const corner = c.pageToViewport({ x: bounds.x + bounds.w, y: bounds.y });
            const { w, h } = c.viewportScreenBounds();
            const x = Math.min(corner.x + GAP, w - SIZE - GAP);
            const y = Math.max(corner.y - SIZE - GAP, GAP);
            if (corner.x < 0 || corner.y > h || x < 0) return undefined;
            return { x, y };
        },
        [],
    );
    if (!action || !at) return null;
    return (
        <div className="selection-action">
            <AddButton action={action} style={{ transform: `translate(${at.x}px, ${at.y}px)` }} />
        </div>
    );
}
