import { camel } from '@domaintrail/kernel';
import type { RuleSink } from '../diagnostics.js';
import { commandsOf, identityField, includedFields, type SourceModel } from '../source-model.js';

/**
 * M017 (warning): an event that a command of an aggregate emits has a field of that aggregate's ID type (its own or
 * from a field set; optional and repeated fields count), so that it says which aggregate it is about. An event emitted
 * by several aggregates needs the ID type of each.
 */
export function checkEventIds(model: SourceModel, rules: RuleSink): void {
    for (const agg of model.elements) {
        if (agg.kind !== 'aggregate') continue;
        const idType = identityField(agg)?.type?.decl?.target;
        if (idType?.kind !== 'id') continue; // reported by M013
        const checked = new Set<unknown>();
        for (const cmd of commandsOf(agg)) {
            for (const e of cmd.emits) {
                const ev = e.event.target;
                if (!ev || checked.has(ev)) continue;
                checked.add(ev);
                const fields = [...includedFields(ev).map((x) => x.field), ...ev.members];
                if (fields.some((f) => f.type?.decl?.target === idType)) continue;
                const typeName = idType.context === ev.context ? idType.name : `${idType.context}.${idType.name}`;
                rules.warning(
                    'M017',
                    `Event '${ev.name}' emitted by '${agg.name}.${cmd.name}' has no field of type '${idType.name}' to tell which '${agg.name}' it is about.`,
                    e.event.at,
                    `add a field such as '${camel(agg.name)}Id: ${typeName}' to event '${ev.name}'`,
                );
            }
        }
    }
}
