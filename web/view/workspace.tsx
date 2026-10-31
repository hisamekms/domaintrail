import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, LayoutGrid, LayoutList, type LucideIcon } from 'lucide-react';
import { Tldraw, type Editor } from 'tldraw';
import { STRUCTURE_LEVELS, type DisplayMode, type Lang, type StructureLevel } from '@domaintrail/visualization/domain/graph/ir';
import type { StormingView, ViewPayload } from '@domaintrail/visualization/protocol';
import { Catalog } from '../catalog';
import { ContextPicker } from '../context-picker';
import { useT } from '../i18n';
import { Legend } from '../legend';
import { shapeUtils } from '../shapes';
import { StormingToolbar } from '../storming';
import { applyTheme, type Theme } from '../theme';
import { useViewCamera } from './camera';
import { fitAll, usePointerCursor } from './canvas';
import { useViewGraph, type ViewGraph } from './graph';
import { isCanvas, useNavigation, useOpenOnStormings, useSelectOnCanvas, type Navigation } from './navigation';
import { useViewSettings, type ViewSettings } from './settings';

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
}) {
    const { workspace, current, mode, legendOpen, onLegendToggle } = props;
    const { editor, onMount, stormings, nav, settings, viewGraph } = workspace;
    const { view, setView, selected, select } = nav;
    const { structureLevel, setStructureLevel, setStructureContexts, setHiddenContexts, mapAll, setMapAll, stormingChoice, setStormingChoice } = settings;
    const { checked, hidden, focusKey, noneChecked, graph } = viewGraph;
    const model = current?.model ?? null;
    const t = useT();
    const empty = { added: [], changed: [], removed: [] };

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
                    {view.kind === 'contextMap' && (
                        <label className="check small">
                            <input type="checkbox" checked={mapAll} onChange={(e) => setMapAll(e.target.checked)} />
                            {t.showAllContexts}
                        </label>
                    )}
                    {view.kind === 'structure' && (
                        <ContextPicker
                            contexts={current?.focusContexts ?? []}
                            labels={model?.contextLabels ?? {}}
                            selected={checked}
                            hidden={hidden}
                            mode={mode}
                            onChange={(cs) => setStructureContexts(cs.length === (current?.focusContexts ?? []).length ? null : cs)}
                            onHiddenChange={setHiddenContexts}
                        />
                    )}
                    {view.kind === 'structure' && (
                        <div className="segmented small icons" role="group" aria-label={t.structureMode}>
                            {STRUCTURE_LEVELS.map((l) => {
                                const Icon = LEVEL_ICONS[l];
                                return (
                                    <button
                                        key={l}
                                        className={structureLevel === l ? 'active' : ''}
                                        aria-pressed={structureLevel === l}
                                        onClick={() => setStructureLevel(l)}
                                        data-tooltip={t.structureLevels[l]}
                                        aria-label={t.structureLevels[l]}
                                    >
                                        <Icon size={15} aria-hidden />
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    {view.kind === 'storming' && <StormingToolbar stormings={stormings} choice={stormingChoice} mode={mode} onChange={setStormingChoice} />}
                    {isCanvas(view) && (
                        <button
                            onClick={() => {
                                // a storming view is fitted like when it is shown: its graph, never zoomed in past normal size
                                if (!editor) return;
                                if (view.kind === 'storming' && graph) fitAll(editor, graph, true);
                                else editor.zoomToFit({ animation: { duration: 200 } });
                            }}
                        >
                            {t.zoomToFit}
                        </button>
                    )}
                </div>
            </div>
            <div className="view-area">
                <Tldraw shapeUtils={shapeUtils} hideUi onMount={onMount} />
                {graph && isCanvas(view) && (
                    <Legend
                        view={
                            view.kind === 'contextMap'
                                ? 'contextMap'
                                : view.kind === 'storming'
                                  ? 'storming'
                                  : `${structureLevel === 'aggregates' ? 'aggregates' : 'structure'}${focusKey ? 'Focus' : ''}`
                        }
                        open={legendOpen}
                        onToggle={onLegendToggle}
                    />
                )}
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
                    />
                )}
            </div>
        </section>
    );
}
