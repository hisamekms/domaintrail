import type { SemanticEdge } from '@domaintrail/storming';

/**
 * The semantic edges of a timeline filter (§9.3), and of a stage's view: each 1-hop path Event → Policy → Command → Event
 * whose two events are in view (`events`), each command that emits an event in view (its cause, without the policy that
 * issues it unless that is such a path), the actors, read models and target of those commands, and the hotspots on an
 * event in view. No path is followed further, so a cycle is no different from any other path (R10, R16).
 */
export function filterEdges(edges: readonly SemanticEdge[], events: ReadonlySet<string>): SemanticEdge[] {
    const from = (id: string, kind: SemanticEdge['kind']): SemanticEdge[] => edges.filter((e) => e.sourceId === id && e.kind === kind);
    const kept = new Set<SemanticEdge>();
    const commands = new Set<string>();
    for (const on of edges) {
        if (on.kind !== 'on' || !events.has(on.sourceId)) continue;
        for (const issues of from(on.targetId, 'issues')) {
            if (!from(issues.targetId, 'emits').some((e) => events.has(e.targetId))) continue;
            kept.add(on).add(issues);
        }
    }
    // the cause of an event in view: each command that emits it (those of the paths above among them)
    for (const e of edges) if (e.kind === 'emits' && events.has(e.targetId)) commands.add(e.sourceId);
    for (const e of edges) {
        const keep =
            (e.kind === 'emits' && events.has(e.targetId)) ||
            ((e.kind === 'actor' || e.kind === 'reads') && commands.has(e.targetId)) ||
            (e.kind === 'target' && commands.has(e.sourceId)) ||
            (e.kind === 'hotspot-on' && events.has(e.targetId));
        if (keep) kept.add(e);
    }
    return edges.filter((e) => kept.has(e));
}
