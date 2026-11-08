// Printing the Live View: a canvas view prints its diagram alone, fitted whole to one landscape page in light colors,
// in its compact layout (「詰めて表示」); the catalog prints as the page it is, its list without the panes around it
// (the print styles in styles.css).
//
// The diagram is printed from a sheet of its own (`PrintSheet`), drawn while printing only: the scene in an `<svg>` whose
// viewBox is the diagram's bounds, so that the browser scales it to whatever page the print dialog picks (the canvas's
// camera is in pixels of the screen, which no print layout keeps). The sheet is static, so that it is drawn at once:
// Ctrl+P prints as soon as `beforeprint` returns. The 印刷 action (`usePrint().print`) first gets the compact layout and
// draws the sheet, then opens the print dialog; Ctrl+P prints the compact layout if the page has it, the shown one if not.
//
// The page has no margin (`@page { margin: 0 }`), so that the browser prints no header or footer of its own (the page's
// title, its URL, the date); the sheet keeps its own margin, and has its own line above the diagram: where it is and how
// it is shown (`sheetHeading`). The legend goes under the diagram if the viewer asked for it (書き出し's 凡例を含める).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import type { DisplayMode, LaidOutGraph } from '@domaintrail/visualization';
import type { ViewPayload } from '@domaintrail/visualization/protocol';
import {
    EdgeContent,
    edgeClassName,
    EdgeMarks,
    GroupContent,
    groupClassName,
    groupStyle,
    InternalContent,
    internalClassName,
    internalStyle,
    NodeContent,
    nodeClassName,
    nodeStyle,
} from '../diagram-items';
import { useLang, useT } from '../i18n';
import { LegendBody, type LegendView } from '../legend';
import { buildScene } from '../render';
import { sceneItems, type DiagMark, type Rect, type SceneItem } from '../scene';
import type { Theme } from '../theme';
import { graphBounds } from './canvas';

/** Where printing is: not, getting the compact layout (the 印刷 action), or printing (the sheet is drawn). */
export type PrintPhase = 'idle' | 'preparing' | 'printing';

/** How long the 印刷 action waits for the compact layout before it prints the shown one. */
export const PRINT_WAIT_MS = 5000;

/** Room left around the diagram on its sheet (page units). */
const SHEET_MARGIN = 8;

/** What printing the current view prints: a canvas view, its diagram on a sheet of its own; the catalog, the page. */
export const printKind = (canvas: boolean): 'diagram' | 'page' => (canvas ? 'diagram' : 'page');

/**
 * Whether the 印刷 action can print `graph` now: its compact layout is shown, there is nothing to wait for (no graph),
 * or it has waited long enough. Undefined is a graph still loading (a focused view).
 */
export function readyToPrint(graph: LaidOutGraph | null | undefined, waitedMs: number): boolean {
    return graph === null || graph?.spacing === 'compact' || waitedMs >= PRINT_WAIT_MS;
}

/** The part of the page a sheet shows: everything the graph draws, with a margin. */
export function sheetBounds(graph: LaidOutGraph): Rect {
    const b = graphBounds(graph) ?? { x: 0, y: 0, w: 1, h: 1 };
    return { x: b.x - SHEET_MARGIN, y: b.y - SHEET_MARGIN, w: b.w + 2 * SHEET_MARGIN, h: b.h + 2 * SHEET_MARGIN };
}

/** Printing the page (`usePrint`). */
export interface Printer {
    /** A canvas view wants its compact layout while this is not `idle`. */
    phase: PrintPhase;
    /** The 印刷 action. */
    print: () => void;
    /** When the 印刷 action started, while it waits to open the print dialog. */
    started: { current: number | undefined };
    setPhase: (phase: PrintPhase | ((p: PrintPhase) => PrintPhase)) => void;
}

/**
 * Printing the page: its phase and the 印刷 action. Ctrl+P (or the browser's menu) prints too: `beforeprint` draws the
 * sheet at once. While printing, the page is in the light theme. `usePrintWhenReady` opens the print dialog of the action.
 */
export function usePrint(theme: Theme): Printer {
    const [phase, setPhase] = useState<PrintPhase>('idle');
    /** The page's theme, put back after printing. */
    const pageTheme = useRef(theme);
    pageTheme.current = theme;
    const phaseNow = useRef(phase);
    phaseNow.current = phase;
    /** When the 印刷 action started (it opens the print dialog once the sheet is drawn). */
    const started = useRef<number | undefined>(undefined);

    useEffect(() => {
        const before = (): void => {
            document.documentElement.dataset.theme = 'light';
            // Ctrl+P: the browser prints right after this returns, so the sheet is drawn now
            if (phaseNow.current === 'idle') flushSync(() => setPhase('printing'));
        };
        const after = (): void => {
            document.documentElement.dataset.theme = pageTheme.current;
            started.current = undefined;
            setPhase('idle');
        };
        addEventListener('beforeprint', before);
        addEventListener('afterprint', after);
        return () => {
            removeEventListener('beforeprint', before);
            removeEventListener('afterprint', after);
        };
    }, []);

    const print = (): void => {
        if (phaseNow.current !== 'idle') return;
        started.current = performance.now();
        setPhase('preparing');
    };
    return { phase, print, started, setPhase };
}

/** The 印刷 action's print dialog: opened once `graph` is shown compact (or waiting longer would not help) and drawn on the sheet. */
export function usePrintWhenReady(printer: Printer, graph: LaidOutGraph | null | undefined): void {
    const { phase, started, setPhase } = printer;
    useEffect(() => {
        if (phase !== 'preparing' || started.current === undefined) return;
        const waited = performance.now() - started.current;
        if (readyToPrint(graph, waited)) {
            setPhase('printing');
            return;
        }
        const timer = setTimeout(() => setPhase((p) => (p === 'preparing' ? 'printing' : p)), PRINT_WAIT_MS - waited);
        return () => clearTimeout(timer);
    }, [phase, graph, started, setPhase]);

    useEffect(() => {
        if (phase !== 'printing' || started.current === undefined) return;
        started.current = undefined;
        let cancelled = false;
        // the sheet's fonts and the fits of its notes' labels, then a frame drawn with them
        void document.fonts.ready.then(() =>
            requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                    if (!cancelled) window.print();
                }),
            ),
        );
        return () => {
            cancelled = true;
        };
    }, [phase, started]);
}

/** The change badge and the diagnostic mark of a node on the sheet, at their normal size. */
function SheetMarks({ badge, diag }: { badge: string; diag: DiagMark }): ReactNode {
    return <EdgeMarks badge={badge} diag={diag} scale={1} />;
}

/** A box of the scene on the sheet, where the canvas draws it (relative to the sheet's top-left corner). */
function SheetBox({ item, origin }: { item: Exclude<SceneItem, { type: 'edge' }>; origin: Rect }): ReactNode {
    const place = { position: 'absolute', left: item.x - origin.x, top: item.y - origin.y } as const;
    const ghost = item.ghost === true ? 'print-box diagram-ghost' : 'print-box';
    if (item.type === 'group')
        return (
            <div className={ghost} style={place}>
                <div className={groupClassName(item.props, false)} style={groupStyle(item.props)}>
                    <GroupContent p={item.props} />
                </div>
            </div>
        );
    if (item.type === 'internal')
        return (
            <div className={ghost} style={place}>
                <div className={internalClassName(item.props)} style={internalStyle(item.props)}>
                    <InternalContent p={item.props} />
                </div>
            </div>
        );
    return (
        <div className={ghost} style={place}>
            <div className={nodeClassName(item.props, false)} style={nodeStyle(item.props)}>
                <NodeContent p={item.props} Marks={SheetMarks} />
            </div>
        </div>
    );
}

/**
 * The diagram as printed: the scene of `graph`, as the canvas draws it (without selection or hover), on a landscape
 * page, fitted whole, under its heading and over its legend (if any). Drawn into `<body>`, beside the app, which the
 * print styles hide; hidden on the screen.
 */
export function PrintSheet(props: { graph: LaidOutGraph; current: ViewPayload; mode: DisplayMode; heading: string; legend: LegendView | null }): ReactNode {
    const { graph, current, mode } = props;
    const lang = useLang();
    const t = useT();
    const scene = useMemo(
        () => buildScene(graph, { diff: current.diff, diagnostics: current.diagnostics, mode, lang }),
        [graph, current.diff, current.diagnostics, mode, lang],
    );
    const items = sceneItems(scene);
    const box = sheetBounds(graph);
    return createPortal(
        <div className="print-sheet" aria-hidden>
            {/* a page of the diagram's shape, without the browser's header and footer (the catalog prints on its default page) */}
            <style>{'@page { size: landscape; margin: 0; }'}</style>
            <div className="print-heading">{props.heading}</div>
            <svg className="print-sheet-svg" viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} preserveAspectRatio="xMidYMid meet">
                <foreignObject x={box.x} y={box.y} width={box.w} height={box.h}>
                    <div className="print-sheet-boxes" style={{ width: box.w, height: box.h }}>
                        {/* a hidden resolved hotspot is not drawn: its sticky's check stands for it */}
                        {items.map((item) =>
                            item.type === 'edge' || (item.type === 'node' && item.on !== undefined) ? null : (
                                <SheetBox key={item.id} item={item} origin={box} />
                            ),
                        )}
                    </div>
                </foreignObject>
                {items.map((item) =>
                    item.type === 'edge' ? (
                        <g key={item.id} className={edgeClassName(item.props)} transform={`translate(${item.x},${item.y})`}>
                            <EdgeContent p={item.props} />
                        </g>
                    ) : null,
                )}
            </svg>
            {props.legend && (
                <div className="legend print-legend">
                    <div className="legend-title">{t.legend}</div>
                    <LegendBody view={props.legend} />
                </div>
            )}
        </div>,
        document.body,
    );
}
