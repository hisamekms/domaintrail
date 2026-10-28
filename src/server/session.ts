import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { analyze } from '../core/analyze.js';
import { DEFAULT_SOURCES } from '../core/config.js';
import { loadWorkspace } from '../core/files.js';
import { buildStateGraph, buildStructureGraph } from '../graph/build.js';
import { buildContextMapGraph } from '../graph/context-map.js';
import { EMPTY_DIFF, diffModels, fingerprints, markLineChanges, type ModelDiff } from '../graph/diff.js';
import { TRANSITION_LABELS, graphSignature, type Graph, type LaidOutGraph, type StructureLevel, type TransitionLabels } from '../graph/ir.js';
import type { LayoutEngine } from '../layout/engine.js';
import { supportingContexts } from '../model/dependencies.js';
import type { DomainModel } from '../model/model.js';
import { resolveCommit, sourcesAt, type GitCommit } from './git.js';
import type { BaseView, Baseline, BaselineSpec, ViewPayload } from './protocol.js';

export const LAYOUT_FILE = path.join('.domaintrail', 'layout.json');

interface LayoutFile {
    version: 1;
    engine: string;
    engineVersion: number;
    graphs: Record<string, Pick<LaidOutGraph, 'signature' | 'nodeLayout' | 'edgeLayout'>>;
}

/**
 * Holds the state of one Live View workspace: re-analyzes on demand, keeps the last drawable
 * model while sources do not parse, computes diffs, and caches layouts (persisted separately from the DSL).
 */
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

export class ViewSession {
    private version = 0;
    private current: ViewPayload;
    private shownModel: DomainModel | undefined;
    /** The model shown before `shownModel` and its graphs: the baseline of the `previous` comparison. */
    private previousView: BaseView | null = null;
    private shownFingerprint = '';
    private modelVersion = 0;
    /** Differences between the model of `previousView` and `shownModel`. */
    private previousDiff: ModelDiff = EMPTY_DIFF;
    private lastDiff: ModelDiff = EMPTY_DIFF;
    private baselineSpec: BaselineSpec;
    private gitBase: GitBase | undefined;
    /** Commit and model the last diff was computed for, to tell when the comparison changes. */
    private comparedKey = '';
    private layouts = new Map<string, LaidOutGraph>();
    /** Layouts of the git baseline's graphs, kept apart: they have the IDs of the current ones. Not persisted. */
    private baseLayouts = new Map<string, LaidOutGraph>();
    /** Layouts of focused Structure Views (see `focusGraph`), least recently used first. */
    private readonly focusLayouts = new Map<string, LaidOutGraph>();
    private layoutsLoaded = false;
    private queue: Promise<unknown> = Promise.resolve();
    private warnedUnsafeLayoutDir = false;

    constructor(
        readonly root: string,
        private readonly engine: LayoutEngine,
        private readonly sources: readonly string[] = DEFAULT_SOURCES,
        private readonly respectGitignore = true,
        /** A git revision to compare with from the start (default: the previously shown model). */
        baseRef?: string,
    ) {
        this.baselineSpec = baseRef ? { kind: 'git', ref: baseRef } : { kind: 'previous' };
        this.current = this.payload({
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
            diagnostics: [],
        });
    }

    get state(): ViewPayload {
        return this.current;
    }

    /** Re-reads every .dt file and recomputes the view. Calls are serialized. */
    refresh(): Promise<ViewPayload> {
        return this.serialized(() => this.doRefresh());
    }

    /**
     * Compares with `spec` from now on and recomputes the view. A git ref is checked first: an unknown one is rejected
     * with `UnknownRevisionError`, and the baseline is left as it was.
     */
    setBaseline(spec: BaselineSpec): Promise<ViewPayload> {
        return this.serialized(async () => {
            if (spec.kind === 'git') await resolveCommit(this.root, spec.ref);
            this.baselineSpec = spec;
            this.gitBase = undefined;
            return this.doRefresh();
        });
    }

    private serialized<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.queue.then(fn);
        this.queue = run.catch(() => undefined);
        return run;
    }

    /**
     * Loads the git baseline when the ref now names another commit (or none). The commit is resolved on every refresh:
     * a branch moves when it is committed to.
     */
    private async syncGitBase(ref: string): Promise<GitBase> {
        let commit: GitCommit;
        try {
            commit = await resolveCommit(this.root, ref);
        } catch (e) {
            return (this.gitBase = { ref, view: null, files: 0, error: e instanceof Error ? e.message : String(e) });
        }
        if (this.gitBase?.ref === ref && this.gitBase.commit?.hash === commit.hash) return this.gitBase;
        const sources = await sourcesAt(this.root, commit.hash, this.sources);
        const analysis = await analyze(sources);
        const base: GitBase = { ref, commit, view: null, files: sources.length };
        if (!analysis.model) {
            base.error = `The sources at '${ref}' do not parse`;
            return (this.gitBase = base);
        }
        const model = analysis.model;
        this.baseLayouts.clear();
        const layout = (g: Graph) => this.layout(g, this.baseLayouts);
        base.model = model;
        base.view = {
            model,
            structure: await layout(buildStructureGraph(model)),
            overview: await layout(buildStructureGraph(model, { level: 'overview' })),
            aggregates: await layout(buildStructureGraph(model, { level: 'aggregates' })),
            contextMap: await layout(buildContextMapGraph(model)),
            contextMapAll: await layout(buildContextMapGraph(model, { all: true })),
            states: await this.stateGraphs(model, () => undefined, layout),
        };
        return (this.gitBase = base);
    }

    /** The model the current one is compared with, if there is one. */
    private baselineModel(): DomainModel | undefined {
        return (this.baselineSpec.kind === 'git' ? this.gitBase?.model : this.previousView?.model) ?? undefined;
    }

    private baseline(): Baseline {
        if (this.baselineSpec.kind === 'previous') return { kind: 'previous' };
        const b = this.gitBase;
        return { kind: 'git', ref: this.baselineSpec.ref, files: b?.files ?? 0, ...(b?.commit && { commit: b.commit }), ...(b?.error && { error: b.error }) };
    }

    /** Every aggregate's State View for each way of labeling transitions, with rows marked against `base`. */
    private async stateGraphs(
        model: DomainModel,
        base: (aggregateId: string, labels: TransitionLabels) => Graph | undefined,
        layout: (g: Graph) => Promise<LaidOutGraph>,
    ): Promise<ViewPayload['states']> {
        const states: ViewPayload['states'] = {};
        for (const el of Object.values(model.elements)) {
            if (el.kind !== 'aggregate') continue;
            const byLabels: Partial<Record<TransitionLabels, LaidOutGraph>> = {};
            for (const l of TRANSITION_LABELS) byLabels[l] = await layout(markLineChanges(buildStateGraph(el, model, l), base(el.id, l)));
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the loop above sets every label
            states[el.id] = byLabels as Record<TransitionLabels, LaidOutGraph>;
        }
        return states;
    }

    private async doRefresh(): Promise<ViewPayload> {
        await this.loadLayouts();
        const sources = await loadWorkspace(this.root, this.sources, this.respectGitignore);
        const analysis = await analyze(sources);
        const files = sources.map((s) => s.path);

        if (sources.length === 0) {
            this.current = this.payload({
                files,
                sources,
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
                diagnostics: [],
            });
            return this.current;
        }
        if (!analysis.model) {
            // Syntax error: keep the last drawable diagram, update diagnostics only.
            this.current = this.payload({
                ...this.current,
                files,
                sources,
                status: 'syntax-error',
                stale: this.current.model !== null,
                diagnostics: analysis.diagnostics,
            });
            return this.current;
        }

        const model = analysis.model;
        const fp = JSON.stringify([...fingerprints(model)]);
        if (fp !== this.shownFingerprint) {
            this.previousDiff = diffModels(this.shownModel, model);
            this.previousView = this.current.model ? pickBaseView(this.current) : null;
            this.shownModel = model;
            this.shownFingerprint = fp;
        }
        const spec = this.baselineSpec;
        const gitBase = spec.kind === 'git' ? await this.syncGitBase(spec.ref) : undefined;
        const baseModel = this.baselineModel();
        this.lastDiff = gitBase ? (gitBase.model ? diffModels(gitBase.model, model) : EMPTY_DIFF) : this.previousDiff;
        // the page redraws (and re-fetches focused views) when the model or what it is compared with changes
        const comparedKey = `${fp}|${spec.kind}|${gitBase?.commit?.hash ?? ''}`;
        if (comparedKey !== this.comparedKey) {
            this.comparedKey = comparedKey;
            this.modelVersion++;
        }

        const layout = (g: Graph) => this.layout(g);
        const structure = await layout(markLineChanges(buildStructureGraph(model), baseModel && buildStructureGraph(baseModel)));
        const focusContexts = focusableContexts(model);
        const contextMap = await layout(buildContextMapGraph(model));
        const contextMapAll = await layout(buildContextMapGraph(model, { all: true }));
        const overview = await layout(buildStructureGraph(model, { level: 'overview' }));
        const aggregates = await layout(buildStructureGraph(model, { level: 'aggregates' }));
        const baseAggregate = (id: string) => (baseModel?.elements[id]?.kind === 'aggregate' ? baseModel.elements[id] : undefined);
        const states = await this.stateGraphs(
            model,
            (id, l) => {
                const agg = baseAggregate(id);
                return agg && baseModel && buildStateGraph(agg, baseModel, l);
            },
            layout,
        );
        // Forget layouts of graphs that no longer exist (e.g. removed aggregates).
        const live = new Set([
            structure.id,
            overview.id,
            aggregates.id,
            contextMap.id,
            contextMapAll.id,
            ...Object.values(states).flatMap((byLabels) => Object.values(byLabels).map((g) => g.id)),
        ]);
        for (const id of this.layouts.keys()) if (!live.has(id)) this.layouts.delete(id);
        await this.saveLayouts();

        this.current = this.payload({
            files,
            sources,
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
            diagnostics: analysis.diagnostics,
        });
        return this.current;
    }

    private payload(
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
            | 'diagnostics'
        >,
    ): ViewPayload {
        return {
            type: 'update',
            version: ++this.version,
            updatedAt: new Date().toISOString(),
            root: this.root,
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
            diagnostics: p.diagnostics,
            modelVersion: this.modelVersion,
            diff: this.lastDiff,
            baseline: this.baseline(),
            base: this.baselineSpec.kind === 'git' ? (this.gitBase?.view ?? null) : this.previousView,
            layoutEngine: this.engine.name,
        };
    }

    /**
     * Structure View of some bounded contexts with their dependencies as stubs, laid out on request (any combination
     * of contexts can be asked for, so these are not part of the pushed state). The dependencies on and from the
     * `hidden` contexts are left out. Unknown contexts are ignored.
     */
    async focusGraph(contexts: readonly string[], level: StructureLevel, hidden: readonly string[] = []): Promise<LaidOutGraph | null> {
        const model = this.current.model;
        if (!model) return null;
        const focusable = new Set(focusableContexts(model));
        const focus = [...new Set(contexts.filter((c) => focusable.has(c)))].sort();
        if (focus.length === 0) return null;
        const opts = { focus, level, hidden: [...new Set(hidden.filter((c) => focusable.has(c)))] };
        const baseModel = this.baselineModel();
        const graph = markLineChanges(buildStructureGraph(model, opts), baseModel && buildStructureGraph(baseModel, opts));
        const signature = graphSignature(graph);
        const cached = this.focusLayouts.get(graph.id);
        if (cached && cached.signature === signature) return { ...graph, nodeLayout: cached.nodeLayout, edgeLayout: cached.edgeLayout, signature };
        const laid = await this.engine.layout(graph);
        // keep the most recently used layouts only
        this.focusLayouts.delete(graph.id);
        this.focusLayouts.set(graph.id, laid);
        if (this.focusLayouts.size > FOCUS_LAYOUT_CACHE) this.focusLayouts.delete(this.focusLayouts.keys().next().value!);
        return laid;
    }

    /** Reuses the cached layout when the graph's shape is unchanged; otherwise lays it out again. */
    private async layout(graph: Graph, cache = this.layouts): Promise<LaidOutGraph> {
        const cached = cache.get(graph.id);
        const signature = graphSignature(graph);
        if (cached && cached.signature === signature) {
            return { ...graph, nodeLayout: cached.nodeLayout, edgeLayout: cached.edgeLayout, signature };
        }
        const laid = await this.engine.layout(graph);
        cache.set(graph.id, laid);
        return laid;
    }

    private async loadLayouts(): Promise<void> {
        if (this.layoutsLoaded) return;
        this.layoutsLoaded = true;
        try {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- our own file; its version and engine are checked below, a broken one is ignored
            const file = JSON.parse(await readFile(path.join(this.root, LAYOUT_FILE), 'utf8')) as LayoutFile;
            if (file.version !== 1 || file.engine !== this.engine.name || file.engineVersion !== this.engine.version) return;
            for (const [id, g] of Object.entries(file.graphs)) {
                this.layouts.set(id, { id, nodes: [], edges: [], ...g });
            }
        } catch {
            // No layout yet, or unreadable: lay out from scratch.
        }
    }

    private async saveLayouts(): Promise<void> {
        const file: LayoutFile = { version: 1, engine: this.engine.name, engineVersion: this.engine.version, graphs: {} };
        for (const [id, g] of [...this.layouts].sort(([a], [b]) => a.localeCompare(b))) {
            file.graphs[id] = { signature: g.signature, nodeLayout: g.nodeLayout, edgeLayout: g.edgeLayout };
        }
        const target = path.join(this.root, LAYOUT_FILE);
        const dir = path.dirname(target);
        // A checked-out repository may contain `.domaintrail` (or the layout file) as a symlink; never write through it.
        const existing = await lstat(dir).catch(() => undefined);
        if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
            if (!this.warnedUnsafeLayoutDir) console.warn(`Not saving layouts: ${dir} is not a plain directory.`);
            this.warnedUnsafeLayoutDir = true;
            return;
        }
        await mkdir(dir, { recursive: true });
        // write a new file and rename it into place: rename replaces a symlinked layout.json instead of following it
        const temp = path.join(dir, `.layout-${process.pid}-${Date.now()}.tmp`);
        await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { flag: 'wx' });
        await rename(temp, target);
    }
}
