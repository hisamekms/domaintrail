// The public surface of @domaintrail/generation (the `.` export; ADR 0027, Layout: the capability `generation`): the
// TypeScript generator over Modeling's typed model (`dt generate ts`: the contracts, the generated checks and contract
// tests), its check of the `.dt` sources (M011), which the project analysis runs, and its sections of domaintrail.jsonc.

// ---- use cases: the TypeScript generator -----------------------------------------------------------------------
export { GENERATED_MARKER, generateTypeScript, type GeneratedFile, type PolicyMode } from './core/typescript.js';
export { aggregateParamName } from './core/naming.js';
// the warnings of `dt generate ts` about the contract tests' settings (a per-type depth of a type that is not recursive)
export { testsWarnings, type TypeTestsOptions } from './core/tests.js';
// its check of the `.dt` sources (M011), which the project analysis runs
export { checkGeneratedNames } from './core/tsnames.js';

// ---- its sections of domaintrail.jsonc, `generate` and `lintHint` (T6), composed by the app --------------------
export {
    GENERATION_CONFIG_KEYS,
    policyModes,
    resolveGenerationConfig,
    staysInside,
    unknownTestsTypes,
    unknownTsContexts,
    validateGenerationConfig,
    type GenerationConfigFile,
    type ResolvedGenerationConfig,
    type TestsConfig,
} from './core/config.js';
