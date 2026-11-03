// The other participants' cursors over the canvas: only those on the same view as this page (equal `ViewLocation`),
// each with its participant's name and color (an identity token, `--participant-*`, with its name in
// `--on-participant` and a halo of the surface around both), placed from page coordinates with the camera of this page.
import { useCanvasValue, type DiagramCanvas } from '../view/diagram';
import type { PeerCursor } from './presence';

export function PeerCursors({ canvas, cursors }: { canvas: DiagramCanvas | null; cursors: readonly PeerCursor[] }) {
    // the placement follows this page's camera and the size of the canvas
    const camera = useCanvasValue(
        canvas,
        (c) => {
            if (!c) return undefined;
            const { x, y, z } = c.getCamera();
            const { w, h } = c.viewportScreenBounds();
            return { x, y, z, w, h };
        },
        [],
    );
    if (!canvas || !camera || !cursors.length) return null;
    return (
        <div className="peer-cursors" aria-hidden>
            {cursors.map((c) => {
                const p = canvas.pageToViewport(c.at);
                if (p.x < 0 || p.y < 0 || p.x > camera.w || p.y > camera.h) return null;
                return (
                    <div key={c.connection} className="peer-cursor" style={{ transform: `translate(${p.x}px, ${p.y}px)`, color: c.color }} data-peer={c.name}>
                        <svg width="14" height="18" viewBox="0 0 14 18">
                            <path className="peer-cursor-arrow" d="M1 1 L1 15 L5 11 L8 17 L10 16 L7 10 L13 10 Z" fill="currentColor" strokeWidth="1" />
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
