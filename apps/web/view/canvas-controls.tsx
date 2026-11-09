import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronsLeft, ChevronsRight, Download, Focus, FoldHorizontal, Maximize, Minus, Plus, Shapes } from 'lucide-react';
import { useT } from '../i18n';
import { Legend, legendRows, type LegendView } from '../legend';
import { useDismiss } from '../shared/layout';
import { canvasShortcut, formatZoom, takesText, useCanvasControls, type CanvasShortcut } from './controls';
import { useCanvasValue, type DiagramCanvas } from './diagram';
import { ExportMenu, type ExportControl } from './export-menu';
import { LineTip } from './lines';

const ANIMATE = { animate: true };

/**
 * The canvas's camera controls and legend, at its bottom-left: `− 85% +` (zoom around the middle; the level resets to
 * 100% on a click), ⤢ (fit everything, as `fitAll` does for this canvas), ◎ (fit the selection), the legend's button,
 * which opens it upward, 「詰めて表示」 (every diagram in its compact layout, remembered), and « , which collapses all of it
 * into a » in the same corner (as `U` does, remembered). How the view is looked at, not what it shows: the view's
 * 印刷 and 書き出し are in its toolbar (`ExportButton`); the inspector's state diagram has its 書き出し here.
 */
export function CanvasControls(props: {
    /** Stable identity of this diagram's controls, including across remounts. */
    id: string;
    canvas: DiagramCanvas | null;
    fitAll: () => void;
    /** The legend of what the canvas shows, if it shows something. */
    legend: { view: LegendView; open: boolean; onToggle: () => void } | null;
    /** Whether the canvas's keys are this canvas's (the main canvas; not the inspector's diagram). */
    keys?: boolean;
    /** 「詰めて表示」, if the canvas offers it (the main canvas). */
    compact?: { on: boolean; onToggle: () => void };
    /** 書き出し, if the canvas offers it here (the inspector's state diagram), as a menu opening upward. */
    exporting?: ExportControl;
}) {
    const { canvas, fitAll, legend } = props;
    const t = useT();
    const { collapsed, toggle } = useCanvasControls(props.id);
    const root = useRef<HTMLDivElement>(null);
    const [exportOpen, setExportOpen] = useState(false);
    const closeExport = useCallback(() => setExportOpen(false), []);
    useDismiss(exportOpen, root, closeExport);
    const zoom = useCanvasValue(canvas, (c) => c?.getZoom() ?? 1, []);
    const selection = useCanvasValue(canvas, (c) => (c?.selectedIds().length ?? 0) > 0, []);

    useCanvasKeys(props.keys === true && canvas !== null, (action) => {
        if (!canvas) return;
        if (action === 'fitAll') fitAll();
        else if (action === 'fitSelection') canvas.fitSelection(ANIMATE);
        else toggle();
    });

    if (!canvas) return null;
    const pct = formatZoom(zoom);
    return (
        <div className={`canvas-controls${collapsed ? ' collapsed' : ''}`} ref={root}>
            {legend && !collapsed && <Legend view={legend.view} open={legend.open} onToggle={legend.onToggle} />}
            {props.exporting && exportOpen && !collapsed && <ExportMenu control={props.exporting} onDone={closeExport} up />}
            <div className="canvas-controls-bar" role="toolbar" aria-label={t.canvasControls.label} aria-hidden={collapsed} inert={collapsed}>
                <div className="canvas-controls-group">
                    <ControlButton label={t.canvasControls.zoomOut} onClick={() => canvas.zoomOut(ANIMATE)}>
                        <Minus size={14} aria-hidden />
                    </ControlButton>
                    <button
                        className="canvas-control canvas-zoom-level"
                        onClick={() => canvas.resetZoom(ANIMATE)}
                        data-tooltip={t.canvasControls.resetZoom}
                        aria-label={t.canvasControls.zoomLevel(pct)}
                    >
                        {pct}
                    </button>
                    <ControlButton label={t.canvasControls.zoomIn} onClick={() => canvas.zoomIn(ANIMATE)}>
                        <Plus size={14} aria-hidden />
                    </ControlButton>
                </div>
                <ControlButton label={t.canvasControls.fitAll} onClick={fitAll}>
                    <Maximize size={14} aria-hidden />
                </ControlButton>
                <ControlButton
                    label={selection ? t.canvasControls.fitSelection : t.canvasControls.fitSelectionNone}
                    disabled={!selection}
                    onClick={() => canvas.fitSelection(ANIMATE)}
                >
                    <Focus size={14} aria-hidden />
                </ControlButton>
                {props.compact && (
                    <button
                        className={`canvas-control${props.compact.on ? ' active' : ''}`}
                        aria-pressed={props.compact.on}
                        aria-label={t.canvasControls.compact}
                        data-tooltip={props.compact.on ? t.canvasControls.compactOff : t.canvasControls.compact}
                        onClick={props.compact.onToggle}
                    >
                        <FoldHorizontal size={14} aria-hidden />
                    </button>
                )}
                {props.exporting && (
                    <button
                        className={`canvas-control${exportOpen ? ' active' : ''}`}
                        aria-haspopup="menu"
                        aria-expanded={exportOpen}
                        aria-label={t.exportMenu.label}
                        data-tooltip={exportOpen ? undefined : t.exportMenu.label}
                        onClick={() => setExportOpen(!exportOpen)}
                    >
                        <Download size={14} aria-hidden />
                    </button>
                )}
                {legend && (
                    <button
                        className={`canvas-control canvas-legend-button${legend.open ? ' active' : ''}`}
                        aria-pressed={legend.open}
                        aria-expanded={legend.open}
                        aria-label={t.legend}
                        onClick={legend.onToggle}
                        data-tooltip={legend.open ? t.closeLegend : t.openLegend}
                    >
                        <Shapes size={14} aria-hidden />
                    </button>
                )}
                <ControlButton label={t.canvasControls.collapse} onClick={toggle}>
                    <ChevronsLeft size={14} aria-hidden />
                </ControlButton>
            </div>
            <button
                className="canvas-control canvas-expand"
                aria-label={t.canvasControls.expand}
                data-tooltip={t.canvasControls.expand}
                aria-hidden={!collapsed}
                inert={!collapsed}
                onClick={toggle}
            >
                <ChevronsRight size={14} aria-hidden />
            </button>
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
 * The canvas's keys (`canvasShortcut`), taken before the canvas's own (its `Shift+1` / `Shift+2` would fit differently,
 * see `flow-canvas.tsx`). The inspector's state diagram keeps the canvas's own while it has the focus.
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

/** How long the pointer rests on an edge before its meaning shows. */
const HINT_DELAY_MS = 300;

/**
 * What the edge under the pointer means, next to the pointer (the canvas tells the item under it: DOM hover may not
 * reach the items): a storming's line, its two ends and its relation in plain words (`LineTip`); another edge, what
 * the legend of the view says of its kind. Hidden while the pointer is pressed (a pan, a click).
 */
export function EdgeHint({ canvas, view }: { canvas: DiagramCanvas | null; view: LegendView | null }) {
    const t = useT();
    const rows = view ? legendRows(view, t.legendRows) : [];
    const hint = useCanvasValue(
        canvas,
        (c) => {
            if (!c || c.isPointing()) return null;
            const id = c.hoveredId();
            const item = id ? c.item(id) : undefined;
            if (item?.type !== 'edge') return null;
            const p = c.pointer();
            // a storming's line says its ends and what it means (none while it is pressed: its popover does);
            // other edges, what their kind means
            if (item.line) return c.onlySelectedId() === item.id ? null : { id: item.id, text: '', line: true, x: p.x, y: p.y };
            const text = rows.find((r) => r.kind === item.kind)?.text;
            if (!text) return null;
            return { id: item.id, text, line: false, x: p.x, y: p.y };
        },
        [rows.map((r) => r.text).join('\n')],
    );
    const [shownId, setShownId] = useState<string | null>(null);
    const hintId = hint?.id ?? null;
    useEffect(() => {
        if (!hintId) return setShownId(null);
        const timer = setTimeout(() => setShownId(hintId), HINT_DELAY_MS);
        return () => clearTimeout(timer);
    }, [hintId]);
    if (!hint || shownId !== hint.id) return null;
    const box = canvas?.viewportScreenBounds();
    const line = hint.line && canvas ? canvas.item(hint.id)?.line : undefined;
    return (
        <div
            className={`edge-hint${line ? ' edge-hint-line' : ''}`}
            role="tooltip"
            style={{ left: hint.x + (box?.x ?? 0) + 14, top: hint.y + (box?.y ?? 0) + 18 }}
        >
            {line && canvas ? <LineTip canvas={canvas} line={line} /> : hint.text}
        </div>
    );
}
