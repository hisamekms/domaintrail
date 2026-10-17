import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { analyze } from '../core/analyze.js';
import { DEFAULT_SOURCES } from '../core/config.js';
import { loadWorkspace } from '../core/files.js';
import { buildStateGraph, buildStructureGraph } from '../graph/build.js';
import { EMPTY_DIFF, diffModels, fingerprints, type ModelDiff } from '../graph/diff.js';
import { graphSignature, type Graph, type LaidOutGraph } from '../graph/ir.js';
import type { LayoutEngine } from '../layout/engine.js';
import type { DomainModel } from '../model/model.js';
import type { ViewPayload } from './protocol.js';

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
export class ViewSession {
    private version = 0;
    private current: ViewPayload;
    private shownModel: DomainModel | undefined;
    private shownFingerprint = '';
    private modelVersion = 0;
    private lastDiff: ModelDiff = EMPTY_DIFF;
    private layouts = new Map<string, LaidOutGraph>();
    private layoutsLoaded = false;
    private queue: Promise<unknown> = Promise.resolve();
    private warnedUnsafeLayoutDir = false;

    constructor(
        readonly root: string,
        private readonly engine: LayoutEngine,
        private readonly sources: readonly string[] = DEFAULT_SOURCES,
    ) {
        this.current = this.payload({ files: [], sources: [], status: 'empty', stale: false, model: null, structure: null, overview: null, states: {}, diagnostics: [] });
    }

    get state(): ViewPayload {
        return this.current;
    }

    /** Re-reads every .dt file and recomputes the view. Calls are serialized. */
    refresh(): Promise<ViewPayload> {
        const run = this.queue.then(() => this.doRefresh());
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async doRefresh(): Promise<ViewPayload> {
        await this.loadLayouts();
        const sources = await loadWorkspace(this.root, this.sources);
        const analysis = await analyze(sources);
        const files = sources.map((s) => s.path);

        if (sources.length === 0) {
            this.current = this.payload({ files, sources, status: 'empty', stale: false, model: null, structure: null, overview: null, states: {}, diagnostics: [] });
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
            this.lastDiff = diffModels(this.shownModel, model);
            this.shownModel = model;
            this.shownFingerprint = fp;
            this.modelVersion++;
        }

        const structure = await this.layout(buildStructureGraph(model));
        const overview = await this.layout(buildStructureGraph(model, { overview: true }));
        const states: Record<string, LaidOutGraph> = {};
        for (const el of Object.values(model.elements)) {
            if (el.kind === 'aggregate') states[el.id] = await this.layout(buildStateGraph(el, model));
        }
        // Forget layouts of graphs that no longer exist (e.g. removed aggregates).
        const live = new Set([structure.id, overview.id, ...Object.values(states).map((g) => g.id)]);
        for (const id of [...this.layouts.keys()]) if (!live.has(id)) this.layouts.delete(id);
        await this.saveLayouts();

        this.current = this.payload({
            files,
            sources,
            status: analysis.ok ? 'ok' : 'invalid',
            stale: false,
            model,
            structure,
            overview,
            states,
            diagnostics: analysis.diagnostics,
        });
        return this.current;
    }

    private payload(p: Pick<ViewPayload, 'files' | 'sources' | 'status' | 'stale' | 'model' | 'structure' | 'overview' | 'states' | 'diagnostics'>): ViewPayload {
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
            states: p.states,
            diagnostics: p.diagnostics,
            modelVersion: this.modelVersion,
            diff: this.lastDiff,
            layoutEngine: this.engine.name,
        };
    }

    /** Reuses the cached layout when the graph's shape is unchanged; otherwise lays it out again. */
    private async layout(graph: Graph): Promise<LaidOutGraph> {
        const cached = this.layouts.get(graph.id);
        const signature = graphSignature(graph);
        if (cached && cached.signature === signature) {
            return { ...graph, nodeLayout: cached.nodeLayout, edgeLayout: cached.edgeLayout, signature };
        }
        const laid = await this.engine.layout(graph);
        this.layouts.set(graph.id, laid);
        return laid;
    }

    private async loadLayouts(): Promise<void> {
        if (this.layoutsLoaded) return;
        this.layoutsLoaded = true;
        try {
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
