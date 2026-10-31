import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, LayoutGrid, LayoutList, PanelLeftOpen, PanelRightOpen, type LucideIcon } from 'lucide-react';
import { Tldraw, type Editor } from 'tldraw';
import type { Diagnostic } from '../../src/core/diagnostics';
import { STRUCTURE_LEVELS, type StructureLevel } from '../../src/graph/ir';
import { BaselineButton, BaselineMenu, baselineName } from '../baseline-picker';
import { BottomPanel } from '../bottom';
import { Catalog } from '../catalog';
import { ContextPicker } from '../context-picker';
import { Explorer } from '../explorer';
import { I18nProvider, MESSAGES } from '../i18n';
import { Inspector } from '../inspector';
import { Legend } from '../legend';
import { fileSelection, inCatalog, inStructure, resolve, selectedFile } from '../model-utils';
import { shapeUtils } from '../shapes';
import { Resizer } from '../shared/layout';
import { SettingsDialog } from '../settings-dialog';
import { StatesCanvas } from '../states-canvas';
import { StormingDetails, StormingToolbar } from '../storming';
import { applyTheme } from '../theme';
import { Tooltips } from '../tooltip';
import { useViewCamera } from '../view/camera';
import { fitAll, usePointerCursor } from '../view/canvas';
import { useViewGraph } from '../view/graph';
import { isCanvas, useNavigation, useOpenOnStormings, useSelectOnCanvas } from '../view/navigation';
import { useViewSettings } from '../view/settings';
import { usePanes } from './panes';
import { usePreferences } from './preferences';
import { useViewSocket } from './useViewSocket';

/** Width of the rail a closed side pane leaves, and height of the bottom pane's tab bar (with its border); see styles.css. */
const RAIL_WIDTH = 28;
const BOTTOM_BAR_HEIGHT = 33;
/** The inspector can be widened until the canvas is this narrow. */
const MIN_CANVAS_WIDTH = 320;

const LEVEL_ICONS: Record<StructureLevel, LucideIcon> = { detail: LayoutList, overview: LayoutGrid, aggregates: Box };

export function App() {
    const { current, connection } = useViewSocket();
    const model = current?.model ?? null;
    /** What the model is compared with: its graphs give the ghosts of removed elements, its model the inspector's diffs. */
    const base = current?.base ?? null;
    const [editor, setEditor] = useState<Editor | null>(null);
    const { mode, setMode, themePreference, setThemePreference, theme, langPreference, setLangPreference, lang } = usePreferences();
    const t = MESSAGES[lang];
    const {
        explorerOpen,
        setExplorerOpen,
        inspectorOpen,
        setInspectorOpen,
        bottomOpen,
        setBottomOpen,
        explorerWidth,
        setExplorerWidth,
        inspectorWidth,
        setInspectorWidth,
        bottomHeight,
        setBottomHeight,
        bottomTab,
        setBottomTab,
        legendOpen,
        setLegendOpen,
        inspectorTab,
        setInspectorTab,
        openInspector,
    } = usePanes();
    /** The button the baseline menu was opened from (it opens next to it), or null while closed. */
    const [baselineAnchor, setBaselineAnchor] = useState<HTMLElement | null>(null);
    const toggleBaselineMenu = (anchor: HTMLElement) => setBaselineAnchor((a) => (a === anchor ? null : anchor));
    const closeBaselineMenu = useCallback(() => setBaselineAnchor(null), []);

    const stormings = useMemo(() => current?.stormings ?? [], [current?.stormings]);
    const { view, setView, selected, sourceFocus, setSourceFocus, select, backTo, goBack, reveal } = useNavigation(editor, current, stormings);
    const settings = useViewSettings();
    const { structureLevel, setStructureLevel, setStructureContexts, setHiddenContexts, mapAll, setMapAll, stormingChoice, setStormingChoice } = settings;
    const viewGraph = useViewGraph(current, view, settings, stormings);
    const { shown, stormingShown, checked, hidden, focusKey, noneChecked, graph } = viewGraph;
    useOpenOnStormings(current, setView);
    useViewCamera(editor, current, view, settings, viewGraph, { mode, lang });

    useEffect(() => {
        applyTheme(theme, editor);
    }, [theme, editor]);

    /** Double-click in the explorer: the view that suits the item best. */
    const openBest = (id: string) => {
        select(id, { highlight: false });
        const r = model ? resolve(model, id) : undefined;
        if (!r) return;
        if (r.kind === 'state' || r.kind === 'command') openInspector('states');
        else if (r.kind === 'context') reveal('structure', id);
        else if (inStructure(r.el.kind)) {
            reveal('structure', id);
            if (r.el.kind === 'aggregate') openInspector('states');
        } else if (inCatalog(r.el.kind)) reveal('catalog', id);
        else openInspector('source');
    };

    const locate = (d: Diagnostic) => {
        // e.g. syntax errors belong to no element: only their file can show them
        select(d.elementId ?? fileSelection(d.file));
        setSourceFocus({ file: d.file, line: d.start.line, endLine: d.end.line });
        if (!d.elementId) setInspectorOpen(true);
    };

    useSelectOnCanvas(editor, select);
    usePointerCursor(editor);

    const onMount = useCallback((e: Editor) => {
        e.updateInstanceState({ isReadonly: true });
        Object.assign(window, { __domaintrailEditor: e }); // for debugging / e2e checks
        setEditor(e);
    }, []);

    const empty = { added: [], changed: [], removed: [] };

    return (
        <I18nProvider lang={lang}>
            <div className="app">
                <header>
                    <div className="brand">DomainTrail</div>
                    <div className="status">
                        {current && <span className={`pill pill-${current.status}`}>{t.status[current.status]}</span>}
                        <span className="muted">
                            {current
                                ? `${t.fileCount(current.files.length)} · v${current.version} · ${new Date(current.updatedAt).toLocaleTimeString(lang)}`
                                : ''}
                        </span>
                        <span className={`conn conn-${connection}`} title={t.connectionTitle(t.connection[connection])} />
                    </div>
                    {current && <BaselineButton baseline={current.baseline} open={!!baselineAnchor} onToggle={toggleBaselineMenu} />}
                    <SettingsDialog
                        mode={mode}
                        onMode={setMode}
                        themePreference={themePreference}
                        theme={theme}
                        onTheme={setThemePreference}
                        langPreference={langPreference}
                        lang={lang}
                        onLang={setLangPreference}
                    />
                </header>
                {current?.baseline.kind === 'git' && current.baseline.error && (
                    <div className="banner">{t.baselineError(current.baseline.ref, current.baseline.error)}</div>
                )}
                {view.kind === 'storming' && shown?.storming.stale && <div className="banner">{t.staleStorming(shown.storming.file)}</div>}
                {current?.stale && <div className="banner">{t.stale(<a onClick={() => setBottomOpen(true)}>{t.problems}</a>)}</div>}
                <div className="workspace">
                    {/* side panes stay mounted so that opening and closing can be animated; a closed one shows its rail */}
                    <div className={`side side-left${explorerOpen ? ' open' : ''}`} style={{ width: explorerOpen ? explorerWidth : RAIL_WIDTH }}>
                        <div className="rail" inert={explorerOpen}>
                            <button className="icon-button" onClick={() => setExplorerOpen(true)} data-tooltip={t.openExplorer} aria-label={t.openExplorer}>
                                <PanelLeftOpen size={16} aria-hidden />
                            </button>
                        </div>
                        <aside className="pane" style={{ width: explorerWidth }} inert={!explorerOpen}>
                            <Explorer
                                model={model}
                                files={current?.files ?? []}
                                diagnostics={current?.diagnostics ?? []}
                                diff={current?.diff ?? empty}
                                mode={mode}
                                selected={selected}
                                onSelect={(id) => {
                                    select(id);
                                    if (selectedFile(id)) setInspectorOpen(true);
                                }}
                                onOpen={openBest}
                                onClose={() => setExplorerOpen(false)}
                            />
                        </aside>
                    </div>
                    <Resizer
                        direction="x"
                        size={explorerWidth}
                        min={180}
                        max={480}
                        open={explorerOpen}
                        collapsed={RAIL_WIDTH}
                        onResize={setExplorerWidth}
                        onOpenChange={setExplorerOpen}
                    />
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
                                {view.kind === 'storming' && (
                                    <StormingToolbar stormings={stormings} choice={stormingChoice} mode={mode} onChange={setStormingChoice} />
                                )}
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
                                    onToggle={() => setLegendOpen(!legendOpen)}
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
                    <Resizer
                        direction="x"
                        size={inspectorWidth}
                        min={300}
                        max={() => window.innerWidth - (explorerOpen ? explorerWidth : RAIL_WIDTH) - MIN_CANVAS_WIDTH}
                        invert
                        open={inspectorOpen}
                        collapsed={RAIL_WIDTH}
                        onResize={setInspectorWidth}
                        onOpenChange={setInspectorOpen}
                    />
                    <div className={`side side-right${inspectorOpen ? ' open' : ''}`} style={{ width: inspectorOpen ? inspectorWidth : RAIL_WIDTH }}>
                        <div className="rail" inert={inspectorOpen}>
                            <button className="icon-button" onClick={() => setInspectorOpen(true)} data-tooltip={t.openInspector} aria-label={t.openInspector}>
                                <PanelRightOpen size={16} aria-hidden />
                            </button>
                        </div>
                        <aside className="pane" style={{ width: inspectorWidth }} inert={!inspectorOpen}>
                            <Inspector
                                model={model}
                                mode={mode}
                                selected={selected}
                                diagnostics={current?.diagnostics ?? []}
                                diff={current?.diff ?? empty}
                                base={base?.model ?? null}
                                sources={current?.sources ?? []}
                                sourceFocus={sourceFocus}
                                statesView={(aggregateId) => (
                                    <StatesCanvas
                                        aggregateId={aggregateId}
                                        graphs={current?.states[aggregateId]}
                                        previous={base?.states[aggregateId]}
                                        diff={current?.diff ?? empty}
                                        diagnostics={current?.diagnostics ?? []}
                                        mode={mode}
                                        lang={lang}
                                        theme={theme}
                                        selected={selected}
                                        onSelect={(id) => select(id)}
                                        legendOpen={legendOpen}
                                        onLegendToggle={() => setLegendOpen(!legendOpen)}
                                    />
                                )}
                                stormingView={(id, history) => (
                                    <StormingDetails
                                        stormings={stormings}
                                        selected={id}
                                        render={
                                            view.kind === 'storming' && shown && id.startsWith(`es/${shown.storming.id}/`) ? stormingShown?.render : undefined
                                        }
                                        model={model}
                                        mode={mode}
                                        diagnostics={current?.diagnostics ?? []}
                                        history={history}
                                        onSelect={(x) => select(x)}
                                    />
                                )}
                                tab={inspectorTab}
                                onTab={setInspectorTab}
                                onSelect={(id) => select(id)}
                                onReveal={reveal}
                                onFocusContext={(ctx) => {
                                    setStructureContexts([ctx]);
                                    setView({ kind: 'structure' });
                                }}
                                backTo={backTo}
                                onBack={goBack}
                                onClose={() => setInspectorOpen(false)}
                            />
                        </aside>
                    </div>
                </div>
                <Resizer
                    direction="y"
                    size={bottomHeight}
                    min={120}
                    max={600}
                    invert
                    open={bottomOpen}
                    collapsed={BOTTOM_BAR_HEIGHT}
                    onResize={setBottomHeight}
                    onOpenChange={setBottomOpen}
                />
                <div className="bottom-wrap" style={{ height: bottomOpen ? bottomHeight : BOTTOM_BAR_HEIGHT }}>
                    <BottomPanel
                        tab={bottomTab}
                        mode={mode}
                        open={bottomOpen}
                        model={model}
                        diagnostics={current?.diagnostics ?? []}
                        diff={current?.diff ?? empty}
                        baseline={current ? baselineName(current.baseline, t.baselinePrevious) : undefined}
                        gitBaseline={current?.baseline.kind === 'git'}
                        onBaseline={toggleBaselineMenu}
                        onTab={setBottomTab}
                        onToggle={() => setBottomOpen(!bottomOpen)}
                        onLocate={locate}
                        onSelect={(id) => select(id)}
                    />
                </div>
                {current && baselineAnchor && <BaselineMenu baseline={current.baseline} anchor={baselineAnchor} onClose={closeBaselineMenu} />}
                <Tooltips />
            </div>
        </I18nProvider>
    );
}
