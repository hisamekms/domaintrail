import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BookOpen, Check, Ellipsis, Focus, Maximize, Minus, Plus } from 'lucide-react';
import { useValue, type Editor } from 'tldraw';
import { useT } from '../i18n';
import { Legend, legendRows, type LegendView } from '../legend';
import { useDismiss } from '../shared/layout';
import { canvasShortcut, formatZoom, takesText, useCanvasControls, type CanvasShortcut } from './controls';

const ANIMATION = { animation: { duration: 200 } };

/** Fits the canvas's selection (the camera never moves when nothing is selected). */
function fitSelection(editor: Editor): void {
    if (editor.getSelectedShapeIds().length > 0) editor.zoomToSelection(ANIMATION);
}

/**
 * The canvas's camera controls and legend, at its bottom-left: `− 85% +` (zoom around the middle; the level resets to
 * 100% on a click), ⤢ (fit everything, as `fitAll` does for this canvas), ◎ (fit the selection) and 凡例, which opens
 * the legend upward. The reader hides the zoom part and the legend separately (`CanvasMenu`), or both for now (`U`).
 */
export function CanvasControls(props: {
    editor: Editor | null;
    fitAll: () => void;
    /** The legend of what the canvas shows, if it shows something. */
    legend: { view: LegendView; open: boolean; onToggle: () => void } | null;
    /** Whether the canvas's keys are this canvas's (the main canvas; not the inspector's diagram). */
    keys?: boolean;
}) {
    const { editor, fitAll, legend } = props;
    const t = useT();
    const { shown, toggleTemporarily } = useCanvasControls();
    const zoom = useValue('zoom level', () => editor?.getZoomLevel() ?? 1, [editor]);
    const selection = useValue('has selection', () => (editor?.getSelectedShapeIds().length ?? 0) > 0, [editor]);

    useCanvasKeys(props.keys === true && editor !== null, (action) => {
        if (!editor) return;
        if (action === 'fitAll') fitAll();
        else if (action === 'fitSelection') fitSelection(editor);
        else toggleTemporarily();
    });

    const showLegend = shown.legend && legend !== null;
    if (!editor || (!shown.zoom && !showLegend)) return null;
    const center = editor.getViewportScreenCenter();
    const pct = formatZoom(zoom);
    return (
        <div className="canvas-controls">
            {showLegend && <Legend view={legend.view} open={legend.open} onToggle={legend.onToggle} />}
            <div className="canvas-controls-bar" role="toolbar" aria-label={t.canvasControls.label}>
                {shown.zoom && (
                    <>
                        <div className="canvas-controls-group">
                            <ControlButton label={t.canvasControls.zoomOut} onClick={() => editor.zoomOut(center, ANIMATION)}>
                                <Minus size={14} aria-hidden />
                            </ControlButton>
                            <button
                                className="canvas-zoom-level"
                                onClick={() => editor.resetZoom(center, ANIMATION)}
                                data-tooltip={t.canvasControls.resetZoom}
                                aria-label={t.canvasControls.zoomLevel(pct)}
                            >
                                {pct}
                            </button>
                            <ControlButton label={t.canvasControls.zoomIn} onClick={() => editor.zoomIn(center, ANIMATION)}>
                                <Plus size={14} aria-hidden />
                            </ControlButton>
                        </div>
                        <ControlButton label={t.canvasControls.fitAll} onClick={fitAll}>
                            <Maximize size={14} aria-hidden />
                        </ControlButton>
                        <ControlButton
                            label={selection ? t.canvasControls.fitSelection : t.canvasControls.fitSelectionNone}
                            disabled={!selection}
                            onClick={() => fitSelection(editor)}
                        >
                            <Focus size={14} aria-hidden />
                        </ControlButton>
                    </>
                )}
                {showLegend && (
                    <button
                        className={`canvas-legend-button${legend.open ? ' active' : ''}`}
                        aria-pressed={legend.open}
                        aria-expanded={legend.open}
                        onClick={legend.onToggle}
                        data-tooltip={legend.open ? t.closeLegend : t.openLegend}
                    >
                        <BookOpen size={14} aria-hidden />
                        {t.legend}
                    </button>
                )}
            </div>
        </div>
    );
}

/**
 * An icon button of the cluster. Disabled, it stays hoverable (`aria-disabled`), so that its tooltip says why.
 */
function ControlButton(props: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
    return (
        <button
            className="canvas-control"
            aria-label={props.label}
            data-tooltip={props.label}
            aria-disabled={props.disabled === true}
            onClick={props.disabled ? undefined : props.onClick}
        >
            {props.children}
        </button>
    );
}

/**
 * The canvas's keys (`canvasShortcut`), taken before tldraw's own: its `Shift+1` / `Shift+2` would fit differently.
 * The inspector's state diagram keeps tldraw's while it has the focus.
 */
function useCanvasKeys(active: boolean, run: (action: CanvasShortcut) => void): void {
    const latest = useRef(run);
    latest.current = run;
    useEffect(() => {
        if (!active) return;
        const onKey = (e: KeyboardEvent): void => {
            const focused = document.activeElement;
            if (focused?.closest('.states-canvas, dialog')) return;
            const action = canvasShortcut(e, takesText(focused));
            if (!action) return;
            e.preventDefault();
            e.stopPropagation();
            latest.current(action);
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [active]);
}

/**
 * The canvas pane's menu (⋯ at the right end of its toolbar, like the inspector's): what shows at the canvas's
 * bottom-left. It stays in the toolbar whatever is hidden.
 */
export function CanvasMenu() {
    const t = useT();
    const { shown, choose } = useCanvasControls();
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    useDismiss(open, root, () => setOpen(false));
    const item = (part: 'zoom' | 'legend', label: string) => (
        <button role="menuitemcheckbox" aria-checked={shown[part]} onClick={() => choose(part, !shown[part])}>
            <span className="pane-menu-check">{shown[part] && <Check size={14} aria-hidden />}</span>
            {label}
        </button>
    );
    return (
        <div className="pane-menu canvas-menu" ref={root}>
            <button
                className="icon-button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t.canvasMenu.label}
                data-tooltip={t.canvasMenu.label}
                onClick={() => setOpen(!open)}
            >
                <Ellipsis size={16} aria-hidden />
            </button>
            {open && (
                <div className="pane-menu-list" role="menu" aria-label={t.canvasMenu.label}>
                    <div className="pane-menu-heading" role="presentation">
                        {t.canvasMenu.display}
                    </div>
                    {item('zoom', t.canvasMenu.zoom)}
                    {item('legend', t.legend)}
                    <div className="pane-menu-note" role="presentation">
                        {t.canvasMenu.hideKey}
                    </div>
                </div>
            )}
        </div>
    );
}

/** How long the pointer rests on an edge before its meaning shows. */
const HINT_DELAY_MS = 300;

/**
 * What the edge under the pointer means, as the legend of the view says it, next to the pointer (tldraw hit-tests the
 * shapes itself: DOM hover never reaches them). Hidden while the pointer is pressed (a pan, a click).
 */
export function EdgeHint({ editor, view }: { editor: Editor | null; view: LegendView | null }) {
    const t = useT();
    const rows = view ? legendRows(view, t.legendRows) : [];
    const hint = useValue(
        'edge hint',
        () => {
            if (!editor || rows.length === 0 || editor.inputs.getIsPointing()) return null;
            const id = editor.getHoveredShapeId();
            const shape = id ? editor.getShape(id) : undefined;
            if (shape?.type !== 'domain-edge') return null;
            const text = rows.find((r) => r.kind === (shape.props as { kind: string }).kind)?.text;
            if (!text) return null;
            const p = editor.inputs.getCurrentScreenPoint();
            return { id: shape.id, text, x: p.x, y: p.y };
        },
        [editor, rows.map((r) => r.text).join('\n')],
    );
    const [shownId, setShownId] = useState<string | null>(null);
    const hintId = hint?.id ?? null;
    useEffect(() => {
        if (!hintId) return setShownId(null);
        const timer = setTimeout(() => setShownId(hintId), HINT_DELAY_MS);
        return () => clearTimeout(timer);
    }, [hintId]);
    if (!hint || shownId !== hint.id) return null;
    const box = editor?.getViewportScreenBounds();
    return (
        <div className="edge-hint" role="tooltip" style={{ left: hint.x + (box?.x ?? 0) + 14, top: hint.y + (box?.y ?? 0) + 18 }}>
            {hint.text}
        </div>
    );
}
