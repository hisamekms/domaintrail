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
    shownLabel,
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
} from './core/graph/ir.js';
export { PRIMITIVE_LABELS, typeText } from './core/graph/build.js';
export { dependencyCounts } from './core/graph/context-map.js';

// ---- core: the storming views ----------------------------------------------------------------------------------
export { LEVEL_KINDS, VIEW_LEVELS, type GridCell, type RenderGraph, type StageGrid, type ViewLevel, type ViewOptions } from './core/storming/ir.js';
export { stormingViewKey } from './core/storming/graph.js';

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

// ---- adapters, for the app that wires them ---------------------------------------------------------------------
export { ElkLayoutEngine } from './adapters/elk.js';
export { createFileLayoutStore } from './adapters/file-layout-store.js';
export { createGitRevisions } from './adapters/git.js';
