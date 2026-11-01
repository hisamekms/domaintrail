// How Modeling's rules report on the model as written (source-model.ts): a diagnostic at a site, exactly as the syntax's
// `DiagnosticSink` reports one on an AST node (the same fields in the same order), so that a rule moved onto the model
// (T10 of docs/plans/0027-boundaries.md) gives the same output. Both may share one list, so that the diagnostics keep
// the order the rules run in.
import type { Diagnostic, Severity } from '@domaintrail/kernel';
import type { ModelingRuleId } from './rule-ids.js';
import type { Site } from './source-model.js';

export class RuleSink {
    constructor(readonly items: Diagnostic[] = []) {}

    report(severity: Severity, code: ModelingRuleId, message: string, at: Site, hint?: string): void {
        const { file, start, end, elementId } = at;
        this.items.push({ file, start, end, severity, code, message, ...(hint ? { hint } : {}), elementId });
    }

    error(code: ModelingRuleId, message: string, at: Site, hint?: string): void {
        this.report('error', code, message, at, hint);
    }

    warning(code: ModelingRuleId, message: string, at: Site, hint?: string): void {
        this.report('warning', code, message, at, hint);
    }
}
