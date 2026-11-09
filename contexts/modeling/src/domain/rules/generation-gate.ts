import type { Diagnostic } from '@domaintrail/kernel';
import { RuleSink } from '../diagnostics.js';
import { commandsOf, invariantsOf, statesOf, type AggregateDecl, type SourceModel } from '../source-model.js';

/** Extra checks required before any generator writes a file. M029 is reserved for unexpressed decisions. */
export function generationGateDiagnostics(model: SourceModel): Diagnostic[] {
    const out: Diagnostic[] = [];
    const rules = new RuleSink(out);
    const decision = (kind: string, name: string, expr: unknown, reason: string | undefined, at: import('../source-model.js').Site): void => {
        if (expr) return;
        if (reason?.trim()) {
            rules.report('info', 'M029', `${kind} '${name}' requires a supplied external check; the annotation alone is not verification.`, at);
        } else {
            rules.error('M029', `${kind} '${name}' is not expressed in the DSL and has no @externalCheck reason.`, at);
        }
    };
    for (const el of model.elements) {
        if (el.kind === 'id' || el.kind === 'primitive') for (const i of el.invariants) decision('Invariant', i.name, i.expr, i.externalReason, i.at);
        if ('members' in el) for (const i of invariantsOf(el.members)) decision('Invariant', i.name, i.expr, i.externalReason, i.at);
        if (el.kind === 'union')
            for (const variant of el.variants) for (const i of invariantsOf(variant.members)) decision('Invariant', i.name, i.expr, i.externalReason, i.at);
        if (el.kind !== 'aggregate') continue;
        const agg: AggregateDecl = el;
        for (const s of statesOf(agg)) for (const i of invariantsOf(s.members)) decision('Invariant', i.name, i.expr, i.externalReason, i.at);
        const groups = agg.members.filter((m) => m.kind === 'transitionGroup');
        for (const c of commandsOf(agg)) {
            for (const r of c.requirements) decision('Requirement', r.name, r.expr, r.externalReason, r.at);
            const outcomes = [...c.outcomes, ...groups.flatMap((g) => g.cases.filter((x) => x.command.text === c.name).flatMap((x) => x.outcomes))];
            for (const o of outcomes) if (o.select?.text !== undefined) decision('Choice rule', o.name, o.select.expr, o.select.externalReason, o.select.at);
            for (const t of c.transitions)
                if (t.to.length > 1) rules.error('M029', `Legacy transition of command '${c.name}' has multiple targets without named choice rules.`, t.at);
        }
        for (const g of groups) for (const c of g.cases) for (const r of c.requirements) decision('Requirement', r.name, r.expr, r.externalReason, r.at);
    }
    return out;
}
