import { useCallback, useState } from 'react';
import type { Diagnostic } from '@domaintrail/modeling/core/diagnostics';
import { BaselineMenu, baselineName } from '../baseline-picker';
import { BottomPanel } from '../bottom';
import { Explorer } from '../explorer';
import { I18nProvider, MESSAGES } from '../i18n';
import { Inspector } from '../inspector';
import { fileSelection, inCatalog, inStructure, resolve, selectedFile } from '../model-utils';
import { StatesCanvas } from '../states-canvas';
import { StormingDetails } from '../storming';
import { ViewWorkspace, useViewWorkspace } from '../view/workspace';
import { usePanes } from './panes';
import { usePreferences } from './preferences';
import { AppShell } from './shell';
import { TopBar } from './top-bar';
import { useViewSocket } from './useViewSocket';

/** The Live View page: composes the shell with the explorer, the view workspace, the inspector and the bottom pane. */
export function App() {
    const { current, connection } = useViewSocket();
    const model = current?.model ?? null;
    /** What the model is compared with: its graphs give the ghosts of removed elements, its model the inspector's diffs. */
    const base = current?.base ?? null;
    const preferences = usePreferences();
    const { mode, theme, lang } = preferences;
    const t = MESSAGES[lang];
    const panes = usePanes();
    const { setExplorerOpen, setInspectorOpen, bottomOpen, setBottomOpen, bottomTab, setBottomTab, legendOpen, setLegendOpen } = panes;
    const { inspectorTab, setInspectorTab, openInspector } = panes;
    /** The button the baseline menu was opened from (it opens next to it), or null while closed. */
    const [baselineAnchor, setBaselineAnchor] = useState<HTMLElement | null>(null);
    const toggleBaselineMenu = (anchor: HTMLElement) => setBaselineAnchor((a) => (a === anchor ? null : anchor));
    const closeBaselineMenu = useCallback(() => setBaselineAnchor(null), []);

    const workspace = useViewWorkspace(current, { mode, lang, theme });
    const { stormings, nav, settings, viewGraph } = workspace;
    const { view, setView, selected, sourceFocus, setSourceFocus, select, backTo, goBack, reveal } = nav;
    const { shown, stormingShown } = viewGraph;

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

    const empty = { added: [], changed: [], removed: [] };

    return (
        <I18nProvider lang={lang}>
            <AppShell
                panes={panes}
                topBar={
                    <TopBar
                        current={current}
                        connection={connection}
                        preferences={preferences}
                        baselineOpen={!!baselineAnchor}
                        onBaselineToggle={toggleBaselineMenu}
                    />
                }
                banners={
                    <>
                        {current?.baseline.kind === 'git' && current.baseline.error && (
                            <div className="banner">{t.baselineError(current.baseline.ref, current.baseline.error)}</div>
                        )}
                        {view.kind === 'storming' && shown?.storming.stale && <div className="banner">{t.staleStorming(shown.storming.file)}</div>}
                        {current?.stale && <div className="banner">{t.stale(<a onClick={() => setBottomOpen(true)}>{t.problems}</a>)}</div>}
                    </>
                }
                explorer={
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
                }
                workspace={
                    <ViewWorkspace
                        workspace={workspace}
                        current={current}
                        mode={mode}
                        legendOpen={legendOpen}
                        onLegendToggle={() => setLegendOpen(!legendOpen)}
                    />
                }
                inspector={
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
                                render={view.kind === 'storming' && shown && id.startsWith(`es/${shown.storming.id}/`) ? stormingShown?.render : undefined}
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
                            settings.setStructureContexts([ctx]);
                            setView({ kind: 'structure' });
                        }}
                        backTo={backTo}
                        onBack={goBack}
                        onClose={() => setInspectorOpen(false)}
                    />
                }
                bottom={
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
                }
                overlays={current && baselineAnchor && <BaselineMenu baseline={current.baseline} anchor={baselineAnchor} onClose={closeBaselineMenu} />}
            />
        </I18nProvider>
    );
}
