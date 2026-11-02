import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelDiff } from '@domaintrail/modeling';
import type { Diagnostic } from '@domaintrail/kernel';
import { type DisplayMode, type LaidOutGraph, type Lang, TRANSITION_LABELS, type TransitionLabels } from '@domaintrail/visualization';
import { fitAll, highlightElement } from './view/canvas';
import { useT } from './i18n';
import { usePersistentState } from './shared/layout';
import { buildScene } from './render';
import { applyTheme, type Theme } from './theme';
import { CanvasControls, EdgeHint } from './view/canvas-controls';
import { useCenterOnResize } from './view/center';
import { useCanvasValue, type Camera, type DiagramCanvas } from './view/diagram';
import { selectedElement } from './view/navigation';
import { TldrawCanvas } from './view/tldraw-canvas';

/** Camera of each aggregate's diagram, kept while the page is open (the canvas unmounts with its inspector tab). */
const cameras = new Map<string, Camera>();

/**
 * State diagram of one aggregate, in the inspector. It stays on the aggregate while its states and commands are
 * selected (in the diagram or elsewhere), and shows the selected one.
 */
export function StatesCanvas(props: {
    aggregateId: string;
    /** The aggregate's graph laid out for each way of labeling transitions. */
    graphs: Record<TransitionLabels, LaidOutGraph> | undefined;
    /** The previously shown version of the same graphs, for ghosts of removed states. */
    previous: Record<TransitionLabels, LaidOutGraph> | undefined;
    diff: ModelDiff;
    diagnostics: Diagnostic[];
    mode: DisplayMode;
    lang: Lang;
    theme: Theme;
    selected: string | undefined;
    onSelect: (id: string) => void;
    legendOpen: boolean;
    onLegendToggle: () => void;
}) {
    const { aggregateId } = props;
    const t = useT();
    const [canvas, setCanvas] = useState<DiagramCanvas | null>(null);
    const [savedLabels, setLabels] = usePersistentState<TransitionLabels>('domaintrail.states.transitionLabels', 'both');
    const labels = TRANSITION_LABELS.includes(savedLabels) ? savedLabels : 'both';
    const graph = props.graphs?.[labels];
    const previous = props.previous?.[labels];
    /** The aggregate whose camera is shown (set once it is restored or fitted). */
    const shown = useRef<string | null>(null);

    useCenterOnResize(canvas);
    useEffect(() => {
        applyTheme(props.theme, canvas);
    }, [props.theme, canvas]);

    useEffect(() => {
        if (!canvas) return;
        return canvas.watch(() => {
            const camera = canvas.getCamera();
            if (shown.current === aggregateId) cameras.set(aggregateId, camera);
        });
    }, [canvas, aggregateId]);

    // Draw the graph; restore the aggregate's camera, or fit the first time it is shown.
    useEffect(() => {
        if (!canvas) return;
        if (!graph) {
            canvas.clear();
            shown.current = null;
            return;
        }
        canvas.show(
            buildScene(graph, {
                diff: props.diff,
                diagnostics: props.diagnostics,
                previous,
                mode: props.mode,
                lang: props.lang,
                transitionLabels: labels,
            }),
        );
        if (shown.current !== aggregateId) {
            const saved = cameras.get(aggregateId);
            if (saved) canvas.setCamera(saved);
            else fitAll(canvas, graph);
            shown.current = aggregateId;
            if (props.selected) highlightElement(canvas, props.selected);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvas, graph, previous, props.diff, props.diagnostics, props.mode, props.lang, labels, aggregateId]);

    // Show a selection made elsewhere.
    useEffect(() => {
        if (canvas && props.selected && shown.current) highlightElement(canvas, props.selected);
    }, [canvas, props.selected]);

    // Clicking an item selects its element (without moving the camera).
    const selectedOnCanvas = useCanvasValue(canvas, selectedElement, []);
    useEffect(() => {
        if (selectedOnCanvas && selectedOnCanvas !== props.selected) props.onSelect(selectedOnCanvas);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedOnCanvas]);

    const onMount = useCallback((c: DiagramCanvas) => setCanvas(c), []);

    return (
        <div className="states-canvas">
            <TldrawCanvas onMount={onMount} />
            {graph ? (
                <>
                    <div className="canvas-toolbar">
                        <div className="segmented small" role="group" aria-label={t.transitionLabels}>
                            {TRANSITION_LABELS.map((l) => (
                                <button
                                    key={l}
                                    className={labels === l ? 'active' : ''}
                                    aria-pressed={labels === l}
                                    onClick={() => setLabels(l)}
                                    data-tooltip={t.transitionLabelModes[l].hint}
                                >
                                    {t.transitionLabelModes[l].label}
                                </button>
                            ))}
                        </div>
                    </div>
                    <CanvasControls
                        canvas={canvas}
                        fitAll={() => canvas && fitAll(canvas, graph, true)}
                        legend={{ view: 'states', open: props.legendOpen, onToggle: props.onLegendToggle }}
                    />
                    <EdgeHint canvas={canvas} view="states" />
                </>
            ) : (
                <div className="empty">{t.noDiagram}</div>
            )}
        </div>
    );
}
