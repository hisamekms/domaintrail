import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Box, LayoutGrid, LayoutList, type LucideIcon } from 'lucide-react';
import { Tldraw, type Editor } from 'tldraw';
import { STRUCTURE_LEVELS, type DisplayMode, type Lang, type StructureLevel } from '@domaintrail/visualization/domain/graph/ir';
import type { StormingView, ViewPayload } from '@domaintrail/visualization/protocol';
import { Catalog, CatalogFilters, CatalogSearch, useCatalogFilter } from '../catalog';
import { ContextList } from '../context-picker';
import { useT } from '../i18n';
import type { LegendView } from '../legend';
import { shapeUtils } from '../shapes';
import { StormingToolbar } from '../storming';
import { applyTheme, type Theme } from '../theme';
import { useViewCamera } from './camera';
import { CanvasControls, CanvasMenu, EdgeHint } from './canvas-controls';
import { fitAll, usePointerCursor } from './canvas';
import { activeFilterCount } from './filters';
import { useViewGraph, type ViewGraph } from './graph';
import { isCanvas, useNavigation, useOpenOnStormings, useSelectOnCanvas, type Navigation } from './navigation';
import { useViewSettings, type ViewSettings } from './settings';
import { FilterPopover, FilterSection, LevelSwitch, ToolbarEnd, ToolbarSubject } from './toolbar';

const LEVEL_ICONS: Record<StructureLevel, LucideIcon> = { detail: LayoutList, overview: LayoutGrid, aggregates: Box };

/** The state of the view workspace: the tldraw editor, the current view with its navigation, settings and graph. */
export interface Workspace {
    editor: Editor | null;
    onMount: (editor: Editor) => void;
    stormings: readonly StormingView[];
    nav: Navigation;
    settings: ViewSettings;
    viewGraph: ViewGraph;
}

/**
 * The view workspace: the current view, the navigation between views and selections with its history, and the canvas
 * (its editor, its camera and the graph drawn on it, in the page's theme).
 */
export function useViewWorkspace(current: ViewPayload | null, display: { mode: DisplayMode; lang: Lang; theme: Theme }): Workspace {
    const { mode, lang, theme } = display;
    const [editor, setEditor] = useState<Editor | null>(null);
    const stormings = useMemo(() => current?.stormings ?? [], [current?.stormings]);
    const nav = useNavigation(editor, current, stormings);
    const settings = useViewSettings();
    const viewGraph = useViewGraph(current, nav.view, settings, stormings);
    useOpenOnStormings(current, nav.setView);
    useViewCamera(editor, current, nav.view, settings, viewGraph, { mode, lang });

    useEffect(() => {
        applyTheme(theme, editor);
    }, [theme, editor]);

    useSelectOnCanvas(editor, nav.select);
    usePointerCursor(editor);

    const onMount = useCallback((e: Editor) => {
        e.updateInstanceState({ isReadonly: true });
        Object.assign(window, { __domaintrailEditor: e }); // for debugging / e2e checks
        setEditor(e);
    }, []);

    return { editor, onMount, stormings, nav, settings, viewGraph };
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
}) {
    const { workspace, current, mode, legendOpen, onLegendToggle } = props;
    const { editor, onMount, stormings, nav, settings, viewGraph } = workspace;
    const { view, setView, selected, select } = nav;
    const { structureLevel, setStructureLevel, setStructureContexts, setHiddenContexts, mapAll, setMapAll, stormingChoice, setStormingChoice } = settings;
    const { checked, hidden, focusKey, noneChecked, graph } = viewGraph;
    const model = current?.model ?? null;
    const focusContexts = current?.focusContexts ?? [];
    const { filter: catalogFilter, setFilter: setCatalogFilter } = useCatalogFilter();
    const t = useT();
    const empty = { added: [], changed: [], removed: [] };
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
        if (!editor) return;
        if (view.kind === 'storming' && graph) fitAll(editor, graph, true);
        else editor.zoomToFit({ animation: { duration: 200 } });
    };

    return (
        <section className="center">
            <div className="view-tabs">
                <div className="view-tab-list" role="tablist">
                    {(['contextMap', 'structure', 'catalog', 'storming'] as const)
                        .filter((k) => k !== 'storming' || stormings.length > 0 || view.kind === 'storming')
                        .map((k) => (
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
                    {view.kind === 'structure' && (
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
                    {view.kind === 'catalog' && (
                        <ToolbarSubject>
                            <CatalogSearch filter={catalogFilter} onChange={setCatalogFilter} />
                        </ToolbarSubject>
                    )}
                    {view.kind === 'storming' && <StormingToolbar stormings={stormings} choice={stormingChoice} mode={mode} onChange={setStormingChoice} />}
                    <ToolbarEnd>
                        {view.kind === 'contextMap' && (
                            <FilterPopover count={activeFilterCount({ view: 'contextMap', mapAll })} onClear={() => setMapAll(false)}>
                                <FilterSection title={t.filters.contexts}>
                                    <label className="check">
                                        <input type="checkbox" checked={mapAll} onChange={(e) => setMapAll(e.target.checked)} />
                                        {t.showAllContexts}
                                    </label>
                                </FilterSection>
                            </FilterPopover>
                        )}
                        {view.kind === 'structure' && (
                            <FilterPopover
                                count={activeFilterCount({ view: 'structure', contexts: focusContexts.length, checked: checked.length, hidden: hidden.length })}
                                onClear={() => {
                                    setStructureContexts(null);
                                    setHiddenContexts([]);
                                }}
                            >
                                <FilterSection title={t.filters.contexts}>
                                    <ContextList
                                        contexts={focusContexts}
                                        labels={model?.contextLabels ?? {}}
                                        selected={checked}
                                        hidden={hidden}
                                        mode={mode}
                                        onChange={(cs) => setStructureContexts(cs.length === focusContexts.length ? null : cs)}
                                        onHiddenChange={setHiddenContexts}
                                    />
                                </FilterSection>
                            </FilterPopover>
                        )}
                        {view.kind === 'catalog' && model && (
                            <FilterPopover
                                count={activeFilterCount({ view: 'catalog', contexts: catalogFilter.contexts, kinds: catalogFilter.sections })}
                                onClear={() => setCatalogFilter({ ...catalogFilter, contexts: null, sections: [] })}
                            >
                                <CatalogFilters model={model} mode={mode} filter={catalogFilter} onChange={setCatalogFilter} />
                            </FilterPopover>
                        )}
                        {isCanvas(view) && <CanvasMenu />}
                    </ToolbarEnd>
                </div>
            </div>
            <div className="view-area">
                <Tldraw shapeUtils={shapeUtils} hideUi onMount={onMount} />
                {isCanvas(view) && props.overlay}
                {isCanvas(view) && (
                    <CanvasControls
                        editor={editor}
                        fitAll={fitView}
                        legend={legendView && { view: legendView, open: legendOpen, onToggle: onLegendToggle }}
                        keys
                    />
                )}
                <EdgeHint editor={editor} view={legendView} />
                {current && !graph && isCanvas(view) && (
                    <div className="empty">
                        {current.status === 'empty'
                            ? t.noDtFiles
                            : view.kind === 'storming'
                              ? t.noStormings
                              : noneChecked && view.kind === 'structure'
                                ? t.pickContexts
                                : focusKey && view.kind === 'structure'
                                  ? t.loading
                                  : t.noDiagram}
                    </div>
                )}
                {view.kind === 'catalog' && model && (
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
