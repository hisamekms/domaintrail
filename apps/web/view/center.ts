import { useEffect } from 'react';
import type { Editor } from 'tldraw';

/** A size on the screen, in CSS pixels. */
export interface Size {
    readonly w: number;
    readonly h: number;
}

/** A tldraw camera: a point of the page is on the canvas at `(page + camera) * z`. */
export interface Camera {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

/**
 * The camera that keeps the point of the page at the canvas's center there while the canvas goes from `before` to
 * `after` (tldraw keeps its top-left corner instead): half of each change, in page units. The zoom is kept.
 */
export function centeredCamera(camera: Camera, before: Size, after: Size): Camera {
    return { x: camera.x + (after.w - before.w) / 2 / camera.z, y: camera.y + (after.h - before.h) / 2 / camera.z, z: camera.z };
}

/** A canvas that is not laid out (hidden, or not yet sized) has no center to keep. */
export function isLaidOut(size: Size): boolean {
    return size.w >= 1 && size.h >= 1;
}

/** Whether tldraw is moving the camera itself (zoomToFit and the like, animated): a camera set now would stop it. */
function animatingCamera(editor: Editor): boolean {
    // internal to tldraw (5.5): the running animation of `_animateToViewport`, null when there is none
    const animation: unknown = Reflect.get(editor, '_viewportAnimation');
    return animation != null;
}

/**
 * Keeps what is at the center of the canvas at its center whenever the canvas changes size — a pane opening, closing
 * or dragged, the inspector moving, the window resized — frame by frame while the panes animate. The size the canvas
 * mounts with is only noted (it is fitted then), and a camera animation under way (a fit) is left alone.
 */
export function useCenterOnResize(editor: Editor | null): void {
    useEffect(() => {
        if (!editor) return;
        const container = editor.getContainer();
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
            if (!isLaidOut(before) || (before.w === size.w && before.h === size.h) || animatingCamera(editor)) return;
            // tldraw's own update of its viewport is throttled; this one is needed for the camera of this very frame
            editor.updateViewportScreenBounds(container);
            editor.setCamera(centeredCamera(editor.getCamera(), before, size));
        });
        observer.observe(container);
        return () => observer.disconnect();
    }, [editor]);
}
