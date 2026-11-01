import { useCallback, useState } from 'react';
import type { Diagnostic } from '@domaintrail/modeling';
import { BaselineButton, BaselineMenu, baselineName } from '../baseline-picker';
import { Explorer } from '../explorer';
import { I18nProvider, MESSAGES } from '../i18n';
import { Inspector } from '../inspector';
import { changeCount, ChangesList, problemCounts, ProblemsList } from '../lists';
import { fileSelection, inCatalog, inStructure, resolve, selectedFile } from '../model-utils';
import { StatesCanvas } from '../states-canvas';
import { useSessionPage } from '../session/page';
import { StormingDetails } from '../storming';
import { ViewWorkspace, useViewWorkspace } from '../view/workspace';
import { usePanes } from './panes';
import { SettingsDialog } from '../settings-dialog';
import { usePreferences } from './preferences';
import { AppShell } from './shell';
import { workspaceName } from './health';
import { HealthButton } from './status';
import { useViewSocket } from './useViewSocket';

/** The Live View page: composes the shell with the left pane's lists, the view workspace, the inspector and, in a session, the chat. */
export function App() {
    const socket = useViewSocket();
    const { current, connection } = socket;
    const model = current?.model ?? null;
    /** What the model is compared with: its graphs give the ghosts of removed elements, its model the inspector's diffs. */
    const base = current?.base ?? null;
    const preferences = usePreferences();
    const { mode, setMode, themePreference, setThemePreference, theme, langPreference, setLangPreference, lang, textSize, setTextSize } = preferences;
    const t = MESSAGES[lang];
    const panes = usePanes(preferences.uiScale);
    const { setExplorerOpen, setInspectorOpen, showLeft, legendOpen, setLegendOpen } = panes;
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

    // in a session (dt session start) only: the session's chat, the facilitator's session pane and the others' cursors
    const session = useSessionPage({ socket, current, workspace, panes, mode, openBest });

    const locate = (d: Diagnostic) => {
        // e.g. syntax errors belong to no element: only their file can show them
        select(d.elementId ?? fileSelection(d.file));
        setSourceFocus({ file: d.file, line: d.start.line, endLine: d.end.line });
        if (!d.elementId) setInspectorOpen(true);
    };

    const empty = { added: [], changed: [], removed: [] };
    const diagnostics = current?.diagnostics ?? [];
    const diff = current?.diff ?? empty;
    const problems = problemCounts(diagnostics);
    const changes = changeCount(diff);

    return (
        <I18nProvider lang={lang}>
            <AppShell
                panes={panes}
                workspaceName={current ? workspaceName(current.root) : undefined}
                health={<HealthButton current={current} connection={connection} />}
                settings={
                    <SettingsDialog
                        mode={mode}
                        onMode={setMode}
                        themePreference={themePreference}
                        theme={theme}
                        onTheme={setThemePreference}
                        langPreference={langPreference}
                        lang={lang}
                        onLang={setLangPreference}
                        textSize={textSize}
                        onTextSize={setTextSize}
                    />
                }
                banners={
                    <>
                        {connection === 'closed' && !session.ended && <div className="banner banner-error">{t.connectionLost}</div>}
                        {current?.baseline.kind === 'git' && current.baseline.error && (
                            <div className="banner">{t.baselineError(current.baseline.ref, current.baseline.error)}</div>
                        )}
                        {view.kind === 'storming' && shown?.storming.stale && <div className="banner">{t.staleStorming(shown.storming.file)}</div>}
                        {current?.stale && <div className="banner">{t.stale(<a onClick={() => showLeft('problems')}>{t.problems}</a>)}</div>}
                    </>
                }
                lists={{
                    tree: {
                        count: 0,
                        content: (
                            <Explorer
                                model={model}
                                files={current?.files ?? []}
                                diagnostics={diagnostics}
                                diff={diff}
                                mode={mode}
                                selected={selected}
                                onSelect={(id) => {
                                    select(id);
                                    if (selectedFile(id)) setInspectorOpen(true);
                                }}
                                onOpen={openBest}
                                onClose={() => setExplorerOpen(false)}
                            />
                        ),
                    },
                    problems: {
                        count: diagnostics.length,
                        badge:
                            problems.errors > 0 ? (
                                <span className="activity-badge badge-error">{problems.errors}</span>
                            ) : problems.warnings > 0 ? (
                                <span className="activity-badge badge-warning">{problems.warnings}</span>
                            ) : undefined,
                        content: <ProblemsList items={diagnostics} onLocate={locate} onClose={() => setExplorerOpen(false)} />,
                    },
                    changes: {
                        count: changes,
                        badge: changes > 0 ? <span className="activity-badge">{changes}</span> : undefined,
                        content: (
                            <ChangesList
                                diff={diff}
                                model={model}
                                mode={mode}
                                baseline={current ? baselineName(current.baseline, t.baselinePrevious) : undefined}
                                gitBaseline={current?.baseline.kind === 'git'}
                                picker={
                                    current && (
                                        <BaselineButton
                                            baseline={current.baseline}
                                            open={!!baselineAnchor}
                                            onToggle={session.baselineLocked ? undefined : toggleBaselineMenu}
                                        />
                                    )
                                }
                                onSelect={(id) => select(id)}
                                onClose={() => setExplorerOpen(false)}
                            />
                        ),
                    },
                }}
                workspace={
                    <ViewWorkspace
                        workspace={workspace}
                        current={current}
                        mode={mode}
                        legendOpen={legendOpen}
                        onLegendToggle={() => setLegendOpen(!legendOpen)}
                        overlay={session.canvasOverlay}
                    />
                }
                {...(session.conversation && { conversation: session.conversation })}
                inspector={(menu) => (
                    <Inspector
                        menu={menu}
                        dock={panes.inspectorDock}
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
                )}
                overlays={
                    current &&
                    baselineAnchor &&
                    !session.baselineLocked && <BaselineMenu baseline={current.baseline} anchor={baselineAnchor} onClose={closeBaselineMenu} />
                }
            />
        </I18nProvider>
    );
}
