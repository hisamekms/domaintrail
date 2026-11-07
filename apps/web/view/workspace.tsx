import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BookOpen, Box, LayoutGrid, LayoutList, Network, Workflow, type LucideIcon } from 'lucide-react';
import { type DisplayMode, type Lang, STRUCTURE_LEVELS, type StructureLevel } from '@domaintrail/visualization';
import type { StormingView, ViewPayload } from '@domaintrail/visualization/protocol';
import { Catalog, CatalogFilters, CatalogSearch, useCatalogFilter } from '../catalog';
import { ContextList } from '../context-picker';
import { useLang, useT } from '../i18n';
import { type CatalogFilter, contextLabels, nameIn } from '../model-utils';
import type { LegendView } from '../legend';
import { focusOn, shownFocus, shownStorming, StormingFilter, StormingToolbar, type ScopeView } from '../storming';
import { exceptionSpan } from '@domaintrail/visualization';
import { nodeItemId, unionRects } from '../scene';
import { drawnLanes, escapeEnds, ExceptionLanes } from './exception-lanes';
import { applyTheme, type Theme } from '../theme';
import { workspaceName } from '../app/health';
import type { Legends } from '../app/legends';
import { buildScene } from '../render';
import { useViewCamera } from './camera';
import type { CanvasMarks } from './change-marks';
import { useCenterOnResize } from './center';
import { CanvasControls, EdgeHint } from './canvas-controls';
import { emptyLine, isEmptyView } from './empty';
import { FlowCanvas } from './flow-canvas';
import { LinePopover, OffscreenPointers } from './lines';
import { fitAll } from './canvas';
import type { DiagramCanvas } from './diagram';
import { activeFilterCount } from './filters';
import { useViewGraph, type ViewGraph } from './graph';
import { useExportOptions, type ExportOptions, type ExportTarget } from './export';
import { ExportButton, PrintButton, toolbarOutput } from './export-menu';
import { PrintSheet, printKind, usePrint, usePrintWhenReady, type Printer } from './print';
import { canvasSubject, exportFileName, sheetHeading } from './sheet';
import { isCanvas, useNavigation, useOpenOnStormings, useSelectOnCanvas, type Navigation, type View } from './navigation';
import { useViewSettings, type ViewSettings } from './settings';
import { useFollow, type Follow } from './follow';
import { FilterPopover, FilterSection, LevelSwitch, NameSwitch, SubjectName, ToolbarEnd, ToolbarSubject } from './toolbar';
import { MODEL_VIEWS, useWorlds, type ModelView, type Worlds } from './worlds';

const LEVEL_ICONS: Record<StructureLevel, LucideIcon> = { detail: LayoutList, overview: LayoutGrid, aggregates: Box };
const VIEW_ICONS: Record<ModelView, LucideIcon> = { contextMap: Network, structure: Workflow, catalog: BookOpen };

/** A level's short name, beside its icon: the part of its name before what it shows (「詳細 — すべての項目を表示」: 詳細). */
export const shortName = (name: string): string => name.split(' — ')[0] ?? name;

/** The state of the view workspace: the canvas, the current view with its navigation, settings and graph. */
export interface Workspace {
    /** The reader's canvas: a camera move or a selection asked through it stops following (`view/follow.ts`). */
    canvas: DiagramCanvas | null;
    onMount: (canvas: DiagramCanvas) => void;
    stormings: readonly StormingView[];
    /** The reader's navigation: showing a view or selecting through it stops following. */
    nav: Navigation;
    /** The world shown (the app bar's switch), derived from the view. */
    worlds: Worlds;
    /** The reader's settings: a change through them stops following. */
    settings: ViewSettings;
    viewGraph: ViewGraph;
    /** Whom the page follows (the AI, a participant), and the bare canvas and setters for their moves. */
    follow: Follow;
    /** The catalog's filter (a session's message carries it as where it was sent from). */
    catalog: { filter: CatalogFilter; setFilter: (filter: CatalogFilter) => void };
    printer: Printer;
    /** What an export (and a print) includes besides the diagram, remembered. */
    exportOptions: { options: ExportOptions; setOptions: (options: ExportOptions) => void };
    /**
     * The marks of a turn's changes on the storming canvas (docs/live-view.md, "What a turn changed"): the page's own
     * (per viewer), set by the session; and the stormings the page saw before, where removed stickies are found.
     */
    marks: { shown: CanvasMarks | null; set: (marks: CanvasMarks | null) => void; snapshots: readonly (readonly StormingView[])[] };
    /**
     * Shows a storming as a toolbar, the navigator or a link asks it (`ScopeView`): its choice and the exception
     * emphasized (through the reader's settings), then the camera to a stage's frame or an exception's path, once drawn.
     */
    showStorming: (view: ScopeView) => void;
}

/** How many earlier versions of the stormings a page keeps, to draw removed stickies where they were. */
const SNAPSHOTS = 8;

/**
 * The stormings the page was sent, the last few versions, oldest first (the current one last): the same array until
 * another version comes.
 */
function useStormingSnapshots(stormings: readonly StormingView[]): readonly (readonly StormingView[])[] {
    const kept = useRef<readonly (readonly StormingView[])[]>([]);
    return useMemo(() => {
        if (stormings.length > 0 && kept.current.at(-1) !== stormings) kept.current = [...kept.current, stormings].slice(-SNAPSHOTS);
        return kept.current;
    }, [stormings]);
}

/**
 * The view workspace: the current view, the navigation between views and selections with its history, and the canvas
 * (its camera and the graph drawn on it, in the page's theme).
 */
export function useViewWorkspace(current: ViewPayload | null, display: { mode: DisplayMode; lang: Lang; theme: Theme }): Workspace {
    const { mode, lang, theme } = display;
    const [canvas, setCanvas] = useState<DiagramCanvas | null>(null);
    const stormings = useMemo(() => current?.stormings ?? [], [current?.stormings]);
    const bareNav = useNavigation(canvas, current, stormings);
    const bareSettings = useViewSettings();
    // what the reader's controls get: each of their moves stops following; the page's own (a view drawn, a resize, the
    // canvas's selection becoming the navigation's) use the bare ones
    const { follow, canvas: readerCanvas, nav, settings } = useFollow(canvas, bareNav, bareSettings);
    const worlds = useWorlds(nav.view, nav.setView);
    const catalog = useCatalogFilter();
    const printer = usePrint(theme);
    const [exportOptions, setExportOptions] = useExportOptions();
    // printing a diagram prints its compact layout
    const viewGraph = useViewGraph(current, nav.view, settings, stormings, settings.compact || printer.phase !== 'idle');
    usePrintWhenReady(printer, isCanvas(nav.view) ? viewGraph.graph : null);
    useOpenOnStormings(current, bareNav.setView);
    const [marks, setMarks] = useState<CanvasMarks | null>(null);
    const snapshots = useStormingSnapshots(stormings);
    useViewCamera(canvas, current, nav.view, settings, viewGraph, { mode, lang }, current !== null && isEmptyView(nav.view.kind, current), {
        shown: marks,
        snapshots,
    });

    useEffect(() => {
        applyTheme(theme, canvas);
    }, [theme, canvas]);

    useSelectOnCanvas(canvas, bareNav.select);
    useCenterOnResize(canvas);

    const onMount = useCallback((c: DiagramCanvas) => setCanvas(c), []);

    // the camera to a stage's frame or an exception's path, once the view asked for is drawn
    const [frame, setFrame] = useState<ScopeView['frame'] & { at: number }>();
    const stormingRender = viewGraph.stormingShown?.render;
    useEffect(() => {
        if (!frame || !canvas || !stormingRender) return;
        const ids = 'stage' in frame ? [`st:${frame.stage}`] : exceptionSpan(stormingRender, frame.exception);
        let done = false;
        const id = requestAnimationFrame(() =>
            requestAnimationFrame(() => {
                const rects = ids.flatMap((n) => canvas.itemBounds(nodeItemId(n)) ?? []);
                const bounds = rects.length ? unionRects(rects) : undefined;
                if (bounds) canvas.fitBounds(bounds, { maxZoom: 1, inset: 48, animate: true });
                done = true;
                setFrame(undefined);
            }),
        );
        return () => {
            if (!done) cancelAnimationFrame(id);
        };
    }, [frame, canvas, stormingRender, viewGraph.graph]);
    const { setStormingChoice, setStormingFocus, stormingChoice } = settings;
    const showStorming = useCallback(
        (v: ScopeView): void => {
            if (v.choice !== stormingChoice) setStormingChoice(v.choice);
            setStormingFocus(v.focus);
            if (v.frame) setFrame({ ...v.frame, at: Date.now() });
        },
        [stormingChoice, setStormingChoice, setStormingFocus],
    );
    // the exception emphasized is close to a selection: Escape ends it once no sticky is selected (a second Escape),
    // and a press on the canvas's empty space ends both
    const focused = nav.view.kind === 'storming' && shownFocus(stormings, stormingChoice, settings.stormingFocus) !== undefined;
    useEffect(() => {
        if (!canvas || !focused) return;
        const el = canvas.container();
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape' && escapeEnds(canvas.selectedIds().length) === 'emphasis') setStormingFocus(null);
        };
        const onClick = (e: MouseEvent): void => {
            if (e.target instanceof Element && e.target.closest('.react-flow__pane')) setStormingFocus(null);
        };
        el.addEventListener('keydown', onKey, true);
        el.addEventListener('click', onClick);
        return () => {
            el.removeEventListener('keydown', onKey, true);
            el.removeEventListener('click', onClick);
        };
    }, [canvas, focused, setStormingFocus]);

    return {
        canvas: readerCanvas,
        onMount,
        stormings,
        nav,
        worlds,
        settings,
        viewGraph,
        catalog,
        printer,
        exportOptions: { options: exportOptions, setOptions: setExportOptions },
        marks: { shown: marks, set: setMarks, snapshots },
        follow,
        showStorming,
    };
}

/** The canvas column: the view bar (the domain model's view switch, the view's conditions), and the canvas (or the catalog). */
export function ViewWorkspace(props: {
    workspace: Workspace;
    current: ViewPayload | null;
    mode: DisplayMode;
    /** Each view's legend, open or closed on its own. */
    legends: Legends;
    /** Drawn over the canvas (a session's cursors of the others). */
    overlay?: ReactNode;
    /** An AI is connected to the chat: an empty view says that asking there makes it. */
    aiReady?: boolean;
}) {
    const { workspace, current, mode, legends } = props;
    const { canvas, onMount, stormings, nav, settings, viewGraph, printer } = workspace;
    const { view, selected, select } = nav;
    const { structureLevel } = settings;
    const { checked, focusKey, noneChecked, graph } = viewGraph;
    const model = current?.model ?? null;
    const { filter: catalogFilter } = workspace.catalog;
    const t = useT();
    const lang = useLang();
    const empty = { added: [], changed: [], removed: [] };
    /** The view has nothing yet: it shows one line, and no control that would have nothing to act on. */
    const nothing = current !== null && isEmptyView(view.kind, current);
    /** The view whose controls the toolbar shows: none for an empty view (they would have nothing to act on). */
    const bar = nothing ? undefined : view.kind;
    const legendView: LegendView | null =
        !graph || !isCanvas(view)
            ? null
            : view.kind === 'contextMap'
              ? 'contextMap'
              : view.kind === 'storming'
                ? 'storming'
                : `${structureLevel === 'aggregates' ? 'aggregates' : 'structure'}${focusKey ? 'Focus' : ''}`;
    /** What the canvas shows, as a printed or exported diagram says it (its heading and its file's name). */
    const subject = canvasSubject(view.kind, settings, focusKey ? checked : [], model, stormings);
    const wsName = current ? workspaceName(current.root) : undefined;
    const heading = subject ? sheetHeading(wsName, subject, t, mode) : '';
    const { options: exportOptions } = workspace.exportOptions;
    const exportTarget = (): ExportTarget | null =>
        graph && current && subject
            ? {
                  graph,
                  scene: () => buildScene(graph, { diff: current.diff, diagnostics: current.diagnostics, mode, lang }),
                  heading,
                  legend: legendView,
                  fileName: (ext) => exportFileName(wsName, subject, ext),
              }
            : null;
    /** Fits the whole view: a storming view like when it is shown (its graph, never zoomed in past normal size). */
    const fitView = (): void => {
        if (!canvas) return;
        if (view.kind === 'storming' && graph) fitAll(canvas, graph, true);
        else canvas.fitContent({ animate: true });
    };

    return (
        <section className="center">
            <ViewBar workspace={workspace} current={current} mode={mode} bar={bar} exportTarget={exportTarget} />
            <div className={`view-area${current ? ' drawn' : ''}`}>
                <FlowCanvas onMount={onMount} />
                {isCanvas(view) && props.overlay}
                {isCanvas(view) && !nothing && (
                    <CanvasControls
                        canvas={canvas}
                        fitAll={fitView}
                        legend={legendView && { view: legendView, open: legends.isOpen(legendView), onToggle: () => legends.toggle(legendView) }}
                        compact={{ on: settings.compact, onToggle: () => settings.setCompact(!settings.compact) }}
                        keys
                    />
                )}
                {printer.phase === 'printing' && printKind(isCanvas(view)) === 'diagram' && current && graph && (
                    <PrintSheet graph={graph} current={current} mode={mode} heading={heading} legend={exportOptions.legend ? legendView : null} />
                )}
                <EdgeHint canvas={canvas} view={legendView} />
                {view.kind === 'storming' && (
                    <>
                        <StormingLanes workspace={workspace} mode={mode} />
                        <LinePopover canvas={canvas} />
                        <OffscreenPointers canvas={canvas} />
                    </>
                )}
                {nothing ? (
                    <div className="empty">{emptyLine(t, view.kind, props.aiReady === true)}</div>
                ) : (
                    current &&
                    !graph &&
                    isCanvas(view) && (
                        <div className="empty">
                            {view.kind === 'storming'
                                ? t.noStormings
                                : noneChecked && view.kind === 'structure'
                                  ? t.pickContexts
                                  : focusKey && view.kind === 'structure'
                                    ? t.loading
                                    : t.noDiagram}
                        </div>
                    )
                )}
                {view.kind === 'catalog' && model && !nothing && (
                    <Catalog
                        model={model}
                        mode={mode}
                        diff={current?.diff ?? empty}
                        diagnostics={current?.diagnostics ?? []}
                        selected={selected}
                        onSelect={(id) => select(id)}
                        filter={catalogFilter}
                    />
                )}
            </div>
        </section>
    );
}

/**
 * The view bar: in the domain model, the view switch (マップ / 構造 / カタログ); then the view's conditions (the
 * structure's focused contexts and level, the catalog's search, the storming › stage or timeline and the level), and at
 * the right end 絞り込み and 書き出し (the catalog: 印刷). `bar` is the view whose controls it shows (none for an empty
 * view).
 */
export function ViewBar(props: {
    workspace: Workspace;
    current: ViewPayload | null;
    mode: DisplayMode;
    bar: View['kind'] | undefined;
    exportTarget: () => ExportTarget | null;
}) {
    const { workspace, current, mode, bar, exportTarget } = props;
    const { stormings, nav, worlds, settings, viewGraph, printer } = workspace;
    const { view, setView } = nav;
    const { structureLevel, setStructureLevel, setStructureContexts, setHiddenContexts, mapAll, setMapAll, stormingChoice, setStormingChoice } = settings;
    const { checked, hidden, focusKey } = viewGraph;
    const model = current?.model ?? null;
    const focusContexts = current?.focusContexts ?? [];
    const { filter: catalogFilter, setFilter: setCatalogFilter } = workspace.catalog;
    const t = useT();
    /** What the bar offers to take the view out of the page (printing, exporting): what it shows, as it is shown. */
    const output = toolbarOutput(bar);
    /** The focused contexts, as the bar names them. */
    const contextNamesOf = (ids: readonly string[]): string => {
        const labels = model ? contextLabels(model) : {};
        return ids.map((c) => nameIn(mode, c, labels[c])).join(', ');
    };
    return (
        <div className="view-toolbar">
            {worlds.world === 'model' && view.kind !== 'storming' && (
                <NameSwitch
                    label={t.modelViewsLabel}
                    className="view-switch"
                    choices={MODEL_VIEWS}
                    value={view.kind}
                    icons={VIEW_ICONS}
                    names={t.modelViews}
                    onChange={(kind) => setView({ kind })}
                />
            )}
            {bar === 'structure' && (
                <ToolbarSubject>
                    {focusKey && checked.length > 0 && <SubjectName label={t.contextsToShow} text={contextNamesOf(checked)} />}
                    <LevelSwitch
                        label={t.structureMode}
                        levels={STRUCTURE_LEVELS}
                        value={structureLevel}
                        icons={LEVEL_ICONS}
                        names={(l) => ({ label: t.structureLevels[l], tooltip: t.structureLevels[l], text: shortName(t.structureLevels[l]) })}
                        onChange={setStructureLevel}
                    />
                </ToolbarSubject>
            )}
            {bar === 'catalog' && (
                <ToolbarSubject>
                    <CatalogSearch filter={catalogFilter} onChange={setCatalogFilter} />
                </ToolbarSubject>
            )}
            {bar === 'storming' && (
                <StormingToolbar stormings={stormings} choice={stormingChoice} focus={settings.stormingFocus} mode={mode} onView={workspace.showStorming} />
            )}
            <ToolbarEnd>
                {bar === 'contextMap' && (
                    <FilterPopover count={activeFilterCount({ view: 'contextMap', mapAll })} onClear={() => setMapAll(false)}>
                        <FilterSection title={t.filters.contexts}>
                            <label className="check">
                                <input type="checkbox" checked={mapAll} onChange={(e) => setMapAll(e.target.checked)} />
                                {t.showAllContexts}
                            </label>
                        </FilterSection>
                    </FilterPopover>
                )}
                {bar === 'structure' && (
                    <FilterPopover
                        count={activeFilterCount({
                            view: 'structure',
                            contexts: focusContexts.length,
                            checked: checked.length,
                            hidden: hidden.length,
                        })}
                        onClear={() => {
                            setStructureContexts(null);
                            setHiddenContexts([]);
                        }}
                    >
                        <FilterSection title={t.filters.contexts}>
                            <ContextList
                                contexts={focusContexts}
                                labels={model ? contextLabels(model) : {}}
                                selected={checked}
                                hidden={hidden}
                                mode={mode}
                                onChange={(cs) => setStructureContexts(cs.length === focusContexts.length ? null : cs)}
                                onHiddenChange={setHiddenContexts}
                            />
                        </FilterSection>
                    </FilterPopover>
                )}
                {bar === 'catalog' && model && (
                    <FilterPopover
                        count={activeFilterCount({ view: 'catalog', contexts: catalogFilter.contexts, kinds: catalogFilter.sections })}
                        onClear={() => setCatalogFilter({ ...catalogFilter, contexts: null, sections: [] })}
                    >
                        <CatalogFilters model={model} mode={mode} filter={catalogFilter} onChange={setCatalogFilter} />
                    </FilterPopover>
                )}
                {bar === 'storming' && <StormingFilter stormings={stormings} choice={stormingChoice} onChange={setStormingChoice} />}
                {output === 'print' && <PrintButton onPrint={printer.print} />}
                {output === 'export' && (
                    <ExportButton
                        control={{
                            target: exportTarget,
                            ...workspace.exportOptions,
                            print: { preparing: printer.phase === 'preparing', onPrint: printer.print },
                        }}
                    />
                )}
            </ToolbarEnd>
        </div>
    );
}

/** The exceptions' lanes over the storming shown (`ExceptionLanes`): a label pressed emphasizes its exception, or ends it. */
function StormingLanes({ workspace, mode }: { workspace: Workspace; mode: DisplayMode }): ReactNode {
    const { canvas, stormings, settings, viewGraph } = workspace;
    const { stormingChoice: choice, stormingFocus } = settings;
    const shown = shownStorming(stormings, choice);
    const render = viewGraph.stormingShown?.render;
    const graph = viewGraph.graph;
    if (!shown || !render || !graph) return null;
    const lanes = drawnLanes(graph, render, shown.storming.timelines);
    const name = (id: string): string => nameIn(mode, id, shown.storming.timelines.find((t) => t.id === id)?.label);
    return (
        <ExceptionLanes
            canvas={canvas}
            lanes={lanes}
            focus={shownFocus(stormings, choice, stormingFocus)}
            name={name}
            onPress={(id) => (id === undefined ? settings.setStormingFocus(null) : workspace.showStorming(focusOn(stormings, choice, shown.storming.id, id)))}
        />
    );
}
