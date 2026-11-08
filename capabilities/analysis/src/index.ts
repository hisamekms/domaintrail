// The public surface of @domaintrail/analysis (the `.` export; ADR 0027, Project analysis and configuration): the
// project analysis behind `dt check`, the language server, the view service, the git baseline and Collaboration's
// validator — Modeling's analysis, Storming's against its model, and the generation's checks, combined — and its
// section of domaintrail.jsonc.

// ---- use cases: the project analysis ---------------------------------------------------------------------------
export { analyze, type Analysis } from './application/analyze.js';

// ---- its section of domaintrail.jsonc, `sources` (T6), composed by the app; the workspace receives `sourceSelection`
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
} from './core/sources.js';
