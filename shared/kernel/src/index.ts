// The public surface of @domaintrail/kernel (the `.` export; ADR 0027, Layout: `shared/kernel`): what every module may
// take and nothing else needs to own — diagnostics, the suggestions, sources and locations, names. Kept small: it
// imports nothing outside it (the rule `kernel` of test/architecture.test.ts). Its types are the context Kernel
// (model/kernel.dt), generated into ./generated and exported here whole, values included: it is the module the
// generated code of other packages imports the context from (`generate.ts.contexts.Kernel.import`, ADR 0028).
export { compareDiagnostics, dedupeDiagnostics, formatDiagnostic, hasErrors, jsonDiagnostic, type RuleCode } from './diagnostics.js';
export { closest, didYouMean, distance, suggestFrom } from './suggest.js';
export { camel } from './names.js';
export {
    equalCandidate,
    equalDiagnostic,
    equalJsonDiagnostic,
    equalLocation,
    equalPosition,
    equalSourceFile,
    type Candidate,
    type Diagnostic,
    type JsonDiagnostic,
    type Location,
    type Position,
    type Severity,
    type SourceFile,
} from './generated/Kernel.js';
