import { useEffect, useRef } from 'react';
import type { DisplayMode, Lang } from '@domaintrail/visualization';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import { buildScene } from '../render';
import { cameraMove, fitAll, fitReadable } from './canvas';
import type { Camera, DiagramCanvas } from './diagram';
import type { ViewGraph } from './graph';
import { isCanvas, type View } from './navigation';
import type { ViewSettings } from './settings';

/**
 * Draws the current view's graph on the canvas. Each view keeps its camera (by `ViewGraph.cameraKey`): a redraw of the
 * shown graph (a live reload) keeps it, a view shown again gets it back, and a view shown the first time is fitted
 * (a storming view: each time it is shown).
 */
export function useViewCamera(
    canvas: DiagramCanvas | null,
    current: ViewPayload | null,
    view: View,
    settings: ViewSettings,
    viewGraph: ViewGraph,
    display: { mode: DisplayMode; lang: Lang },
): void {
    const base = current?.base ?? null;
    const { structureLevel, mapAll } = settings;
    const { graph, graphFor, cameraKey, focusKey, focusGraph, noneChecked, stormingShown } = viewGraph;
    const { mode, lang } = display;
    const cameras = useRef(new Map<string, Camera>());
    const shownView = useRef<string | null>(null);

    useEffect(() => {
        if (!canvas || !current || !isCanvas(view)) return;
        const key = cameraKey(view);
        if (shownView.current && shownView.current !== key) cameras.current.set(shownView.current, canvas.getCamera());
        const switched = shownView.current !== key;
        if (!graph) {
            // not marked as shown, so that the graph is fitted once it arrives (focused views load on request)
            canvas.clear();
            return;
        }
        // ghosts of removed elements need the baseline's version of the same graph; focused graphs are not kept
        const before = focusKey && view.kind === 'structure' ? undefined : (graphFor(base, view) ?? undefined);
        canvas.show(buildScene(graph, { diff: current.diff, diagnostics: current.diagnostics, previous: before, mode, lang }));
        const saved = cameras.current.get(key);
        const move = cameraMove({ switched, storming: view.kind === 'storming', saved: !!saved });
        if (move === 'restore' && saved) canvas.setCamera(saved);
        else if (move === 'fitAll') fitAll(canvas, graph);
        // larger text (overview) allows zooming further out while staying readable
        else if (move === 'fitReadable') fitReadable(canvas, graph.textScale ?? 1);
        shownView.current = key;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvas, current, base, view, mode, structureLevel, focusKey, focusGraph, mapAll, noneChecked, lang, stormingShown]);
}
