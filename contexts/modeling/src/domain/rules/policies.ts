import type { RuleSink } from '../diagnostics.js';
import { isShared, type PolicyDecl, type SourceModel } from '../source-model.js';

/**
 * M023: policies (`policy Name when Event -> Aggregate.command`). That the event, the aggregate (of the policy's own
 * context) and the command exist is reported from linking (see `policyLink` in analyze.ts); this checks what linking
 * cannot:
 *   - the event is not of a shared context (a shared context has no events, see M014)
 *   - (warning) two policies of a context state the same reaction (the same event and command)
 * A policy in a shared context is reported by M014, a repeated name by M002.
 */
export function checkPolicies(model: SourceModel, rules: RuleSink): void {
    const seen = new Map<string, PolicyDecl>();
    for (const policy of model.elements) {
        if (policy.kind !== 'policy') continue;
        const event = policy.event.target;
        if (event && event.kind === 'event' && isShared(model, event.context)) {
            rules.error(
                'M023',
                `Policy '${policy.name}' reacts to '${event.context}.${event.name}' of shared context '${event.context}', which cannot hold events.`,
                policy.event.at,
            );
        }
        const agg = policy.aggregate.target;
        const command = policy.command.target;
        if (!event || !agg || agg.kind !== 'aggregate' || !command) continue;
        const key = `${policy.context}|${event.context}.${event.name}|${agg.name}.${command.name}`;
        const prev = seen.get(key);
        if (prev) {
            rules.warning(
                'M023',
                `Policy '${policy.name}' states the same reaction as '${prev.name}': when '${policy.event.text}', '${agg.name}.${command.name}'.`,
                policy.nameAt,
                `remove one of them, or merge their descriptions`,
            );
        } else {
            seen.set(key, policy);
        }
    }
}
