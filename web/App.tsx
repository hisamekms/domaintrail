import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, LayoutGrid, LayoutList, PanelLeftOpen, PanelRightOpen, type LucideIcon } from 'lucide-react';
import { Tldraw, useValue, type Editor, type TLCamera } from 'tldraw';
import type { Diagnostic } from '../src/core/diagnostics';
import { STRUCTURE_LEVELS, type DisplayMode, type LaidOutGraph, type StructureLevel } from '../src/graph/ir';
import { BottomPanel, type BottomTab } from './bottom';
import { Catalog } from './catalog';
import { fitReadable, highlightElement, usePointerCursor } from './canvas';
import { Explorer } from './explorer';
import { Legend } from './legend';
import { backIndex, popHistory, pushHistory, type History } from './history';
import { Inspector, type InspectorTab, type RevealTarget } from './inspector';
import { Resizer, usePersistentState } from './layout';
import { fileSelection, inCatalog, inStructure, resolve, selectedFile } from './model-utils';
import { renderGraph, shapeElementId, withWriteAccess } from './render';
import { shapeUtils } from './shapes';
import { locationOf, type SourceFocus } from './source';
import { ContextPicker } from './context-picker';
import { SettingsDialog } from './settings-dialog';
import { StatesCanvas } from './states-canvas';
import { THEME_KEY, applyTheme, useResolvedTheme, type ThemePreference } from './theme';
import { I18nProvider, LANG_KEY, MESSAGES, useResolvedLang, type LangPreference } from './i18n';
import { useViewSocket } from './useViewSocket';

type View = { kind: 'contextMap' } | { kind: 'structure' } | { kind: 'catalog' };

/** Width of the rail a closed side pane leaves, and height of the bottom pane's tab bar (with its border); see styles.css. */
const RAIL_WIDTH = 28;
const BOTTOM_BAR_HEIGHT = 33;
/** The inspector can be widened until the canvas is this narrow. */
const MIN_CANVAS_WIDTH = 320;

/** The display mode saved under its former key and values (日本語 / English / 両方), if any. */
function savedDisplayMode(): DisplayMode {
    try {
        const old = JSON.parse(localStorage.getItem('domaintrail.displayMode') ?? 'null') as string | null;
        return old === 'ja' ? 'label' : old === 'en' ? 'name' : 'both';
    } catch {
        return 'both';
    }
}
const isCanvas = (v: View): boolean => v.kind === 'contextMap' || v.kind === 'structure';

const LEVEL_ICONS: Record<StructureLevel, LucideIcon> = { detail: LayoutList, overview: LayoutGrid, aggregates: Box };
/** The pushed graph of each Structure View level (focused views are fetched instead). */
const LEVEL_GRAPHS = { detail: 'structure', overview: 'overview', aggregates: 'aggregates' } as const;

export function App() {
    const { current, previous, connection } = useViewSocket();
    const model = current?.model ?? null;
    const [editor, setEditor] = useState<Editor | null>(null);
    const [view, setView] = useState<View>({ kind: 'structure' });
    const [mode, setMode] = usePersistentState<DisplayMode>('domaintrail.nameDisplay', savedDisplayMode());
    const [themePreference, setThemePreference] = usePersistentState<ThemePreference>(THEME_KEY, 'auto');
    const theme = useResolvedTheme(themePreference);
    const [langPreference, setLangPreference] = usePersistentState<LangPreference>(LANG_KEY, 'auto');
    const lang = useResolvedLang(langPreference);
    const t = MESSAGES[lang];
    /** Structure View: all fields (detail), names only in larger text (overview), or aggregates only (aggregates). */
    const [savedLevel, setStructureLevel] = usePersistentState<StructureLevel>('domaintrail.structureMode', 'detail');
    const structureLevel = STRUCTURE_LEVELS.includes(savedLevel) ? savedLevel : 'detail';
    /** Structure View: the bounded contexts to draw (null = every context, including ones added later). */
    const [structureContexts, setStructureContexts] = usePersistentState<string[] | null>('domaintrail.structureContexts', null);
    /** Focused Structure View: contexts whose stubs (and the dependencies on and from them) are not drawn. */
    const [hiddenContexts, setHiddenContexts] = usePersistentState<string[]>('domaintrail.structureHiddenContexts', []);
    /** Context Map: also show shared and ID-only contexts. */
    const [mapAll, setMapAll] = usePersistentState('domaintrail.contextMapAll', false);

    // Layout (remembered per browser)
    const [explorerOpen, setExplorerOpen] = usePersistentState('domaintrail.layout.explorer', true);
    const [inspectorOpen, setInspectorOpen] = usePersistentState('domaintrail.layout.inspector', true);
    const [bottomOpen, setBottomOpen] = usePersistentState('domaintrail.layout.bottom', false);
    const [explorerWidth, setExplorerWidth] = usePersistentState('domaintrail.layout.explorerWidth', 260);
    const [inspectorWidth, setInspectorWidth] = usePersistentState('domaintrail.layout.inspectorWidth', 420);
    const [bottomHeight, setBottomHeight] = usePersistentState('domaintrail.layout.bottomHeight', 220);
    const [bottomTab, setBottomTab] = usePersistentState<BottomTab>('domaintrail.layout.bottomTab', 'problems');
    const [legendOpen, setLegendOpen] = usePersistentState('domaintrail.layout.legend', true);
    const [inspectorTab, setInspectorTab] = usePersistentState<InspectorTab>('domaintrail.inspector.tab', 'structure');

    // Selection with a back history
    const [history, setHistory] = useState<History>([]);
    const selected = history[history.length - 1];
    const [sourceFocus, setSourceFocus] = useState<SourceFocus | undefined>();

    const cameras = useRef(new Map<string, TLCamera>());
    const shownView = useRef<string | null>(null);

    /** The checked contexts that can still be drawn, in model order. */
    const checked = useMemo(
        () => (current?.focusContexts ?? []).filter((c) => structureContexts === null || structureContexts.includes(c)),
        [current?.focusContexts, structureContexts],
    );
    const allChecked = checked.length === (current?.focusContexts ?? []).length;
    /** Some but not all contexts: drawn only them, with their dependencies as stubs. */
    const focused = useMemo(() => (allChecked ? [] : checked), [allChecked, checked]);
    const noneChecked = !allChecked && checked.length === 0;
    /** The hidden contexts that apply: only ones drawn as stubs, so none without a focus. */
    const hidden = useMemo(
        () => (focused.length ? (current?.focusContexts ?? []).filter((c) => hiddenContexts.includes(c) && !focused.includes(c)) : []),
        [current?.focusContexts, hiddenContexts, focused],
    );
    const focusKey = focused.length ? `${focused.join('+')}|${hidden.join('+')}|${structureLevel}` : '';
    /** The focused Structure View is laid out on request by the server. */
    const [focusGraph, setFocusGraph] = useState<{ key: string; graph: LaidOutGraph } | null>(null);
    useEffect(() => {
        if (!focusKey || view.kind !== 'structure') return;
        let cancelled = false;
        const params = new URLSearchParams({ contexts: focused.join(','), level: structureLevel, hide: hidden.join(',') });
        fetch(`/api/focus?${params}`)
            .then((r) => (r.ok ? (r.json() as Promise<LaidOutGraph>) : null))
            .then((graph) => {
                if (!cancelled && graph) setFocusGraph({ key: focusKey, graph });
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
        // re-fetch when the model changes, not on every diagnostics update
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusKey, current?.modelVersion, view.kind]);

    const graphFor = (p: typeof current, v: View): LaidOutGraph | null | undefined => {
        if (!p || !isCanvas(v)) return null;
        if (v.kind === 'contextMap') return mapAll ? p.contextMapAll : p.contextMap;
        if (v.kind === 'structure') {
            if (noneChecked) return null;
            if (focusKey) return focusGraph?.key === focusKey ? focusGraph.graph : undefined;
            return p[LEVEL_GRAPHS[structureLevel]];
        }
        return null;
    };
    /** Camera key: each view (and each Structure mode and focus) keeps its own camera. */
    const cameraKey = (v: View): string =>
        v.kind === 'structure' ? (focusKey ? `structure:focus:${focusKey}` : `structure:${structureLevel}`) : `${v.kind}:${mapAll}`;
    const graph = graphFor(current, view);

    // Draw the current graph; keep the camera of each view, fit only the first time a view is shown.
    useEffect(() => {
        if (!editor || !current || !isCanvas(view)) return;
        const key = cameraKey(view);
        if (shownView.current && shownView.current !== key) cameras.current.set(shownView.current, editor.getCamera());
        const switched = shownView.current !== key;
        if (!graph) {
            // not marked as shown, so that the graph is fitted once it arrives (focused views load on request)
            withWriteAccess(editor, () => editor.deleteShapes([...editor.getCurrentPageShapeIds()]));
            return;
        }
        // ghosts of removed elements need the previous version of the same graph; focused graphs are not kept
        const before = focusKey && view.kind === 'structure' ? undefined : (graphFor(previous, view) ?? undefined);
        renderGraph(editor, graph, { diff: current.diff, diagnostics: current.diagnostics, previous: before, mode, lang });
        if (switched) {
            const saved = cameras.current.get(key);
            if (saved) editor.setCamera(saved);
            // larger text (overview) allows zooming further out while staying readable
            else fitReadable(editor, graph.textScale ?? 1);
        }
        shownView.current = key;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editor, current, previous, view, mode, structureLevel, focusKey, focusGraph, mapAll, noneChecked, lang]);

    useEffect(() => {
        applyTheme(theme, editor);
    }, [theme, editor]);

    /** Highlights `id` in the current view if it is shown there; never switches views. */
    const highlight = useCallback(
        (id: string, v: View = view) => {
            if (editor && isCanvas(v)) highlightElement(editor, id);
        },
        [editor, view],
    );

    const focusSource = useCallback((id: string) => setSourceFocus(locationOf(model, id)), [model]);

    /** Selects an item: updates the inspector, the history and the highlight in the current view. */
    const select = useCallback(
        (id: string, opts: { highlight?: boolean } = {}) => {
            setHistory((h) => pushHistory(h, id));
            focusSource(id);
            if (opts.highlight !== false) highlight(id);
        },
        [focusSource, highlight],
    );

    /** Whether a history entry can still be shown; without a model, elements are kept (they may come back). */
    const exists = (id: string): boolean => {
        const file = selectedFile(id);
        if (file) return (current?.sources ?? []).some((s) => s.path === file);
        return !model || !!resolve(model, id);
    };
    const backTo = history[backIndex(history, exists)];
    const goBack = () => {
        if (!backTo) return;
        setHistory(popHistory(history, exists));
        focusSource(backTo);
        highlight(backTo);
    };

    /** Shows `id` in a specific view (explicit user action). */
    const reveal = useCallback(
        (target: RevealTarget, id: string) => {
            const next: View = { kind: target };
            setView(next);
            if (isCanvas(next)) requestAnimationFrame(() => requestAnimationFrame(() => highlight(id, next)));
        },
        [highlight],
    );

    const openInspector = (tab: InspectorTab) => {
        setInspectorTab(tab);
        setInspectorOpen(true);
    };

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

    // Clicking a shape on the canvas selects it (without moving the camera).
    const selectedOnCanvas = useValue(
        'selected element',
        () => {
            const only = editor?.getOnlySelectedShape();
            return only && editor ? shapeElementId(editor, only.id) : undefined;
        },
        [editor],
    );
    useEffect(() => {
        if (selectedOnCanvas) select(selectedOnCanvas, { highlight: false });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedOnCanvas]);

    usePointerCursor(editor);

    const onMount = useCallback((e: Editor) => {
        e.updateInstanceState({ isReadonly: true });
        (window as unknown as { __domaintrailEditor?: Editor }).__domaintrailEditor = e; // for debugging / e2e checks
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
                        {current ? `${t.fileCount(current.files.length)} · v${current.version} · ${new Date(current.updatedAt).toLocaleTimeString(lang)}` : ''}
                    </span>
                    <span className={`conn conn-${connection}`} title={t.connectionTitle(t.connection[connection])} />
                </div>
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
            {current?.stale && (
                <div className="banner">
                    {t.stale(<a onClick={() => setBottomOpen(true)}>{t.problems}</a>)}
                </div>
            )}
            <div className="workspace">
                {/* side panes stay mounted so that opening and closing can be animated; a closed one shows its rail */}
                <div className={`side side-left${explorerOpen ? ' open' : ''}`} style={{ width: explorerOpen ? explorerWidth : RAIL_WIDTH }}>
                    <div className="rail" inert={explorerOpen}>
                        <button className="icon-button" onClick={() => setExplorerOpen(true)} title={t.openExplorer} aria-label={t.openExplorer}>
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
                        {(['contextMap', 'structure', 'catalog'] as const).map((k) => (
                            <button key={k} role="tab" aria-selected={view.kind === k} className={view.kind === k ? 'active' : ''} onClick={() => setView({ kind: k })}>
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
                                                title={t.structureLevels[l]}
                                                aria-label={t.structureLevels[l]}
                                            >
                                                <Icon size={15} aria-hidden />
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                            {isCanvas(view) && <button onClick={() => editor?.zoomToFit({ animation: { duration: 200 } })}>{t.zoomToFit}</button>}
                        </div>
                    </div>
                    <div className="view-area">
                        <Tldraw shapeUtils={shapeUtils} hideUi onMount={onMount} />
                        {graph && isCanvas(view) && (
                            <Legend
                                view={view.kind === 'contextMap' ? 'contextMap' : `${structureLevel === 'aggregates' ? 'aggregates' : 'structure'}${focusKey ? 'Focus' : ''}`}
                                open={legendOpen}
                                onToggle={() => setLegendOpen(!legendOpen)}
                            />
                        )}
                        {current && !graph && isCanvas(view) && (
                            <div className="empty">
                                {current.status === 'empty'
                                    ? t.noDtFiles
                                    : noneChecked && view.kind === 'structure'
                                      ? t.pickContexts
                                      : focusKey && view.kind === 'structure' ? t.loading : t.noDiagram}
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
                        <button className="icon-button" onClick={() => setInspectorOpen(true)} title={t.openInspector} aria-label={t.openInspector}>
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
                                sources={current?.sources ?? []}
                                sourceFocus={sourceFocus}
                                statesView={(aggregateId) => (
                                    <StatesCanvas
                                        aggregateId={aggregateId}
                                        graph={current?.states[aggregateId]}
                                        previous={previous?.states[aggregateId]}
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
                    onTab={setBottomTab}
                    onToggle={() => setBottomOpen(!bottomOpen)}
                    onLocate={locate}
                    onSelect={(id) => select(id)}
                />
            </div>
        </div>
        </I18nProvider>
    );
}
