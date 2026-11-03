// The public surface of @domaintrail/storming (the `.` export; ADR 0027, Dependency rules): Storming's published
// language — the IR of the stormings of the `.dtes` files (ADR 0024), checked against Modeling's typed model — then its
// use cases and the syntax the language server wires.
//
// A downstream context (Collaboration) takes only the published language (`published` in test/architecture/map.ts).

// ---- published language: the IR of a storming, its semantic graph and timeline occurrences, its rule IDs, its files
export {
    declarations,
    DESIGN_LEVEL,
    esElementId,
    isDesignLevelOnly,
    RELATION_RULES,
    type AnyDeclaration,
    type Clause,
    type ElementKind as StormingElementKind,
    type EventStepRef,
    type Group,
    type NodeElement,
    type NodeElementKind,
    type RelationKeyword,
    type SourceRange,
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
    stormingTimelines,
    timelineOccurrences,
    type EventOccurrence,
    type SemanticEdge,
    type SemanticEdgeKind,
    type SemanticGraph,
} from './domain/semantic.js';
export type { StormingRuleId } from './domain/rule-ids.js';
export { isStormingFile } from './domain/files.js';

// ---- use cases: Storming's analysis of the `.dtes` sources against the typed model; formatting -----------------
export { analyzeStormings } from './application/analyze.js';
export { formatStorming } from './infrastructure/syntax/format.js';

// ---- the syntax, for the language server -----------------------------------------------------------------------
export * as stormingAst from './infrastructure/syntax/generated/ast.js';
export { EventStormingGeneratedModule, EventStormingGeneratedSharedModule } from './infrastructure/syntax/generated/module.js';
export { EventStormingModule } from './infrastructure/syntax/module.js';
export { docComment } from './infrastructure/syntax/doc-comment.js';
