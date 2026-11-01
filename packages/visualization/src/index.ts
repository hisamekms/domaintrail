// The public surface of @domaintrail/visualization (the `.` export; ADR 0027, Dependency rules): the graphs the Live
// View draws, the view service and its ports, and the adapters an app wires. Its wire types are `./protocol`.

// ---- core: the graph IR and the projections the page draws -----------------------------------------------------
export {
    compartmentHeight,
    DISPLAY_MODES,
    INTERNAL_PADDING,
    internalRowHeight,
    STRUCTURE_LEVELS,
    TRANSITION_LABELS,
    TRANSITION_LINE_HEIGHT,
    TRANSITION_SUB_LINE_HEIGHT,
    TRANSITION_SUB_SIZE,
    transitionText,
    type DisplayMode,
    type EdgeKind,
    type GraphEdge,
    type GraphNode,
    type LaidOutGraph,
    type Lang,
    type NodeLayout,
    type StructureLevel,
    type Texts,
    type TransitionLabels,
} from './domain/graph/ir.js';
export { PRIMITIVE_LABELS, typeText } from './domain/graph/build.js';
export { dependencyCounts } from './domain/graph/context-map.js';
// the model diff (T7: Modeling's domain)
export { diffModels, type ModelDiff } from './domain/graph/diff.js';

// ---- core: the storming views (the semantic graph and the occurrences: T7, Storming's domain) -------------------
export {
    LEVEL_KINDS,
    VIEW_LEVELS,
    type EventOccurrence,
    type RenderGraph,
    type SemanticEdgeKind,
    type ViewLevel,
    type ViewOptions,
} from './domain/storming/ir.js';
export { stormingGraphId, stormingViewKey } from './domain/storming/graph.js';
export { projectView } from './domain/storming/render.js';
export { buildSemanticGraph, firstDeclarations, stormingTimelines } from './domain/storming/semantic.js';
export { timelineOccurrences } from './domain/storming/trie.js';

// ---- application: the view service and its ports ---------------------------------------------------------------
export { createViewService, type ViewService, type ViewServiceDeps } from './application/view-service.js';
export {
    UnknownRevisionError,
    type GitCommit,
    type GitRefs,
    type GitRevisions,
    type LayoutCache,
    type LayoutStore,
    type WorkspaceReader,
} from './application/ports.js';
export { type LayoutEngine, type LayoutOptions } from './application/layout-engine.js';

// ---- adapters, for the app that wires them (infrastructure/: adapters/ after T8) --------------------------------
export { ElkLayoutEngine } from './infrastructure/elk.js';
export { createFileLayoutStore } from './infrastructure/file-layout-store.js';
export { createGitRevisions } from './infrastructure/git.js';
