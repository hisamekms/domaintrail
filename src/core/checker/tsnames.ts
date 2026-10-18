import { isAggregate } from '../../language/generated/ast.js';
import {
    EVENT_TAG,
    RUNTIME_NAMES,
    TS_RESERVED,
    aggregateParamName,
    commandTypeName,
    generatedNames,
} from '../../generator/naming.js';
import type { DiagnosticSink } from '../diagnostics.js';
import { commandsOf, includedFields, type ModelIndex } from '../model-index.js';

/** M011: generated TypeScript names do not collide. */
export function checkTsNames(index: ModelIndex, sink: DiagnosticSink): void {
    const contexts = index.contextNames;
    for (const ctx of contexts) {
        const taken = new Map<string, string>();
        for (const n of RUNTIME_NAMES) taken.set(n, 'the domaintrail runtime');
        for (const other of contexts) if (other !== ctx) taken.set(other, `the import of context '${other}'`);

        for (const g of generatedNames(index, ctx)) {
            if (TS_RESERVED.has(g.name)) {
                sink.error('M011', `Generated TypeScript name '${g.name}' (${g.origin}) is a reserved word.`, g.node, 'name');
                continue;
            }
            const prev = taken.get(g.name);
            if (prev) {
                sink.error('M011', `Generated TypeScript name '${g.name}' for ${g.origin} collides with ${prev}.`, g.node, 'name');
            } else {
                taken.set(g.name, g.origin);
            }
        }
    }

    for (const el of [...index.events, ...index.errors]) {
        const kind = el.$type === 'EventDecl' ? 'event' : 'error';
        for (const f of el.members) {
            if (f.name === EVENT_TAG) {
                sink.error('M011', `Field '${EVENT_TAG}' is reserved for the discriminant of generated ${kind} types.`, f, 'name');
            }
        }
        for (const { field, fieldSet } of includedFields(el)) {
            if (field.name !== EVENT_TAG) continue;
            const at = el.fieldSets.findIndex((r) => r.ref === fieldSet);
            sink.error('M011', `Field '${EVENT_TAG}' of field set '${fieldSet.name}' is reserved for the discriminant of generated ${kind} types.`, el, 'fieldSets', at);
        }
    }

    for (const agg of index.elements.filter(isAggregate)) {
        const self = aggregateParamName(agg);
        for (const cmd of commandsOf(agg)) {
            for (const p of cmd.params) {
                if (TS_RESERVED.has(p.name)) {
                    sink.error('M011', `Parameter name '${p.name}' is a reserved word in TypeScript.`, p, 'name');
                } else if (!cmd.factory && p.name === self) {
                    sink.error('M011', `Parameter '${p.name}' of ${commandTypeName(agg, cmd)} collides with the aggregate parameter '${self}'.`, p, 'name');
                }
            }
        }
    }
}
