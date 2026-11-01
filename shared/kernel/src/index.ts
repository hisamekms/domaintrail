// The public surface of @domaintrail/kernel (the `.` export; ADR 0027, Layout: `shared/kernel`): what every module may
// take and nothing else needs to own — diagnostics, the suggestions, sources and locations, names. Kept small: it
// imports nothing outside it (the rule `kernel` of test/architecture.test.ts).
export {
    compareDiagnostics,
    dedupeDiagnostics,
    formatDiagnostic,
    hasErrors,
    jsonDiagnostic,
    type Diagnostic,
    type JsonDiagnostic,
    type Position,
    type RuleCode,
    type Severity,
} from './diagnostics.js';
export { closest, didYouMean, distance, suggestFrom, type Candidate } from './suggest.js';
export { camel } from './names.js';
export { type Location, type SourceFile } from './source.js';
