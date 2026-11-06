// The public surface of @domaintrail/visualization (the `.` export; ADR 0027, Dependency rules): the graphs the Live
// View draws, the view service and its ports, and the adapters an app wires. Its wire types are `./protocol`.

// ---- core: the graph IR and the projections the page draws -----------------------------------------------------
export {
    compartmentHeight,
    DISPLAY_MODES,
    INTERNAL_PADDING,
    internalRowHeight,
    isUndirectedEdge,
    LAYOUT_SPACINGS,
    STRUCTURE_LEVELS,
    TRANSITION_LABELS,
    TRANSITION_LINE_HEIGHT,
    TRANSITION_SUB_LINE_HEIGHT,
    TRANSITION_SUB_SIZE,
    transitionText,
    shownLabel,
    type DisplayMode,
    type EdgeKind,
    type EdgeRelation,
    type GraphEdge,
    type GraphNode,
    type LaidOutGraph,
    type Lang,
    type LayoutSpacing,
    type LineRelation,
    type NodeLayout,
    type StructureLevel,
    type Texts,
    type TransitionLabels,
} from './core/graph/ir.js';
export { PRIMITIVE_LABELS, typeText } from './core/graph/build.js';
export { dependencyCounts } from './core/graph/context-map.js';

// ---- core: the storming views ----------------------------------------------------------------------------------
export {
    HIDDEN_BY,
    HIDEABLE,
    hides,
    laidOutHidden,
    LEVEL_KINDS,
    VIEW_LEVELS,
    type DrawnHideable,
    type GridCell,
    type Hideable,
    type LaidOutHideable,
    type RenderGraph,
    type StageGrid,
    type ViewLevel,
    type ViewOptions,
} from './core/storming/ir.js';
export { drawsElement, hiddenInDrawing, hideInDrawing } from './core/storming/hide.js';
export { stormingViewKey } from './core/storming/graph.js';

// ---- core: the drawing of a laid-out graph, shared by the Live View's canvas and `dt export svg` ------------------
export {
    edgeItemId,
    ghostItemId,
    graphNodeOf,
    internalItemId,
    nodeItemId,
    rectCenter,
    rectContains,
    sceneItems,
    unionRects,
    type ChangeMark,
    type DiagMark,
    type EdgeProps,
    type EdgeTone,
    type GroupProps,
    type SettledHotspot,
    type InternalProps,
    type NodeProps,
    type Point,
    type Rect,
    type Scene,
    type SceneEdge,
    type SceneGroup,
    type SceneId,
    type SceneInternal,
    type SceneItem,
    type SceneItemType,
    type SceneNode,
} from './core/drawing/scene.js';
export { buildScene, ownerElement, type ChangedElements, type RenderOptions } from './core/drawing/build-scene.js';
export { exportBounds, graphBounds } from './core/drawing/bounds.js';
export { BADGE, badgeWidth, checkPath, DIAG_RADIUS, RESOLVED_MARK } from './core/drawing/marks.js';
export { fitLabel, fontSizes, NOTE_KINDS, type LabelFit } from './core/drawing/note-fit.js';
export { DIAGRAM_TEXTS, type DiagramTexts } from './core/drawing/texts.js';
export {
    legendContent,
    legendKindNames,
    legendRows,
    STORMING_LEGEND_KINDS,
    type LegendContent,
    type LegendKind,
    type LegendRow,
    type LegendView,
} from './core/drawing/legend.js';
export {
    exportFileName,
    nameIn,
    sheetHeading,
    slug,
    stormingSheetSubject,
    type Named,
    type SheetSubject,
    type StormingOutline,
    type StormingScope,
} from './core/drawing/sheet.js';
export { tableMeasure } from './core/drawing/text-measure.js';
export { styleFonts, stylePalette, styleTokens, tokenColour, type DiagramTheme, type StyleTokens } from './core/drawing/palette.js';
export {
    breakUnits,
    ellipsize,
    noteText,
    PALETTE_VARS,
    PAPER,
    portableSvg,
    wrapLines,
    xml,
    type Font,
    type Fonts,
    type NoteText,
    type Palette,
    type PaletteVar,
    type PortableSvg,
    type PortableSvgInput,
    type Rgba,
    type TextMeasure,
} from './core/drawing/portable-svg.js';

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
