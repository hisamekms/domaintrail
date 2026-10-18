import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Tldraw, react, useValue, type Editor, type TLCamera } from 'tldraw';
import type { Diagnostic } from '../src/core/diagnostics';
import type { DisplayMode, LaidOutGraph } from '../src/graph/ir';
import { BottomPanel, type BottomTab } from './bottom';
import { PrimitiveCatalog } from './catalog';
import { Explorer } from './explorer';
import { Legend } from './legend';
import { Inspector, type InspectorTab, type RevealTarget } from './inspector';
import { Resizer, usePersistentState } from './layout';
import { inCatalog, inStructure, nameIn, resolve } from './model-utils';
import { findShapeForElement, ownerElement, renderGraph, shapeElementId, withWriteAccess } from './render';
import { shapeUtils } from './shapes';
import { CopyLocation, SourceView, locationOf, type SourceFocus } from './source';
import { ContextPicker } from './context-picker';
import { THEME_KEY, applyTheme, useResolvedTheme, type ThemePreference } from './theme';
import { useViewSocket } from './useViewSocket';

type View = { kind: 'contextMap' } | { kind: 'structure' } | { kind: 'states'; aggregateId: string } | { kind: 'primitives' } | { kind: 'source' };

/**
 * Initial zoom never goes below this (in units of normal-size text), so text stays readable;
 * large diagrams are shown from the top-left.
 */
const MIN_INITIAL_ZOOM = 0.9;

function fitReadable(editor: Editor, textScale = 1): void {
    const minZoom = MIN_INITIAL_ZOOM / textScale;
    editor.zoomToFit();
    if (editor.getZoomLevel() >= minZoom) return;
    const bounds = editor.getCurrentPageBounds();
    if (!bounds) return;
    const screen = editor.getViewportScreenBounds();
    const margin = 24;
    editor.setCamera({ ...editor.getCamera(), z: minZoom });
    editor.centerOnPoint({
        x: Math.min(bounds.center.x, bounds.x + screen.w / minZoom / 2 - margin),
        y: Math.min(bounds.center.y, bounds.y + screen.h / minZoom / 2 - margin),
    });
}

const MODE_LABEL: Record<DisplayMode, string> = { ja: '日本語', en: 'English', both: '両方' };
const THEME_LABEL: Record<ThemePreference, string> = { auto: '自動', light: 'ライト', dark: 'ダーク' };
const viewKey = (v: View): string => (v.kind === 'states' ? `states:${v.aggregateId}` : v.kind);
const isCanvas = (v: View): boolean => v.kind === 'contextMap' || v.kind === 'structure' || v.kind === 'states';

const STATUS_LABEL = {
    ok: '正常',
    invalid: '検証エラー',
    'syntax-error': '構文エラー',
    empty: '.dt なし',
} as const;

export function App() {
    const { current, previous, connection } = useViewSocket();
    const model = current?.model ?? null;
    const [editor, setEditor] = useState<Editor | null>(null);
    const [view, setView] = useState<View>({ kind: 'structure' });
    const [mode, setMode] = usePersistentState<DisplayMode>('domaintrail.displayMode', 'both');
    const [themePreference, setThemePreference] = usePersistentState<ThemePreference>(THEME_KEY, 'auto');
    const theme = useResolvedTheme(themePreference);
    /** Structure View: all fields (detail) or names only in larger text (overview). */
    const [structureMode, setStructureMode] = usePersistentState<'detail' | 'overview'>('domaintrail.structureMode', 'detail');
    /** Structure View: only these bounded contexts, with their dependencies as stubs (empty = every context). */
    const [focusContexts, setFocusContexts] = usePersistentState<string[]>('domaintrail.structureFocusContexts', []);
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
    const [inspectorTab, setInspectorTab] = usePersistentState<InspectorTab>('domaintrail.inspector.tab', 'structure');

    // Selection with back/forward history
    const [history, setHistory] = useState<{ stack: string[]; index: number }>({ stack: [], index: -1 });
    const selected = history.stack[history.index];
    const [sourceFile, setSourceFile] = useState<string | undefined>();
    const [sourceFocus, setSourceFocus] = useState<SourceFocus | undefined>();

    const cameras = useRef(new Map<string, TLCamera>());
    const shownView = useRef<string | null>(null);

    const aggregates = useMemo(() => Object.values(model?.elements ?? {}).filter((e) => e.kind === 'aggregate'), [model]);
    const lastAggregate = useRef<string | undefined>(undefined);
    if (view.kind === 'states') lastAggregate.current = view.aggregateId;

    /** The focused contexts that can still be drawn, in model order. */
    const focused = useMemo(() => (current?.focusContexts ?? []).filter((c) => focusContexts.includes(c)), [current?.focusContexts, focusContexts]);
    const focusKey = focused.length ? `${focused.join('+')}|${structureMode}` : '';
    /** The focused Structure View is laid out on request by the server. */
    const [focusGraph, setFocusGraph] = useState<{ key: string; graph: LaidOutGraph } | null>(null);
    useEffect(() => {
        if (!focusKey || view.kind !== 'structure') return;
        let cancelled = false;
        const params = new URLSearchParams({ contexts: focused.join(','), overview: structureMode === 'overview' ? '1' : '0' });
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
            if (focusKey) return focusGraph?.key === focusKey ? focusGraph.graph : undefined;
            return structureMode === 'overview' ? p.overview : p.structure;
        }
        return p.states[(v as { aggregateId: string }).aggregateId];
    };
    /** Camera key: each view (and each Structure mode and focus) keeps its own camera. */
    const cameraKey = (v: View): string =>
        v.kind === 'structure'
            ? focusKey
                ? `structure:focus:${focusKey}`
                : `structure:${structureMode}`
            : v.kind === 'contextMap'
              ? `contextMap:${mapAll}`
              : viewKey(v);
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
        renderGraph(editor, graph, { diff: current.diff, diagnostics: current.diagnostics, previous: before, mode });
        if (switched) {
            const saved = cameras.current.get(key);
            if (saved) editor.setCamera(saved);
            // larger text (overview) allows zooming further out while staying readable
            else fitReadable(editor, graph.textScale ?? 1);
        }
        shownView.current = key;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editor, current, previous, view, mode, structureMode, focusKey, focusGraph, mapAll]);

    useEffect(() => {
        applyTheme(theme, editor);
    }, [theme, editor]);

    // If the aggregate of the State View disappears, fall back to the Structure View.
    useEffect(() => {
        if (view.kind === 'states' && model && !model.elements[view.aggregateId]) setView({ kind: 'structure' });
    }, [model, view]);

    /** Highlights `id` in the current view if it is shown there; never switches views. */
    const highlight = useCallback(
        (id: string, v: View = view) => {
            if (!editor || !isCanvas(v)) return;
            const shape = findShapeForElement(editor, id);
            if (!shape) {
                editor.selectNone();
                return;
            }
            editor.select(shape);
            const b = editor.getShapePageBounds(shape);
            if (b && !editor.getViewportPageBounds().contains(b)) editor.centerOnPoint(b.center, { animation: { duration: 200 } });
        },
        [editor, view],
    );

    const focusSource = useCallback(
        (id: string) => {
            const loc = locationOf(model, id);
            if (!loc) return;
            setSourceFocus(loc);
            setSourceFile(loc.file);
        },
        [model],
    );

    /** Selects an item: updates the inspector, the history and the highlight in the current view. */
    const select = useCallback(
        (id: string, opts: { highlight?: boolean } = {}) => {
            setHistory((h) => (h.stack[h.index] === id ? h : { stack: [...h.stack.slice(0, h.index + 1), id], index: h.index + 1 }));
            focusSource(id);
            if (opts.highlight !== false) highlight(id);
        },
        [focusSource, highlight],
    );

    const goHistory = (delta: number) => {
        const index = history.index + delta;
        const id = history.stack[index];
        if (!id) return;
        setHistory({ ...history, index });
        focusSource(id);
        highlight(id);
    };

    /** Shows `id` in a specific view (explicit user action). */
    const reveal = useCallback(
        (target: RevealTarget, id: string) => {
            let next: View;
            if (target === 'contextMap') {
                next = { kind: 'contextMap' };
            } else if (target === 'states') {
                const owner = ownerElement(id);
                next = { kind: 'states', aggregateId: model?.elements[owner]?.kind === 'aggregate' ? owner : id };
            } else {
                next = { kind: target };
            }
            setView(next);
            focusSource(id);
            if (isCanvas(next)) requestAnimationFrame(() => requestAnimationFrame(() => highlight(id, next)));
        },
        [model, focusSource, highlight],
    );

    /** Double-click in the explorer: the view that suits the item best. */
    const openBest = (id: string) => {
        select(id, { highlight: false });
        const r = model ? resolve(model, id) : undefined;
        if (!r) return;
        if (r.kind === 'state' || r.kind === 'command') reveal('states', id);
        else if (r.kind === 'context') reveal('structure', id);
        else if (inStructure(r.el.kind)) reveal('structure', id);
        else if (inCatalog(r.el.kind)) reveal('primitives', id);
        else reveal('source', id);
    };

    const locate = (d: Diagnostic) => {
        if (d.elementId) select(d.elementId);
        setSourceFile(d.file);
        setSourceFocus({ file: d.file, line: d.start.line, endLine: d.end.line });
        if (!d.elementId) setView({ kind: 'source' }); // e.g. syntax errors: only the source can show them
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

    // tldraw hit-tests shapes itself (DOM hover never reaches them) and resets the cursor on its own state changes
    // (e.g. after a click), so the pointer cursor is re-derived whenever the hover target or the cursor changes.
    useEffect(() => {
        if (!editor) return;
        return react('pointer cursor', () => {
            const id = editor.getHoveredShapeId();
            const shape = id ? editor.getShape(id) : undefined;
            const clickable = !!shape && !(shape.meta as { ghost?: boolean }).ghost;
            const cursor = editor.getInstanceState().cursor.type;
            if (clickable && cursor === 'default') editor.setCursor({ type: 'pointer', rotation: 0 });
            else if (!clickable && cursor === 'pointer') editor.setCursor({ type: 'default', rotation: 0 });
        });
    }, [editor]);

    const onMount = useCallback((e: Editor) => {
        e.updateInstanceState({ isReadonly: true });
        (window as unknown as { __domaintrailEditor?: Editor }).__domaintrailEditor = e; // for debugging / e2e checks
        setEditor(e);
    }, []);

    const activeFile = sourceFile ?? current?.files[0];
    const empty = { added: [], changed: [], removed: [] };

    return (
        <div className="app">
            <header>
                <div className="brand">DomainTrail</div>
                <div className="pane-toggles" role="group" aria-label="ペインの表示">
                    <button className={explorerOpen ? 'active' : ''} onClick={() => setExplorerOpen(!explorerOpen)} title="エクスプローラ">
                        ◧ エクスプローラ
                    </button>
                    <button className={bottomOpen ? 'active' : ''} onClick={() => setBottomOpen(!bottomOpen)} title="問題・変更">
                        ⬓ 問題・変更
                    </button>
                    <button className={inspectorOpen ? 'active' : ''} onClick={() => setInspectorOpen(!inspectorOpen)} title="インスペクタ">
                        ◨ インスペクタ
                    </button>
                </div>
                <div className="segmented" role="group" aria-label="表示名">
                    {(Object.keys(MODE_LABEL) as DisplayMode[]).map((m) => (
                        <button key={m} className={mode === m ? 'active' : ''} aria-pressed={mode === m} onClick={() => setMode(m)}>
                            {MODE_LABEL[m]}
                        </button>
                    ))}
                </div>
                <div className="segmented" role="group" aria-label="テーマ" title={themePreference === 'auto' ? `OS の設定に従う（いまは${THEME_LABEL[theme]}）` : undefined}>
                    {(Object.keys(THEME_LABEL) as ThemePreference[]).map((t) => (
                        <button key={t} className={themePreference === t ? 'active' : ''} aria-pressed={themePreference === t} onClick={() => setThemePreference(t)}>
                            {THEME_LABEL[t]}
                        </button>
                    ))}
                </div>
                <div className="status">
                    {current && <span className={`pill pill-${current.status}`}>{STATUS_LABEL[current.status]}</span>}
                    <span className="muted">
                        {current ? `${current.files.length} files · v${current.version} · ${new Date(current.updatedAt).toLocaleTimeString()}` : ''}
                    </span>
                    <span className={`conn conn-${connection}`} title={`WebSocket: ${connection}`} />
                </div>
            </header>
            {current?.stale && (
                <div className="banner">
                    構文エラーのため、最後に解析できた図を表示しています。
                    <a onClick={() => setBottomOpen(true)}>問題</a>から該当箇所へ移動できます。
                </div>
            )}
            <div className="workspace">
                {explorerOpen && (
                    <>
                        <aside className="pane pane-left" style={{ width: explorerWidth }}>
                            <Explorer
                                model={model}
                                files={current?.files ?? []}
                                diagnostics={current?.diagnostics ?? []}
                                diff={current?.diff ?? empty}
                                mode={mode}
                                selected={selected}
                                activeFile={view.kind === 'source' ? activeFile : undefined}
                                onSelect={(id) => select(id)}
                                onOpen={openBest}
                                onOpenFile={(f) => {
                                    setSourceFile(f);
                                    setView({ kind: 'source' });
                                }}
                            />
                        </aside>
                        <Resizer direction="x" size={explorerWidth} min={180} max={480} onResize={setExplorerWidth} />
                    </>
                )}
                <section className="center">
                    <div className="view-tabs" role="tablist">
                        {(['contextMap', 'structure', 'states', 'primitives', 'source'] as const).map((k) => (
                            <button
                                key={k}
                                role="tab"
                                aria-selected={view.kind === k}
                                className={view.kind === k ? 'active' : ''}
                                disabled={k === 'states' && aggregates.length === 0}
                                onClick={() =>
                                    setView(k === 'states' ? { kind: 'states', aggregateId: lastAggregate.current ?? aggregates[0]?.id ?? '' } : { kind: k })
                                }
                            >
                                {{ contextMap: 'Context Map', structure: 'Structure', states: 'States', primitives: 'Primitives', source: 'Source' }[k]}
                            </button>
                        ))}
                        <div className="view-toolbar">
                            {view.kind === 'states' && (
                                <select value={view.aggregateId} onChange={(e) => setView({ kind: 'states', aggregateId: e.target.value })} aria-label="集約">
                                    {aggregates.map((a) => (
                                        <option key={a.id} value={a.id}>
                                            {nameIn(mode, a.id, a.label)}
                                        </option>
                                    ))}
                                </select>
                            )}
                            {view.kind === 'contextMap' && (
                                <label className="check small">
                                    <input type="checkbox" checked={mapAll} onChange={(e) => setMapAll(e.target.checked)} />
                                    共有・外部の BC も表示
                                </label>
                            )}
                            {view.kind === 'structure' && (
                                <ContextPicker
                                    contexts={current?.focusContexts ?? []}
                                    labels={model?.contextLabels ?? {}}
                                    selected={focused}
                                    mode={mode}
                                    onChange={setFocusContexts}
                                />
                            )}
                            {view.kind === 'structure' && (
                                <div className="segmented small" role="group" aria-label="Structure の表示">
                                    {(['detail', 'overview'] as const).map((m) => (
                                        <button key={m} className={structureMode === m ? 'active' : ''} aria-pressed={structureMode === m} onClick={() => setStructureMode(m)}>
                                            {m === 'detail' ? '詳細' : '概観'}
                                        </button>
                                    ))}
                                </div>
                            )}
                            {isCanvas(view) && <button onClick={() => editor?.zoomToFit({ animation: { duration: 200 } })}>全体表示</button>}
                            {view.kind === 'source' && activeFile && (
                                <>
                                    <span className="muted">{activeFile}（表示専用）</span>
                                    {sourceFocus?.file === activeFile && <CopyLocation loc={sourceFocus} />}
                                </>
                            )}
                        </div>
                    </div>
                    <div className="view-area">
                        <Tldraw shapeUtils={shapeUtils} hideUi onMount={onMount} />
                        {graph && isCanvas(view) && <Legend view={view.kind === 'states' ? 'states' : view.kind === 'contextMap' ? 'contextMap' : focusKey ? 'focus' : 'structure'} />}
                        {current && !graph && isCanvas(view) && (
                            <div className="empty">
                                {current.status === 'empty' ? '.dt ファイルがありません' : focusKey && view.kind === 'structure' ? '読み込み中…' : '表示できる図がありません'}
                            </div>
                        )}
                        {view.kind === 'source' && current && (
                            <SourceView
                                sources={current.sources}
                                diagnostics={current.diagnostics}
                                model={model}
                                file={activeFile}
                                focus={sourceFocus}
                                onSelect={(id) => select(id)}
                            />
                        )}
                        {view.kind === 'primitives' && model && (
                            <PrimitiveCatalog
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
                {inspectorOpen && (
                    <>
                        <Resizer direction="x" size={inspectorWidth} min={300} max={720} invert onResize={setInspectorWidth} />
                        <aside className="pane pane-right" style={{ width: inspectorWidth }}>
                            <Inspector
                                model={model}
                                mode={mode}
                                selected={selected}
                                diagnostics={current?.diagnostics ?? []}
                                diff={current?.diff ?? empty}
                                sources={current?.sources ?? []}
                                tab={inspectorTab}
                                onTab={setInspectorTab}
                                onSelect={(id) => select(id)}
                                onReveal={reveal}
                                onFocusContext={(ctx) => {
                                    setFocusContexts([ctx]);
                                    setView({ kind: 'structure' });
                                }}
                                canBack={history.index > 0}
                                canForward={history.index < history.stack.length - 1}
                                onBack={() => goHistory(-1)}
                                onForward={() => goHistory(1)}
                            />
                        </aside>
                    </>
                )}
            </div>
            {bottomOpen && <Resizer direction="y" size={bottomHeight} min={120} max={600} invert onResize={setBottomHeight} />}
            <div className="bottom-wrap" style={{ height: bottomOpen ? bottomHeight : undefined }}>
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
    );
}
