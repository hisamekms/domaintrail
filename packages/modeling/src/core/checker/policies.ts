import { isAggregate, isEventDecl, type Policy } from '../../language/generated/ast.js';
import type { DiagnosticSink } from '../diagnostics.js';
import type { ModelIndex } from '../model-index.js';

/**
 * M023: policies (`policy Name when Event -> Aggregate.command`). That the event, the aggregate (of the policy's own
 * context) and the command exist is reported from linking (see `policyLink` in analyze.ts); this checks what linking
 * cannot:
 *   - the event is not of a shared context (a shared context has no events, see M014)
 *   - (warning) two policies of a context state the same reaction (the same event and command)
 * A policy in a shared context is reported by M014, a repeated name by M002.
 */
export function checkPolicies(index: ModelIndex, sink: DiagnosticSink): void {
    const seen = new Map<string, Policy>();
    for (const p of index.elements) {
        if (p.$type !== 'Policy') continue;
        const policy = p as Policy;
        const event = policy.event.ref;
        if (event && isEventDecl(event) && index.isShared(event.$container.name)) {
            sink.error(
                'M023',
                `Policy '${policy.name}' reacts to '${event.$container.name}.${event.name}' of shared context '${event.$container.name}', which cannot hold events.`,
                policy,
                'event',
            );
        }
        const agg = policy.aggregate.ref;
        const command = policy.command.ref;
        if (!event || !agg || !isAggregate(agg) || !command) continue;
        const key = `${policy.$container.name}|${event.$container.name}.${event.name}|${agg.name}.${command.name}`;
        const prev = seen.get(key);
        if (prev) {
            sink.warning(
                'M023',
                `Policy '${policy.name}' states the same reaction as '${prev.name}': when '${policy.event.$refText}', '${agg.name}.${command.name}'.`,
                policy,
                'name',
                undefined,
                `remove one of them, or merge their descriptions`,
            );
        } else {
            seen.set(key, policy);
        }
    }
}
