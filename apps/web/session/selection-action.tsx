// The selection's 💬 on the canvas (ADR 0026, the composer): a small button next to the selected shapes, following the
// camera, hidden while the canvas is dragged, panned or moving. It confirms the selection as the request's targets and
// puts the caret in the composer, as the `C` key does.
import { MessageSquarePlus } from 'lucide-react';
import { useValue, type Editor } from 'tldraw';

/** Room between the selection's bounds and the button. */
const GAP = 6;
const SIZE = 28;

export function SelectionAction({ editor, enabled, label, onConfirm }: { editor: Editor | null; enabled: boolean; label: string; onConfirm: () => void }) {
    const at = useValue(
        'selection action',
        () => {
            if (!editor || editor.getSelectedShapeIds().length === 0) return undefined;
            if (editor.inputs.getIsDragging() || editor.inputs.getIsPanning() || editor.getCameraState() === 'moving') return undefined;
            const bounds = editor.getSelectionPageBounds();
            if (!bounds) return undefined;
            // the top right corner, outside the shapes
            const corner = editor.pageToViewport({ x: bounds.maxX, y: bounds.minY });
            const { w, h } = editor.getViewportScreenBounds();
            const x = Math.min(corner.x + GAP, w - SIZE - GAP);
            const y = Math.max(corner.y - SIZE - GAP, GAP);
            if (corner.x < 0 || corner.y > h || x < 0) return undefined;
            return { x, y };
        },
        [editor],
    );
    if (!enabled || !at) return null;
    return (
        <div className="selection-action">
            <button
                style={{ transform: `translate(${at.x}px, ${at.y}px)` }}
                aria-label={label}
                data-tooltip={label}
                // keeps the canvas's selection: the click must not reach tldraw
                onPointerDown={(e) => e.stopPropagation()}
                onClick={onConfirm}
            >
                <MessageSquarePlus size={15} aria-hidden />
            </button>
        </div>
    );
}
