// The validation of a snapshot, per DSL (ADR 0026): the summary a revision keeps, the diagnostics a run added
// compared with its base, and the run success rule that decides between Completed and Failed.
import { isStormingFile } from '@domaintrail/modeling/core/analyze';
import type { Diagnostic, RuleId } from '@domaintrail/modeling/core/diagnostics';
import { Collaboration } from '../generated/index.js';
import { comparePaths } from './snapshot.js';

/** The `.dtes` diagnostics that check a `ref` against the `.dt` model (ADR 0024: S010–S013): the link warnings. */
export const LINK_RULES: ReadonlySet<RuleId> = new Set<RuleId>(['S010', 'S011', 'S012', 'S013']);

/** A count as a `Tally`; throws on a negative or fractional number (a programming error, never input). */
export function tally(n: number): Collaboration.Tally {
    const made = Collaboration.makeTally(n);
    if (!made.ok) throw new Error(`Not a count: ${n}`);
    return made.value;
}

/** The `.dtes` files with a syntax error, sorted: those whose stormings are not known. */
export function unparsedDtes(diagnostics: readonly Diagnostic[]): string[] {
    return [...new Set(diagnostics.filter((d) => isStormingFile(d.file) && d.code === 'SYNTAX').map((d) => d.file))].sort(comparePaths);
}

/**
 * The validation summary of a snapshot from its diagnostics: `.dt` errors; `.dtes` errors and warnings other than the
 * link rules; the link rules of any severity (`linkWarnings`); `stale` as given (the diagnostics are older than the
 * snapshot's content).
 */
export function summarize(diagnostics: readonly Diagnostic[], stale: boolean): Collaboration.ValidationSummary {
    const dt = diagnostics.filter((d) => !isStormingFile(d.file));
    const dtes = diagnostics.filter((d) => isStormingFile(d.file) && !LINK_RULES.has(d.code));
    return {
        dtErrors: tally(dt.filter((d) => d.severity === 'error').length),
        dtesErrors: tally(dtes.filter((d) => d.severity === 'error').length),
        dtesWarnings: tally(dtes.filter((d) => d.severity === 'warning').length),
        linkWarnings: tally(diagnostics.filter((d) => isStormingFile(d.file) && LINK_RULES.has(d.code)).length),
        stale,
    };
}

/** What a run changed in the diagnostics, per DSL, compared with its base revision. */
export interface DiagnosticsDiff {
    /** `.dt` errors the base did not have: each counts against the run success rule. */
    readonly newDtErrors: readonly Diagnostic[];
    /** `.dt` errors of the base that are gone. */
    readonly resolvedDtErrors: readonly Diagnostic[];
    /** `.dtes` diagnostics (errors, warnings, link rules) the base did not have: shown, not a failure. */
    readonly newDtes: readonly Diagnostic[];
    /** `.dtes` diagnostics of the base that are gone. */
    readonly resolvedDtes: readonly Diagnostic[];
    /** The `.dtes` files that do not parse after the run: each counts against the run success rule. */
    readonly unparsedDtes: readonly string[];
}

/**
 * Which diagnostics are "the same" across two snapshots: file, rule, severity and message, not the position (an edit
 * above a diagnostic moves it without changing it). Compared as multisets, so a second identical error is new.
 */
const identity = (d: Diagnostic): string => [d.file, d.code, d.severity, d.message].join('\u0000');

/** The diagnostics of `after` that `before` does not have, counting repeats. */
function added(before: readonly Diagnostic[], after: readonly Diagnostic[]): Diagnostic[] {
    const left = new Map<string, number>();
    for (const d of before) left.set(identity(d), (left.get(identity(d)) ?? 0) + 1);
    return after.filter((d) => {
        const n = left.get(identity(d)) ?? 0;
        if (n === 0) return true;
        left.set(identity(d), n - 1);
        return false;
    });
}

/** The diagnostics a run added and resolved compared with its base, split per DSL with `isStormingFile`. */
export function diagnosticsDiff(base: readonly Diagnostic[], result: readonly Diagnostic[]): DiagnosticsDiff {
    const dtErrors = (ds: readonly Diagnostic[]): Diagnostic[] => ds.filter((d) => !isStormingFile(d.file) && d.severity === 'error');
    const dtes = (ds: readonly Diagnostic[]): Diagnostic[] => ds.filter((d) => isStormingFile(d.file));
    return {
        newDtErrors: added(dtErrors(base), dtErrors(result)),
        resolvedDtErrors: added(dtErrors(result), dtErrors(base)),
        newDtes: added(dtes(base), dtes(result)),
        resolvedDtes: added(dtes(result), dtes(base)),
        unparsedDtes: unparsedDtes(result),
    };
}

/** What the agent and the pipeline report about a run, before the diagnostics are compared. */
export interface RunFacts {
    readonly exitCode: number;
    /** `dt fmt` ran. */
    readonly formatted: boolean;
    /** `dt check` ran. */
    readonly checked: boolean;
}

/** The report of a run: the facts, and the counts of the diagnostics diff that the success rule looks at. */
export const runReport = (facts: RunFacts, diff: DiagnosticsDiff): Collaboration.RunReport => ({
    exitCode: facts.exitCode,
    formatted: facts.formatted,
    checked: facts.checked,
    newDtErrors: tally(diff.newDtErrors.length),
    unparsedDtes: tally(diff.unparsedDtes.length),
});

/**
 * The run success rule (ADR 0026): the agent exited 0, `dt fmt` and `dt check` ran, no `.dt` error is new compared
 * with the base revision, and every `.dtes` file parses. Pre-existing diagnostics and `.dtes` warnings do not count.
 * The same expression as the invariant `succeeded` of a completed run.
 */
export const succeeded = (report: Collaboration.RunReport): boolean =>
    report.exitCode === 0 && report.formatted && report.checked && report.newDtErrors === 0 && report.unparsedDtes === 0;
