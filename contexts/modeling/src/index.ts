// The public surface of @domaintrail/modeling (the `.` export; ADR 0027, Dependency rules): Modeling's published
// language, then the use cases the apps and capabilities call. The kernel is @domaintrail/kernel, Storming
// @domaintrail/storming.
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
} from './domain/model.js';
export {
    contextDependencies,
    groupByContext,
    representative,
    supportingContexts,
    type ContextDependency,
    type Dependency,
    type DependencyKind,
} from './domain/dependencies.js';
export { commandsWithOutcome, fieldSetUsers, fieldUseText, fieldUses, identityOf, type FieldUse, type Named } from './domain/usages.js';
export { commandId } from './domain/ids.js';
export { aggregateDependencies, owningAggregates, soleOwner, type AggregateDependency } from './domain/aggregates.js';
export { diffModels, EMPTY_DIFF, fingerprints, isEmptyDiff, type ModelDiff } from './domain/diff.js';
export type { ModelingRuleId } from './domain/rule-ids.js';

// ---- use cases: Modeling's analysis of the `.dt` sources -------------------------------------------------------
export { analyzeDomain, type DomainAnalysis } from './application/analyze.js';

// ---- use cases: formatting -------------------------------------------------------------------------------------
export { formatDomain, FormatError } from './infrastructure/syntax/format.js';

// ---- the syntax, for the language server -----------------------------------------------------------------------
// (and, until T10, for the TypeScript generator's name check and naming, which read the AST index and report through
// the diagnostic sink: exceptions `foreign-infrastructure` of generation in test/architecture/map.ts)
export * as ast from './infrastructure/syntax/generated/ast.js';
export { DomainGeneratedModule, DomainGeneratedSharedModule } from './infrastructure/syntax/generated/module.js';
export { DomainModule } from './infrastructure/syntax/domain-module.js';
export { docComment, LabelResolver } from './infrastructure/syntax/labels.js';
export { commandsOf, includedFields, invariantsOf, ModelIndex, primitiveInvariants, statesOf } from './infrastructure/syntax/model-index.js';
export { elementIdOf } from './infrastructure/syntax/element-id.js';
export { DiagnosticSink, type FileResolver } from './infrastructure/syntax/diagnostic-sink.js';
