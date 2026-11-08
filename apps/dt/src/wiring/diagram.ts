// The Live View's diagrams of a workspace without a server (`dt export svg`): the view service over the workspace's
// sources, with nothing saved and no git, laid out from scratch every time.
import { sourceSelection } from '@domaintrail/analysis';
import { createViewService, ElkLayoutEngine, type GitRevisions, type LayoutStore } from '@domaintrail/visualization';
import { createWorkspaceReader } from '@domaintrail/workspace';
import type { DiagramViews, SourcesExportOptions } from '../cli/ports.js';

/** No layouts kept: every graph is laid out anew, the same way for the same sources. */
const NO_LAYOUTS: LayoutStore = { load: async () => new Map(), save: async () => {} };

/** No baseline: nothing is marked as changed. */
const NO_GIT: GitRevisions = {
    resolveCommit: (ref) => Promise.reject(new Error(`no git baseline here: ${ref}`)),
    sourcesAt: async () => [],
    listRefs: async () => ({ branches: [], tags: [], commits: [] }),
    gitDirs: async () => undefined,
};

/** Reads the workspace's sources and lays out every view of it, as the Live View does when it starts. */
export async function loadDiagramViews({ root, sources, respectGitignore }: SourcesExportOptions): Promise<DiagramViews> {
    const engine = new ElkLayoutEngine();
    try {
        const view = createViewService({
            root,
            engine,
            workspace: createWorkspaceReader(root, sourceSelection(sources, respectGitignore)),
            layoutStore: NO_LAYOUTS,
            git: NO_GIT,
            sources,
        });
        const payload = await view.refresh();
        return { payload, focusGraph: (contexts, level) => view.focusGraph(contexts, level), dispose: () => engine.dispose() };
    } catch (e) {
        engine.dispose();
        throw e;
    }
}
