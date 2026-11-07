import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Blocks, StickyNote, type LucideIcon } from 'lucide-react';
import type { Diagnostic } from '@domaintrail/kernel';
import type { DomainModel } from '@domaintrail/modeling';
import { firstDeclarations } from '@domaintrail/storming';
import { LEVEL_KINDS } from '@domaintrail/visualization';
import { BaselineButton, BaselineMenu, baselineName } from '../baseline-picker';
import { Explorer } from '../explorer';
import { I18nProvider, MESSAGES } from '../i18n';
import { Inspector, selectionName } from '../inspector';
import { changeCount, ChangesList, problemCounts, ProblemsList } from '../lists';
import { fileSelection, inCatalog, inStructure, resolve, selectedFile } from '../model-utils';
import { StatesCanvas } from '../states-canvas';
import { useSessionPage } from '../session/page';
import { type StormingChoice, chooseScope, isStormingSelection, revealIn, StormingDetails, stormingExists } from '../storming';
import { StormingNavigator } from '../storming-navigator';
import { NameSwitch } from '../view/toolbar';
import { ViewWorkspace, useViewWorkspace } from '../view/workspace';
import { WORLDS, type World } from '../view/worlds';
import { readBoot } from './boot';
import { usePanes } from './panes';
import { SettingsDialog } from '../settings-dialog';
import { usePreferences } from './preferences';
import { AppShell, type Conversation } from './shell';
import type { TreeFold } from '../tree-fold';
import { workspaceName } from './health';
import { HealthButton } from './status';
import { useViewSocket } from './useViewSocket';
import { CommandPalette, usePaletteKey } from '../shared/palette';
import { searchSections } from '../search/find';
import { goToModel } from '../search/go';
import { modelFindables } from '../search/model';
import { modelTakenText, SearchNotice, stormingTaken, stormingTakenText, useNotice } from '../search/notice';
import { searchPaletteSections } from '../search/palette';
import { modelDestination, modelNotes } from '../search/reveal';
import { focusCanvas, useStickyActions } from '../stickies/layer';
import { linkedElement } from '../stickies/link';
import { currentReturn, RETURN_STATE, type ReturnPoint } from '../stickies/return';
import { isMac } from '../stickies/registry';
import { highlightElement } from '../view/canvas';
import { KnowledgeList, KnowledgeMarks, KnowledgeNotice, StickyKnowledge } from '../knowledge/panel';
import { KnowledgeContext, useKnowledge } from '../knowledge/useKnowledge';
import { CopySteps } from '../view/lines';

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
    const { setExplorerOpen, showInspector, showLeft, legends } = panes;
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
    const { view, setView, selected, history, sourceFocus, setSourceFocus, select, backTo, goBack, reveal } = nav;
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
        // a sticky opened from a knowledge item (or a hotspot) is shown in the detail, under the tree; on the storming
        // canvas, shown first when the 絞り込み hides it
        select: (id) => {
            if (view.kind === 'storming' && isStormingSelection(id)) openSticky(id);
            else select(id);
            showInspector();
        },
        showList: () => showLeft('knowledge'),
    });

    /**
     * Shows a sticky: its storming's integrated canvas (the view shown kept when it draws it), at a level that draws
     * it, with what the 絞り込み hides of it shown (`revealIn`), and selects it there (the palette, a link, the knowledge,
     * a link of the detail, a sticky renamed).
     */
    const { stormingChoice, setStormingChoice } = settings;
    const { canvas } = workspace;
    const openSticky = useCallback(
        (id: string): void => {
            const [, stormingId, local] = id.split('/');
            const storming = stormings.find((x) => x.id === stormingId);
            if (!storming || local === undefined) return;
            const kind = firstDeclarations(storming.storming).get(local)?.kind;
            const drawn = LEVEL_KINDS[stormingChoice.level].some((k) => k === kind);
            const inView = view.kind === 'storming' && shown?.storming.id === stormingId && drawn && canvas?.findElement(id) !== undefined;
            const { [stormingId]: _, ...others } = stormingChoice.timelines;
            const there = inView ? stormingChoice : { ...stormingChoice, stormingId, level: drawn ? stormingChoice.level : 'design-level', timelines: others };
            const next = revealIn(stormings, there, id);
            if (next !== stormingChoice) setStormingChoice(next);
            if (view.kind !== 'storming') setView({ kind: 'storming' });
            select(id, { highlight: false });
            // selected on the canvas, which takes the focus: Escape clears the selection there
            requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                    if (!canvas) return;
                    highlightElement(canvas, id);
                    focusCanvas(canvas);
                }),
            );
        },
        [stormings, stormingChoice, setStormingChoice, view.kind, shown?.storming.id, canvas, select, setView],
    );

    // the way back from ドメインモデルで見る and このタイムラインで見る (ADR 0033): a return point per jump, with a browser
    // history entry of its own, so that the detail's ← and the browser's Back both return to the storming as it was shown
    const [returns, setReturns] = useState<ReturnPoint<StormingChoice>[]>([]);
    const leave = useCallback(
        (from: string, to: string): void => {
            const point: ReturnPoint<StormingChoice> = { from, to, view, choice: stormingChoice, ...(canvas && { camera: canvas.getCamera() }) };
            setReturns((r) => [...r, point]);
            window.history.pushState({ [RETURN_STATE]: true }, '');
        },
        [view, stormingChoice, canvas],
    );
    const comeBack = useCallback(
        (point: ReturnPoint<StormingChoice>): void => {
            setReturns((r) => r.slice(0, -1));
            setStormingChoice(point.choice);
            setView(point.view);
            select(point.from, { highlight: false });
            // once the view is drawn again (it is fitted when shown): the camera it had, and the sticky selected there
            setTimeout(() => {
                if (!canvas) return;
                if (point.camera) canvas.setCamera(point.camera);
                const item = canvas.findElement(point.from);
                if (item) canvas.select([item]);
            }, 200);
        },
        [setStormingChoice, setView, select, canvas],
    );
    const returnPoint = currentReturn(returns, selected);
    useEffect(() => {
        const onPop = (): void => {
            const point = returns.at(-1);
            if (point) comeBack(point);
        };
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, [returns, comeBack]);
    /** The detail's ←: back across the jump through the browser's history (one entry each), else the selection's. */
    const back = (): void => {
        if (!returnPoint) return goBack();
        const state: unknown = window.history.state;
        const ours = typeof state === 'object' && state !== null && RETURN_STATE in state;
        if (ours) window.history.back();
        else comeBack(returnPoint);
    };

    // a sticky found by 探す (`findSticky`, below): the same function for the stickies' findables
    const findStickyRef = useRef<(id: string) => void>(() => {});
    const findStickyFromSearch = useCallback((id: string) => findStickyRef.current(id), []);
    // the stickies' actions (ADR 0033): the toolbar, the menu, the keys and the windows over a storming, 探す's items
    const stickyActions = useStickyActions({
        canvas,
        stormings,
        model,
        mode,
        active: view.kind === 'storming',
        ...(shown?.options.timelineId !== undefined && { timelineShown: shown.options.timelineId }),
        session: session.stickies,
        onSeeModel: (dtId, from) => {
            leave(from, dtId);
            openBest(dtId);
        },
        onSeeTimeline: (stormingId, timeline, then) => {
            leave(then, then);
            setStormingChoice(chooseScope(stormingChoice, stormingId, timeline));
            setView({ kind: 'storming' });
            requestAnimationFrame(() => requestAnimationFrame(() => select(then)));
        },
        onOpenSticky: openSticky,
        onFindSticky: findStickyFromSearch,
        // ナレッジを見る: the sticky's knowledge in the detail, under the tree (a session with a store only)
        ...(knowledge.available && {
            knowledge: {
                has: (id: string) => knowledge.marks.has(id),
                open: (id: string) => {
                    select(id, { highlight: false });
                    showInspector();
                    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector('.knowledge-sticky')?.scrollIntoView({ block: 'start' })));
                },
            },
        }),
    });
    // a hotspot the AI renamed while it was selected (ADR 0033): selected again under its name
    const renamed = session.stickies?.renamed;
    useEffect(() => {
        const next = selected !== undefined ? renamed?.get(selected) : undefined;
        if (next !== undefined && stormingExists(stormings, next) && !stormingExists(stormings, selected ?? '')) openSticky(next);
    }, [selected, renamed, stormings, openSticky]);
    // 探す (the app bar's search, ⌘K / Ctrl+K): the actions on the selection, the stickies and the domain model of both
    // worlds; going to what is found shows what hides it first, and says so for a moment
    const mac = useMemo(isMac, []);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const openPalette = useCallback(() => setPaletteOpen(true), []);
    usePaletteKey(mac, openPalette);
    const notice = useNotice();
    const { say } = notice;
    // a sticky: `openSticky` (a level that draws it, what the 絞り込み hides of it shown); what it changed of the
    // storming view is said once the choice is set
    const takenFrom = useRef<{ choice: StormingChoice; storming: string } | undefined>(undefined);
    useEffect(() => {
        const from = takenFrom.current;
        if (!from) return;
        takenFrom.current = undefined;
        say(stormingTakenText(t, stormingTaken(from.choice, stormingChoice, from.storming)));
    }, [stormingChoice, say, t]);
    const findSticky = (id: string): void => {
        takenFrom.current = { choice: stormingChoice, storming: id.split('/')[1] ?? '' };
        openSticky(id);
        // nothing changed: nothing to say
        requestAnimationFrame(() => requestAnimationFrame(() => (takenFrom.current = undefined)));
    };
    findStickyRef.current = findSticky;
    const { filter: catalogFilter, setFilter: setCatalogFilter } = workspace.catalog;
    /** Selects the item of `id` on the canvas once it is drawn (a few frames at most), then runs `then`. */
    const showOnCanvas = useCallback(
        (id: string, then: () => void): void => {
            let frames = 60;
            const tryShow = (): void => {
                if (canvas?.findElement(id) === undefined && --frames > 0) return void requestAnimationFrame(tryShow);
                if (canvas) highlightElement(canvas, id);
                // after the canvas's selection became the navigation's
                requestAnimationFrame(() => requestAnimationFrame(then));
            };
            requestAnimationFrame(tryShow);
        },
        [canvas],
    );
    const findModel = (id: string): void => {
        if (!model || !current) return;
        const dest = modelDestination(model, id, {
            graphs: { detail: current.structure, overview: current.overview, aggregates: current.aggregates },
            level: settings.structureLevel,
            contexts: settings.structureContexts,
            focusContexts: current.focusContexts,
            catalog: catalogFilter,
        });
        if (!dest) return;
        goToModel(dest, {
            nav,
            settings,
            clearCatalogFilter: () => setCatalogFilter({ query: '', sections: [], contexts: null }),
            openInspector,
            show: showOnCanvas,
        });
        say(modelTakenText(t, modelNotes(dest.place)));
    };
    const findModelRef = useRef(findModel);
    findModelRef.current = findModel;
    const findables = useMemo(
        () => [...stickyActions.findables, ...modelFindables(model, mode, t, (id) => findModelRef.current(id))],
        [stickyActions.findables, model, mode, t],
    );
    const searchList = useCallback(
        (query: string, expanded: ReadonlySet<string>) =>
            searchPaletteSections(searchSections({ query, findables, actions: stickyActions.actions, world: worlds.world, mode, history, expanded }), mode, t),
        [findables, stickyActions.actions, worlds.world, mode, history, t],
    );

    // a link to an element (`#select=…`): opened once its storming is there, then the fragment is dropped
    const [linked, setLinked] = useState(() => linkedElement(window.location.hash));
    useEffect(() => {
        // a link opened in a page already showing the Live View only changes the fragment
        const onHash = (): void => setLinked(linkedElement(window.location.hash));
        window.addEventListener('hashchange', onHash);
        return () => window.removeEventListener('hashchange', onHash);
    }, []);
    useEffect(() => {
        if (linked === undefined || !stormingExists(stormings, linked)) return;
        setLinked(undefined);
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
        openSticky(linked);
    }, [linked, stormings, openSticky]);

    const locate = (d: Diagnostic) => {
        // e.g. syntax errors belong to no element: only their file can show them
        select(d.elementId ?? fileSelection(d.file));
        setSourceFocus({ file: d.file, line: d.start.line, endLine: d.end.line });
        if (!d.elementId) showInspector();
    };

    /** The tree's fold over the detail; folded, its head line names the world and what is selected. */
    const fold: TreeFold = {
        folded: panes.treeFolded,
        label: [t.worlds[worlds.world], ...(selected ? [selectionName(selected, mode, model, stormings)] : [])].join(' › '),
        onToggle: () => panes.setTreeFolded(!panes.treeFolded),
    };

    const empty = { added: [], changed: [], removed: [] };
    const diagnostics = current?.diagnostics ?? [];
    const diff = current?.diff ?? empty;
    const problems = problemCounts(diagnostics);
    const changes = changeCount(diff);

    return (
        <I18nProvider lang={lang}>
            <KnowledgeContext.Provider value={session.messageOf ? { ...knowledge, messageOf: session.messageOf } : knowledge}>
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
                                        fold={fold}
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
                                            if (selectedFile(id)) showInspector();
                                        }}
                                        onOpen={openBest}
                                        onClose={() => setExplorerOpen(false)}
                                        fold={fold}
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
                                    {stickyActions.overlay}
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
                            stormings={stormings}
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
                                    copies={view.kind === 'storming' ? (elementId) => <CopySteps canvas={workspace.canvas} elementId={elementId} /> : undefined}
                                    // a sticky of the storming shown: shown first when the 絞り込み hides it
                                    onSelect={(x) =>
                                        view.kind === 'storming' && isStormingSelection(x) && shown && x.startsWith(`es/${shown.storming.id}/`)
                                            ? openSticky(x)
                                            : select(x)
                                    }
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
                            backTo={returnPoint?.from ?? backTo}
                            onBack={back}
                        />
                    }
                    overlays={
                        <>
                            {current && baselineAnchor && !session.baselineLocked && (
                                <BaselineMenu baseline={current.baseline} anchor={baselineAnchor} onClose={closeBaselineMenu} />
                            )}
                            <KnowledgeNotice />
                            <SearchNotice text={notice.text} />
                            {paletteOpen && (
                                <CommandPalette
                                    texts={{ label: t.search.open, placeholder: t.search.placeholder, empty: t.search.empty, more: t.search.more }}
                                    sections={searchList}
                                    onClose={() => setPaletteOpen(false)}
                                />
                            )}
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
