// The public surface of @domaintrail/modeling (the `.` export; ADR 0027, Dependency rules): Modeling's and Storming's
// published language, then the use cases the apps and capabilities call. Storming is part of this package until T8
// (contexts/storming), the analysis until T4 (capabilities/analysis), the generator until T8 (capabilities/generation).
//
// A downstream context takes only the published language (the sections marked so; `published` in
// test/architecture/map.ts). The other sections are for the apps and capabilities; what is not Modeling's at all is
// marked with the task that moves it.

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
    type Location,
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

// ---- published language: diagnostics and suggestions (T3: shared/kernel) ---------------------------------------
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
} from './core/diagnostics.js';
export { closest, didYouMean, type Candidate } from './core/suggest.js';

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

// ---- use cases: the project analysis (T4: capabilities/analysis; `SourceFile` to the kernel in T3) ---------------
export { analyze, isStormingFile, type Analysis, type SourceFile } from './core/analyze.js';

// ---- use cases: formatting -------------------------------------------------------------------------------------
export { formatDomain, FormatError } from './format/format.js';
export { formatStorming } from './storming/format.js';

// ---- use cases: Storming's parser, the .dtes sources to its IR (T8: contexts/storming) --------------------------
export { parseStormings } from './storming/parse.js';

// ---- use cases: the TypeScript generator (T8: capabilities/generation) ------------------------------------------
export { GENERATED_MARKER, generateTypeScript, type GeneratedFile, type PolicyMode } from './generator/typescript.js';
export { aggregateParamName } from './generator/naming.js';

// ---- the configuration of domaintrail.jsonc (T6: each section to its owner, composed by the app) ----------------
export {
    checkTsContexts,
    CONFIG_FILES,
    ConfigError,
    DEFAULT_AGENT_TOOLS,
    DEFAULT_SOURCES,
    defaultConfig,
    IGNORED_DIRS,
    policyModes,
    resolveConfig,
    sourceMatcher,
    staysInside,
    type ClefModel,
    type ResolvedConfig,
    type ResolvedSessionConfig,
} from './core/config.js';

// ---- not Modeling's language: the emoji rule of Collaboration's `Emoji` (T6: moves to collaboration) ------------
export { DEFAULT_QUICK_REACTIONS, isNormalEmoji, isSingleEmoji, MAX_EMOJI_BYTES, normalizeEmoji, readEmoji } from './core/emoji.js';

// ---- the syntax, for the language server (T8: Modeling's and Storming's infrastructure/syntax) -----------------
export * as ast from './language/generated/ast.js';
export { DomainGeneratedModule, DomainGeneratedSharedModule, EventStormingGeneratedModule } from './language/generated/module.js';
export { DomainModule } from './language/domain-module.js';
export { EventStormingModule } from './storming/language/module.js';
export { docComment, LabelResolver } from './core/labels.js';
export { commandsOf, ModelIndex } from './core/model-index.js';
