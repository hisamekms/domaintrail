// The read-only page of the knowledge store's Worker (ADR 0031, section 11): for the business's readers, at any time,
// the canvas of a published storming with the knowledge marks, a sticky's items in the detail, the ナレッジ list with its
// search and filters, the items about stickies missing from the drawing apart, and the date of the drawing. It is the
// Live View's canvas and knowledge panels in a read-only mode: nothing of the drawing changes here; the knowledge is
// corrected and deleted as in a session (section 7), with 元に戻す. There is no session: no chat, no hotspot request.
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Microscope, PanelLeftOpen, Telescope, X, type LucideIcon } from 'lucide-react';
import type { MissingStickies, PublishedEntry, PublishedLevel, PublishedStorming } from '@domaintrail/knowledge';
import { PUBLISHED_LEVELS } from '@domaintrail/knowledge';
import { BrandLogo } from '../app/brand';
import { usePreferences } from '../app/preferences';
import { I18nProvider, useLang, useT } from '../i18n';
import { KnowledgeApiContext } from '../knowledge/api';
import { marksOf, selectionOfSticky, stickyOfSelection, type StickyMark } from '../knowledge/model';
import { ItemRow, KnowledgeList, KnowledgeMarks, KnowledgeNotice, StickyKnowledge } from '../knowledge/panel';
import { KnowledgeContext, useDeletion, type KnowledgeView } from '../knowledge/useKnowledge';
import { buildScene } from '../render';
import { applyTheme } from '../theme';
import { Tooltips } from '../tooltip';
import { fitAll, showItem } from '../view/canvas';
import { CanvasControls } from '../view/canvas-controls';
import { useCanvasValue, type DiagramCanvas } from '../view/diagram';
import { FlowCanvas } from '../view/flow-canvas';
import { selectedElement } from '../view/navigation';
import { LevelSwitch, SubjectName, SubjectPicker } from '../view/toolbar';
import { publishedApi, workerKnowledgeApi } from './api';
import { drawingDate, drawingOf, locationOf, searchOf, shownStorming, stickyNames, type PageLocation } from './model';

const LEVEL_ICONS: Record<PublishedLevel, LucideIcon> = { 'big-picture': Telescope, 'design-level': Microscope };
const NO_DIFF = { added: [], changed: [], removed: [] };
const failure = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Where the page is: its query, kept in the address bar so that a link opens the same view. */
function useLocation(): [PageLocation, (next: PageLocation) => void] {
    const [where, setWhere] = useState(() => locationOf(location.search));
    useEffect(() => {
        const onPop = (): void => setWhere(locationOf(location.search));
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);
    const go = useCallback((next: PageLocation) => {
        history.pushState(null, '', `${location.pathname}${searchOf(next)}`);
        setWhere(next);
    }, []);
    return [where, go];
}

export function PublishedPage(): ReactElement {
    const prefs = usePreferences();
    return (
        <I18nProvider lang={prefs.lang}>
            <Page theme={prefs.theme} mode={prefs.mode} />
        </I18nProvider>
    );
}

function Page({ theme, mode }: { theme: 'light' | 'dark'; mode: ReturnType<typeof usePreferences>['mode'] }): ReactElement {
    const all = useT();
    const t = all.published;
    const lang = useLang();
    const [where, go] = useLocation();
    const [projects, setProjects] = useState<readonly string[] | undefined>();
    const [entries, setEntries] = useState<readonly PublishedEntry[] | undefined>();
    const [forms, setForms] = useState<ReadonlyMap<string, PublishedStorming>>(new Map());
    const [loadError, setLoadError] = useState<string | undefined>();
    const [canvas, setCanvas] = useState<DiagramCanvas | null>(null);
    const [listOpen, setListOpen] = useState(true);

    // the projects, and the one to show: asked for, else the only one
    useEffect(() => {
        publishedApi.projects().then(setProjects, (e: unknown) => setLoadError(failure(e)));
    }, []);
    const project = where.project ?? (projects?.length === 1 ? projects[0] : undefined);
    const api = useMemo(() => (project ? workerKnowledgeApi(project) : undefined), [project]);
    const projectName = project ?? '';

    useEffect(() => {
        if (!project) return;
        let stale = false;
        setEntries(undefined);
        publishedApi.list(project).then(
            (list) => !stale && setEntries(list),
            (e: unknown) => !stale && setLoadError(failure(e)),
        );
        return () => {
            stale = true;
        };
    }, [project]);
    const storming = entries ? shownStorming(entries, where.storming) : undefined;
    // every published storming of the project: the one shown, and the names of the stickies the knowledge is about
    useEffect(() => {
        if (!project || !entries) return;
        let stale = false;
        Promise.all(entries.map((e) => publishedApi.storming(project, e.storming))).then(
            (all) => !stale && setForms(new Map(all.map((f) => [f.storming, f]))),
            (e: unknown) => !stale && setLoadError(failure(e)),
        );
        return () => {
            stale = true;
        };
    }, [project, entries]);
    const shown = storming ? forms.get(storming) : undefined;
    const allForms = useMemo(() => [...forms.values()], [forms]);

    // the drawing on the canvas, in the page's theme; fitted whole when another one is shown
    const level = where.level;
    const drawing = useMemo((): { graph?: ReturnType<typeof drawingOf>; error?: string } => {
        if (!shown) return {};
        try {
            return { graph: drawingOf(shown, level) };
        } catch (e) {
            return { error: failure(e) };
        }
    }, [shown, level]);
    const graph = drawing.graph;
    const shownError = loadError ?? drawing.error;
    useEffect(() => applyTheme(theme, canvas), [theme, canvas]);
    useEffect(() => {
        if (!canvas || !graph) return;
        canvas.show(buildScene(graph, { diff: NO_DIFF, diagnostics: [], mode, lang }));
    }, [canvas, graph, mode, lang]);
    useEffect(() => {
        if (canvas && graph) fitAll(canvas, graph);
    }, [canvas, graph]);

    const knowledge = usePageKnowledge({
        api,
        storming,
        forms: allForms,
        mode,
        canvas,
        level,
        show: (s, l) => go({ ...where, project: projectName, storming: s, level: l }),
    });
    const selectedSticky = stickyOfSelection(useCanvasValue(canvas, selectedElement, []));

    return (
        <div className="app published-page">
            <header className="app-bar">
                <span className="app-bar-brand">
                    <BrandLogo />
                    <span className="brand">DomainTrail</span>
                    {projects && projects.length > 1 ? (
                        <SubjectPicker
                            label={t.project}
                            value={projectName}
                            options={projects.map((p) => ({ value: p, label: p }))}
                            onChange={(p) => go({ project: p, level })}
                        />
                    ) : (
                        project && <span className="workspace-name">{project}</span>
                    )}
                </span>
                {entries && entries.length > 0 && storming && (
                    <nav className="published-subject" aria-label={t.storming}>
                        {entries.length > 1 ? (
                            <SubjectPicker
                                label={t.storming}
                                value={storming}
                                options={entries.map((e) => ({ value: e.storming, label: e.label ?? e.storming }))}
                                onChange={(s) => go({ ...where, project: projectName, storming: s })}
                            />
                        ) : (
                            <SubjectName label={t.storming} text={entries[0]?.label ?? storming} />
                        )}
                        <LevelSwitch
                            label={all.stormingLevel}
                            levels={PUBLISHED_LEVELS}
                            value={level}
                            icons={LEVEL_ICONS}
                            names={(l) => ({ label: all.stormingLevels[l].label, tooltip: `${all.stormingLevels[l].label} — ${all.stormingLevels[l].hint}` })}
                            onChange={(l) => go({ ...where, project: projectName, level: l })}
                        />
                        {shown && (
                            <span className="published-drawn" data-tooltip={t.drawnHint}>
                                {t.drawn(drawingDate(shown.drawing, lang))}
                            </span>
                        )}
                    </nav>
                )}
                <span className="app-bar-space" />
            </header>
            {api && knowledge ? (
                <KnowledgeApiContext.Provider value={api}>
                    <KnowledgeContext.Provider value={knowledge}>
                        <div className="app-body published-body">
                            {listOpen ? (
                                <aside className="published-list">
                                    <KnowledgeList onClose={() => setListOpen(false)} closeLabel={t.closeList} />
                                    <MissingList project={projectName} version={knowledge.version} />
                                </aside>
                            ) : (
                                <button
                                    type="button"
                                    className="icon-button published-list-open"
                                    aria-label={t.openList}
                                    data-tooltip={t.openList}
                                    onClick={() => setListOpen(true)}
                                >
                                    <PanelLeftOpen size={16} aria-hidden />
                                </button>
                            )}
                            <section className="center">
                                <div className={`view-area${graph ? ' drawn' : ''}`}>
                                    <FlowCanvas onMount={setCanvas} />
                                    <KnowledgeMarks canvas={canvas} />
                                    {graph && <CanvasControls canvas={canvas} fitAll={() => canvas && fitAll(canvas, graph, true)} legend={null} keys />}
                                    {entries?.length === 0 && <div className="empty">{t.noStormings}</div>}
                                </div>
                            </section>
                            <aside className="published-detail">
                                {selectedSticky ? (
                                    <div className="inspector">
                                        <div className="inspector-head published-detail-head">
                                            <h2>{knowledge.label(selectedSticky)}</h2>
                                            <button
                                                type="button"
                                                className="icon-button"
                                                aria-label={t.closeDetail}
                                                data-tooltip={t.closeDetail}
                                                onClick={() => canvas?.selectNone()}
                                            >
                                                <X size={16} aria-hidden />
                                            </button>
                                        </div>
                                        <div className="inspector-body">
                                            <StickyKnowledge key={selectedSticky} sticky={selectedSticky} />
                                        </div>
                                    </div>
                                ) : (
                                    <p className="muted published-pick">{t.pick}</p>
                                )}
                            </aside>
                        </div>
                        <KnowledgeNotice />
                    </KnowledgeContext.Provider>
                </KnowledgeApiContext.Provider>
            ) : (
                <div className="app-body published-body">
                    <div className="empty">{shownError ? t.failed(shownError) : projects?.length === 0 ? t.noProjects : null}</div>
                </div>
            )}
            {shownError && api && (
                <div className="knowledge-notice knowledge-notice-error" role="alert">
                    {t.failed(shownError)}
                </div>
            )}
            <Tooltips />
        </div>
    );
}

/**
 * The page's knowledge (the panels' `KnowledgeView`): the marks of the storming shown, the stickies an opened item lights
 * up, deleting with 元に戻す, and selecting a sticky on the canvas (at the Design Level when the Big Picture does not
 * draw it).
 */
function usePageKnowledge(input: {
    readonly api: ReturnType<typeof workerKnowledgeApi> | undefined;
    readonly storming: string | undefined;
    readonly forms: readonly PublishedStorming[];
    readonly mode: ReturnType<typeof usePreferences>['mode'];
    readonly canvas: DiagramCanvas | null;
    readonly level: PublishedLevel;
    /** Shows another storming or level. */
    readonly show: (storming: string, level: PublishedLevel) => void;
}): KnowledgeView | undefined {
    const { api, storming, forms, mode, canvas, level, show } = input;
    const [version, setVersion] = useState(0);
    const [marks, setMarks] = useState<ReadonlyMap<string, StickyMark>>(new Map());
    const [lit, setLitState] = useState<readonly string[]>([]);
    const [error, setError] = useState<string | undefined>();
    const [pending, setPending] = useState<string | undefined>();
    const changed = useCallback(() => setVersion((v) => v + 1), []);
    const deletion = useDeletion(api ?? { delete: () => Promise.reject(new Error('no project')), restore: () => Promise.reject(new Error('no project')) }, {
        changed,
        deleted: () => setLitState([]),
        failed: (e) => setError(failure(e)),
    });

    useEffect(() => {
        if (!api || !storming) return;
        let stale = false;
        api.counts(storming).then(
            (counts) => !stale && setMarks(marksOf(counts)),
            (e: unknown) => !stale && setError(failure(e)),
        );
        return () => {
            stale = true;
        };
    }, [api, storming, version]);

    // a sticky asked for that the level shown does not draw: selected once the Design Level is drawn
    const drawn = useCanvasValue(canvas, (c) => (pending && c ? c.findElement(selectionOfSticky(pending)) : undefined), [pending]);
    useEffect(() => {
        if (!canvas || !drawn) return;
        showItem(canvas, drawn);
        setPending(undefined);
    }, [canvas, drawn]);

    const label = useMemo(() => stickyNames(forms, mode), [forms, mode]);
    const setLit = useCallback((stickies: readonly string[]) => setLitState((old) => (old.join() === stickies.join() ? old : stickies)), []);
    if (!api) return undefined;
    return {
        available: true,
        version,
        marks,
        lit,
        setLit,
        undoable: deletion.undoable,
        remove: deletion.remove,
        undo: deletion.undo,
        changed,
        label,
        select(sticky) {
            if (!canvas) return;
            const item = canvas.findElement(selectionOfSticky(sticky));
            if (item) return showItem(canvas, item);
            // another storming's sticky, or one the Big Picture does not draw: shown once its drawing is
            const owner = forms.find((f) => f.stickies.some((s) => s.ref === sticky));
            if (!owner) return;
            const element = selectionOfSticky(sticky);
            const drawsIt = (l: PublishedLevel): boolean => {
                try {
                    return drawingOf(owner, l).nodes.some((n) => n.elementId === element);
                } catch {
                    return false;
                }
            };
            setPending(sticky);
            show(owner.storming, drawsIt(level) ? level : 'design-level');
        },
        extraction: undefined,
        setExtraction: async () => {},
        error,
        setError,
    };
}

/** The items about stickies that no published storming has, apart from the list (ADR 0031, section 11). */
function MissingList({ project, version }: { project: string; version: number }): ReactElement | null {
    const t = useT().published;
    const [missing, setMissing] = useState<MissingStickies | undefined>();
    const [opened, setOpened] = useState<string | undefined>();
    useEffect(() => {
        let stale = false;
        publishedApi.missing(project).then(
            (m) => !stale && setMissing(m),
            () => undefined,
        );
        return () => {
            stale = true;
        };
    }, [project, version]);
    if (!missing || missing.items.length === 0) return null;
    return (
        <section className="published-missing" aria-label={t.missing}>
            <div className="list-head">
                <span className="list-title" data-tooltip={t.missingHint}>
                    {t.missing}
                </span>
                <span className="published-missing-refs">{missing.stickies.join('、')}</span>
            </div>
            <ul className="knowledge-items">
                {missing.items.map((i) => (
                    <ItemRow key={i.id} item={i} from={undefined} open={opened === i.id} onToggle={() => setOpened((o) => (o === i.id ? undefined : i.id))} />
                ))}
            </ul>
        </section>
    );
}
