import { useCallback, useState } from 'react';
import { Blocks, StickyNote, type LucideIcon } from 'lucide-react';
import type { Diagnostic } from '@domaintrail/kernel';
import type { DomainModel } from '@domaintrail/modeling';
import { BaselineButton, BaselineMenu, baselineName } from '../baseline-picker';
import { Explorer } from '../explorer';
import { I18nProvider, MESSAGES } from '../i18n';
import { Inspector } from '../inspector';
import { changeCount, ChangesList, problemCounts, ProblemsList } from '../lists';
import { fileSelection, inCatalog, inStructure, resolve, selectedFile } from '../model-utils';
import { StatesCanvas } from '../states-canvas';
import { useSessionPage } from '../session/page';
import { chooseScope, StormingDetails, stormingExists } from '../storming';
import { StormingNavigator } from '../storming-navigator';
import { NameSwitch } from '../view/toolbar';
import { ViewWorkspace, useViewWorkspace } from '../view/workspace';
import { WORLDS, type World } from '../view/worlds';
import { readBoot } from './boot';
import { usePanes } from './panes';
import { SettingsDialog } from '../settings-dialog';
import { usePreferences } from './preferences';
import { AppShell, type Conversation } from './shell';
import { workspaceName } from './health';
import { HealthButton } from './status';
import { useViewSocket } from './useViewSocket';
import { KnowledgeList, KnowledgeMarks, KnowledgeNotice, StickyKnowledge } from '../knowledge/panel';
import { KnowledgeContext, useKnowledge } from '../knowledge/useKnowledge';

const WORLD_ICONS: Record<World, LucideIcon> = { model: Blocks, storming: StickyNote };

/** The conversation's column while the session the server announced has not arrived: its place, quiet and empty. */
const PENDING_CONVERSATION: Conversation = { content: <div className="conversation-pending" aria-busy="true" />, launcher: null };

/** An aggregate's name and label (its ID while the model does not have it). */
function aggregateNames(model: DomainModel | null, id: string): { name: string; label?: string | undefined } {
    const r = model ? resolve(model, id) : undefined;
    return r?.kind === 'element' ? { name: r.el.name, label: r.el.label } : { name: id };
}

/** The Live View page: composes the shell with the left column's lists and detail (the inspector), the view workspace and, in a session, the chat. */
export function App() {
    // what the server wrote into the page for its first frame (none: the page waits for the payload, as before)
    const [boot] = useState(() => readBoot());
    const socket = useViewSocket();
    const { current, connection } = socket;
    const model = current?.model ?? null;
    /** What the model is compared with: its graphs give the ghosts of removed elements, its model the inspector's diffs. */
    const base = current?.base ?? null;
    const preferences = usePreferences();
    const { mode, setMode, themePreference, setThemePreference, theme, langPreference, setLangPreference, lang, textSize, setTextSize } = preferences;
    const t = MESSAGES[lang];
    // a session's page opens on its chat (useSessionPage): from the first frame when the server said there is one
    const panes = usePanes(preferences.uiScale, boot?.session !== undefined);
    const { setExplorerOpen, setInspectorOpen, showLeft, legends } = panes;
    const { inspectorTab, setInspectorTab, openInspector } = panes;
    /** The button the baseline menu was opened from (it opens next to it), or null while closed. */
    const [baselineAnchor, setBaselineAnchor] = useState<HTMLElement | null>(null);
    const toggleBaselineMenu = (anchor: HTMLElement) => setBaselineAnchor((a) => (a === anchor ? null : anchor));
    const closeBaselineMenu = useCallback(() => setBaselineAnchor(null), []);
    /** The app bar's place for a session's controls of the whole page (the chat puts them there). */
    const [sessionSlot, setSessionSlot] = useState<HTMLDivElement | null>(null);
    const [journeySlot, setJourneySlot] = useState<HTMLDivElement | null>(null);

    const workspace = useViewWorkspace(current, { mode, lang, theme });
    const { stormings, nav, worlds, settings, viewGraph } = workspace;
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
    const session = useSessionPage({ socket, current, workspace, panes, mode, openBest, barSlot: sessionSlot, journeySlot });

    // the knowledge of a session with a store (ADR 0031): the marks of the storming shown, the ナレッジ list, a sticky's items
    const knowledge = useKnowledge({
        socket,
        session: boot?.session !== undefined || session.conversation !== undefined,
        storming: view.kind === 'storming' ? shown?.storming.id : undefined,
        stormings,
        mode,
        select: (id) => select(id),
    });

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
            <KnowledgeContext.Provider value={knowledge}>
                <AppShell
                    panes={panes}
                    workspaceName={current ? workspaceName(current.root) : boot?.workspaceName}
                    world={
                        <NameSwitch
                            label={t.worldsLabel}
                            className="world-switch"
                            choices={WORLDS}
                            value={worlds.world}
                            icons={WORLD_ICONS}
                            names={t.worlds}
                            onChange={worlds.setWorld}
                        />
                    }
                    sessionSlot={setSessionSlot}
                    journeySlot={setJourneySlot}
                    session={boot?.session && { mode: boot.session.mode, ready: session.conversation !== undefined }}
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
                            // the navigator follows the world: the model tree, or the stormings with their stages and timelines
                            content:
                                worlds.world === 'storming' ? (
                                    <StormingNavigator
                                        stormings={stormings}
                                        choice={settings.stormingChoice}
                                        mode={mode}
                                        onChoose={settings.setStormingChoice}
                                        onSelect={(id) => {
                                            if (stormingExists(stormings, id)) select(id, { highlight: false });
                                        }}
                                        onClose={() => setExplorerOpen(false)}
                                    />
                                ) : (
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
                        ...(knowledge.available && {
                            knowledge: { count: 0, content: <KnowledgeList onClose={() => setExplorerOpen(false)} closeLabel={t.closeExplorer} /> },
                        }),
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
                            legends={legends}
                            overlay={
                                <>
                                    {session.canvasOverlay}
                                    <KnowledgeMarks canvas={workspace.canvas} />
                                </>
                            }
                            aiReady={session.aiReady}
                        />
                    }
                    {...((session.conversation ?? boot?.session) && { conversation: session.conversation ?? PENDING_CONVERSATION })}
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
                                    legendOpen={legends.isOpen('states')}
                                    onLegendToggle={() => legends.toggle('states')}
                                    compact={settings.compact}
                                    aggregate={aggregateNames(model, aggregateId)}
                                    workspaceName={current ? workspaceName(current.root) : undefined}
                                    exportOptions={workspace.exportOptions}
                                />
                            )}
                            stormingView={(id, history) => (
                                <StormingDetails
                                    stormings={stormings}
                                    selected={id}
                                    render={view.kind === 'storming' && shown && id.startsWith(`es/${shown.storming.id}/`) ? stormingShown?.render : undefined}
                                    level={shown?.options.level ?? settings.stormingChoice.level}
                                    model={model}
                                    mode={mode}
                                    diagnostics={current?.diagnostics ?? []}
                                    history={history}
                                    headingAction={session.inspectorAction}
                                    session={session.stormingDetail}
                                    knowledge={knowledge.available ? (sticky) => <StormingKnowledgeSlot sticky={sticky} /> : undefined}
                                    onSelect={(x) => select(x)}
                                    onShowScope={(stormingId, scope, then) => {
                                        settings.setStormingChoice(chooseScope(settings.stormingChoice, stormingId, scope));
                                        setView({ kind: 'storming' });
                                        // the element in the view just chosen, once it is drawn
                                        if (then) requestAnimationFrame(() => requestAnimationFrame(() => select(then)));
                                    }}
                                    onLevel={(level) => {
                                        settings.setStormingChoice({ ...settings.stormingChoice, level });
                                        setView({ kind: 'storming' });
                                        requestAnimationFrame(() => requestAnimationFrame(() => select(id)));
                                    }}
                                />
                            )}
                            headingAction={session.inspectorAction}
                            {...(session.contextJourneys && { contextJourneys: session.contextJourneys })}
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
                    overlays={
                        <>
                            {current && baselineAnchor && !session.baselineLocked && (
                                <BaselineMenu baseline={current.baseline} anchor={baselineAnchor} onClose={closeBaselineMenu} />
                            )}
                            <KnowledgeNotice />
                        </>
                    }
                />
            </KnowledgeContext.Provider>
        </I18nProvider>
    );
}

/** A sticky's knowledge in its detail, mounted again for another sticky (its opened item and order start afresh). */
function StormingKnowledgeSlot({ sticky }: { sticky: string }) {
    return <StickyKnowledge key={sticky} sticky={sticky} />;
}
