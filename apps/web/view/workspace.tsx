import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Box, LayoutGrid, LayoutList, type LucideIcon } from 'lucide-react';
import { type DisplayMode, type Lang, STRUCTURE_LEVELS, type StructureLevel } from '@domaintrail/visualization';
import type { StormingView, ViewPayload } from '@domaintrail/visualization/protocol';
import { Catalog, CatalogFilters, CatalogSearch, useCatalogFilter } from '../catalog';
import { ContextList } from '../context-picker';
import { useT } from '../i18n';
import { contextLabels } from '../model-utils';
import type { LegendView } from '../legend';
import { StormingToolbar } from '../storming';
import { applyTheme, type Theme } from '../theme';
import { useViewCamera } from './camera';
import { useCenterOnResize } from './center';
import { CanvasControls, EdgeHint } from './canvas-controls';
import { emptyLine, isEmptyView, VIEW_TABS } from './empty';
import { FlowCanvas } from './flow-canvas';
import { fitAll } from './canvas';
import type { DiagramCanvas } from './diagram';
import { activeFilterCount } from './filters';
import { useViewGraph, type ViewGraph } from './graph';
import { isCanvas, useNavigation, useOpenOnStormings, useSelectOnCanvas, type Navigation } from './navigation';
import { useViewSettings, type ViewSettings } from './settings';
import { FilterPopover, FilterSection, LevelSwitch, ToolbarEnd, ToolbarSubject } from './toolbar';

const LEVEL_ICONS: Record<StructureLevel, LucideIcon> = { detail: LayoutList, overview: LayoutGrid, aggregates: Box };

/** The state of the view workspace: the canvas, the current view with its navigation, settings and graph. */
export interface Workspace {
    canvas: DiagramCanvas | null;
    onMount: (canvas: DiagramCanvas) => void;
    stormings: readonly StormingView[];
    nav: Navigation;
    settings: ViewSettings;
    viewGraph: ViewGraph;
}

/**
 * The view workspace: the current view, the navigation between views and selections with its history, and the canvas
 * (its camera and the graph drawn on it, in the page's theme).
 */
export function useViewWorkspace(current: ViewPayload | null, display: { mode: DisplayMode; lang: Lang; theme: Theme }): Workspace {
    const { mode, lang, theme } = display;
    const [canvas, setCanvas] = useState<DiagramCanvas | null>(null);
    const stormings = useMemo(() => current?.stormings ?? [], [current?.stormings]);
    const nav = useNavigation(canvas, current, stormings);
    const settings = useViewSettings();
    const viewGraph = useViewGraph(current, nav.view, settings, stormings);
    useOpenOnStormings(current, nav.setView);
    useViewCamera(canvas, current, nav.view, settings, viewGraph, { mode, lang });

    useEffect(() => {
        applyTheme(theme, canvas);
    }, [theme, canvas]);

    useSelectOnCanvas(canvas, nav.select);
    useCenterOnResize(canvas);

    const onMount = useCallback((c: DiagramCanvas) => setCanvas(c), []);

    return { canvas, onMount, stormings, nav, settings, viewGraph };
}

/** The center of the page: the view tabs, the current view's toolbar, and the canvas (or the catalog). */
export function ViewWorkspace(props: {
    workspace: Workspace;
    current: ViewPayload | null;
    mode: DisplayMode;
    legendOpen: boolean;
    onLegendToggle: () => void;
    /** Drawn over the canvas (a session's cursors of the others). */
    overlay?: ReactNode;
    /** An AI is connected to the chat: an empty view says that asking there makes it. */
    aiReady?: boolean;
}) {
    const { workspace, current, mode, legendOpen, onLegendToggle } = props;
    const { canvas, onMount, stormings, nav, settings, viewGraph } = workspace;
    const { view, setView, selected, select } = nav;
    const { structureLevel, setStructureLevel, setStructureContexts, setHiddenContexts, mapAll, setMapAll, stormingChoice, setStormingChoice } = settings;
    const { checked, hidden, focusKey, noneChecked, graph } = viewGraph;
    const model = current?.model ?? null;
    const focusContexts = current?.focusContexts ?? [];
    const { filter: catalogFilter, setFilter: setCatalogFilter } = useCatalogFilter();
    const t = useT();
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
    /** Fits the whole view: a storming view like when it is shown (its graph, never zoomed in past normal size). */
    const fitView = (): void => {
        if (!canvas) return;
        if (view.kind === 'storming' && graph) fitAll(canvas, graph, true);
        else canvas.fitContent({ animate: true });
    };

    return (
        <section className="center">
            <div className="view-tabs">
                <div className="view-tab-list" role="tablist">
                    {VIEW_TABS.map((k) => (
                        <button
                            key={k}
                            role="tab"
                            aria-selected={view.kind === k}
                            className={view.kind === k ? 'active' : ''}
                            onClick={() => setView({ kind: k })}
                        >
                            {t.views[k]}
                        </button>
                    ))}
                </div>
                <div className="view-toolbar">
                    {bar === 'structure' && (
                        <ToolbarSubject>
                            <LevelSwitch
                                label={t.structureMode}
                                levels={STRUCTURE_LEVELS}
                                value={structureLevel}
                                icons={LEVEL_ICONS}
                                names={(l) => ({ label: t.structureLevels[l], tooltip: t.structureLevels[l] })}
                                onChange={setStructureLevel}
                            />
                        </ToolbarSubject>
                    )}
                    {bar === 'catalog' && (
                        <ToolbarSubject>
                            <CatalogSearch filter={catalogFilter} onChange={setCatalogFilter} />
                        </ToolbarSubject>
                    )}
                    {bar === 'storming' && <StormingToolbar stormings={stormings} choice={stormingChoice} mode={mode} onChange={setStormingChoice} />}
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
                    </ToolbarEnd>
                </div>
            </div>
            <div className="view-area">
                <FlowCanvas onMount={onMount} />
                {isCanvas(view) && props.overlay}
                {isCanvas(view) && !nothing && (
                    <CanvasControls
                        canvas={canvas}
                        fitAll={fitView}
                        legend={legendView && { view: legendView, open: legendOpen, onToggle: onLegendToggle }}
                        keys
                    />
                )}
                <EdgeHint canvas={canvas} view={legendView} />
                {nothing ? (
                    <div className="empty">{emptyLine(t, props.aiReady === true)}</div>
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
