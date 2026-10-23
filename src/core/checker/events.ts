import { isIdType } from '../../language/generated/ast.js';
import { camel } from '../../generator/naming.js';
import type { DiagnosticSink } from '../diagnostics.js';
import { commandsOf, identityField, includedFields, type ModelIndex } from '../model-index.js';

/**
 * M017 (warning): an event that a command of an aggregate emits has a field of that aggregate's ID type (its own or
 * from a field set; optional and repeated fields count), so that it says which aggregate it is about. An event emitted
 * by several aggregates needs the ID type of each.
 */
export function checkEventIds(index: ModelIndex, sink: DiagnosticSink): void {
    for (const agg of index.aggregates) {
        const idType = identityField(agg)?.type?.decl?.ref;
        if (!idType || !isIdType(idType)) continue; // reported by M013
        const checked = new Set<unknown>();
        for (const cmd of commandsOf(agg)) {
            for (const e of cmd.emits) {
                const ev = e.event.ref;
                if (!ev || checked.has(ev)) continue;
                checked.add(ev);
                const fields = [...includedFields(ev).map((x) => x.field), ...ev.members];
                if (fields.some((f) => f.type?.decl?.ref === idType)) continue;
                const typeName = idType.$container.name === ev.$container.name ? idType.name : `${idType.$container.name}.${idType.name}`;
                sink.warning(
                    'M017',
                    `Event '${ev.name}' emitted by '${agg.name}.${cmd.name}' has no field of type '${idType.name}' to tell which '${agg.name}' it is about.`,
                    e,
                    'event',
                    undefined,
                    `add a field such as '${camel(agg.name)}Id: ${typeName}' to event '${ev.name}'`,
                );
            }
        }
    }
}
