// The public surface of @domaintrail/modeling (the `.` export; ADR 0027, Dependency rules): Modeling's and Storming's
// published language, the kernel, then the use cases the apps and capabilities call. Storming is part of this package
// until T8 (contexts/storming), the kernel until T8 (shared/kernel), the project analysis (`analysis/`) until T8
// (capabilities/analysis), the generator until T8 (capabilities/generation).
//
// A downstream context takes only the published language and the kernel (the sections marked so; `published` and
// `kernel` in test/architecture/map.ts). The other sections are for the apps and capabilities; what is not Modeling's
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

// ---- the kernel: diagnostics, suggestions, sources and locations (T8: shared/kernel) ----------------------------
export {
    compareDiagnostics,
    formatDiagnostic,
    hasErrors,
    jsonDiagnostic,
    type Diagnostic,
    type JsonDiagnostic,
    type Position,
    type RuleId,
    type Severity,
} from './kernel/diagnostics.js';
export { closest, didYouMean, type Candidate } from './kernel/suggest.js';
export { type Location, type SourceFile } from './kernel/source.js';

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

// ---- use cases: the project analysis (T8: capabilities/analysis) ------------------------------------------------
export { analyze, isStormingFile, type Analysis } from './analysis/analyze.js';
// its section of domaintrail.jsonc, `sources` (T6), composed by the app; the workspace receives `sourceSelection`
export {
    DEFAULT_SOURCES,
    IGNORED_DIRS,
    resolveSourcesConfig,
    sourceMatcher,
    sourceSelection,
    SOURCES_CONFIG_KEYS,
    validateSourcesConfig,
    type ResolvedSourcesConfig,
    type SourcesConfigFile,
} from './analysis/sources.js';

// ---- use cases: formatting -------------------------------------------------------------------------------------
export { formatDomain, FormatError } from './format/format.js';
export { formatStorming } from './storming/format.js';

// ---- use cases: the TypeScript generator (T8: capabilities/generation) ------------------------------------------
export { GENERATED_MARKER, generateTypeScript, type GeneratedFile, type PolicyMode } from './generator/typescript.js';
export { aggregateParamName } from './generator/naming.js';
// its sections of domaintrail.jsonc, `generate` and `lintHint` (T6), composed by the app
export {
    GENERATION_CONFIG_KEYS,
    policyModes,
    resolveGenerationConfig,
    staysInside,
    unknownTsContexts,
    validateGenerationConfig,
    type GenerationConfigFile,
    type ResolvedGenerationConfig,
} from './generator/config.js';

// ---- the syntax, for the language server (T8: Modeling's and Storming's infrastructure/syntax) -----------------
export * as ast from './language/generated/ast.js';
export { DomainGeneratedModule, DomainGeneratedSharedModule, EventStormingGeneratedModule } from './language/generated/module.js';
export { DomainModule } from './language/domain-module.js';
export { EventStormingModule } from './storming/language/module.js';
export { docComment, LabelResolver } from './core/labels.js';
export { commandsOf, ModelIndex } from './core/model-index.js';
