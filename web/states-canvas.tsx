import { useCallback, useEffect, useRef, useState } from 'react';
import { Tldraw, react, useValue, type Editor, type TLCamera } from 'tldraw';
import type { Diagnostic } from '../src/core/diagnostics';
import type { ModelDiff } from '../src/graph/diff';
import { TRANSITION_LABELS, type DisplayMode, type Lang, type LaidOutGraph, type TransitionLabels } from '../src/graph/ir';
import { fitAll, highlightElement, usePointerCursor } from './canvas';
import { useT } from './i18n';
import { usePersistentState } from './layout';
import { Legend } from './legend';
import { renderGraph, shapeElementId, withWriteAccess } from './render';
import { shapeUtils } from './shapes';
import { applyTheme, type Theme } from './theme';

/** Camera of each aggregate's diagram, kept while the page is open (the canvas unmounts with its inspector tab). */
const cameras = new Map<string, TLCamera>();

/**
 * State diagram of one aggregate, in the inspector. It stays on the aggregate while its states and commands are
 * selected (in the diagram or elsewhere), and shows the selected one.
 */
export function StatesCanvas(props: {
    aggregateId: string;
    graph: LaidOutGraph | undefined;
    /** The previously shown version of the same graph, for ghosts of removed states. */
    previous: LaidOutGraph | undefined;
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
    const { aggregateId, graph } = props;
    const t = useT();
    const [editor, setEditor] = useState<Editor | null>(null);
    const [savedLabels, setLabels] = usePersistentState<TransitionLabels>('domaintrail.states.transitionLabels', 'both');
    const labels = TRANSITION_LABELS.includes(savedLabels) ? savedLabels : 'both';
    /** The aggregate whose camera is shown (set once it is restored or fitted). */
    const shown = useRef<string | null>(null);

    usePointerCursor(editor);
    useEffect(() => {
        applyTheme(props.theme, editor);
    }, [props.theme, editor]);

    useEffect(() => {
        if (!editor) return;
        return react('remember camera', () => {
            const camera = editor.getCamera();
            if (shown.current === aggregateId) cameras.set(aggregateId, camera);
        });
    }, [editor, aggregateId]);

    // Draw the graph; restore the aggregate's camera, or fit the first time it is shown.
    useEffect(() => {
        if (!editor) return;
        if (!graph) {
            withWriteAccess(editor, () => editor.deleteShapes([...editor.getCurrentPageShapeIds()]));
            shown.current = null;
            return;
        }
        renderGraph(editor, graph, { diff: props.diff, diagnostics: props.diagnostics, previous: props.previous, mode: props.mode, lang: props.lang, transitionLabels: labels });
        if (shown.current !== aggregateId) {
            const saved = cameras.get(aggregateId);
            if (saved) editor.setCamera(saved);
            else fitAll(editor, graph);
            shown.current = aggregateId;
            if (props.selected) highlightElement(editor, props.selected);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editor, graph, props.previous, props.diff, props.diagnostics, props.mode, props.lang, labels, aggregateId]);

    // Show a selection made elsewhere.
    useEffect(() => {
        if (editor && props.selected && shown.current) highlightElement(editor, props.selected);
    }, [editor, props.selected]);

    // Clicking a shape selects it (without moving the camera).
    const selectedOnCanvas = useValue(
        'selected element',
        () => {
            const only = editor?.getOnlySelectedShape();
            return only && editor ? shapeElementId(editor, only.id) : undefined;
        },
        [editor],
    );
    useEffect(() => {
        if (selectedOnCanvas && selectedOnCanvas !== props.selected) props.onSelect(selectedOnCanvas);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedOnCanvas]);

    const onMount = useCallback((e: Editor) => {
        e.updateInstanceState({ isReadonly: true });
        setEditor(e);
    }, []);

    return (
        <div className="states-canvas">
            <Tldraw shapeUtils={shapeUtils} hideUi onMount={onMount} />
            {graph ? (
                <>
                    <div className="canvas-toolbar">
                        <div className="segmented small" role="group" aria-label={t.transitionLabels}>
                            {TRANSITION_LABELS.map((l) => (
                                <button key={l} className={labels === l ? 'active' : ''} aria-pressed={labels === l} onClick={() => setLabels(l)} data-tooltip={t.transitionLabelModes[l].hint}>
                                    {t.transitionLabelModes[l].label}
                                </button>
                            ))}
                        </div>
                        <button onClick={() => editor && fitAll(editor, graph, true)}>{t.zoomToFit}</button>
                    </div>
                    <Legend view="states" open={props.legendOpen} onToggle={props.onLegendToggle} />
                </>
            ) : (
                <div className="empty">{t.noDiagram}</div>
            )}
        </div>
    );
}
