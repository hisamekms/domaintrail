import { useEffect } from 'react';
import type { Camera, DiagramCanvas } from './diagram';

/** A size on the screen, in CSS pixels. */
export interface Size {
    readonly w: number;
    readonly h: number;
}

/**
 * The camera that keeps the point of the page at the canvas's center there while the canvas goes from `before` to
 * `after` (the canvas keeps its top-left corner instead): half of each change, in page units. The zoom is kept.
 */
export function centeredCamera(camera: Camera, before: Size, after: Size): Camera {
    return { x: camera.x + (after.w - before.w) / 2 / camera.z, y: camera.y + (after.h - before.h) / 2 / camera.z, z: camera.z };
}

/** A canvas that is not laid out (hidden, or not yet sized) has no center to keep. */
export function isLaidOut(size: Size): boolean {
    return size.w >= 1 && size.h >= 1;
}

/**
 * Keeps what is at the center of the canvas at its center whenever the canvas changes size — a pane opening, closing
 * or dragged, the inspector moving, the window resized — frame by frame while the panes animate. The size the canvas
 * mounts with is only noted (it is fitted then), and a camera animation under way (a fit) is left alone.
 */
export function useCenterOnResize(canvas: DiagramCanvas | null): void {
    useEffect(() => {
        if (!canvas) return;
        const container = canvas.container();
        const measure = (): Size => {
            const r = container.getBoundingClientRect();
            return { w: r.width, h: r.height };
        };
        let last = measure();
        const observer = new ResizeObserver(() => {
            const size = measure();
            if (!isLaidOut(size)) return;
            const before = last;
            last = size;
            if (!isLaidOut(before) || (before.w === size.w && before.h === size.h) || canvas.isAnimating()) return;
            // the canvas's own update of its viewport may lag behind; this one is needed for the camera of this very frame
            canvas.measure();
            canvas.setCamera(centeredCamera(canvas.getCamera(), before, size));
        });
        observer.observe(container);
        return () => observer.disconnect();
    }, [canvas]);
}
