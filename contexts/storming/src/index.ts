// The public surface of @domaintrail/storming (the `.` export; ADR 0027, Dependency rules): Storming's published
// language — the IR of the stormings of the `.dtes` files (ADR 0024), checked against Modeling's typed model — then its
// use cases and the syntax the language server wires.
//
// A downstream context (Collaboration) takes only the published language (`published` in test/architecture/map.ts).

// ---- published language: the IR of a storming, its semantic graph and timeline occurrences, its rule IDs, its files,
// the sticky note its elements are drawn as
export {
    allTimelines,
    declarations,
    DESIGN_LEVEL,
    esElementId,
    isDesignLevelOnly,
    isRemovedKeyword,
    nodeElements,
    RELATION_KEYWORDS,
    RELATION_RULES,
    REMOVED_KEYWORDS,
    type AnyDeclaration,
    type Clause,
    type ElementKind as StormingElementKind,
    type EventStepRef,
    type Group,
    type NodeElement,
    type NodeElementKind,
    type RelationKeyword,
    type RemovedKeyword,
    type SourceRange,
    type Stage,
    type StageRef,
    type Storming,
    type StormingAnalysis,
    type StormingElement,
    type Timeline,
    type TimelineStep,
} from './domain/ir.js';
export {
    buildSemanticGraph,
    firstDeclarations,
    semanticEdgeKey,
    stormingStages,
    stormingTimelines,
    timelineOccurrences,
    type EventOccurrence,
    type SemanticEdge,
    type SemanticEdgeKind,
    type SemanticGraph,
} from './domain/semantic.js';
export {
    branchPoints,
    drawnInSections,
    hasExceptions,
    mainFlows,
    orderStages,
    rejoinPoint,
    sameStep,
    sections,
    stepEvents,
    topLevel,
    trunk,
    type BranchPoint,
    type RejoinPoint,
    type Section,
    type StageOrder,
} from './domain/stages.js';
export { localNameProblem, referencesTo, STORMING_KEYWORDS, type LocalNameProblem, type ReferenceSite, type StormingReference } from './domain/references.js';
export type { StormingRuleId } from './domain/rule-ids.js';
export { designGaps, hasDesignLevel, openGaps, openQuestions, type Gap, type Missing } from './domain/gaps.js';
export { isStormingFile } from './domain/files.js';
export { estimatedLabelLines, labelOverflowsNote, LINES_AT_FLOOR, STICKY_NOTE } from './domain/sticky-note.js';

// ---- use cases: Storming's analysis of the `.dtes` sources against the typed model; formatting; migrating v0.1 ------
export { analyzeStormings } from './application/analyze.js';
export { formatStorming } from './infrastructure/syntax/format.js';
export {
    MAX_HOTSPOT_QUESTION,
    MAX_RESOLUTION,
    MAX_STICKY_LABEL,
    planStickyEdit,
    quoteLabel,
    stickyWording,
    stormingNames,
    type StickyEditInput,
    type StickyEditPlan,
    type StickyEditProblem,
    type StickyEditResult,
    type StickyWording,
} from './infrastructure/syntax/edit.js';
export {
    migrateStorming,
    type MigrationLeft,
    type MigrationMove,
    type MigrationPlace,
    type MigrationRewrite,
    type StormingMigration,
} from './infrastructure/syntax/migrate.js';

// ---- the syntax, for the language server -----------------------------------------------------------------------
export * as stormingAst from './infrastructure/syntax/generated/ast.js';
export { EventStormingGeneratedModule, EventStormingGeneratedSharedModule } from './infrastructure/syntax/generated/module.js';
export { EventStormingModule } from './infrastructure/syntax/module.js';
export { docComment } from './infrastructure/syntax/doc-comment.js';
