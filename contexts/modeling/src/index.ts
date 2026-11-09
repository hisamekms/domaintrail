// The public surface of @domaintrail/modeling (the `.` export; ADR 0027, Dependency rules): Modeling's published
// language, then the use cases the apps and capabilities call. The kernel is @domaintrail/kernel, Storming
// @domaintrail/storming.
//
// A downstream context takes only the published language (the sections marked so; `published` in
// test/architecture/map.ts). The other sections are for the apps and capabilities; what is not Modeling's
// at all is marked with the task that moves it.

// ---- published language: the typed model ----------------------------------------------------------------------
// (its types are described in model/*.dt and generated into src/generated; the helpers are written in domain/)
export {
    allFieldsOf,
    applicableOutcomes,
    BINARY_OP_TEXT,
    commandsOf,
    contextNames,
    contextOf,
    elementOf,
    elementsIn,
    emitApplies,
    emitSuffix,
    emittedEvents,
    emittedEventsInAggregate,
    fieldSetsOf,
    fieldsOf,
    hasElement,
    hasExternalObligations,
    invariantsOf,
    outcomeFields,
    outcomePatternText,
    ownFields,
    policiesReactingTo,
    policiesRunning,
    policyList,
    sameFieldType,
    sharedContexts,
    statesOf,
    valuesOf,
    validStatesFor,
    variantsOf,
    type AggregateModel,
    type BinaryOp,
    type Cardinality,
    type CommandModel,
    type CommandCaseModel,
    type ChoiceRuleModel,
    type ContextModel,
    type ContextName,
    type Described,
    type DomainModel,
    type ElementId,
    type ElementKind,
    type ElementModel,
    type ElementOf,
    type EmitModel,
    type EnumModel,
    type EnumValueModel,
    type ExprModel,
    type FieldKind,
    type FieldModel,
    type FieldsElement,
    type InvariantModel,
    type InitialModel,
    type LabelSource,
    type OutcomePatternModel,
    type OutcomeModel,
    type PolicyElement,
    type PolicyModel,
    type PrimitiveName,
    type QualifiedName,
    type Quantifier,
    type RequirementModel,
    type StateModel,
    type TermModel,
    type TransitionModel,
    type TransitionGroupModel,
    type TypeExpr,
    type UnionModel,
    type VariantModel,
    type VerifiedFor,
    type VerifiedModel,
    type ValidKindStatesModel,
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
export { commandId, contextName, elementId, idOfName, nameOfId, qualifiedName, stateId } from './domain/ids.js';
export { aggregateDependencies, owningAggregates, soleOwner, type AggregateDependency } from './domain/aggregates.js';
export { diffModels, EMPTY_DIFF, fingerprints, isEmptyDiff, type ModelDiff } from './domain/diff.js';
export type { ModelingRuleId } from './domain/rule-ids.js';

// ---- the model as written, for the rules: what `DomainAnalysis.sourceModel` holds ------------------------------
// (not published language: Modeling's rules and the generator's name check read it and report through `RuleSink`;
// its lookups and member helpers are the namespace `written` (`written.commandsOf`), apart from the Typed Model's
// helpers of the same names above)
export type {
    AggregateDecl,
    AggregateMember,
    CommandDecl,
    ContextFragment,
    DataMember,
    Declared,
    ElementDecl,
    EmitDecl,
    EntityDecl,
    EnumDecl,
    EnumValueDecl,
    ErrorDecl,
    EventDecl,
    Expr,
    ExprKind,
    FieldDecl,
    FieldSetDecl,
    IdDecl,
    InvariantDecl,
    Multiplicity,
    OutcomePatternDecl,
    ParamDecl,
    PolicyDecl,
    PrimitiveDecl,
    Ref,
    RequirementDecl,
    Site,
    SourceModel,
    StateDecl,
    TermDecl,
    TransitionDecl,
    TypeDecl,
    TypeRef,
    UnionDecl,
    ValueObjectDecl,
    VariantDecl,
    VerifiedDecl,
    WithFieldSets,
    WithMembers,
} from './domain/source-model.js';
export * as written from './domain/source-model.js';
export { RuleSink } from './domain/diagnostics.js';
export { generationGateDiagnostics } from './domain/rules/generation-gate.js';

// ---- use cases: Modeling's analysis of the `.dt` sources -------------------------------------------------------
export { analyzeDomain, type DomainAnalysis } from './application/analyze.js';

// ---- use cases: formatting -------------------------------------------------------------------------------------
export { formatDomain, FormatError } from './infrastructure/syntax/format.js';

// ---- the syntax, for the language server -----------------------------------------------------------------------
export * as ast from './infrastructure/syntax/generated/ast.js';
export { DomainGeneratedModule, DomainGeneratedSharedModule } from './infrastructure/syntax/generated/module.js';
export { DomainModule } from './infrastructure/syntax/domain-module.js';
export { docComment, LabelResolver } from './infrastructure/syntax/labels.js';
export { ModelIndex } from './infrastructure/syntax/model-index.js';
export { elementIdOf } from './infrastructure/syntax/element-id.js';
