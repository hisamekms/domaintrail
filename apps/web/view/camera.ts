import { useEffect, useRef } from 'react';
import type { DisplayMode, Lang } from '@domaintrail/visualization';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import { buildScene } from '../render';
import { cameraMove, fitAll, fitReadable } from './canvas';
import { canvasShows } from './empty';
import type { Camera, DiagramCanvas } from './diagram';
import type { ViewGraph } from './graph';
import { isCanvas, type View } from './navigation';
import type { ViewSettings } from './settings';

/**
 * Draws the current view's graph on the canvas. Each view keeps its camera (by `ViewGraph.cameraKey`): a redraw of the
 * shown graph (a live reload) keeps it, a view shown again gets it back, and a view shown the first time is fitted
 * (a storming view: each time it is shown). An empty view (`empty`) clears the canvas. A view's compact layout
 * (「詰めて表示」) is another graph, with a camera of its own; it draws no ghosts of removed elements (they are where the
 * baseline's normal layout had them).
 */
export function useViewCamera(
    canvas: DiagramCanvas | null,
    current: ViewPayload | null,
    view: View,
    settings: ViewSettings,
    viewGraph: ViewGraph,
    display: { mode: DisplayMode; lang: Lang },
    empty: boolean,
): void {
    const base = current?.base ?? null;
    const { structureLevel, mapAll } = settings;
    const { graph, graphFor, cameraKey, focusKey, noneChecked, stormingShown } = viewGraph;
    const { mode, lang } = display;
    const cameras = useRef(new Map<string, Camera>());
    const shownView = useRef<string | null>(null);

    useEffect(() => {
        if (!canvas || !current) return;
        const shows = canvasShows(view.kind, empty, !!graph);
        if (shows === 'covered') return;
        const compact = graph?.spacing === 'compact';
        const key = isCanvas(view) ? `${cameraKey(view)}${compact ? ':compact' : ''}` : null;
        if (key && shownView.current && shownView.current !== key) cameras.current.set(shownView.current, canvas.getCamera());
        const switched = shownView.current !== key;
        if (shows === 'nothing' || !key || !graph) {
            // not marked as shown, so that the graph is fitted once it arrives (focused views load on request); an empty
            // view of the canvas forgets the shown one, so that the next view is shown anew (a storming view fitted)
            if (empty && key) shownView.current = null;
            canvas.clear();
            return;
        }
        // ghosts of removed elements need the baseline's version of the same graph; focused graphs are not kept
        const before = compact || (focusKey && view.kind === 'structure') ? undefined : (graphFor(base, view) ?? undefined);
        canvas.show(buildScene(graph, { diff: current.diff, diagnostics: current.diagnostics, previous: before, mode, lang }));
        const saved = cameras.current.get(key);
        const move = cameraMove({ switched, storming: view.kind === 'storming', saved: !!saved });
        if (move === 'restore' && saved) canvas.setCamera(saved);
        else if (move === 'fitAll') fitAll(canvas, graph);
        // larger text (overview) allows zooming further out while staying readable
        else if (move === 'fitReadable') fitReadable(canvas, graph.textScale ?? 1);
        shownView.current = key;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvas, current, base, view, mode, structureLevel, focusKey, graph, mapAll, noneChecked, lang, stormingShown, empty]);
}
