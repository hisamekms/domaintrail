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
import { useCompactGraph } from './view/compact';
import type { ExportOptions, ExportTarget } from './view/export';
import { exportFileName, sheetHeading, type SheetSubject } from './view/sheet';
import { useCanvasValue, type Camera, type DiagramCanvas } from './view/diagram';
import { FlowCanvas } from './view/flow-canvas';
import { selectedElement } from './view/navigation';

/**
 * Camera of each aggregate's diagram (and of its compact layout, `<aggregate>:compact`), kept while the page is open
 * (the canvas unmounts with its inspector tab).
 */
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
    /** 「詰めて表示」: the compact layout, once the page has it (without ghosts of removed states). */
    compact: boolean;
    /** The aggregate's name and label, and the workspace's name: what an exported diagram says it is. */
    aggregate: { name: string; label?: string | undefined };
    workspaceName: string | undefined;
    /** 書き出し's options (the workspace's). */
    exportOptions: { options: ExportOptions; setOptions: (options: ExportOptions) => void };
}) {
    const { aggregateId } = props;
    const t = useT();
    const [canvas, setCanvas] = useState<DiagramCanvas | null>(null);
    const [savedLabels, setLabels] = usePersistentState<TransitionLabels>('domaintrail.states.transitionLabels', 'both');
    const labels = TRANSITION_LABELS.includes(savedLabels) ? savedLabels : 'both';
    const graph = useCompactGraph(props.graphs?.[labels], props.compact);
    const previous = graph?.spacing === 'compact' ? undefined : props.previous?.[labels];
    /** The aggregate's camera key: its compact layout has a camera of its own. */
    const cameraKey = graph?.spacing === 'compact' ? `${aggregateId}:compact` : aggregateId;
    /** The camera key shown (set once it is restored or fitted). */
    const shown = useRef<string | null>(null);

    useCenterOnResize(canvas);
    useEffect(() => {
        applyTheme(props.theme, canvas);
    }, [props.theme, canvas]);

    useEffect(() => {
        if (!canvas) return;
        return canvas.watch(() => {
            const camera = canvas.getCamera();
            if (shown.current === cameraKey) cameras.set(cameraKey, camera);
        });
    }, [canvas, cameraKey]);

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
        if (shown.current !== cameraKey) {
            const saved = cameras.get(cameraKey);
            if (saved) canvas.setCamera(saved);
            else fitAll(canvas, graph);
            shown.current = cameraKey;
            if (props.selected) highlightElement(canvas, props.selected);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvas, graph, previous, props.diff, props.diagnostics, props.mode, props.lang, labels, cameraKey]);

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
    const exportTarget = (): ExportTarget | null => {
        if (!graph) return null;
        const subject: SheetSubject = { view: 'states', aggregate: { id: aggregateId, ...props.aggregate } };
        return {
            graph,
            // as drawn, without the ghosts of removed states
            scene: () => buildScene(graph, { diff: props.diff, diagnostics: props.diagnostics, mode: props.mode, lang: props.lang, transitionLabels: labels }),
            heading: sheetHeading(props.workspaceName, subject, t, props.mode),
            legend: 'states',
            fileName: (ext) => exportFileName(props.workspaceName, subject, ext),
        };
    };

    return (
        <div className="states-canvas">
            <FlowCanvas onMount={onMount} />
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
                        exporting={{ target: exportTarget, ...props.exportOptions }}
                    />
                    <EdgeHint canvas={canvas} view="states" />
                </>
            ) : (
                <div className="empty">{t.noDiagram}</div>
            )}
        </div>
    );
}
