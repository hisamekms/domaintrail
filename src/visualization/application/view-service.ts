import { analyze } from '../../core/analyze.js';
import { DEFAULT_SOURCES } from '../../core/config.js';
import type { Storming, StormingAnalysis } from '../../dtes/ir.js';
import { VIEW_LEVELS, type RenderGraph, type ViewOptions } from '../domain/storming/ir.js';
import { matchRenderNodes, projectView } from '../domain/storming/render.js';
import { stormingTimelines } from '../domain/storming/semantic.js';
import { renderToGraph, stormingViewKey } from '../domain/storming/graph.js';
import { buildStateGraph, buildStructureGraph } from '../domain/graph/build.js';
import { buildContextMapGraph } from '../domain/graph/context-map.js';
import { EMPTY_DIFF, diffModels, fingerprints, markLineChanges, type ModelDiff } from '../domain/graph/diff.js';
import {
    TRANSITION_LABELS,
    graphSignature,
    type Graph,
    type LaidOutGraph,
    type Point,
    type StructureLevel,
    type TransitionLabels,
} from '../domain/graph/ir.js';
import type { LayoutEngine, LayoutOptions } from './layout-engine.js';
import { supportingContexts } from '../../model/dependencies.js';
import type { DomainModel } from '../../model/model.js';
import type { GitCommit, GitRevisions, LayoutCache, LayoutStore, WorkspaceReader } from './ports.js';
import type { BaseView, Baseline, BaselineSpec, StormingView, ViewPayload } from '../protocol.js';

/** Number of focused Structure View layouts kept in memory. */
const FOCUS_LAYOUT_CACHE = 20;

/** Contexts that can be focused in the Structure View: domain contexts with something to draw. */
export function focusableContexts(model: DomainModel): string[] {
    const supporting = supportingContexts(model);
    const drawn = new Set(['aggregate', 'entity', 'valueObject', 'union']);
    return model.contexts.filter((c) => !supporting.has(c) && Object.values(model.elements).some((e) => e.context === c && drawn.has(e.kind)));
}

const pickBaseView = ({ model, structure, overview, aggregates, contextMap, contextMapAll, states }: ViewPayload): BaseView => ({
    model,
    structure,
    overview,
    aggregates,
    contextMap,
    contextMapAll,
    states,
});

/** A git baseline as loaded: the commit, and its model with its graphs (none when its sources do not parse). */
interface GitBase {
    ref: string;
    commit?: GitCommit;
    model?: DomainModel;
    view: BaseView | null;
    files: number;
    error?: string;
}

const stormingGraphIds = (stormings: readonly StormingView[]): string[] => stormings.flatMap((s) => Object.values(s.views).map((v) => v.graph.id));

/** What a view service works with: the workspace and the adapters of its ports. */
export interface ViewServiceDeps {
    root: string;
    engine: LayoutEngine;
    /** The current sources. */
    workspace: WorkspaceReader;
    /** Where the layouts are kept between runs. */
    layoutStore: LayoutStore;
    /** The git repository around `root`, for git baselines. */
    git: GitRevisions;
    /** Globs of the sources, for those of a git baseline (default `DEFAULT_SOURCES`). */
    sources?: readonly string[];
    /** A git revision to compare with from the start (default: the previously shown model). */
    baseRef?: string;
}

/**
 * Holds the state of one Live View workspace: re-analyzes on demand, keeps the last drawable
 * model while sources do not parse, computes diffs, and caches layouts (persisted separately from the DSL).
 */
export interface ViewService {
    readonly root: string;
    /** The view last computed. */
    readonly state: ViewPayload;
    /** Re-reads every .dt file and recomputes the view. Calls are serialized. */
    refresh(): Promise<ViewPayload>;
    /**
     * Compares with `spec` from now on and recomputes the view. A git ref is checked first: an unknown one is rejected
     * with `UnknownRevisionError`, and the baseline is left as it was.
     */
    setBaseline(spec: BaselineSpec): Promise<ViewPayload>;
    /**
     * Structure View of some bounded contexts with their dependencies as stubs, laid out on request (any combination
     * of contexts can be asked for, so these are not part of the pushed state). The dependencies on and from the
     * `hidden` contexts are left out. Unknown contexts are ignored.
     */
    focusGraph(contexts: readonly string[], level: StructureLevel, hidden?: readonly string[]): Promise<LaidOutGraph | null>;
}

export function createViewService(deps: ViewServiceDeps): ViewService {
    const { root, engine, workspace, layoutStore, git } = deps;
    const sources = deps.sources ?? DEFAULT_SOURCES;
    let version = 0;
    let shownModel: DomainModel | undefined;
    /** The model shown before `shownModel` and its graphs: the baseline of the `previous` comparison. */
    let previousView: BaseView | null = null;
    let shownFingerprint = '';
    let modelVersion = 0;
    /** Differences between the model of `previousView` and `shownModel`. */
    let previousDiff: ModelDiff = EMPTY_DIFF;
    let lastDiff: ModelDiff = EMPTY_DIFF;
    let baselineSpec: BaselineSpec = deps.baseRef ? { kind: 'git', ref: deps.baseRef } : { kind: 'previous' };
    let gitBase: GitBase | undefined;
    /** Commit and model the last diff was computed for, to tell when the comparison changes. */
    let comparedKey = '';
    const layouts: LayoutCache = new Map();
    /** Layouts of the git baseline's graphs, kept apart: they have the IDs of the current ones. Not persisted. */
    const baseLayouts: LayoutCache = new Map();
    /** Layouts of focused Structure Views (see `focusGraph`), least recently used first. */
    const focusLayouts: LayoutCache = new Map();
    let layoutsLoaded = false;
    /** The stormings last parsed from each `.dtes` file: kept, as stale, while it does not parse. */
    let stormingsByFile = new Map<string, Storming[]>();
    /** The render graph each storming graph was laid out for, to pair its nodes with the next one's (`matchRenderNodes`). */
    const renders = new Map<string, RenderGraph>();
    let queue: Promise<unknown> = Promise.resolve();

    const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
        const run = queue.then(fn);
        queue = run.catch(() => undefined);
        return run;
    };

    /**
     * Reuses the cached layout when the graph's shape is unchanged; otherwise lays it out again, with the `incremental`
     * options derived from the cached layout, if any.
     */
    const layout = async (graph: Graph, cache = layouts, incremental?: (cached: LaidOutGraph) => LayoutOptions): Promise<LaidOutGraph> => {
        const cached = cache.get(graph.id);
        const signature = graphSignature(graph);
        if (cached && cached.signature === signature) {
            return { ...graph, nodeLayout: cached.nodeLayout, edgeLayout: cached.edgeLayout, signature };
        }
        const laid = await engine.layout(graph, cached && incremental ? incremental(cached) : {});
        cache.set(graph.id, laid);
        return laid;
    };

    const loadLayouts = async (): Promise<void> => {
        if (layoutsLoaded) return;
        layoutsLoaded = true;
        for (const [id, g] of await layoutStore.load(engine)) layouts.set(id, g);
    };

    /** Every aggregate's State View for each way of labeling transitions, with rows marked against `base`. */
    const stateGraphs = async (
        model: DomainModel,
        base: (aggregateId: string, labels: TransitionLabels) => Graph | undefined,
        layoutGraph: (g: Graph) => Promise<LaidOutGraph>,
    ): Promise<ViewPayload['states']> => {
        const states: ViewPayload['states'] = {};
        for (const el of Object.values(model.elements)) {
            if (el.kind !== 'aggregate') continue;
            const byLabels: Partial<Record<TransitionLabels, LaidOutGraph>> = {};
            for (const l of TRANSITION_LABELS) byLabels[l] = await layoutGraph(markLineChanges(buildStateGraph(el, model, l), base(el.id, l)));
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the loop above sets every label
            states[el.id] = byLabels as Record<TransitionLabels, LaidOutGraph>;
        }
        return states;
    };

    /**
     * Loads the git baseline when the ref now names another commit (or none). The commit is resolved on every refresh:
     * a branch moves when it is committed to.
     */
    const syncGitBase = async (ref: string): Promise<GitBase> => {
        let commit: GitCommit;
        try {
            commit = await git.resolveCommit(ref);
        } catch (e) {
            return (gitBase = { ref, view: null, files: 0, error: e instanceof Error ? e.message : String(e) });
        }
        if (gitBase?.ref === ref && gitBase.commit?.hash === commit.hash) return gitBase;
        const files = await git.sourcesAt(commit.hash, sources);
        const analysis = await analyze(files);
        const base: GitBase = { ref, commit, view: null, files: files.length };
        if (!analysis.model) {
            base.error = `The sources at '${ref}' do not parse`;
            return (gitBase = base);
        }
        const model = analysis.model;
        baseLayouts.clear();
        const layoutBase = (g: Graph): Promise<LaidOutGraph> => layout(g, baseLayouts);
        base.model = model;
        base.view = {
            model,
            structure: await layoutBase(buildStructureGraph(model)),
            overview: await layoutBase(buildStructureGraph(model, { level: 'overview' })),
            aggregates: await layoutBase(buildStructureGraph(model, { level: 'aggregates' })),
            contextMap: await layoutBase(buildContextMapGraph(model)),
            contextMapAll: await layoutBase(buildContextMapGraph(model, { all: true })),
            states: await stateGraphs(model, () => undefined, layoutBase),
        };
        return (gitBase = base);
    };

    /** The model the current one is compared with, if there is one. */
    const baselineModel = (): DomainModel | undefined => (baselineSpec.kind === 'git' ? gitBase?.model : previousView?.model) ?? undefined;

    const baseline = (): Baseline => {
        if (baselineSpec.kind === 'previous') return { kind: 'previous' };
        const b = gitBase;
        return { kind: 'git', ref: baselineSpec.ref, files: b?.files ?? 0, ...(b?.commit && { commit: b.commit }), ...(b?.error && { error: b.error }) };
    };

    const payload = (
        p: Pick<
            ViewPayload,
            | 'files'
            | 'sources'
            | 'status'
            | 'stale'
            | 'model'
            | 'structure'
            | 'overview'
            | 'aggregates'
            | 'states'
            | 'focusContexts'
            | 'contextMap'
            | 'contextMapAll'
            | 'stormings'
            | 'diagnostics'
        >,
    ): ViewPayload => ({
        type: 'update',
        version: ++version,
        updatedAt: new Date().toISOString(),
        root,
        files: p.files,
        sources: p.sources,
        status: p.status,
        stale: p.stale,
        model: p.model,
        structure: p.structure,
        overview: p.overview,
        aggregates: p.aggregates,
        states: p.states,
        focusContexts: p.focusContexts,
        contextMap: p.contextMap,
        contextMapAll: p.contextMapAll,
        stormings: p.stormings,
        diagnostics: p.diagnostics,
        modelVersion,
        diff: lastDiff,
        baseline: baseline(),
        base: baselineSpec.kind === 'git' ? (gitBase?.view ?? null) : previousView,
        layoutEngine: engine.name,
    });

    let current: ViewPayload = payload({
        files: [],
        sources: [],
        status: 'empty',
        stale: false,
        model: null,
        structure: null,
        overview: null,
        aggregates: null,
        states: {},
        focusContexts: [],
        contextMap: null,
        contextMapAll: null,
        stormings: [],
        diagnostics: [],
    });

    /**
     * Lays out a storming view. A changed one is laid out incrementally: the nodes paired with the previous render graph's
     * (`matchRenderNodes`, spec §10.3) keep their order within their layer; the others are placed anew.
     */
    const layoutStorming = (render: RenderGraph, storming: Storming): Promise<LaidOutGraph> => {
        const graph = renderToGraph(render, storming);
        const previous = renders.get(graph.id);
        renders.set(graph.id, render);
        return layout(graph, layouts, (cached) => {
            if (!previous) return {};
            const positions: Record<string, Point> = {};
            // the integrated view's notes are one per element (`renderToGraph`): the same ID is the same note
            for (const n of graph.nodes) {
                const at = cached.nodeLayout[n.id];
                if (at) positions[n.id] = { x: at.x, y: at.y };
            }
            for (const [next, prev] of matchRenderNodes(previous, render)) {
                const at = cached.nodeLayout[prev];
                if (at) positions[next] = { x: at.x, y: at.y };
            }
            return { positions };
        });
    };

    /**
     * Every view of every storming, laid out (ADR 0024). A file that does not parse keeps the stormings it last had, as
     * stale. Of two stormings with one ID (S001), the first is shown.
     */
    const stormingViews = async (analysis: StormingAnalysis): Promise<StormingView[]> => {
        const broken = new Set(analysis.diagnostics.filter((d) => d.code === 'SYNTAX').map((d) => d.file));
        const parsed = new Map<string, Storming[]>();
        for (const s of analysis.stormings) parsed.set(s.range.file, [...(parsed.get(s.range.file) ?? []), s]);
        const byFile = new Map<string, Storming[]>();
        for (const file of analysis.files) {
            const list = broken.has(file) ? stormingsByFile.get(file) : parsed.get(file);
            if (list) byFile.set(file, list);
        }
        stormingsByFile = byFile;

        const views: StormingView[] = [];
        const ids = new Set<string>();
        for (const [file, list] of byFile) {
            for (const storming of list) {
                if (ids.has(storming.id)) continue;
                ids.add(storming.id);
                const timelines = stormingTimelines(storming).map((t) => ({ id: t.id, ...(t.label !== undefined && { label: t.label }) }));
                const byKey: StormingView['views'] = {};
                for (const level of VIEW_LEVELS) {
                    for (const timelineId of [undefined, ...timelines.map((t) => t.id)]) {
                        const options: ViewOptions = timelineId === undefined ? { level } : { level, timelineId };
                        const render = projectView(storming, options);
                        byKey[stormingViewKey(options)] = { render, graph: await layoutStorming(render, storming) };
                    }
                }
                views.push({
                    id: storming.id,
                    ...(storming.label !== undefined && { label: storming.label }),
                    file,
                    timelines,
                    storming,
                    views: byKey,
                    stale: broken.has(file),
                });
            }
        }
        return views;
    };

    /** Drops the layouts of storming graphs other than `keep` (the `.dt` graphs are kept while the sources do not parse). */
    const forgetLayouts = (keep: readonly string[]): void => {
        const live = new Set(keep);
        for (const id of [...layouts.keys(), ...renders.keys()]) {
            if (id.startsWith('storming:') && !live.has(id)) {
                layouts.delete(id);
                renders.delete(id);
            }
        }
    };

    const doRefresh = async (): Promise<ViewPayload> => {
        await loadLayouts();
        const read = [...(await workspace.readSources())];
        const analysis = await analyze(read);
        const files = read.map((s) => s.path);
        const stormings = await stormingViews(analysis.stormings);

        if (read.length === 0) {
            current = payload({
                files,
                sources: read,
                status: 'empty',
                stale: false,
                model: null,
                structure: null,
                overview: null,
                aggregates: null,
                states: {},
                focusContexts: [],
                contextMap: null,
                contextMapAll: null,
                stormings,
                diagnostics: [],
            });
            return current;
        }
        if (!analysis.model) {
            forgetLayouts(stormingGraphIds(stormings));
            // Syntax error: keep the last drawable diagram, update diagnostics only.
            current = payload({
                ...current,
                files,
                sources: read,
                status: 'syntax-error',
                stale: current.model !== null,
                stormings,
                diagnostics: analysis.diagnostics,
            });
            return current;
        }

        const model = analysis.model;
        const fp = JSON.stringify([...fingerprints(model)]);
        if (fp !== shownFingerprint) {
            previousDiff = diffModels(shownModel, model);
            previousView = current.model ? pickBaseView(current) : null;
            shownModel = model;
            shownFingerprint = fp;
        }
        const spec = baselineSpec;
        const base = spec.kind === 'git' ? await syncGitBase(spec.ref) : undefined;
        const baseModel = baselineModel();
        lastDiff = base ? (base.model ? diffModels(base.model, model) : EMPTY_DIFF) : previousDiff;
        // the page redraws (and re-fetches focused views) when the model or what it is compared with changes
        const key = `${fp}|${spec.kind}|${base?.commit?.hash ?? ''}`;
        if (key !== comparedKey) {
            comparedKey = key;
            modelVersion++;
        }

        const layoutCurrent = (g: Graph): Promise<LaidOutGraph> => layout(g);
        const structure = await layoutCurrent(markLineChanges(buildStructureGraph(model), baseModel && buildStructureGraph(baseModel)));
        const focusContexts = focusableContexts(model);
        const contextMap = await layoutCurrent(buildContextMapGraph(model));
        const contextMapAll = await layoutCurrent(buildContextMapGraph(model, { all: true }));
        const overview = await layoutCurrent(buildStructureGraph(model, { level: 'overview' }));
        const aggregates = await layoutCurrent(buildStructureGraph(model, { level: 'aggregates' }));
        const baseAggregate = (id: string) => (baseModel?.elements[id]?.kind === 'aggregate' ? baseModel.elements[id] : undefined);
        const states = await stateGraphs(
            model,
            (id, l) => {
                const agg = baseAggregate(id);
                return agg && baseModel && buildStateGraph(agg, baseModel, l);
            },
            layoutCurrent,
        );
        // Forget layouts of graphs that no longer exist (e.g. removed aggregates).
        const live = new Set([
            structure.id,
            overview.id,
            aggregates.id,
            contextMap.id,
            contextMapAll.id,
            ...Object.values(states).flatMap((byLabels) => Object.values(byLabels).map((g) => g.id)),
            ...stormingGraphIds(stormings),
        ]);
        for (const id of layouts.keys()) if (!live.has(id)) layouts.delete(id);
        for (const id of renders.keys()) if (!live.has(id)) renders.delete(id);
        await layoutStore.save(engine, layouts);

        current = payload({
            files,
            sources: read,
            status: analysis.ok ? 'ok' : 'invalid',
            stale: false,
            model,
            structure,
            overview,
            aggregates,
            states,
            focusContexts,
            contextMap,
            contextMapAll,
            stormings,
            diagnostics: analysis.diagnostics,
        });
        return current;
    };

    return {
        root,
        get state(): ViewPayload {
            return current;
        },

        refresh(): Promise<ViewPayload> {
            return serialized(() => doRefresh());
        },

        setBaseline(spec: BaselineSpec): Promise<ViewPayload> {
            return serialized(async () => {
                if (spec.kind === 'git') await git.resolveCommit(spec.ref);
                baselineSpec = spec;
                gitBase = undefined;
                return doRefresh();
            });
        },

        async focusGraph(contexts: readonly string[], level: StructureLevel, hidden: readonly string[] = []): Promise<LaidOutGraph | null> {
            const model = current.model;
            if (!model) return null;
            const focusable = new Set(focusableContexts(model));
            const focus = [...new Set(contexts.filter((c) => focusable.has(c)))].sort();
            if (focus.length === 0) return null;
            const opts = { focus, level, hidden: [...new Set(hidden.filter((c) => focusable.has(c)))] };
            const baseModel = baselineModel();
            const graph = markLineChanges(buildStructureGraph(model, opts), baseModel && buildStructureGraph(baseModel, opts));
            const signature = graphSignature(graph);
            const cached = focusLayouts.get(graph.id);
            if (cached && cached.signature === signature) return { ...graph, nodeLayout: cached.nodeLayout, edgeLayout: cached.edgeLayout, signature };
            const laid = await engine.layout(graph);
            // keep the most recently used layouts only
            focusLayouts.delete(graph.id);
            focusLayouts.set(graph.id, laid);
            if (focusLayouts.size > FOCUS_LAYOUT_CACHE) focusLayouts.delete(focusLayouts.keys().next().value!);
            return laid;
        },
    };
}
