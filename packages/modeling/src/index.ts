// The public surface of @domaintrail/modeling (the `.` export; ADR 0027, Dependency rules): Modeling's and Storming's
// published language, then the use cases the apps and capabilities call. Storming is part of this package until T8
// (contexts/storming). The kernel is @domaintrail/kernel.
//
// A downstream context takes only the published language (the sections marked so; `published` in
// test/architecture/map.ts). The other sections are for the apps and capabilities; what is not Modeling's
// at all is marked with the task that moves it.

// ---- published language: the typed model ----------------------------------------------------------------------
export {
    allFieldsOf,
    elementList,
    elementsIn,
    emitApplies,
    emitSuffix,
    emittedEvents,
    outcomeFields,
    outcomePatternText,
    ownFields,
    policiesReactingTo,
    policiesRunning,
    policyList,
    sameFieldType,
    type Cardinality,
    type CommandModel,
    type Described,
    type DomainModel,
    type ElementKind,
    type ElementModel,
    type EmitModel,
    type ExprModel,
    type FieldModel,
    type InvariantModel,
    type OutcomePatternModel,
    type PolicyModel,
    type PrimitiveName,
    type RequirementModel,
    type StateModel,
    type TermModel,
    type TransitionModel,
    type TypeExpr,
    type VariantModel,
    type VerifiedModel,
} from './model/model.js';
export {
    contextDependencies,
    groupByContext,
    representative,
    supportingContexts,
    type ContextDependency,
    type Dependency,
    type DependencyKind,
} from './model/dependencies.js';
export { commandsWithOutcome, fieldSetUsers, fieldUseText, fieldUses, identityOf, type FieldUse, type Named } from './model/usages.js';
export { elementIdOf } from './model/ids.js';
export { aggregateDependencies, owningAggregates, soleOwner, type AggregateDependency } from './model/aggregates.js';
export { diffModels, EMPTY_DIFF, fingerprints, isEmptyDiff, type ModelDiff } from './model/diff.js';
export type { ModelingRuleId } from './model/rule-ids.js';

// ---- published language: Storming's IR (T8: contexts/storming) -------------------------------------------------
export {
    declarations,
    esElementId,
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
} from './storming/ir.js';
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
} from './storming/semantic.js';
export type { StormingRuleId } from './storming/rule-ids.js';
export { isStormingFile } from './storming/files.js';

// ---- use cases: Modeling's analysis of the `.dt` sources, Storming's of the `.dtes` sources ---------------------
export { analyzeDomain, type DomainAnalysis } from './core/analyze.js';
export { analyzeStormings } from './storming/analyze.js';

// ---- use cases: formatting -------------------------------------------------------------------------------------
export { formatDomain, FormatError } from './format/format.js';
export { formatStorming } from './storming/format.js';

// ---- the syntax, for the TypeScript generator's name check and naming until T10 (they read the AST index) --------
export { DiagnosticSink, type FileResolver } from './core/diagnostic-sink.js';
export { includedFields, invariantsOf, primitiveInvariants, statesOf } from './core/model-index.js';

// ---- the syntax, for the language server (T8: Modeling's and Storming's infrastructure/syntax) -----------------
export * as ast from './language/generated/ast.js';
export { DomainGeneratedModule, DomainGeneratedSharedModule, EventStormingGeneratedModule } from './language/generated/module.js';
export { DomainModule } from './language/domain-module.js';
export { EventStormingModule } from './storming/language/module.js';
export { docComment, LabelResolver } from './core/labels.js';
export { commandsOf, ModelIndex } from './core/model-index.js';
