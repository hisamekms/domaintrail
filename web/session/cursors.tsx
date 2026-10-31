// The other participants' cursors over the canvas: only those on the same view as this page (equal `ViewLocation`),
// each with its participant's name and color, placed from tldraw world coordinates with the camera of this page.
import { useValue, type Editor } from 'tldraw';
import type { PeerCursor } from './presence';

export function PeerCursors({ editor, cursors }: { editor: Editor | null; cursors: readonly PeerCursor[] }) {
    // the placement follows this page's camera and the size of the canvas
    const camera = useValue(
        'camera',
        () => {
            if (!editor) return undefined;
            const { x, y, z } = editor.getCamera();
            const { w, h } = editor.getViewportScreenBounds();
            return { x, y, z, w, h };
        },
        [editor],
    );
    if (!editor || !camera || !cursors.length) return null;
    return (
        <div className="peer-cursors" aria-hidden>
            {cursors.map((c) => {
                const p = editor.pageToViewport(c.at);
                if (p.x < 0 || p.y < 0 || p.x > camera.w || p.y > camera.h) return null;
                return (
                    <div key={c.connection} className="peer-cursor" style={{ transform: `translate(${p.x}px, ${p.y}px)`, color: c.color }} data-peer={c.name}>
                        <svg width="14" height="18" viewBox="0 0 14 18">
                            <path d="M1 1 L1 15 L5 11 L8 17 L10 16 L7 10 L13 10 Z" fill="currentColor" stroke="white" strokeWidth="1" />
                        </svg>
                        <span className="peer-cursor-name" style={{ background: c.color }}>
                            {c.name}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}
