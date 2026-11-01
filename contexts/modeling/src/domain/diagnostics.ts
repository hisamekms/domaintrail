// How Modeling's rules (and the generator's name check) report on the model as written (source-model.ts): a diagnostic
// at a site, its fields in the order `dt check`'s JSON and the Live View payloads have them. The analysis hands its own
// list in, so that the diagnostics keep the order the rules run in.
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
