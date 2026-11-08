// The generator's check of the `.dt` sources (ADR 0027, Modeling: the TypeScript name check is generation's, and the
// project analysis runs it): what `generateTypeScript` would write must not collide. It reads Modeling's model as
// written (`DomainAnalysis.sourceModel`) and reports through its `RuleSink`.
import { RuleSink, written, type SourceModel } from '@domaintrail/modeling';
import type { Diagnostic } from '@domaintrail/kernel';
import { EVENT_TAG, RUNTIME_NAMES, TS_RESERVED, aggregateParamName, commandTypeName, generatedNames } from './naming.js';

/**
 * The generator's checks over Modeling's analysis of the `.dt` sources (M011), once they parse (none before): what the
 * project analysis adds to Modeling's diagnostics.
 */
export function checkGeneratedNames(domain: { syntaxOk: boolean; sourceModel?: SourceModel }): Diagnostic[] {
    if (!domain.syntaxOk || !domain.sourceModel) return [];
    const rules = new RuleSink();
    checkTsNames(domain.sourceModel, rules);
    return rules.items;
}

/** M011: generated TypeScript names do not collide. */
export function checkTsNames(model: SourceModel, rules: RuleSink): void {
    const contexts = model.contexts;
    for (const ctx of contexts) {
        const taken = new Map<string, string>();
        for (const n of RUNTIME_NAMES) taken.set(n, 'the domaintrail runtime');
        for (const other of contexts) if (other !== ctx) taken.set(other, `the import of context '${other}'`);

        for (const g of generatedNames(model, ctx)) {
            if (TS_RESERVED.has(g.name)) {
                rules.error('M011', `Generated TypeScript name '${g.name}' (${g.origin}) is a reserved word.`, g.at);
                continue;
            }
            const prev = taken.get(g.name);
            if (prev) {
                rules.error('M011', `Generated TypeScript name '${g.name}' for ${g.origin} collides with ${prev}.`, g.at);
            } else {
                taken.set(g.name, g.origin);
            }
        }
    }

    const events = model.elements.filter((el): el is written.EventDecl => el.kind === 'event');
    const errors = model.elements.filter((el): el is written.ErrorDecl => el.kind === 'error');
    for (const el of [...events, ...errors]) {
        const kind = el.kind;
        for (const f of el.members) {
            if (f.name === EVENT_TAG) {
                rules.error('M011', `Field '${EVENT_TAG}' is reserved for the discriminant of generated ${kind} types.`, f.nameAt);
            }
        }
        for (const { field, fieldSet } of written.includedFields(el)) {
            if (field.name !== EVENT_TAG) continue;
            const at = el.fieldSets.find((r) => r.target === fieldSet)!.at;
            rules.error('M011', `Field '${EVENT_TAG}' of field set '${fieldSet.name}' is reserved for the discriminant of generated ${kind} types.`, at);
        }
    }

    for (const agg of model.elements.filter((el): el is written.AggregateDecl => el.kind === 'aggregate')) {
        const self = aggregateParamName(agg);
        for (const cmd of written.commandsOf(agg)) {
            for (const p of cmd.params) {
                if (TS_RESERVED.has(p.name)) {
                    rules.error('M011', `Parameter name '${p.name}' is a reserved word in TypeScript.`, p.nameAt);
                } else if (!cmd.factory && p.name === self) {
                    rules.error('M011', `Parameter '${p.name}' of ${commandTypeName(agg, cmd)} collides with the aggregate parameter '${self}'.`, p.nameAt);
                }
            }
            // the events of a command's success value are keyed by their simple name
            const keys = new Map<string, string>();
            for (const e of cmd.emits) {
                const ev = e.event.target;
                if (!ev) continue;
                const qname = `${ev.context}.${ev.name}`;
                const prev = keys.get(ev.name);
                if (prev === qname) {
                    rules.error(
                        'M011',
                        `Event '${ev.name}' is listed more than once in 'emits' of '${agg.name}.${cmd.name}'; the events of its result are keyed by name.`,
                        e.event.at,
                        `list it once, with a multiplicity such as '${ev.name}[1..*]' or '${ev.name}?'`,
                    );
                } else if (prev) {
                    rules.error(
                        'M011',
                        `Events '${prev}' and '${qname}' of '${agg.name}.${cmd.name}' have the same name, and the events of its result are keyed by name.`,
                        e.event.at,
                        `rename one of the events`,
                    );
                } else {
                    keys.set(ev.name, qname);
                }
            }
        }
    }
}
